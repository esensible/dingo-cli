// c6oracle: the C6 body node's dingoFW core, compiled for the host, answering
// the parameter protocol. It is the independent check behind dingo-cli's
// c6body_v1 board row (internal/params/testdata/c6body_v1.fw.json).
//
// It links exactly the translation units the firmware links (hilux
// wireless-can/build.rs: the dingoFW logic, the board's hw_devices.cpp and
// msg.cpp, and dingo/glue/core.cpp) against the same hal.h/ch.h shim, and
// supplies only the dingo_* callbacks the Rust side supplies on the C6 (CAN
// TX/RX, time, sleep, fatal error, config store).
// Every answer below therefore comes from the firmware's own code:
//
//   board  core_info(): base id, param count, var-map size, board type
//   params stParams[] verbatim: index, sub, type, default, min, max
//   varmap InitVarMap()'s pVarMap[], each slot named by locating the object
//          it points at (the method of dingo-cli/fwhost/src/probe_varmap.cpp)
//   runs   for each param file given: the frames dingo-cli sends for `apply`
//          (WriteAll, WriteAllVal x N, WriteAllComplete), then CheckCrc,
//          ReadAll and a burn, pushed through core_cycle() exactly as CAN RX
//          frames, and the device's answers decoded; then a reboot from the
//          burned blob and CheckCrc again; then 1 s of cycles with the cyclic
//          TX, reporting every frame the core sent.
//
// Usage: c6oracle [name=params.txt ...]   (params.txt: "index sub value" per
// line, decimal, in send order). Output: one JSON object on stdout.

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <map>
#include <string>
#include <vector>

#include "hal.h"
#include "port.h"
#include "device.h"
#include "config.h"
#include "param_registry.h"

// ---- what the Rust side provides on the C6 ---------------------------------

struct DingoFrame
{
    uint32_t id;
    uint8_t ide;
    uint8_t rtr;
    uint8_t dlc;
    uint8_t data[8];
};

struct DingoCoreInfo
{
    uint16_t base_id;
    uint16_t num_params;
    uint16_t var_map_size;
    uint8_t board_type;
    uint8_t version_major;
    uint8_t version_minor;
    uint8_t version_build;
};

struct DingoConfigLoad
{
    uint8_t result; // 0 Restored, 1 Absent, 2.. rejected (glue/core.cpp ConfigLoad)
    uint32_t a;
    uint32_t b;
};

static std::deque<DingoFrame> rxq;
static std::vector<DingoFrame> txlog;
static std::vector<uint8_t> stored; // the "settings partition"
static uint32_t now_ms = 0;
static int fatal = -1;

extern "C" {
bool dingo_can_tx(const DingoFrame *f)
{
    txlog.push_back(*f);
    return true;
}
bool dingo_can_rx(DingoFrame *f)
{
    if (rxq.empty())
        return false;
    *f = rxq.front();
    rxq.pop_front();
    return true;
}
bool dingo_can_rx_pending(void) { return !rxq.empty(); }
void dingo_fatal_error(uint8_t err, uint8_t src) { fatal = err * 256 + src; }
uint32_t dingo_sys_time_ms(void) { return now_ms; }
void dingo_sleep_us(uint32_t) {}

uint32_t core_config_blob_len(void);
uint32_t core_config_serialize(uint8_t *out, uint32_t cap);

// A burn: the firmware's Rust side writes core_config_serialize()'s blob to
// the settings partition, synchronously, inside the cycle.
bool dingo_config_store(void)
{
    std::vector<uint8_t> b(core_config_blob_len());
    if (core_config_serialize(b.data(), b.size()) != b.size())
        return false;
    stored = b;
    return true;
}

void core_init(const uint8_t *blob, uint32_t len, DingoConfigLoad *load);
void core_cycle(void);
void core_cyclic_tx(void);
uint32_t core_cyclic_tx_period_ms(void);
void core_info(DingoCoreInfo *info);
}

// ---- helpers ---------------------------------------------------------------

static uint16_t base()
{
    DingoCoreInfo i;
    core_info(&i);
    return i.base_id;
}

static void cycle()
{
    core_cycle();
    now_ms += 2;
}

// Send one 8-byte param-protocol frame to base+1 and run one cycle (the core
// drains its whole RX queue every cycle). Returns the frames it answered on
// base+0.
static std::vector<DingoFrame> request(uint8_t cmd, uint16_t index, uint8_t sub, uint32_t value)
{
    DingoFrame f = {};
    f.id = base() + 1;
    f.dlc = 8;
    f.data[0] = cmd;
    f.data[1] = index & 0xFF;
    f.data[2] = index >> 8;
    f.data[3] = sub;
    for (int i = 0; i < 4; i++)
        f.data[4 + i] = (value >> (8 * i)) & 0xFF;
    uint16_t answerOn = base();
    size_t mark = txlog.size();
    rxq.push_back(f);
    cycle();
    // WriteAllComplete applies the new config before it answers, so a config
    // that changes the base id is answered on the new base.
    uint16_t answerAfter = base();
    std::vector<DingoFrame> out;
    for (size_t i = mark; i < txlog.size(); i++)
        if ((txlog[i].id == answerOn || txlog[i].id == answerAfter) && txlog[i].dlc == 8)
            out.push_back(txlog[i]);
    return out;
}

static uint16_t idx(const DingoFrame &f) { return f.data[1] | (f.data[2] << 8); }
static uint32_t val(const DingoFrame &f)
{
    return f.data[4] | (f.data[5] << 8) | (f.data[6] << 16) | ((uint32_t)f.data[7] << 24);
}

static const char *typeName(ParamType t)
{
    switch (t)
    {
    case ParamType::UInt8: return "uint8";
    case ParamType::Int8: return "int8";
    case ParamType::UInt16: return "uint16";
    case ParamType::Int16: return "int16";
    case ParamType::UInt32: return "uint32";
    case ParamType::Int32: return "int32";
    case ParamType::Float: return "float";
    case ParamType::Bool: return "bool";
    case ParamType::Enum: return "enum";
    }
    return "?";
}

static std::string varName(int i)
{
    const float *p = pVarMap[i];
    char b[48];
    for (int k = 0; k < NUM_CAN_INPUTS; k++)
    {
        if (p == &canIn[k].fOutput) { snprintf(b, sizeof b, "CanIn%dOut", k + 1); return b; }
        if (p == &canIn[k].fVal) { snprintf(b, sizeof b, "CanIn%dVal", k + 1); return b; }
    }
    for (int k = 0; k < NUM_VIRT_INPUTS; k++)
        if (p == &virtIn[k].fVal) { snprintf(b, sizeof b, "VirtIn%d", k + 1); return b; }
    for (int k = 0; k < NUM_FLASHERS; k++)
        if (p == &flasher[k].fVal) { snprintf(b, sizeof b, "Flasher%d", k + 1); return b; }
    for (int k = 0; k < NUM_CONDITIONS; k++)
        if (p == &condition[k].fVal) { snprintf(b, sizeof b, "Cond%d", k + 1); return b; }
    for (int k = 0; k < NUM_COUNTERS; k++)
        if (p == &counter[k].fVal) { snprintf(b, sizeof b, "Counter%d", k + 1); return b; }
    // ALWAYS_FALSE/ALWAYS_TRUE are per-TU statics (port.h) and fState is
    // file-static in device.cpp, so they cannot be matched by address. They
    // are the first three slots (InitVarMap); name them only where the slot
    // holds the value that identity requires.
    if (i == 0 && *p == 0.0f) return "AlwaysFalse";
    if (i == 1 && *p == 1.0f) return "AlwaysTrue";
    if (i == 2) return "State";
    return "?";
}

// ---- one apply/verify/read-back run ---------------------------------------

struct P
{
    uint16_t index;
    uint8_t sub;
    uint32_t value;
};

static void run(const char *name, const char *path)
{
    std::vector<P> ps;
    FILE *fp = fopen(path, "r");
    if (!fp)
    {
        fprintf(stderr, "c6oracle: cannot open %s\n", path);
        exit(1);
    }
    unsigned a, b;
    unsigned long c;
    while (fscanf(fp, "%u %u %lu", &a, &b, &c) == 3)
        ps.push_back({(uint16_t)a, (uint8_t)b, (uint32_t)c});
    fclose(fp);

    uint16_t baseBefore = base();
    printf("{\"name\":\"%s\",\"sent\":%zu,\"baseBefore\":%u", name, ps.size(), baseBefore);

    // dingo apply: WriteAll, every value, WriteAllComplete(count).
    auto start = request(20, 0, 0, 0);
    printf(",\"writeAllAck\":%s", (start.size() == 1 && start[0].data[0] == 20) ? "true" : "false");
    int rejected = 0;
    for (auto &p : ps)
    {
        // A staged value is never answered; 25 = param not found, 26 = out
        // of range.
        for (auto &f : request(21, p.index, p.sub, p.value))
        {
            if (f.data[0] != 25 && f.data[0] != 26)
                continue;
            rejected++;
            fprintf(stderr, "c6oracle: %s: 0x%04X.%u = %u answered cmd %u\n", name, p.index, p.sub, p.value, f.data[0]);
        }
    }
    auto done = request(22, (uint16_t)ps.size(), 0, 0);
    if (done.size() != 1 || done[0].data[0] != 22)
    {
        fprintf(stderr, "c6oracle: %s: no WriteAllComplete answer\n", name);
        exit(1);
    }
    printf(",\"rejected\":%d,\"writeCount\":%u,\"writeCrc\":\"%08X\"", rejected, idx(done[0]), val(done[0]));
    printf(",\"baseAfter\":%u", base());

    // dingo verify.
    auto chk = request(34, 0, 0, 0);
    if (chk.size() != 1 || chk[0].data[0] != 35)
    {
        fprintf(stderr, "c6oracle: %s: no CheckCrc answer\n", name);
        exit(1);
    }
    printf(",\"checkCrc\":\"%08X\"", val(chk[0]));

    // dingo read-all: the dump must be exactly what was sent, in order.
    auto dump = request(10, 0, 0, 0);
    size_t n = 0;
    bool same = true;
    uint32_t readCount = 0, readCrc = 0;
    for (auto &f : dump)
    {
        if (f.data[0] == 11)
        {
            if (n >= ps.size() || idx(f) != ps[n].index || f.data[3] != ps[n].sub || val(f) != ps[n].value)
                same = false;
            n++;
        }
        else if (f.data[0] == 12)
        {
            readCount = idx(f);
            readCrc = val(f);
        }
    }
    printf(",\"readCount\":%u,\"readCrc\":\"%08X\",\"readBackEqualsSent\":%s",
           readCount, readCrc, (same && n == ps.size()) ? "true" : "false");

    // dingo burn (magic 30,1,3,8), then a reboot from what was stored: the
    // node must come back holding the same config.
    auto burn = request(30, 0x0301, 8, 0);
    int burnResult = (burn.size() == 1 && burn[0].data[0] == 30) ? burn[0].data[4] : -1;
    DingoConfigLoad load = {};
    core_init(stored.data(), (uint32_t)stored.size(), &load);
    for (int i = 0; i < 5; i++)
        cycle();
    auto rb = request(34, 0, 0, 0);
    printf(",\"burnResult\":%d,\"rebootLoad\":%u,\"rebootCrc\":\"%08X\"", burnResult, load.result,
           (rb.size() == 1 && rb[0].data[0] == 35) ? val(rb[0]) : 0u);

    // One second of the 2 ms loop plus the 100 ms cyclic TX: every frame the
    // core put on the bus other than protocol answers, last payload per id.
    size_t mark = txlog.size();
    uint32_t period = core_cyclic_tx_period_ms();
    for (int i = 0; i < 500; i++)
    {
        cycle();
        if (now_ms % period == 0)
            core_cyclic_tx();
    }
    // Per id: how many frames, and each distinct payload in first-seen order
    // (the heartbeat byte makes every status frame distinct, so status
    // payloads are summarised by the last one).
    struct Seen
    {
        int count = 0;
        uint8_t dlc = 0;
        std::vector<std::string> payloads;
    };
    std::map<uint32_t, Seen> seen;
    for (size_t i = mark; i < txlog.size(); i++)
    {
        const DingoFrame &f = txlog[i];
        Seen &s = seen[f.id];
        s.count++;
        s.dlc = f.dlc;
        char hex[17] = {};
        for (int k = 0; k < f.dlc; k++)
            snprintf(hex + 2 * k, 3, "%02X", f.data[k]);
        bool isStatus = f.id == (uint32_t)base() + 2;
        if (isStatus)
            s.payloads.assign(1, hex);
        else if (std::find(s.payloads.begin(), s.payloads.end(), std::string(hex)) == s.payloads.end())
            s.payloads.push_back(hex);
    }
    printf(",\"tx1s\":[");
    bool first = true;
    for (auto &kv : seen)
    {
        printf("%s{\"id\":%u,\"count\":%d,\"dlc\":%u,\"payloads\":[", first ? "" : ",", kv.first, kv.second.count, kv.second.dlc);
        for (size_t k = 0; k < kv.second.payloads.size(); k++)
            printf("%s\"%s\"", k ? "," : "", kv.second.payloads[k].c_str());
        printf("]}");
        first = false;
    }
    printf("]}");
}

int main(int argc, char **argv)
{
    DingoConfigLoad boot = {};
    core_init(nullptr, 0, &boot); // nothing stored: a fresh node
    for (int i = 0; i < 5; i++)
        cycle();

    DingoCoreInfo info;
    core_info(&info);
    printf("{\"generator\":\"dingo-cli/tools/c6oracle\",\"board\":{\"baseId\":%u,\"numParams\":%u,"
           "\"varMapSize\":%u,\"pdmType\":%u,\"version\":\"%u.%u.%u\"},\"bootLoad\":%u",
           info.base_id, info.num_params, info.var_map_size, info.board_type,
           info.version_major, info.version_minor, info.version_build, boot.result);

    // What `dingo verify` reads from a node that has only ever had its
    // defaults (a fresh or erased one).
    auto chk = request(34, 0, 0, 0);
    if (chk.size() != 1 || chk[0].data[0] != 35)
    {
        fprintf(stderr, "c6oracle: no CheckCrc answer from the defaults\n");
        return 1;
    }
    printf(",\"defaultsCrc\":\"%08X\"", val(chk[0]));

    printf(",\n\"params\":[");
    for (int i = 0; i < NUM_PARAMS; i++)
    {
        const ParamInfo &p = stParams[i];
        printf("%s\n{\"index\":%u,\"sub\":%u,\"type\":\"%s\",\"default\":%u,\"min\":%u,\"max\":%u}",
               i ? "," : "", p.nIndex, p.nSubIndex, typeName(p.eType), p.nDefaultVal, p.nMinVal, p.nMaxVal);
    }
    printf("],\n\"varMap\":[");
    for (int i = 0; i < (int)VAR_MAP_SIZE; i++)
        printf("%s\"%s\"", i ? "," : "", varName(i).c_str());
    printf("],\n\"runs\":[");
    for (int i = 1; i < argc; i++)
    {
        char *eq = strchr(argv[i], '=');
        if (!eq)
        {
            fprintf(stderr, "usage: c6oracle [name=params.txt ...]\n");
            return 2;
        }
        *eq = 0;
        if (i > 1)
            printf(",\n");
        run(argv[i], eq + 1);
    }
    printf("],\n\"fatal\":%d}\n", fatal);
    return fatal >= 0 ? 1 : 0;
}

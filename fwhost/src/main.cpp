// fwhost -- run a dingoConfig against a stimulus trace using the REAL dingoFW
// logic compiled for the host.
//
//   fwhost <config.json> <trace.json> [--base <id>] [--vars i,j,k]
//
// Emits one JSON object per 2 ms cycle on stdout:
//   {"cycle":N,"ms":M,"label":"...","obs":{ "out1":0, "can:0:0x301:0:1":1, ...}}
//
// The observation vector matches fwmodel/model/dingosim.py Sim.observe():
//   * physical outputs keyed by output number,
//   * CAN output values keyed by (ide, id, startBit, bitLength).
// CAN values are read back out of the frames the firmware actually posted to
// the TX mailbox this cycle -- the true device boundary.  Every CAN output's
// interval is forced to 1 ms first so a frame is posted every cycle and the
// value stream is observable per-cycle (interval affects transmit cadence
// only: frame grouping and DLC are computed from id/ide/startBit/bitLength).
#include "host.h"
#include "json.h"
#include "loader.h"

#include "port.h"
#include "config.h"
#include "config_handler.h"
#include "device.h"
#include "dbc.h"
#include "profet.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>

static const uint32_t CYCLE_MS = 2;   // core/device.cpp: chThdSleepMilliseconds(2)

extern int g_fatalErrors;
extern FatalErrorType g_lastFatalError;

// ---------------------------------------------------------------- trace ----
struct Step {
    std::map<int, int> pins;                       // 1-based pin -> level
    std::map<uint32_t, std::vector<uint8_t>> payloads;
    std::set<uint32_t> silent;
    int cycles = 1;
    std::string label;
};

static uint32_t parseId(const std::string &s) {
    return (uint32_t)strtoul(s.c_str(), nullptr,
                             (s.size() > 1 && (s[1] == 'x' || s[1] == 'X')) ? 16 : 10);
}

static bool loadTrace(const std::string &path, std::vector<Step> *out,
                      std::string *name, std::string *err) {
    JPtr doc = jparseFile(path, err);
    if (!doc) return false;
    auto nm = doc->get("name");
    *name = nm && nm->kind == JVal::Str ? nm->str : "trace";
    auto steps = doc->get("steps");
    if (!steps || steps->kind != JVal::Arr) { *err = "trace has no steps[]"; return false; }

    std::map<int, int> pins;
    std::map<uint32_t, std::vector<uint8_t>> payloads;
    std::set<uint32_t> silent;

    for (auto &s : steps->arr) {
        if (auto p = s->get("pins"))
            for (auto &kv : p->obj)
                pins[atoi(kv.first.c_str())] = (int)kv.second->num;
        if (auto b = s->get("bits"))
            for (auto &kv : b->obj) {
                size_t c = kv.first.find(':');
                uint32_t cid = parseId(kv.first.substr(0, c));
                int bit = atoi(kv.first.substr(c + 1).c_str());
                auto &buf = payloads[cid];
                if (buf.empty()) buf.assign(8, 0);
                if ((int)kv.second->num) buf[bit / 8] |= (1 << (bit % 8));
                else                     buf[bit / 8] &= ~(1 << (bit % 8)) & 0xFF;
            }
        if (auto by = s->get("bytes"))
            for (auto &kv : by->obj) {
                std::vector<uint8_t> buf(8, 0);
                for (size_t i = 0; i < kv.second->arr.size() && i < 8; i++)
                    buf[i] = (uint8_t)kv.second->arr[i]->num;
                payloads[parseId(kv.first)] = buf;
            }
        if (auto q = s->get("quiet"))
            for (auto &v : q->arr)
                silent.insert(v->kind == JVal::Str ? parseId(v->str) : (uint32_t)v->num);
        if (auto l = s->get("loud"))
            for (auto &v : l->arr)
                silent.erase(v->kind == JVal::Str ? parseId(v->str) : (uint32_t)v->num);

        Step st;
        st.pins = pins;
        for (auto &kv : payloads)
            if (!silent.count(kv.first)) st.payloads[kv.first] = kv.second;
        auto cyc = s->get("cycles");
        if (cyc) st.cycles = (int)cyc->num;
        else {
            auto ms = s->get("ms");
            int m = ms ? (int)ms->num : (int)CYCLE_MS;
            st.cycles = (int)((m + CYCLE_MS - 1) / CYCLE_MS);
            if (st.cycles < 1) st.cycles = 1;
        }
        auto lab = s->get("label");
        if (lab && lab->kind == JVal::Str) st.label = lab->str;
        out->push_back(st);
    }
    return true;
}

// ------------------------------------------------------------ pin wiring ----
// Trace pin N (1-based, before inversion) -> the board line Digital_Input N reads.
static ioline_t pinLine(int n) {
    static const ioline_t lines[NUM_DIG_INPUTS] = {LINE_DI1, LINE_DI2};
    return (n >= 1 && n <= NUM_DIG_INPUTS) ? lines[n - 1] : 0;
}

// ------------------------------------------------------------------ main ----
int main(int argc, char **argv) {
    const char *cfgPath = nullptr, *tracePath = nullptr;
    int baseId = -1;
    std::vector<int> dumpVars;

    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--base" && i + 1 < argc) baseId = atoi(argv[++i]);
        else if (a == "--vars" && i + 1 < argc) {
            char *s = argv[++i];
            for (char *tok = strtok(s, ","); tok; tok = strtok(nullptr, ","))
                dumpVars.push_back(atoi(tok));
        } else if (!cfgPath) cfgPath = argv[i];
        else if (!tracePath) tracePath = argv[i];
    }
    if (!cfgPath || !tracePath) {
        fprintf(stderr, "usage: fwhost <config.json> <trace.json> [--base id] [--vars i,j]\n");
        return 2;
    }

    InitVarMap();

    LoadResult lr;
    if (!LoadDingoConfig(cfgPath, baseId, &lr)) {
        fprintf(stderr, "config: %s\n", lr.error.c_str());
        return 2;
    }
    for (auto &w : lr.warnings) fprintf(stderr, "warn: %s\n", w.c_str());
    if (lr.usesKeypad) fprintf(stderr, "warn: config enables keypads; no keypad traffic is injected\n");

    // Force per-cycle transmission so CAN output values are observable every
    // cycle.  Only the cadence changes; grouping and DLC do not depend on it.
    for (int i = 0; i < NUM_CAN_OUTPUTS; i++) stConfig.stCanOutput[i].nInterval = 1;
    ApplyAllConfig();

    std::vector<Step> steps;
    std::string traceName, err;
    if (!loadTrace(tracePath, &steps, &traceName, &err)) {
        fprintf(stderr, "trace: %s\n", err.c_str());
        return 2;
    }

    printf("{\"_meta\":{\"config\":\"%s\",\"baseId\":%d,\"trace\":\"%s\","
           "\"varMapSize\":%d,\"fw\":\"host-compiled dingoFW\"}}\n",
           lr.name.c_str(), lr.baseId, traceName.c_str(), (int)VAR_MAP_SIZE);

    int cycle = 0;
    uint32_t ms = 0;
    for (auto &st : steps) {
        for (int c = 0; c < st.cycles; c++) {
            hostSetTimeMs(ms);
            hostClearTx();

            for (auto &kv : st.pins) {
                ioline_t l = pinLine(kv.first);
                if (l) hostPalWrite(l, kv.second ? 1 : 0);
            }
            for (auto &kv : st.payloads) {
                HostFrame f{};
                f.id = kv.first;
                f.ide = 0;
                f.dlc = 8;
                memcpy(f.data, kv.second.data(), 8);
                hostPushRx(f);
            }

            CyclicUpdate();

            printf("{\"cycle\":%d,\"ms\":%u,\"label\":\"%s\",\"obs\":{",
                   cycle, ms, st.label.c_str());
            bool first = true;
            for (int i = 0; i < NUM_OUTPUTS; i++) {
                printf("%s\"out%d\":%g", first ? "" : ",", i + 1, pf[i].fOutput);
                first = false;
            }
            for (int i = 0; i < NUM_CAN_OUTPUTS; i++) {
                const Config_CanOutput &co = stConfig.stCanOutput[i];
                if (!co.bEnabled || co.nBitLength == 0) continue;
                const HostFrame *hit = nullptr;
                for (auto &f : hostTx())
                    if (f.ide == co.nIDE && f.id == co.nID) hit = &f;
                if (!hit) continue;   // no frame this cycle (only possible at t=0)
                float v = Dbc::DecodeFloat(hit->data, co.nStartBit, co.nBitLength,
                                           co.fFactor, co.fOffset, co.eByteOrder,
                                           co.bSigned);
                printf("%s\"can:%u:%#x:%u:%u\":%g", first ? "" : ",",
                       co.nIDE, co.nID, co.nStartBit, co.nBitLength, v);
                first = false;
            }
            for (int v : dumpVars) {
                if (v >= 0 && v < (int)VAR_MAP_SIZE)
                    printf("%s\"var%d\":%g", first ? "" : ",", v, *pVarMap[v]);
                first = false;
            }
            printf("}}\n");

            cycle++;
            ms += CYCLE_MS;
        }
    }

    if (g_fatalErrors)
        fprintf(stderr, "warn: firmware raised %d fatal error(s), last type %d\n",
                g_fatalErrors, (int)g_lastFatalError);
    return 0;
}

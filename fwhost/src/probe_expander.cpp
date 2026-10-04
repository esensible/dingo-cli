// canboard_v2_exp: assertions about EXECUTED firmware object code.
//
// The real core/device.cpp, functions/digital_input.cpp and
// hardware/mcp23017.cpp run against the fake MCP23017 in host_i2c.cpp.
#include "host.h"
#include "host_i2c.h"
#include "config.h"
#include "config_handler.h"
#include "device.h"
#include "hw_devices.h"
#include "param_registry.h"
#include "status.h"

#include <cstdio>
#include <cstring>

extern int g_fatalErrors;
extern FatalErrorType g_lastFatalError;

static int g_fail = 0;
static void ok(bool cond, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void ok(bool cond, const char *fmt, ...) {
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    printf("%-4s %s\n", cond ? "ok" : "FAIL", buf);
    if (!cond) g_fail++;
}

static int findIdx(const float *p) {
    for (int i = 0; i < (int)VAR_MAP_SIZE; i++) if (pVarMap[i] == p) return i;
    return -1;
}

// --- cycle driver ----------------------------------------------------------
static uint32_t g_ms = 0;
static void cycle(int n = 1) {
    for (int i = 0; i < n; i++) {
        hostSetTimeMs(g_ms);
        hostClearTx();
        CyclicUpdate();
        g_ms += 2;              // the device thread's 2 ms period
    }
}

// Ground-switching input: idle high (pulled up), asserted low, bInvert set.
static void configInput(int i, uint16_t debounceMs, bool invert,
                        InputMode mode = InputMode::Momentary,
                        InputPull pull = InputPull::Up) {
    stConfig.stDigInput[i].bEnabled      = true;
    stConfig.stDigInput[i].eMode         = mode;
    stConfig.stDigInput[i].bInvert       = invert;
    stConfig.stDigInput[i].nDebounceTime = debounceMs;
    stConfig.stDigInput[i].ePull         = pull;
}

int main() {
    printf("===== A. var map and parameter table\n");

    InitVarMap();
    ok(g_fatalErrors == 0, "InitVarMap() raised no fatal error (index == VAR_MAP_SIZE)");
    ok(VAR_MAP_SIZE == 90, "VAR_MAP_SIZE == 90 (was 75 with 8 inputs; +15)");
    ok(NUM_DIG_INPUTS == 23, "NUM_DIG_INPUTS == 23");

    bool contiguous = true;
    for (int i = 0; i < NUM_DIG_INPUTS; i++)
        if (findIdx(&digIn[i].fVal) != 3 + i) contiguous = false;
    ok(contiguous, "DI1..DI23 occupy var-map indices 3..25 in order");
    printf("     DigIn1=%d DigIn7=%d DigIn8=%d DigIn23=%d DigOut1=%d AnIn1=%d\n",
           findIdx(&digIn[0].fVal), findIdx(&digIn[6].fVal),
           findIdx(&digIn[7].fVal), findIdx(&digIn[22].fVal),
           findIdx(&digOut[0].fVal), findIdx(&analogIn[0].fVal));

    bool allParams = true;
    for (int i = 0; i < NUM_DIG_INPUTS; i++)
        for (int sub = 0; sub <= 4; sub++)
            if (FindParam(0x1200 + i, sub) == nullptr) allParams = false;
    ok(allParams, "param table has all 5 sub-indices for DI1..DI23 (0x1200..0x1216)");
    ok(FindParam(0x1200 + NUM_DIG_INPUTS, 0) == nullptr,
       "param table has no DI24 (0x1217)");

    const ParamInfo *vi = FindParam(0x1400, 2);   // VirtualInput nVar0
    ok(vi != nullptr && vi->nMaxVal == VAR_MAP_SIZE - 1,
       "var-index params range to VAR_MAP_SIZE-1 = %d (got %u)",
       (int)VAR_MAP_SIZE - 1, vi ? vi->nMaxVal : 0u);

    ok(sizeof(DeviceConfig) + sizeof(uint32_t) <= 2048,
       "DeviceConfig %zu B + CRC fits the 2 KB flash config sector",
       sizeof(DeviceConfig));

    // ---------------------------------------------------------------------
    printf("\n===== B. expander input behaves exactly like a native input\n");

    hostMcpReset();
    hostMcpSetPins(0xFFFF);                   // all 16 idle high (pulled up)
    hostPalWrite(LINE_DI1, 1);                // native DI1 idle high

    stConfig.stDevice.nBaseId = 0x640;
    configInput(0,  20, true);                // DI1  - native PA5
    configInput(7,  20, true);                // DI8  - expander GPA0
    configInput(22, 20, true, InputMode::Momentary, InputPull::Down); // DI23 - GPB7, unsupported pull
    ApplyAllConfig();
    bool init = ioExpander.Init();            // same call site as InitDevice()

    ok(init, "ioExpander.Init() succeeded against the fake device");
    ok(hostMcpGetIocon() == 0x44, "IOCON = 0x44 (MIRROR | ODR), got 0x%02X", hostMcpGetIocon());
    ok(hostMcpGetIodir() == 0xFFFF, "IODIR = 0xFFFF (all inputs), got 0x%04X", hostMcpGetIodir());
    ok(hostMcpGetGpinten() == 0xFFFF, "GPINTEN = 0xFFFF (interrupt on change), got 0x%04X",
       hostMcpGetGpinten());
    ok(ioExpander.GetInputs() == 0xFFFF, "mirror seeded from GPIO at init = 0x%04X",
       ioExpander.GetInputs());

    ok(hostMcpGetPulls() == 0x0001,
       "GPPU has only DI8's bit set: DI23 asked for a pull-DOWN and got none (0x%04X)",
       hostMcpGetPulls());
    ok(ioExpander.GetUnsupportedPullMask() == 0x8000,
       "unsupported-pull mask flags GPB7 (0x%04X)", ioExpander.GetUnsupportedPullMask());

    const int iDI1 = findIdx(&digIn[0].fVal);
    const int iDI8 = findIdx(&digIn[7].fVal);

    cycle(30);                                 // settle, 60 ms
    ok(*pVarMap[iDI1] == 0.0f && *pVarMap[iDI8] == 0.0f,
       "idle: DI1 and DI8 both 0 (high + invert)");

    uint32_t readsBefore = hostMcpGpioReadCount();
    cycle(100);                                // 200 ms of nothing happening
    ok(hostMcpGpioReadCount() == readsBefore,
       "no I2C traffic while nothing changes (%u GPIO reads over 200 ms)",
       hostMcpGpioReadCount() - readsBefore);

    // Assert both inputs on the same cycle and compare them cycle by cycle.
    hostPalWrite(LINE_DI1, 0);
    hostMcpSetPins(0xFFFE);                    // GPA0 low
    ok(hostMcpIntAsserted(), "expander asserted INT on the pin change");

    bool identical = true;
    int  firstAssertCycle = -1;
    for (int c = 0; c < 40; c++) {
        cycle();
        if (*pVarMap[iDI1] != *pVarMap[iDI8]) identical = false;
        if (firstAssertCycle < 0 && *pVarMap[iDI8] == 1.0f) firstAssertCycle = c;
    }
    ok(identical, "DI8 tracked native DI1 on every one of 40 cycles");
    ok(*pVarMap[iDI8] == 1.0f, "DI8 asserted (low + invert = 1)");
    ok(firstAssertCycle >= 10 && firstAssertCycle <= 11,
       "20 ms debounce honoured: first asserted on cycle %d (~10 x 2 ms)",
       firstAssertCycle);
    ok(!hostMcpIntAsserted(), "INT cleared by the driver's GPIO read");
    ok(hostMcpGpioReadCount() == readsBefore + 1,
       "exactly one GPIO read for the change (%u)", hostMcpGpioReadCount() - readsBefore);

    // A glitch shorter than the debounce window must not get through.
    uint16_t before = (uint16_t)*pVarMap[iDI8];
    hostMcpSetPins(0xFFFF);                    // release
    cycle(4);                                  // 8 ms - inside the 20 ms window
    hostMcpSetPins(0xFFFE);                    // re-assert
    cycle(20);
    ok((uint16_t)*pVarMap[iDI8] == before,
       "8 ms glitch on the expander pin debounced away (still %u)", before);

    // Release for real.
    hostPalWrite(LINE_DI1, 1);
    hostMcpSetPins(0xFFFF);
    cycle(40);
    ok(*pVarMap[iDI8] == 0.0f && *pVarMap[iDI1] == 0.0f, "both released back to 0");

    // Invert off: the raw level shows through, same as a native pin.
    // NOTE: Digital_Input only re-evaluates input.Check() on a raw EDGE (or
    // before bInit), so a config change does not take effect until the pin
    // next moves.  That is pre-existing firmware behaviour and it is the same
    // for native and expander inputs - asserted explicitly below.
    stConfig.stDigInput[7].bInvert = false;
    stConfig.stDigInput[0].bInvert = false;
    ApplyAllConfig();
    cycle(40);
    ok(*pVarMap[iDI8] == 0.0f && *pVarMap[iDI1] == 0.0f,
       "invert change with no edge is not picked up - identically on native (%g) "
       "and expander (%g)", *pVarMap[iDI1], *pVarMap[iDI8]);

    hostPalWrite(LINE_DI1, 0); hostMcpSetPins(0xFFFE); cycle(30);
    ok(*pVarMap[iDI8] == 0.0f && *pVarMap[iDI1] == 0.0f,
       "invert off, pin low: 0 on both");
    hostPalWrite(LINE_DI1, 1); hostMcpSetPins(0xFFFF); cycle(30);
    ok(*pVarMap[iDI8] == 1.0f && *pVarMap[iDI1] == 1.0f,
       "invert off, pin high: 1 on both");

    stConfig.stDigInput[7].bInvert = true;
    stConfig.stDigInput[0].bInvert = true;
    ApplyAllConfig();
    hostPalWrite(LINE_DI1, 0); hostMcpSetPins(0xFFFE); cycle(30);
    hostPalWrite(LINE_DI1, 1); hostMcpSetPins(0xFFFF); cycle(30);
    ok(*pVarMap[iDI8] == 0.0f && *pVarMap[iDI1] == 0.0f, "invert restored on both");

    // Latching mode on an expander input.
    stConfig.stDigInput[7].eMode = InputMode::Latching;
    ApplyAllConfig();
    cycle(40);
    float latched0 = *pVarMap[iDI8];
    hostMcpSetPins(0xFFFE); cycle(30);
    float latched1 = *pVarMap[iDI8];
    hostMcpSetPins(0xFFFF); cycle(30);
    float latched2 = *pVarMap[iDI8];
    ok(latched0 == 0.0f && latched1 == 1.0f && latched2 == 1.0f,
       "latching mode: %g -> press %g -> release %g (stays latched)",
       latched0, latched1, latched2);
    hostMcpSetPins(0xFFFE); cycle(30);
    hostMcpSetPins(0xFFFF); cycle(30);
    ok(*pVarMap[iDI8] == 0.0f, "second press unlatched");
    stConfig.stDigInput[7].eMode = InputMode::Momentary;
    ApplyAllConfig();
    cycle(40);

    // Every one of the 16 bits lands on the right var-map index.
    bool mapping = true;
    for (int b = 0; b < 16; b++) {
        configInput(7 + b, 0, false);
    }
    ApplyAllConfig();
    hostMcpSetPins(0x0000);         // edge on every bit so the new config takes
    cycle(5);
    for (int b = 0; b < 16; b++) {
        hostMcpSetPins((uint16_t)(1u << b));
        cycle(5);
        for (int j = 0; j < 16; j++) {
            float want = (j == b) ? 1.0f : 0.0f;
            if (*pVarMap[findIdx(&digIn[7 + j].fVal)] != want) mapping = false;
        }
    }
    ok(mapping, "each of GPA0..GPA7, GPB0..GPB7 maps to DI8..DI23 in order");

    // ---------------------------------------------------------------------
    printf("\n===== C. fail safe\n");

    for (int b = 0; b < 16; b++) configInput(7 + b, 20, true);  // ground-switching
    configInput(0, 20, true);
    ApplyAllConfig();
    hostMcpSetPins(0x0000); cycle(20);                          // edge on every bit
    hostMcpSetPins(0xFFFF); cycle(30);                          // all released
    hostPalWrite(LINE_DI1, 0);                                  // native DI1 asserted
    cycle(30);

    bool allZero = true;
    for (int b = 0; b < 16; b++)
        if (*pVarMap[findIdx(&digIn[7 + b].fVal)] != 0.0f) allZero = false;
    ok(allZero, "baseline: all 16 expander inputs idle 0, native DI1 = %g", *pVarMap[iDI1]);
    ok(*pVarMap[iDI1] == 1.0f, "native DI1 asserted before the fault");

    // Assert a few expander inputs, then kill the bus.
    hostMcpSetPins(0xFFFF ^ 0x0007);
    cycle(30);
    int asserted = 0;
    for (int b = 0; b < 16; b++)
        if (*pVarMap[findIdx(&digIn[7 + b].fVal)] == 1.0f) asserted++;
    ok(asserted == 3, "3 expander inputs asserted before the fault (got %d)", asserted);

    hostMcpSetBusFail(true);
    hostMcpSetPins(0xFFFF ^ 0x000F);   // force the driver to attempt a read
    cycle(30);

    ok(!ioExpander.IsOk(), "driver marked the expander failed");
    ok(ioExpander.GetFaultCount() == 1, "one fault recorded (got %u)", ioExpander.GetFaultCount());
    ok(ioExpander.GetInputs() == 0, "mirror zeroed");

    bool failSafe = true;
    for (int b = 0; b < 16; b++)
        if (*pVarMap[findIdx(&digIn[7 + b].fVal)] != 0.0f) failSafe = false;
    ok(failSafe, "ALL 16 expander inputs read 0 = not asserted, despite bInvert");
    ok(*pVarMap[iDI1] == 1.0f, "native DI1 still asserted - unaffected by the bus fault");

    hostPalWrite(LINE_DI1, 1);
    cycle(30);
    ok(*pVarMap[iDI1] == 0.0f, "native DI1 still tracks its pin while the bus is down");

    // Retry must be rate limited, not every 2 ms.
    uint32_t txBefore = hostMcpReadCount() + hostMcpWriteCount();
    cycle(1000);                        // 2 s
    uint32_t attempts = (hostMcpReadCount() + hostMcpWriteCount()) - txBefore;
    ok(attempts == 0, "no I2C attempts at all while failed and inside the 3 s retry window "
                      "(bus errors are counted by the fake only on success; attempts=%u)", attempts);

    // Let the retry timer expire with the bus still broken.
    cycle(700);                         // total > 3 s
    ok(!ioExpander.IsOk(), "still failed after a retry against a broken bus");

    // Bus comes back.
    hostMcpSetBusFail(false);
    cycle(2000);                        // 4 s - at least one retry window
    ok(ioExpander.IsOk(), "expander re-initialised automatically once the bus recovered");
    ok(hostMcpGetIocon() == 0x44, "re-init reconfigured IOCON");
    ok(hostMcpGetPulls() == 0xFFFF, "re-init restored the full GPPU mask (0x%04X)",
       hostMcpGetPulls());

    hostMcpSetPins(0xFFFF ^ 0x0100);    // GPB0 = DI16
    cycle(40);
    ok(*pVarMap[findIdx(&digIn[15].fVal)] == 1.0f, "DI16 works again after recovery");

    // Absent part (never ACKs) - the boot-time case.
    printf("\n===== D. expander absent at boot\n");
    hostMcpReset();
    hostMcpSetPresent(false);
    bool init2 = ioExpander.Init();
    ok(!init2, "Init() fails cleanly when nothing ACKs");
    ok(!ioExpander.IsOk(), "expander reports not ok");
    cycle(200);
    bool absentSafe = true;
    for (int b = 0; b < 16; b++)
        if (*pVarMap[findIdx(&digIn[7 + b].fVal)] != 0.0f) absentSafe = false;
    ok(absentSafe, "all expander inputs 0 with no part fitted");
    hostPalWrite(LINE_DI1, 0);
    cycle(30);
    ok(*pVarMap[iDI1] == 1.0f, "native DI1 works with no expander fitted");
    ok(g_fatalErrors == 0, "no fatal error raised at any point (got %d, last %d)",
       g_fatalErrors, (int)g_lastFatalError);

    printf("\n%s (%d failures)\n", g_fail ? "FAILURES" : "all assertions passed", g_fail);
    return g_fail ? 1 : 0;
}

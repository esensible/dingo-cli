#pragma once
#include <cstdint>
#include <vector>
#include "hal.h"

// ---- virtual clock / GPIO (host_io.cpp) ----
void     hostSetTimeMs(uint32_t ms);
uint32_t hostPalGetMode(ioline_t line);

// ---- drivable battery voltage (host_stubs.cpp) ----
// GetBattVolt() returns this; set from the trace's "batt" field so configs
// whose logic pivots on battery voltage (e.g. ENGINE_RUNNING = BattVolt > 12.4)
// can be exercised. Defaults to 0.0 until the trace sets it.
void  hostSetBattVolt(float v);

// ---- CAN plumbing (host_stubs.cpp) ----
struct HostFrame {
    uint32_t id;
    uint8_t  ide;
    uint8_t  dlc;
    uint8_t  data[8];
};
void hostPushRx(const HostFrame &f);          // queue a frame for CyclicUpdate
void hostClearTx();                           // drop frames posted so far
const std::vector<HostFrame> &hostTx();       // frames posted this cycle

// ---- firmware entry points we drive directly ----
void InitVarMap();
void CyclicUpdate();

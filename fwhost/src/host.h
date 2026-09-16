#pragma once
#include <cstdint>
#include <vector>
#include "hal.h"

// ---- virtual clock / GPIO (host_io.cpp) ----
void     hostSetTimeMs(uint32_t ms);
uint32_t hostPalGetMode(ioline_t line);

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

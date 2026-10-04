// Control surface for the fake MCP23017 in host_i2c.cpp.
#pragma once
#include <cstdint>

void     hostMcpReset();
void     hostMcpSetPresent(bool present);   // false = nothing ACKs on the bus
void     hostMcpSetBusFail(bool fail);      // true  = every transaction errors
void     hostMcpSetAddr(uint8_t addr);
void     hostMcpSetPins(uint16_t pins);     // drive the 16 physical pins

uint16_t hostMcpGetPulls();                 // GPPUB:GPPUA as written by the driver
uint8_t  hostMcpGetIocon();
uint16_t hostMcpGetIodir();
uint16_t hostMcpGetGpinten();
bool     hostMcpIntAsserted();
uint32_t hostMcpGpioReadCount();
uint32_t hostMcpReadCount();
uint32_t hostMcpWriteCount();

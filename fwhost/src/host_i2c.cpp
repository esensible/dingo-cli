// A fake MCP23017 on the host's virtual I2C bus.
//
// This is a device model, not a stand-in for firmware logic: the REAL
// dingoFW hardware/mcp23017.cpp runs against it unmodified, so the register
// sequence, the INT polling scheme, the GPPU write-back and the fail-safe
// paths are all exercised as written.
//
// Interrupt behaviour matches the part in the mode the firmware configures:
// interrupt-on-change against the previous pin value (INTCON = 0), both
// ports mirrored onto one open-drain INT line (IOCON.MIRROR/ODR), asserted
// low, cleared by reading GPIO.
#include "hal.h"
#include "host.h"
#include "host_i2c.h"

#include <cstring>

namespace {

// MCP23017 register file, IOCON.BANK = 0 addressing.
enum {
    R_IODIRA = 0x00, R_IODIRB = 0x01,
    R_IPOLA = 0x02,  R_IPOLB = 0x03,
    R_GPINTENA = 0x04, R_GPINTENB = 0x05,
    R_DEFVALA = 0x06,  R_DEFVALB = 0x07,
    R_INTCONA = 0x08,  R_INTCONB = 0x09,
    R_IOCONA = 0x0A,   R_IOCONB = 0x0B,
    R_GPPUA = 0x0C,    R_GPPUB = 0x0D,
    R_INTFA = 0x0E,    R_INTFB = 0x0F,
    R_INTCAPA = 0x10,  R_INTCAPB = 0x11,
    R_GPIOA = 0x12,    R_GPIOB = 0x13,
    R_OLATA = 0x14,    R_OLATB = 0x15,
    R_COUNT = 0x16
};

struct FakeMcp23017 {
    uint8_t  addr = 0x20;
    bool     present = true;   // part answers on the bus
    bool     busFail = false;  // every transaction errors
    uint8_t  reg[R_COUNT] = {0};

    uint16_t pins = 0;         // physical pin state
    uint16_t lastPins = 0;     // value the part last compared against
    bool     intLatched = false;

    uint32_t reads = 0;        // transactions that read something
    uint32_t writes = 0;       // transactions that only wrote
    uint32_t gpioReads = 0;    // reads of the GPIOA/GPIOB pair

    void Reset() {
        memset(reg, 0, sizeof(reg));
        reg[R_IODIRA] = reg[R_IODIRB] = 0xFF;   // POR: all inputs
        pins = lastPins = 0;
        intLatched = false;
        reads = writes = gpioReads = 0;
    }
};

FakeMcp23017 g_dev;
i2cflags_t   g_errors = 0;

void RefreshIntLine() {
    // Open drain, active low, with an MCU pull-up: 0 = asserted.
    hostPalWrite(LINE_IO_EXP_INT, g_dev.intLatched ? 0u : 1u);
}

} // namespace

void hostMcpReset() {
    g_dev.Reset();
    g_dev.present = true;
    g_dev.busFail = false;
    g_errors = 0;
    RefreshIntLine();
}

void hostMcpSetPresent(bool present) {
    g_dev.present = present;
    if (!present) { g_dev.intLatched = false; RefreshIntLine(); }
}

void hostMcpSetBusFail(bool fail) { g_dev.busFail = fail; }

void hostMcpSetAddr(uint8_t addr) { g_dev.addr = addr; }

void hostMcpSetPins(uint16_t pins) {
    if (!g_dev.present) { g_dev.pins = pins; return; }

    uint16_t gpinten = (uint16_t)g_dev.reg[R_GPINTENA] |
                       ((uint16_t)g_dev.reg[R_GPINTENB] << 8);
    uint16_t changed = (uint16_t)(pins ^ g_dev.lastPins);

    g_dev.pins = pins;

    if (changed & gpinten) {
        // INTCAP latches only on a fresh interrupt.
        if (!g_dev.intLatched) {
            g_dev.reg[R_INTCAPA] = (uint8_t)(pins & 0xFF);
            g_dev.reg[R_INTCAPB] = (uint8_t)(pins >> 8);
        }
        g_dev.reg[R_INTFA] = (uint8_t)(changed & gpinten & 0xFF);
        g_dev.reg[R_INTFB] = (uint8_t)((changed & gpinten) >> 8);
        g_dev.intLatched = true;
        g_dev.lastPins = pins;
        RefreshIntLine();
    } else {
        g_dev.lastPins = pins;
    }
}

uint16_t hostMcpGetPulls() {
    return (uint16_t)g_dev.reg[R_GPPUA] | ((uint16_t)g_dev.reg[R_GPPUB] << 8);
}
uint8_t  hostMcpGetIocon()      { return g_dev.reg[R_IOCONA]; }
uint16_t hostMcpGetIodir() {
    return (uint16_t)g_dev.reg[R_IODIRA] | ((uint16_t)g_dev.reg[R_IODIRB] << 8);
}
uint16_t hostMcpGetGpinten() {
    return (uint16_t)g_dev.reg[R_GPINTENA] | ((uint16_t)g_dev.reg[R_GPINTENB] << 8);
}
bool     hostMcpIntAsserted()   { return g_dev.intLatched; }
uint32_t hostMcpGpioReadCount() { return g_dev.gpioReads; }
uint32_t hostMcpReadCount()     { return g_dev.reads; }
uint32_t hostMcpWriteCount()    { return g_dev.writes; }

// --- the ChibiOS I2C API the driver calls ---------------------------------
void i2cAcquireBus(I2CDriver *) {}
void i2cReleaseBus(I2CDriver *) {}
i2cflags_t i2cGetErrors(I2CDriver *) { return g_errors; }

msg_t i2cMasterTransmitTimeout(I2CDriver *, i2caddr_t addr,
                               const uint8_t *txbuf, size_t txbytes,
                               uint8_t *rxbuf, size_t rxbytes,
                               sysinterval_t) {
    if (g_dev.busFail) { g_errors = 0x10; return (msg_t)-1; }   // I2C_BUS_ERROR
    if (!g_dev.present || addr != g_dev.addr) {
        g_errors = 0x04;                                        // I2C_ACK_FAILURE
        return (msg_t)-1;
    }
    if (txbytes < 1) { g_errors = 0x01; return (msg_t)-1; }

    uint8_t reg = txbuf[0];

    // Write phase: sequential, address auto-increments (IOCON.SEQOP = 0).
    for (size_t i = 1; i < txbytes; i++) {
        uint8_t r = (uint8_t)(reg + (i - 1));
        if (r >= R_COUNT) continue;
        if (r == R_IOCONA || r == R_IOCONB) {
            g_dev.reg[R_IOCONA] = g_dev.reg[R_IOCONB] = txbuf[i];
        } else {
            g_dev.reg[r] = txbuf[i];
        }
        // Enabling interrupt-on-change re-arms the comparison baseline.
        if (r == R_GPINTENA || r == R_GPINTENB) g_dev.lastPins = g_dev.pins;
    }
    if (txbytes > 1) g_dev.writes++;

    if (rxbytes == 0) return MSG_OK;

    // Read phase, also sequential from the same starting register.
    g_dev.reads++;
    for (size_t i = 0; i < rxbytes; i++) {
        uint8_t r = (uint8_t)(reg + i);
        uint8_t v = 0;
        switch (r) {
            case R_GPIOA:
                v = (uint8_t)(g_dev.pins & 0xFF);
                break;
            case R_GPIOB:
                v = (uint8_t)(g_dev.pins >> 8);
                break;
            default:
                v = (r < R_COUNT) ? g_dev.reg[r] : 0;
                break;
        }
        rxbuf[i] = v;
    }

    // Reading GPIO (either port) or INTCAP clears the interrupt.
    bool touchedGpio = false;
    for (size_t i = 0; i < rxbytes; i++) {
        uint8_t r = (uint8_t)(reg + i);
        if (r == R_GPIOA || r == R_GPIOB || r == R_INTCAPA || r == R_INTCAPB)
            touchedGpio = true;
    }
    if (touchedGpio) {
        g_dev.gpioReads++;
        g_dev.intLatched = false;
        g_dev.reg[R_INTFA] = g_dev.reg[R_INTFB] = 0;
        g_dev.lastPins = g_dev.pins;
        RefreshIntLine();
    }

    return MSG_OK;
}

msg_t i2cMasterReceiveTimeout(I2CDriver *p, i2caddr_t addr,
                              uint8_t *rxbuf, size_t rxbytes,
                              sysinterval_t timeout) {
    uint8_t tx[1] = {0};
    return i2cMasterTransmitTimeout(p, addr, tx, 1, rxbuf, rxbytes, timeout);
}

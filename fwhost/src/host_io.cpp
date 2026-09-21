// Host backend for the hal.h shim: virtual clock, virtual GPIO, and no-op
// peripherals.  Nothing here reimplements firmware logic.
#include "hal.h"
#include "host.h"

#include <cstring>

// --- virtual clock ---------------------------------------------------------
static uint32_t g_ms = 0;
extern "C" uint32_t hostSysTimeMs(void) { return g_ms; }
void hostSetTimeMs(uint32_t ms) { g_ms = ms; }

// --- virtual GPIO ----------------------------------------------------------
// Plain arrays, not containers: the Profet constructors in hw_devices.cpp call
// palSetLine() during static initialisation, before any dynamic init runs.
#define HOST_PAL_LINES 4096
static uint8_t g_pal[HOST_PAL_LINES];
static uint8_t g_palMode[HOST_PAL_LINES];

uint32_t hostPalRead(ioline_t line) {
    return line < HOST_PAL_LINES ? g_pal[line] : 0u;
}
void hostPalWrite(ioline_t line, uint32_t v) {
    if (line < HOST_PAL_LINES) g_pal[line] = v ? 1u : 0u;
}
void hostPalMode(ioline_t line, uint32_t m) {
    if (line < HOST_PAL_LINES) g_palMode[line] = (uint8_t)m;
}
uint32_t hostPalGetMode(ioline_t line) {
    return line < HOST_PAL_LINES ? g_palMode[line] : 0u;
}

// --- peripheral objects the board files take addresses of ------------------
CANDriver CAND1{};
I2CDriver I2CD1{};

static stm32_tim_t g_tim[12];
PWMDriver PWMD1{0,0,0,nullptr,&g_tim[0]},  PWMD2{0,0,0,nullptr,&g_tim[1]};
PWMDriver PWMD3{0,0,0,nullptr,&g_tim[2]},  PWMD4{0,0,0,nullptr,&g_tim[3]};
PWMDriver PWMD5{0,0,0,nullptr,&g_tim[4]},  PWMD8{0,0,0,nullptr,&g_tim[5]};
PWMDriver PWMD9{0,0,0,nullptr,&g_tim[6]},  PWMD10{0,0,0,nullptr,&g_tim[7]};
PWMDriver PWMD11{0,0,0,nullptr,&g_tim[8]}, PWMD12{0,0,0,nullptr,&g_tim[9]};
PWMDriver PWMD13{0,0,0,nullptr,&g_tim[10]},PWMD14{0,0,0,nullptr,&g_tim[11]};

msg_t i2cStart(I2CDriver *, const I2CConfig *) { return HAL_RET_SUCCESS; }

msg_t pwmStart(PWMDriver *p, const PWMConfig *c) {
    p->state = PWM_READY; p->config = c; p->period = c->period;
    return HAL_RET_SUCCESS;
}
void pwmChangePeriod(PWMDriver *p, uint32_t period) { p->period = period; }
void pwmEnableChannel(PWMDriver *p, uint8_t ch, uint32_t width) {
    p->enabled |= (1u << ch);
    if (ch < PWM_CHANNELS) p->tim->CCR[ch] = width;
}
void pwmDisableChannel(PWMDriver *p, uint8_t ch) {
    p->enabled &= ~(1u << ch);
    if (ch < PWM_CHANNELS) p->tim->CCR[ch] = 0;
}
void pwmEnablePeriodicNotification(PWMDriver *) {}
void pwmDisablePeriodicNotification(PWMDriver *) {}
void pwmEnableChannelNotification(PWMDriver *, uint8_t) {}

thread_t *chThdCreateStatic(void *, size_t, int, tfunc_t, void *) {
    return nullptr;   // no threads on the host
}

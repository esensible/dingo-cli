/* HOST SHIM for ChibiOS hal.h.  Only what dingoFW's logic path touches. */
#pragma once

#include <cstdint>
#include <cstddef>

#ifndef TRUE
#define TRUE 1
#endif
#ifndef FALSE
#define FALSE 0
#endif

typedef int32_t msg_t;
#define MSG_OK ((msg_t)0)
#define HAL_RET_SUCCESS ((msg_t)0)

typedef uint32_t ioline_t;
typedef uint32_t systime_t;
typedef uint32_t sysinterval_t;
typedef uint8_t  i2caddr_t;
typedef uint32_t i2cflags_t;

#include "board.h"

/* --- PAL ---------------------------------------------------------------- */
#define PAL_MODE_INPUT           0u
#define PAL_MODE_INPUT_PULLUP    1u
#define PAL_MODE_INPUT_PULLDOWN  2u
#define PAL_MODE_OUTPUT_PUSHPULL 3u

/* The host backend lives in host_io.cpp. */
uint32_t hostPalRead(ioline_t line);
void     hostPalWrite(ioline_t line, uint32_t v);
void     hostPalMode(ioline_t line, uint32_t mode);

#define palReadLine(l)        (hostPalRead(l))
#define palWriteLine(l, v)    hostPalWrite((l), (uint32_t)(v))
#define palSetLine(l)         hostPalWrite((l), 1u)
#define palClearLine(l)       hostPalWrite((l), 0u)
#define palToggleLine(l)      hostPalWrite((l), !hostPalRead(l))
#define palSetLineMode(l, m)  hostPalMode((l), (m))

/* --- CAN ---------------------------------------------------------------- */
/* Layout copied verbatim from
   ChibiOS/os/hal/ports/STM32/LLD/CANv1/hal_can_lld.h so the SID/EID union
   aliasing that can_outputs.cpp relies on behaves identically. */
typedef struct {
  struct {
    uint8_t  DLC:4;
    uint8_t  RTR:1;
    uint8_t  IDE:1;
  };
  union {
    struct { uint32_t SID:11; };
    struct { uint32_t EID:29; };
  };
  union {
    uint8_t  data8[8];
    uint16_t data16[4];
    uint32_t data32[2];
    uint64_t data64[1];
  };
} CANTxFrame;

typedef struct {
  struct {
    uint8_t  FMI;
    uint16_t TIME;
  };
  struct {
    uint8_t  DLC:4;
    uint8_t  RTR:1;
    uint8_t  IDE:1;
  };
  union {
    struct { uint32_t SID:11; };
    struct { uint32_t EID:29; };
  };
  union {
    uint8_t  data8[8];
    uint16_t data16[4];
    uint32_t data32[2];
    uint64_t data64[1];
  };
} CANRxFrame;

#define CAN_IDE_STD 0
#define CAN_IDE_EXT 1
#define CAN_RTR_DATA 0
#define CAN_RTR_REMOTE 1
typedef struct { uint32_t mcr; uint32_t btr; } CANConfig;
typedef struct { uint32_t filter; uint32_t mode; uint32_t scale;
                 uint32_t assignment; uint32_t register1;
                 uint32_t register2; } CANFilter;
typedef struct { int state; } CANDriver;
extern CANDriver CAND1;

/* --- I2C ---------------------------------------------------------------- */
#define OPMODE_I2C         0
#define FAST_DUTY_CYCLE_2  1
typedef struct { uint32_t op_mode; uint32_t clock_speed;
                 uint32_t duty_cycle; } I2CConfig;
typedef struct { int state; } I2CDriver;
extern I2CDriver I2CD1;
msg_t i2cStart(I2CDriver *p, const I2CConfig *c);

/* --- PWM ---------------------------------------------------------------- */
#define PWM_READY 2
#define PWM_CHANNELS 4
typedef struct { volatile uint32_t CNT; volatile uint32_t ARR;
                 volatile uint32_t CCR[PWM_CHANNELS]; } stm32_tim_t;
#define PWM_OUTPUT_DISABLED    0
#define PWM_OUTPUT_ACTIVE_HIGH 1
#define PWM_OUTPUT_ACTIVE_LOW  2
struct hal_pwm_driver;
typedef struct hal_pwm_driver PWMDriver;
typedef void (*pwmcallback_t)(PWMDriver *);
typedef struct { uint32_t mode; pwmcallback_t callback; } PWMChannelConfig;
typedef struct hal_pwm_config {
  uint32_t         frequency;
  uint32_t         period;
  pwmcallback_t    callback;
  PWMChannelConfig channels[PWM_CHANNELS];
  uint32_t         cr2;
  uint32_t         bdtr;
  uint32_t         dier;
} PWMConfig;
struct hal_pwm_driver {
  int state;
  uint32_t enabled;
  uint32_t period;
  const PWMConfig *config;
  stm32_tim_t *tim;
};
extern PWMDriver PWMD1, PWMD2, PWMD3, PWMD4, PWMD5, PWMD8, PWMD9,
                 PWMD10, PWMD11, PWMD12, PWMD13, PWMD14;
#define PWM_PERCENTAGE_TO_WIDTH(p, v) ((uint32_t)(((uint64_t)(p)->period * (v)) / 10000))
msg_t pwmStart(PWMDriver *p, const PWMConfig *c);
void pwmChangePeriod(PWMDriver *p, uint32_t period);
void pwmEnableChannel(PWMDriver *p, uint8_t ch, uint32_t width);
void pwmDisableChannel(PWMDriver *p, uint8_t ch);
void pwmEnablePeriodicNotification(PWMDriver *p);
void pwmDisablePeriodicNotification(PWMDriver *p);
void pwmEnableChannelNotification(PWMDriver *p, uint8_t ch);

/* --- ADC ---------------------------------------------------------------- */
typedef uint16_t adcsample_t;

/* --- time ---------------------------------------------------------------
   In the real build chVTGetSystemTimeX() reaches hal.h via osal.h.          */
#ifdef __cplusplus
extern "C" {
#endif
uint32_t hostSysTimeMs(void);   /* virtual clock, advanced by the host runner */
#ifdef __cplusplus
}
#endif
#define chVTGetSystemTimeX() ((systime_t)hostSysTimeMs())
#define chVTGetSystemTime()  ((systime_t)hostSysTimeMs())
#define chThdSleepMilliseconds(x) ((void)(x))
#define chThdSleepMicroseconds(x) ((void)(x))

/* Thread creation: declared so TUs that spawn threads compile.  Nothing is
   ever started on the host -- the runner calls CyclicUpdate() directly. */
#define NORMALPRIO 128
#define THD_WORKING_AREA(name, sz) uint32_t name[((sz) + 3) / 4]
#define chRegSetThreadName(n) ((void)(n))
typedef struct { int dummy; } thread_t;
typedef void (*tfunc_t)(void *);
thread_t *chThdCreateStatic(void *wsp, size_t size, int prio,
                            tfunc_t pf, void *arg);

#define TIME_I2MS(t) ((uint32_t)(t))
#define TIME_MS2I(m) ((sysinterval_t)(m))
#define TIME_US2I(u) ((sysinterval_t)(u))
#define TIME_INFINITE ((sysinterval_t)-1)
#define TIME_IMMEDIATE ((sysinterval_t)0)

/* --- extras for the other board variants ---------------------------------
   GetAdcVolts() is used by functions/analog_input.cpp but is not declared in
   every board's port.h (a real firmware inconsistency); DMA types are used by
   functions/neopixels.h on pt-dpdm4_1. */
/* GetAdcVolts() is declared per board in the shim's analog boards; see
   host_stubs.cpp for the definition. */
typedef struct { int dummy; } stm32_dma_stream_t;
typedef void (*stm32_dmaisr_t)(void *, uint32_t);
#define STM32_TIM_DIER_UDE 0x0100u

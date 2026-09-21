/* HOST SHIM for ChibiOS ch.h  (the timing macros live in shim/hal.h). */
#pragma once

#include "hal.h"

#define NORMALPRIO 128
#define chSysLock()   ((void)0)
#define chSysUnlock() ((void)0)

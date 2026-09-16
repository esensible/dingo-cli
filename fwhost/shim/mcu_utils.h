/* HOST SHIM for boards/cortex-m4/mcu_utils.h (no MCU calibration registers). */
#pragma once

#define STM32_TEMP_3V3_30C  (0)
#define STM32_TEMP_3V3_110C (0)
#define STM32_VREF_INT_CAL  (0)

void EnterStopMode();
void RequestBootloader();
void CheckBootloaderRequest(void);

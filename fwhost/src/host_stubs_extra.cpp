// Board-variant extras: analogue voltage read and neopixels.  Neither is
// modelled; analogue reads return 0 like every other analogue path here.
#include "port.h"
#if NUM_ANALOG_INPUTS > 0
float GetAdcVolts(AnalogChannel) { return 0.0f; }
#endif
#if !HAS_EXT_TEMP_SENSOR && NUM_ANALOG_INPUTS > 0
uint16_t GetTemperature() { return 25; }
#elif HAS_EXT_TEMP_SENSOR
float GetTemperature() { return 25.0f; }
#endif
#if HAS_NEOPIXELS
#include "neopixels.h"
NeoPixels::NeoPixels(uint8_t n, PWMDriver *d, const PWMConfig *c, PwmChannel ch)
    : m_numPixels(n), m_pwmDriver(d), m_pwmCfg(c), m_pwmCh(ch) {}
void UpdateNeopixels() {}
#endif

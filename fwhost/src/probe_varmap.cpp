// Derive the var-map layout from the REAL InitVarMap() by locating known
// object addresses in pVarMap[].
#include "host.h"
#include "config.h"
#include "device.h"
#include "virtual_input.h"
#include "condition.h"
#include "counter.h"
#include "flasher.h"
#include <cstdio>

static int findIdx(const float *p) {
    for (int i = 0; i < (int)VAR_MAP_SIZE; i++) if (pVarMap[i] == p) return i;
    return -1;
}
int main() {
    InitVarMap();
    printf("VAR_MAP_SIZE      = %d\n", (int)VAR_MAP_SIZE);
    printf("NUM_OUTPUTS=%d NUM_DIG_INPUTS=%d NUM_DIG_OUTPUTS=%d NUM_ANALOG_INPUTS=%d\n",
           NUM_OUTPUTS, NUM_DIG_INPUTS, NUM_DIG_OUTPUTS, NUM_ANALOG_INPUTS);
    printf("NUM_CAN_INPUTS=%d NUM_VIRT_INPUTS=%d NUM_FLASHERS=%d NUM_CONDITIONS=%d NUM_COUNTERS=%d NUM_KEYPADS=%d\n",
           NUM_CAN_INPUTS, NUM_VIRT_INPUTS, NUM_FLASHERS, NUM_CONDITIONS, NUM_COUNTERS, NUM_KEYPADS);
#if NUM_DIG_INPUTS > 0
    printf("DigIn1            = %d\n", findIdx(&digIn[0].fVal));
#endif
    printf("CanIn1Out         = %d\n", findIdx(&canIn[0].fOutput));
    printf("VirtIn1           = %d\n", findIdx(&virtIn[0].fVal));
#if NUM_OUTPUTS > 0
    printf("Out1Active        = %d\n", findIdx(&pf[0].fOutput));
#endif
    printf("Flasher1          = %d\n", findIdx(&flasher[0].fVal));
    printf("Cond1             = %d\n", findIdx(&condition[0].fVal));
    printf("Counter1          = %d\n", findIdx(&counter[0].fVal));
    return 0;
}

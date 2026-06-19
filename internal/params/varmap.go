package params

import (
	"fmt"
	"strings"
)

// The var map is the firmware's ordered list of runtime variables (device.cpp
// InitVarMap). Input fields (output[n].input, condition[n].input, etc.) reference
// a variable by its index here. We expose stable names so configs read clearly;
// a raw index is also always accepted. Order/size mirror dingopdm_v7
// (VAR_MAP_SIZE = 217). Names are 1-based to match the UI.
var (
	varNames  []string          // index -> name
	varByName map[string]uint16 // lower(name) -> index
)

func init() { buildVarMap() }

// VarName returns the human name for a var-map index ("" if out of range).
func VarName(i uint16) string {
	if int(i) < len(varNames) {
		return varNames[i]
	}
	return ""
}

// VarIndex resolves a var-map name (case-insensitive) to its index.
func VarIndex(name string) (uint16, bool) {
	i, ok := varByName[strings.ToLower(strings.TrimSpace(name))]
	return i, ok
}

// VarMapSize is the number of var-map slots for this board.
func VarMapSize() int { return len(varNames) }

func vadd(name string) { varNames = append(varNames, name) }

func buildVarMap() {
	// System vars (VAR_MAP_SYS_VARS = 5; ext temp + batt sense present).
	vadd("AlwaysFalse")
	vadd("AlwaysTrue")
	vadd("State")
	vadd("BoardTemp")
	vadd("BattVolt")
	// Digital inputs (1 var each).
	for n := 1; n <= numDigInputs; n++ {
		vadd(fmt.Sprintf("DigIn%d", n))
	}
	// Digital outputs (1 var each) — firmware InitVarMap order: digOut before
	// analog and CAN inputs. Zero on dingopdm_v7, kept for board fidelity.
	for n := 1; n <= numDigOutputs; n++ {
		vadd(fmt.Sprintf("DigOut%d", n))
	}
	// Analog inputs (4 vars each: Value, milliVolts, RotaryPos, SwitchVal).
	for n := 1; n <= numAnalogInputs; n++ {
		vadd(fmt.Sprintf("Analog%dVal", n))
		vadd(fmt.Sprintf("Analog%dmV", n))
		vadd(fmt.Sprintf("Analog%dRotary", n))
		vadd(fmt.Sprintf("Analog%dSwitch", n))
	}
	// CAN inputs (2 vars each: scaled Output, raw Value).
	for n := 1; n <= numCanInputs; n++ {
		vadd(fmt.Sprintf("CanIn%dOut", n))
		vadd(fmt.Sprintf("CanIn%dVal", n))
	}
	// Virtual inputs (1 var each).
	for n := 1; n <= numVirtInputs; n++ {
		vadd(fmt.Sprintf("VirtIn%d", n))
	}
	// Outputs (4 vars each: Active, Current, Overcurrent, Fault).
	for n := 1; n <= numOutputs; n++ {
		vadd(fmt.Sprintf("Out%dActive", n))
		vadd(fmt.Sprintf("Out%dCurrent", n))
		vadd(fmt.Sprintf("Out%dOvercurrent", n))
		vadd(fmt.Sprintf("Out%dFault", n))
	}
	// Flashers (1 var each).
	for n := 1; n <= numFlashers; n++ {
		vadd(fmt.Sprintf("Flasher%d", n))
	}
	// Conditions (1 var each).
	for n := 1; n <= numConditions; n++ {
		vadd(fmt.Sprintf("Cond%d", n))
	}
	// Counters (1 var each).
	for n := 1; n <= numCounters; n++ {
		vadd(fmt.Sprintf("Counter%d", n))
	}
	// Wiper outputs (VAR_MAP_WIPER_VARS = 6).
	vadd("WiperSlowOut")
	vadd("WiperFastOut")
	vadd("WiperParkOut")
	vadd("WiperInterOut")
	vadd("WiperWashOut")
	vadd("WiperSwipeOut")
	// Keypads (each: 20 buttons, 2 dials, 4 analog).
	for k := 1; k <= numKeypads; k++ {
		for b := 1; b <= keypadButtons; b++ {
			vadd(fmt.Sprintf("Keypad%dButton%d", k, b))
		}
		for d := 1; d <= keypadDials; d++ {
			vadd(fmt.Sprintf("Keypad%dDial%d", k, d))
		}
		for a := 1; a <= keypadAnalogs; a++ {
			vadd(fmt.Sprintf("Keypad%dAnalog%d", k, a))
		}
	}

	varByName = make(map[string]uint16, len(varNames))
	for i, n := range varNames {
		varByName[strings.ToLower(n)] = uint16(i)
	}
}

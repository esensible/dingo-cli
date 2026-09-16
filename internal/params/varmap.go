package params

import (
	"fmt"
	"strings"
)

// The var map is the firmware's ordered list of runtime variables (device.cpp
// InitVarMap). Input fields (output[n].input, condition[n].input, etc.) reference
// a variable by its index here. We expose stable names so configs read clearly;
// a raw index is also always accepted.
//
// The order below is InitVarMap's order exactly — system vars, digital inputs,
// digital OUTPUTS, analog inputs, CAN inputs, virtual inputs, outputs, flashers,
// conditions, counters, wiper, keypads — not the order the VAR_MAP_SIZE macro
// happens to sum its terms in (those disagree between boards and the macro is
// only a sum, so only InitVarMap is authoritative).
//
// Names are 1-based to match the UI.

// VarName returns the human name for a var-map index ("" if out of range).
func (r *Registry) VarName(i uint16) string {
	if int(i) < len(r.varNames) {
		return r.varNames[i]
	}
	return ""
}

// VarIndex resolves a var-map name (case-insensitive) to its index.
func (r *Registry) VarIndex(name string) (uint16, bool) {
	i, ok := r.varByName[strings.ToLower(strings.TrimSpace(name))]
	return i, ok
}

// VarMapSize is the number of var-map slots for this board.
func (r *Registry) VarMapSize() int { return len(r.varNames) }

// VarNames returns every var-map name in index order.
func (r *Registry) VarNames() []string { return r.varNames }

// VarName resolves against the default board.
func VarName(i uint16) string { return defaultReg.VarName(i) }

// VarIndex resolves against the default board.
func VarIndex(name string) (uint16, bool) { return defaultReg.VarIndex(name) }

// VarMapSize reports the default board's var-map size.
func VarMapSize() int { return defaultReg.VarMapSize() }

func (r *Registry) vadd(name string) { r.varNames = append(r.varNames, name) }

func (r *Registry) buildVarMap() {
	bd := r.board

	// System vars. AlwaysFalse/AlwaysTrue/State are unconditional; BoardTemp
	// and BattVolt exist only where HAS_EXT_TEMP_SENSOR / HAS_BATT_VOLT_SENSE,
	// which is what SysVars (3 or 5) encodes.
	r.vadd("AlwaysFalse")
	r.vadd("AlwaysTrue")
	r.vadd("State")
	if bd.SysVars >= 4 {
		r.vadd("BoardTemp")
	}
	if bd.SysVars >= 5 {
		r.vadd("BattVolt")
	}
	// Digital inputs (1 var each).
	for n := 1; n <= bd.DigInputs; n++ {
		r.vadd(fmt.Sprintf("DigIn%d", n))
	}
	// Digital outputs (1 var each) — firmware InitVarMap order: digOut before
	// analog and CAN inputs.
	for n := 1; n <= bd.DigOutputs; n++ {
		r.vadd(fmt.Sprintf("DigOut%d", n))
	}
	// Analog inputs (4 vars each: Value, milliVolts, RotaryPos, SwitchVal).
	for n := 1; n <= bd.AnalogInputs; n++ {
		r.vadd(fmt.Sprintf("Analog%dVal", n))
		r.vadd(fmt.Sprintf("Analog%dmV", n))
		r.vadd(fmt.Sprintf("Analog%dRotary", n))
		r.vadd(fmt.Sprintf("Analog%dSwitch", n))
	}
	// CAN inputs (2 vars each: the boolean Output of the operator comparison,
	// then the decoded numeric Value).
	for n := 1; n <= bd.CanInputs; n++ {
		r.vadd(fmt.Sprintf("CanIn%dOut", n))
		r.vadd(fmt.Sprintf("CanIn%dVal", n))
	}
	// Virtual inputs (1 var each).
	for n := 1; n <= bd.VirtInputs; n++ {
		r.vadd(fmt.Sprintf("VirtIn%d", n))
	}
	// Outputs (4 vars each: Active, Current, Overcurrent, Fault).
	for n := 1; n <= bd.Outputs; n++ {
		r.vadd(fmt.Sprintf("Out%dActive", n))
		r.vadd(fmt.Sprintf("Out%dCurrent", n))
		r.vadd(fmt.Sprintf("Out%dOvercurrent", n))
		r.vadd(fmt.Sprintf("Out%dFault", n))
	}
	// Flashers (1 var each).
	for n := 1; n <= bd.Flashers; n++ {
		r.vadd(fmt.Sprintf("Flasher%d", n))
	}
	// Conditions (1 var each).
	for n := 1; n <= bd.Conditions; n++ {
		r.vadd(fmt.Sprintf("Cond%d", n))
	}
	// Counters (1 var each).
	for n := 1; n <= bd.Counters; n++ {
		r.vadd(fmt.Sprintf("Counter%d", n))
	}
	// Wiper outputs (VAR_MAP_WIPER_VARS = 6).
	if bd.HasWipers {
		r.vadd("WiperSlowOut")
		r.vadd("WiperFastOut")
		r.vadd("WiperParkOut")
		r.vadd("WiperInterOut")
		r.vadd("WiperWashOut")
		r.vadd("WiperSwipeOut")
	}
	// Keypads (each: buttons, dials, analog).
	for k := 1; k <= bd.Keypads; k++ {
		for b := 1; b <= bd.KeypadButtons; b++ {
			r.vadd(fmt.Sprintf("Keypad%dButton%d", k, b))
		}
		for d := 1; d <= bd.KeypadDials; d++ {
			r.vadd(fmt.Sprintf("Keypad%dDial%d", k, d))
		}
		for a := 1; a <= bd.KeypadAnalogs; a++ {
			r.vadd(fmt.Sprintf("Keypad%dAnalog%d", k, a))
		}
	}

	r.varByName = make(map[string]uint16, len(r.varNames))
	for i, n := range r.varNames {
		r.varByName[strings.ToLower(n)] = uint16(i)
	}
}

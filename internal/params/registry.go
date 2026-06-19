// Package params is the name-based, type-aware parameter registry for the
// dingoPDM (board dingopdm_v7). It mirrors the firmware's compile-time parameter
// table (DingoPDM_FW/core/param_defs.h + boards/dingopdm_v7/params.h), so every
// configurable field the UI exposes is addressable by a stable name and encoded
// with the correct wire type and firmware range.
//
// Naming: <block>[<instance>].<field>. Every [n] is 1-based, matching the UI and
// silkscreen (e.g. output[4] is the 4th output, protocol index 0x1003).
// Singletons (device, starter, wiper) have no [instance].
//
// NOTE: this table is hand-transcribed from the firmware and must be kept in sync
// with it. The min/max/default columns come from param_defs.h. The eventual fix
// for this duplication is to generate the table from a firmware-emitted manifest;
// until then, registry_test.go pins counts/indices to firmware facts.
package params

import "fmt"

// Type is the wire/encoding type of a parameter (firmware ParamType).
type Type int

const (
	TBool   Type = iota // 0/1
	TU8                 // uint8
	TU16                // uint16
	TU32                // uint32
	TI8                 // int8 (two's-complement, sign-extended on the wire)
	TFloat              // IEEE-754 single, sent as its 32-bit pattern
	TEnum               // uint8 enumerator; Enum names the enum
	TVarMap             // var-map reference (uint16 index, or a var name)
)

func (t Type) String() string {
	switch t {
	case TBool:
		return "bool"
	case TU8:
		return "uint8"
	case TU16:
		return "uint16"
	case TU32:
		return "uint32"
	case TI8:
		return "int8"
	case TFloat:
		return "float"
	case TEnum:
		return "enum"
	case TVarMap:
		return "varmap"
	default:
		return "?"
	}
}

// Def describes one configurable parameter. Min/Max/Default are the firmware's
// values in natural units (floats for TFloat, the numeric value otherwise);
// TVarMap fields are range-checked against the live var-map size instead.
type Def struct {
	Name    string
	Index   uint16
	Sub     uint8
	Type    Type
	Enum    string // enum type name when Type==TEnum
	Default float64
	Min     float64
	Max     float64
}

// Board instance counts for dingopdm_v7 (boards/dingopdm_v7/port.h). These are
// the single source for counts inside the CLI; varmap.go consumes them too.
const (
	numOutputs      = 8
	numDigInputs    = 2
	numDigOutputs   = 0 // NUM_DIG_OUTPUTS
	numAnalogInputs = 0 // NUM_ANALOG_INPUTS
	numCanInputs    = 32
	numCanOutputs   = 32
	numVirtInputs   = 16
	numConditions   = 32
	numCounters     = 4
	numFlashers     = 4
	numKeypads      = 2
	keypadButtons   = 20 // KEYPAD_MAX_BUTTONS
	keypadDials     = 2  // KEYPAD_MAX_DIALS
	keypadAnalogs   = 4  // KEYPAD_MAX_ANALOG_INPUTS
)

// firmware float range sentinel: F(-1e9f)..F(1e9f) used by factor/offset/operand/arg.
const (
	fLo = -1e9
	fHi = 1e9
)

var (
	defs   []Def
	byName = map[string]*Def{}
	byKey  = map[uint32]*Def{} // index<<8 | sub
)

// field is one sub-index within an instance block.
type field struct {
	sub  uint8
	name string
	typ  Type
	enum string
	def  float64
	min  float64
	max  float64
}

// Field constructors keep the block tables readable.
func b(sub uint8, name string, def float64) field {
	return field{sub, name, TBool, "", def, 0, 1}
}
func vm(sub uint8, name string) field { // var-map ref; range-checked vs var-map size
	return field{sub, name, TVarMap, "", 0, 0, 0}
}
func u(sub uint8, name string, typ Type, def, min, max float64) field {
	return field{sub, name, typ, "", def, min, max}
}
func fl(sub uint8, name string, def, min, max float64) field {
	return field{sub, name, TFloat, "", def, min, max}
}
func en(sub uint8, name, enum string, def, min, max float64) field {
	return field{sub, name, TEnum, enum, def, min, max}
}
func i8(sub uint8, name string, def, min, max float64) field {
	return field{sub, name, TI8, "", def, min, max}
}

func init() {
	buildRegistry()
	for i := range defs {
		d := &defs[i]
		byName[d.Name] = d
		byKey[uint32(d.Index)<<8|uint32(d.Sub)] = d
	}
}

// Lookup resolves a parameter by name.
func Lookup(name string) (*Def, bool) { d, ok := byName[name]; return d, ok }

// LookupKey resolves a parameter by index+subindex (for naming a dump).
func LookupKey(index uint16, sub uint8) (*Def, bool) {
	d, ok := byKey[uint32(index)<<8|uint32(sub)]
	return d, ok
}

// All returns every parameter definition (registration order).
func All() []Def { return defs }

func add(name string, index uint16, f field) {
	defs = append(defs, Def{
		Name: name, Index: index, Sub: f.sub, Type: f.typ, Enum: f.enum,
		Default: f.def, Min: f.min, Max: f.max,
	})
}

// addBlock appends an instanced block: prefix[n].field, n 1-based, for the
// firmware instances 0..count-1 (index base+0 .. base+count-1).
func addBlock(prefix string, base uint16, count int, fields []field) {
	for i := 0; i < count; i++ {
		inst := fmt.Sprintf("%s[%d]", prefix, i+1)
		for _, f := range fields {
			add(inst+"."+f.name, base+uint16(i), f)
		}
	}
}

// addSingle appends a singleton block: prefix.field (no instance).
func addSingle(prefix string, base uint16, fields []field) {
	for _, f := range fields {
		add(prefix+"."+f.name, base, f)
	}
}

func buildRegistry() {
	// Device config (0x0000)
	addSingle("device", 0x0000, []field{
		u(0, "baseId", TU16, 222, 0, 0x7FF),
		en(1, "canSpeed", "CanBitrate", 1, 0, 4),
		b(2, "sleepEnabled", 0),
		b(3, "canFilterEnabled", 0),
		b(4, "connectUsbToCan", 1),
	})

	// Outputs (0x1000+)
	addBlock("output", 0x1000, numOutputs, []field{
		b(0, "enabled", 0),
		vm(1, "input"),
		fl(2, "currentLimit", 20, 0, 100),
		fl(3, "inrushLimit", 50, 0, 100),
		u(4, "inrushTime", TU16, 1000, 0, 10000),
		en(5, "resetMode", "ProfetResetMode", 0, 0, 2),
		u(6, "resetTime", TU16, 1000, 0, 60000),
		u(7, "resetLimit", TU8, 3, 0, 20),
		b(8, "pwm.enabled", 0),
		b(9, "pwm.softStart", 0),
		b(10, "pwm.variableDutyCycle", 0),
		vm(11, "pwm.dutyCycleInput"),
		u(12, "pwm.fixedDutyCycle", TU8, 100, 0, 100),
		u(13, "pwm.freq", TU16, 100, 0, 400),
		u(14, "pwm.softStartRampTime", TU16, 0, 0, 10000),
		u(15, "pwm.dutyCycleInputDenom", TU16, 100, 1, 5000),
		u(16, "pwm.minDutyCycle", TU16, 0, 0, 100),
		// nPrimaryOutput is a 0-based OUTPUT index (-1 = unpaired). Unlike the
		// 1-based block names, this is a raw index; firmware accepts up to
		// VAR_MAP_SIZE-1 but ignores anything >= numOutputs, so we validate the
		// effective range -1..numOutputs-1.
		i8(17, "primaryOutput", -1, -1, numOutputs-1),
	})

	// Digital inputs (0x1200+)
	addBlock("digInput", 0x1200, numDigInputs, []field{
		b(0, "enabled", 0),
		en(1, "mode", "InputMode", 0, 0, 1),
		b(2, "invert", 0),
		u(3, "debounceTime", TU16, 20, 0, 1000),
		en(4, "pull", "InputPull", 0, 0, 2),
	})

	// CAN inputs (0x1300+)
	addBlock("canInput", 0x1300, numCanInputs, []field{
		b(0, "enabled", 0),
		b(1, "timeoutEnabled", 0),
		u(2, "timeout", TU16, 1000, 0, 60000),
		u(3, "ide", TU8, 0, 0, 1),
		u(4, "id", TU32, 0, 0, 536870911),
		u(5, "startBit", TU8, 0, 0, 63),
		u(6, "bitLength", TU8, 8, 1, 32),
		fl(7, "factor", 1, fLo, fHi),
		fl(8, "offset", 0, fLo, fHi),
		en(9, "byteOrder", "ByteOrder", 0, 0, 1),
		b(10, "signed", 0),
		en(11, "operator", "Operator", 0, 0, 7),
		fl(12, "operand", 0, fLo, fHi),
		en(13, "mode", "InputMode", 0, 0, 1),
	})

	// Virtual inputs (0x1400+)
	addBlock("virtualInput", 0x1400, numVirtInputs, []field{
		b(0, "enabled", 0),
		b(1, "not0", 0),
		vm(2, "var0"),
		en(3, "cond0", "BoolOperator", 0, 0, 2),
		b(4, "not1", 0),
		vm(5, "var1"),
		en(6, "cond1", "BoolOperator", 0, 0, 2),
		b(7, "not2", 0),
		vm(8, "var2"),
		en(9, "mode", "InputMode", 0, 0, 1),
	})

	// Conditions (0x1500+)
	addBlock("condition", 0x1500, numConditions, []field{
		b(0, "enabled", 0),
		vm(1, "input"),
		en(2, "operator", "Operator", 0, 0, 7),
		fl(3, "arg", 0, fLo, fHi),
	})

	// Counters (0x1600+)
	addBlock("counter", 0x1600, numCounters, []field{
		b(0, "enabled", 0),
		vm(1, "incInput"),
		vm(2, "decInput"),
		vm(3, "resetInput"),
		u(4, "minCount", TU8, 0, 0, 255),
		u(5, "maxCount", TU8, 10, 0, 255),
		en(6, "incEdge", "InputEdge", 0, 0, 2),
		en(7, "decEdge", "InputEdge", 0, 0, 2),
		en(8, "resetEdge", "InputEdge", 0, 0, 2),
		b(9, "wrapAround", 0),
		b(10, "holdToReset", 0),
		u(11, "resetTime", TU16, 2000, 0, 10000),
	})

	// Flashers (0x1700+)
	addBlock("flasher", 0x1700, numFlashers, []field{
		b(0, "enabled", 0),
		vm(1, "input"),
		u(2, "flashOnTime", TU16, 500, 0, 5000),
		u(3, "flashOffTime", TU16, 500, 0, 5000),
		b(4, "singleCycle", 0),
	})

	// Starter (0x1800, single) + disable-output array (sub 2..2+numOutputs-1)
	starterFields := []field{
		b(0, "enabled", 0),
		vm(1, "input"),
	}
	for i := 0; i < numOutputs; i++ {
		starterFields = append(starterFields, b(uint8(2+i), fmt.Sprintf("disableOut[%d]", i+1), 0))
	}
	addSingle("starter", 0x1800, starterFields)

	// Wiper (0x1900, single): base fields + speedMap[0..7] + intermitTime[0..5]
	wiperFields := []field{
		b(0, "enabled", 0),
		en(1, "mode", "WiperMode", 0, 0, 2),
		vm(2, "slowInput"),
		vm(3, "fastInput"),
		vm(4, "interInput"),
		vm(5, "onInput"),
		vm(6, "speedInput"),
		vm(7, "parkInput"),
		b(8, "parkStopLevel", 0),
		vm(9, "swipeInput"),
		vm(10, "washInput"),
		u(11, "washWipeCycles", TU8, 3, 0, 10),
	}
	// eSpeedMap defaults: Intermittent1..6 then Slow, Fast (enums.h WiperSpeed).
	speedDefaults := []float64{3, 4, 5, 6, 7, 8, 1, 2}
	for i := 0; i < 8; i++ {
		wiperFields = append(wiperFields, en(uint8(12+i), fmt.Sprintf("speedMap[%d]", i+1), "WiperSpeed", speedDefaults[i], 0, 8))
	}
	// nIntermitTime defaults: 1000..6000 ms.
	for i := 0; i < 6; i++ {
		wiperFields = append(wiperFields, u(uint8(20+i), fmt.Sprintf("intermitTime[%d]", i+1), TU16, float64((i+1)*1000), 0, 30000))
	}
	addSingle("wiper", 0x1900, wiperFields)

	// CAN outputs (0x2000+)
	addBlock("canOutput", 0x2000, numCanOutputs, []field{
		b(0, "enabled", 0),
		vm(1, "input"),
		u(2, "ide", TU8, 0, 0, 1),
		u(3, "id", TU32, 0, 0, 536870911),
		u(4, "startBit", TU8, 0, 0, 63),
		u(5, "bitLength", TU8, 8, 1, 32),
		fl(6, "factor", 1, fLo, fHi),
		fl(7, "offset", 0, fLo, fHi),
		en(8, "byteOrder", "ByteOrder", 0, 0, 1),
		b(9, "signed", 0),
		u(10, "interval", TU16, 1000, 0, 60000),
	})

	// Keypads base (0x3000+)
	addBlock("keypad", 0x3000, numKeypads, []field{
		b(0, "enabled", 0),
		u(1, "nodeId", TU8, 0, 0, 127),
		b(2, "timeoutEnabled", 0),
		u(3, "timeout", TU16, 0, 0, 60000),
		// firmware param range is 0..13 (it rejects higher even though the
		// KeypadModel enum defines Grayhill values up to 24 — a firmware limit).
		en(4, "model", "KeypadModel", 6, 0, 13),
		u(5, "backlightBrightness", TU8, 63, 0, 63),
		u(6, "dimBacklightBrightness", TU8, 32, 0, 63),
		u(7, "backlightColor", TU8, 0, 0, 9),
		vm(8, "dimmingVar"),
		u(9, "buttonBrightness", TU8, 63, 0, 63),
		u(10, "dimButtonBrightness", TU8, 32, 0, 63),
	})

	// Keypad buttons (0x3100 + k*32 + b) and dials (0x3200 + k*4 + d)
	for k := 0; k < numKeypads; k++ {
		for bi := 0; bi < keypadButtons; bi++ {
			base := uint16(0x3100 + k*32 + bi)
			pre := fmt.Sprintf("keypad[%d].button[%d]", k+1, bi+1)
			add(pre+".enabled", base, b(0, "enabled", 0))
			add(pre+".mode", base, en(1, "mode", "InputMode", 0, 0, 1))
			for c := 0; c < 4; c++ {
				add(fmt.Sprintf("%s.colors[%d]", pre, c+1), base, u(uint8(2+c), "", TU8, 0, 0, 7))
			}
			add(pre+".faultColor", base, u(6, "", TU8, 0, 0, 7))
			for v := 0; v < 4; v++ {
				add(fmt.Sprintf("%s.vars[%d]", pre, v+1), base, vm(uint8(7+v), ""))
			}
			add(pre+".faultVar", base, vm(11, ""))
			for v := 0; v < 4; v++ {
				add(fmt.Sprintf("%s.blink[%d]", pre, v+1), base, b(uint8(12+v), "", 0))
			}
			add(pre+".faultBlink", base, b(16, "", 0))
			for c := 0; c < 4; c++ {
				add(fmt.Sprintf("%s.blinkColors[%d]", pre, c+1), base, u(uint8(17+c), "", TU8, 0, 0, 7))
			}
			add(pre+".faultBlinkColor", base, u(21, "", TU8, 0, 0, 7))
		}
		for d := 0; d < keypadDials; d++ {
			base := uint16(0x3200 + k*4 + d)
			pre := fmt.Sprintf("keypad[%d].dial[%d]", k+1, d+1)
			add(pre+".enabled", base, b(0, "enabled", 0))
			add(pre+".minCount", base, u(1, "minCount", TU8, 0, 0, 16))
			add(pre+".maxCount", base, u(2, "maxCount", TU8, 16, 0, 16))
			add(pre+".ledOffset", base, u(3, "ledOffset", TU8, 0, 0, 16))
		}
	}
}

package params

import (
	"math"
	"testing"
)

// TestParamCount pins the registry to the firmware's NUM_PARAMS for dingopdm_v7,
// computed from the registration list (param_registry.cpp + params.h):
// device 5 + outputs 8*18 + digIn 2*5 + canIn 32*14 + virtIn 16*10 +
// cond 32*4 + counter 4*12 + flasher 4*5 + starter (2+8) + wiper (12+8+6) +
// canOut 32*11 + keypad base 2*11 + keypad btn 2*20*22 + keypad dial 2*2*4.
func TestParamCount(t *testing.T) {
	want := 5 + 8*18 + 2*5 + 32*14 + 16*10 + 32*4 + 4*12 + 4*5 + (2 + 8) +
		(12 + 8 + 6) + 32*11 + 2*11 + 2*20*22 + 2*2*4
	if want != 2269 {
		t.Fatalf("test arithmetic wrong: %d", want)
	}
	if got := len(All()); got != want {
		t.Fatalf("registry has %d params, want %d", got, want)
	}
}

func TestSpotChecks(t *testing.T) {
	cases := []struct {
		name  string
		index uint16
		sub   uint8
		typ   Type
	}{
		{"device.baseId", 0x0000, 0, TU16},
		{"device.canSpeed", 0x0000, 1, TEnum},
		{"output[1].currentLimit", 0x1000, 2, TFloat},
		{"output[4].enabled", 0x1003, 0, TBool},
		{"output[4].input", 0x1003, 1, TVarMap},
		{"output[8].primaryOutput", 0x1007, 17, TI8},
		{"digInput[2].pull", 0x1201, 4, TEnum},
		{"canInput[32].id", 0x131F, 4, TU32},
		{"virtualInput[1].cond0", 0x1400, 3, TEnum},
		{"condition[32].arg", 0x151F, 3, TFloat},
		{"counter[4].resetTime", 0x1603, 11, TU16},
		{"flasher[4].singleCycle", 0x1703, 4, TBool},
		{"starter.disableOut[8]", 0x1800, 9, TBool},
		{"wiper.speedMap[1]", 0x1900, 12, TEnum},
		{"wiper.intermitTime[6]", 0x1900, 25, TU16},
		{"canOutput[1].id", 0x2000, 3, TU32},
		{"canOutput[32].interval", 0x201F, 10, TU16},
		{"keypad[2].model", 0x3001, 4, TEnum},
		{"keypad[1].button[1].enabled", 0x3100, 0, TBool},
		{"keypad[2].button[20].faultBlinkColor", 0x3100 + 32 + 19, 21, TU8},
		{"keypad[2].dial[2].ledOffset", 0x3205, 3, TU8},
	}
	for _, c := range cases {
		d, ok := Lookup(c.name)
		if !ok {
			t.Errorf("%s: not found", c.name)
			continue
		}
		if d.Index != c.index || d.Sub != c.sub || d.Type != c.typ {
			t.Errorf("%s: got index=0x%04X sub=%d type=%s, want index=0x%04X sub=%d type=%s",
				c.name, d.Index, d.Sub, d.Type, c.index, c.sub, c.typ)
		}
	}
}

func TestVarMap(t *testing.T) {
	if VarMapSize() != 217 {
		t.Fatalf("var map size %d, want 217", VarMapSize())
	}
	checks := map[string]uint16{
		"AlwaysFalse": 0,
		"AlwaysTrue":  1,
		"State":       2,
		"BoardTemp":   3,
		"BattVolt":    4,
		"DigIn1":      5,
		"DigIn2":      6,
		"CanIn1Out":   7,
		"CanIn1Val":   8,
		"VirtIn1":     71,
		"Out1Active":  87,
		"Out4Active":  99, // 87 + 4*3
		"Out8Fault":   118,
		"Flasher1":    119,
		"Cond1":       123,
		"Counter1":    155,
		"WiperSwipeOut": 164,
		"Keypad1Button1": 165,
		"Keypad2Analog4": 216,
	}
	for name, idx := range checks {
		if got, ok := VarIndex(name); !ok || got != idx {
			t.Errorf("VarIndex(%q) = %d,%v; want %d", name, got, ok, idx)
		}
		if got := VarName(idx); got != name {
			t.Errorf("VarName(%d) = %q; want %q", idx, got, name)
		}
	}
}

func TestEncode(t *testing.T) {
	enc := func(name string, v interface{}) uint32 {
		d, ok := Lookup(name)
		if !ok {
			t.Fatalf("%s not found", name)
		}
		val, err := Encode(d, v)
		if err != nil {
			t.Fatalf("encode %s: %v", name, err)
		}
		return val
	}
	if got := enc("output[1].currentLimit", 20.0); got != math.Float32bits(20.0) {
		t.Errorf("float encode = 0x%X, want 0x%X", got, math.Float32bits(20.0))
	}
	if got := enc("device.canSpeed", "500K"); got != 1 {
		t.Errorf("enum 500K = %d, want 1", got)
	}
	if got := enc("output[4].input", "AlwaysTrue"); got != 1 {
		t.Errorf("varmap AlwaysTrue = %d, want 1", got)
	}
	if got := enc("output[4].enabled", true); got != 1 {
		t.Errorf("bool true = %d, want 1", got)
	}
	if got := enc("output[8].primaryOutput", -1.0); got != 0xFFFFFFFF {
		t.Errorf("int8 -1 = 0x%X, want 0xFFFFFFFF", got)
	}
	if got := enc("canInput[1].id", 536870911.0); got != 536870911 {
		t.Errorf("uint32 id = %d, want 536870911", got)
	}
}

func TestRangeValidationRejects(t *testing.T) {
	bad := []struct {
		name string
		v    interface{}
	}{
		{"canInput[1].bitLength", 0.0},          // firmware min 1
		{"output[1].resetLimit", 50.0},          // max 20 (type would allow 255)
		{"output[1].pwm.freq", 500.0},           // max 400
		{"output[1].pwm.minDutyCycle", 200.0},   // max 100
		{"canOutput[1].id", 600000000.0},        // max 536870911 (29-bit)
		{"keypad[1].model", "Grayhill20Key"},    // enum exists but firmware max 13
		{"virtualInput[1].cond0", 3.0},          // enum-by-int, max 2
		{"output[8].primaryOutput", 9.0},        // max numOutputs-1 = 7
		{"output[1].currentLimit", 150.0},       // float max 100.0
	}
	for _, c := range bad {
		d, ok := Lookup(c.name)
		if !ok {
			t.Fatalf("%s not found", c.name)
		}
		if _, err := Encode(d, c.v); err == nil {
			t.Errorf("%s = %v: expected range error, got nil", c.name, c.v)
		}
	}

	good := []struct {
		name string
		v    interface{}
	}{
		{"canInput[1].bitLength", 1.0},
		{"output[1].resetLimit", 20.0},
		{"keypad[1].model", "Blink12Key"},
		{"output[8].primaryOutput", 7.0},
		{"output[8].primaryOutput", -1.0},
		{"output[1].currentLimit", 100.0},
	}
	for _, c := range good {
		d, _ := Lookup(c.name)
		if _, err := Encode(d, c.v); err != nil {
			t.Errorf("%s = %v: unexpected error: %v", c.name, c.v, err)
		}
	}
}

func TestEnumDecodeDeterministic(t *testing.T) {
	d, ok := Lookup("canInput[1].byteOrder")
	if !ok {
		t.Fatal("byteOrder not found")
	}
	if got := Decode(d, 0); got != "LittleEndian" {
		t.Errorf("decode 0 = %v, want canonical LittleEndian", got)
	}
	if got := Decode(d, 1); got != "BigEndian" {
		t.Errorf("decode 1 = %v, want canonical BigEndian", got)
	}
	if v, ok := EnumValue("ByteOrder", "Intel"); !ok || v != 0 {
		t.Errorf("alias Intel = %d,%v; want 0,true", v, ok)
	}
}

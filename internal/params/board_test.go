package params

import "testing"

// TestBoardVarMaps pins the var-map layout of every board to the firmware's
// InitVarMap emission order.
//
// These indices are the reason device({board: ...}) is mandatory. A config
// compiled for the wrong variant passes every range check and still wires the
// wrong signals together — and the failure modes are not symmetric: v7 and Max
// AGREE on VirtIn1 and diverge only at Cond1, so a v7 config written to a Max
// points every condition and counter reference into the output block, and every
// symptom looks like a logic bug rather than a portability bug.
func TestBoardVarMaps(t *testing.T) {
	cases := []struct {
		board string
		size  int
		spots map[string]uint16
	}{
		{"dingoPDM", 217, map[string]uint16{
			"AlwaysFalse": 0, "AlwaysTrue": 1, "State": 2, "BoardTemp": 3, "BattVolt": 4,
			"DigIn1": 5, "CanIn1Out": 7, "VirtIn1": 71, "Out1Active": 87,
			"Flasher1": 119, "Cond1": 123, "Counter1": 155, "WiperSlowOut": 159,
			"Keypad1Button1": 165,
		}},
		{"dingoPDM-Max", 201, map[string]uint16{
			"VirtIn1": 71, "Out1Active": 87, "Flasher1": 103,
			"Cond1": 107, "Counter1": 139,
		}},
		{"PT-DPDM", 209, map[string]uint16{
			// pt-dpdm4_1 has 2 analogue inputs (4 vars each) ahead of the CAN
			// inputs, which is what moves VirtIn1 from 71 to 79.
			"Analog1Val": 7, "CanIn1Out": 15, "VirtIn1": 79, "Out1Active": 95,
			"Cond1": 115, "Counter1": 147,
		}},
		{"CANBoard", 75, map[string]uint16{
			// Three system vars, not five: canboard_v2 has neither the external
			// temperature sensor nor battery-voltage sense.
			"AlwaysFalse": 0, "AlwaysTrue": 1, "State": 2,
			"DigIn1": 3, "DigOut1": 11, "Analog1Val": 15, "CanIn1Out": 35,
			"VirtIn1": 51, "Flasher1": 59, "Cond1": 63, "Counter1": 71,
		}},
	}
	for _, c := range cases {
		b, ok := LookupBoard(c.board)
		if !ok {
			t.Fatalf("board %q not found", c.board)
		}
		r := NewRegistry(b)
		if got := r.VarMapSize(); got != c.size {
			t.Errorf("%s: var map size %d, want %d", c.board, got, c.size)
		}
		for name, idx := range c.spots {
			got, found := r.VarIndex(name)
			if !found {
				t.Errorf("%s: %s missing from var map", c.board, name)
				continue
			}
			if got != idx {
				t.Errorf("%s: %s = %d, want %d", c.board, name, got, idx)
			}
		}
	}
}

// TestBoardsDropAbsentBlocks checks that a board's parameter table omits the
// blocks its port.h compiles out.
func TestBoardsDropAbsentBlocks(t *testing.T) {
	cb, _ := LookupBoard("CANBoard")
	r := NewRegistry(cb)
	for _, absent := range []string{
		"output[1].enabled", "starter.enabled", "wiper.enabled", "keypad[1].enabled",
		"digInput[9].enabled", "virtualInput[9].enabled", "condition[9].enabled",
	} {
		if _, ok := r.Lookup(absent); ok {
			t.Errorf("CANBoard registry should not have %s", absent)
		}
	}
	for _, present := range []string{
		"digInput[8].enabled", "digOutput[4].input", "analogInput[5].rotary.step",
		"virtualInput[8].var2", "condition[8].arg", "counter[4].maxCount",
		"canInput[8].id", "canOutput[8].interval",
	} {
		if _, ok := r.Lookup(present); !ok {
			t.Errorf("CANBoard registry should have %s", present)
		}
	}
}

// TestDefaultRegistryUnchanged guards the package-level helpers, which every
// pre-existing caller uses and which must keep resolving against dingopdm_v7.
func TestDefaultRegistryUnchanged(t *testing.T) {
	if Default().Board().Name != "dingoPDM" {
		t.Fatalf("default board is %s", Default().Board().Name)
	}
	if VarMapSize() != 217 {
		t.Fatalf("package-level VarMapSize = %d", VarMapSize())
	}
	if idx, ok := VarIndex("VirtIn1"); !ok || idx != 71 {
		t.Fatalf("package-level VarIndex(VirtIn1) = %d,%v", idx, ok)
	}
}

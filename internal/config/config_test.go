package config

import (
	"strings"
	"testing"
)

func TestResolveSortsAndEncodes(t *testing.T) {
	raw := map[string]interface{}{
		"output[4].currentLimit": 15.0,
		"output[4].enabled":      true,
		"output[4].input":        "AlwaysTrue",
	}
	ps, err := Resolve(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(ps) != 3 {
		t.Fatalf("got %d params, want 3", len(ps))
	}
	// All index 0x1003; must be sorted by subindex 0,1,2.
	for i, sub := range []uint8{0, 1, 2} {
		if ps[i].Index != 0x1003 || ps[i].SubIndex != sub {
			t.Errorf("ps[%d] = 0x%04X/%d, want 0x1003/%d", i, ps[i].Index, ps[i].SubIndex, sub)
		}
	}
}

func TestResolveAccumulatesErrors(t *testing.T) {
	raw := map[string]interface{}{
		"output[4].enabled":    true,  // ok
		"nope.field":           1.0,   // unknown
		"output[1].resetLimit": 99.0,  // out of firmware range
	}
	_, err := Resolve(raw)
	if err == nil {
		t.Fatal("expected errors")
	}
	s := err.Error()
	if !strings.Contains(s, "unknown param: nope.field") {
		t.Errorf("missing unknown-param error in: %s", s)
	}
	if !strings.Contains(s, "resetLimit") {
		t.Errorf("missing range error in: %s", s)
	}
}

func TestResolveNamedRoundTrip(t *testing.T) {
	raw := map[string]interface{}{
		"device.baseId":          222.0,
		"output[4].input":        "AlwaysTrue",
		"output[4].enabled":      true,
		"condition[1].arg":       13.5,
		"canInput[1].byteOrder":  "BigEndian",
	}
	ps, err := Resolve(raw)
	if err != nil {
		t.Fatal(err)
	}
	// Decode back to names, then re-resolve: must produce identical wire params.
	ps2, err := Resolve(Named(ps))
	if err != nil {
		t.Fatalf("re-resolve: %v", err)
	}
	if len(ps2) != len(ps) {
		t.Fatalf("round-trip len %d != %d", len(ps2), len(ps))
	}
	for i := range ps {
		if ps[i] != ps2[i] {
			t.Errorf("param %d: %+v != %+v", i, ps[i], ps2[i])
		}
	}
}

package ops

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"dingo-cli/internal/canframe"
	"dingo-cli/internal/params"
)

func TestBroadcastType(t *testing.T) {
	f := newFakePDM()
	f.rx <- canframe.Frame{ID: base + 3, Data: []byte{0, 0xF0, 0, 0, 0, 0, 0, 0}} // not the status frame
	f.rx <- canframe.Frame{ID: base + 2, Data: []byte{0}}                         // too short to carry a type
	f.rx <- canframe.Frame{ID: base + 2, Data: []byte{0, 0xC1, 0, 0, 0, 0, 0, 7}} // type 0xC, state 1
	start := time.Now()
	typ, seen := BroadcastType(f, base, time.Second)
	if !seen || typ != 12 {
		t.Fatalf("BroadcastType = %d, %v; want 12, true", typ, seen)
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Fatalf("did not return on the first status frame (%v)", time.Since(start))
	}
	if _, seen := BroadcastType(f, base, 30*time.Millisecond); seen {
		t.Fatal("seen a type on a silent bus")
	}
}

func TestCheckType(t *testing.T) {
	c6, _ := params.LookupBoard("c6body_v1")
	pdm, _ := params.LookupBoard("dingoPDM")
	cb, _ := params.LookupBoard("CANBoard")
	if err := CheckType(c6, 0x500, 12); err != nil {
		t.Fatal(err)
	}
	if err := CheckType(pdm, 0x0DE, 0); err != nil {
		t.Fatal(err)
	}
	if err := CheckType(cb, 0x640, 3); err != nil {
		t.Fatalf("CANBoard broadcasts no type, so is never checked: %v", err)
	}
	err := CheckType(c6, 0x500, 0)
	if err == nil || err.Error() != "the node at base 0x500 broadcasts board type 0 (dingoPDM) but the config is for c6body_v1 (pdmType 12): wrong base id or wrong config" {
		t.Fatalf("err = %v", err)
	}
	if err := CheckType(pdm, 0x0DE, 9); err == nil || !strings.Contains(err.Error(), "type 9 (an unknown board)") {
		t.Fatalf("err = %v", err)
	}
}

// TestC6ApplyVerify: the C6 examples go through Apply/Verify/ReadAll like a
// PDM config, and c6-empty verifies as the firmware's defaults CRC
// (params/testdata/c6body_v1.fw.json, from the real core).
func TestC6ApplyVerify(t *testing.T) {
	for name, want := range map[string]string{"c6-empty": "19879C6B", "c6-test": "C1E4D8D1"} {
		data, err := os.ReadFile("../../web/examples/" + name + ".json")
		if err != nil {
			t.Fatal(err)
		}
		b, err := ConfigBoard(data, 0x500)
		if err != nil || b.Name != "c6body_v1" {
			t.Fatalf("%s: board %s, %v", name, b.Name, err)
		}
		cfg, err := EncodeConfig(data, 0x500, false)
		if err != nil {
			t.Fatal(err)
		}
		f := newFakePDM()
		cl := client(f)
		res, err := Apply(cl, cfg, ApplyOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if res.Applied != 385 || fmt.Sprintf("%08X", res.CRC) != want {
			t.Fatalf("%s: applied %d crc %08X, want 385 %s", name, res.Applied, res.CRC, want)
		}
		if crc, err := Verify(cl); err != nil || crc != res.CRC {
			t.Fatalf("%s: verify %08X, %v", name, crc, err)
		}
		ps, crc, err := ReadAll(cl)
		if err != nil || len(ps) != 385 || crc != res.CRC {
			t.Fatalf("%s: read-all %d params %08X, %v", name, len(ps), crc, err)
		}
	}
}

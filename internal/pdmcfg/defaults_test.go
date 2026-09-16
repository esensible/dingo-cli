package pdmcfg

import (
	"encoding/json"
	"math"
	"os"
	"testing"

	"dingo-cli/internal/dingo"
	"dingo-cli/internal/params"
)

func index(ps []dingo.Param) map[uint32]uint32 {
	m := map[uint32]uint32{}
	for _, p := range ps {
		m[uint32(p.Index)<<8|uint32(p.SubIndex)] = p.Value
	}
	return m
}

func loadSparse(t *testing.T, opt Options) []dingo.Param {
	t.Helper()
	data, err := os.ReadFile("testdata/sparse.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	ps, err := DeviceParamsOpts(data, 512, opt)
	if err != nil {
		t.Fatalf("DeviceParamsOpts: %v", err)
	}
	return ps
}

// TestSparseDocumentIsStillComplete: a document that mentions one input, two
// outputs and no wiper at all still writes every parameter the board has.
//
// Anything skipped would leave the device holding the previous config's value
// for that field, so the same JSON applied to two differently-configured devices
// would produce two different devices.
func TestSparseDocumentIsStillComplete(t *testing.T) {
	ps := loadSparse(t, Options{})
	if got := len(ps); got != 2269 {
		t.Fatalf("projected %d params from a sparse document, want 2269", got)
	}
}

// TestDefaultsAreFirmwareDefaultsNotZero. Two of these are actively dangerous
// as zeros: bitrate 0 is 1000 kbit/s rather than "unset", and primaryOutput 0
// pairs output 1 rather than leaving the output unpaired.
func TestDefaultsAreFirmwareDefaultsNotZero(t *testing.T) {
	by := index(loadSparse(t, Options{}))
	cases := []struct {
		name  string
		index uint16
		sub   uint8
		want  uint32
	}{
		{"device.canSpeed (absent -> 500K, not 1000K)", 0x0000, 1, 1},
		{"output1.primaryOutput (absent -> -1, not paired)", 0x1000, 17, 0xFFFFFFFF},
		{"output2.primaryOutput", 0x1001, 17, 0xFFFFFFFF},
		{"output2.currentLimit (absent -> 20.0)", 0x1001, 2, math.Float32bits(20)},
		{"output2.inrushLimit (absent -> 50.0)", 0x1001, 3, math.Float32bits(50)},
		{"output2.resetLimit (absent -> 3)", 0x1001, 7, 3},
		{"digInput2.debounceTime (slot absent entirely -> 20)", 0x1201, 3, 20},
		{"canInput1.factor (absent -> 1.0)", 0x1300, 7, math.Float32bits(1)},
		{"canInput1.bitLength (present)", 0x1300, 6, 1},
		{"canInput2.bitLength (slot absent -> 8)", 0x1301, 6, 8},
		{"counter1.maxCount (present)", 0x1600, 5, 1},
		{"counter2.maxCount (slot absent -> 10)", 0x1601, 5, 10},
		{"counter1.resetTime (absent -> 2000)", 0x1600, 11, 2000},
		{"flasher1.onTime (block absent -> 500)", 0x1700, 2, 500},
		{"wiper.speedMap[1] (block absent -> Intermittent1)", 0x1900, 12, 3},
		{"wiper.intermitTime[6] (block absent -> 6000)", 0x1900, 25, 6000},
		{"starter.enabled (block absent -> false)", 0x1800, 0, 0},
		{"keypad1.model (block absent -> Blink12Key)", 0x3000, 4, 6},
		{"keypad1.backlightBrightness (block absent -> 63)", 0x3000, 5, 63},
	}
	for _, c := range cases {
		got, ok := by[uint32(c.index)<<8|uint32(c.sub)]
		if !ok {
			t.Errorf("%s: no param at 0x%04X.%d", c.name, c.index, c.sub)
			continue
		}
		if got != c.want {
			t.Errorf("%s: 0x%04X.%d = %d (0x%X), want %d (0x%X)",
				c.name, c.index, c.sub, got, got, c.want, c.want)
		}
	}
}

// TestDocumentValuesStillWin: defaulting must not override what the document
// actually says.
func TestDocumentValuesStillWin(t *testing.T) {
	by := index(loadSparse(t, Options{}))
	cases := []struct {
		name  string
		index uint16
		sub   uint8
		want  uint32
	}{
		{"device.baseId", 0x0000, 0, 512},
		{"output1.enabled", 0x1000, 0, 1},
		{"output1.input", 0x1000, 1, 5},
		{"output1.currentLimit", 0x1000, 2, math.Float32bits(13)},
		{"output2.enabled (explicitly false)", 0x1001, 0, 0},
		{"digInput1.invert", 0x1200, 2, 1},
		{"canOutput1.id", 0x2000, 3, 769},
	}
	for _, c := range cases {
		got, ok := by[uint32(c.index)<<8|uint32(c.sub)]
		if !ok {
			t.Errorf("%s: missing", c.name)
			continue
		}
		if got != c.want {
			t.Errorf("%s = %d, want %d", c.name, got, c.want)
		}
	}
}

// TestPartialRestoresTheOldBehaviour.
func TestPartialRestoresTheOldBehaviour(t *testing.T) {
	ps := loadSparse(t, Options{Partial: true})
	if len(ps) >= 2269 {
		t.Fatalf("partial projection wrote %d params; it should only write what the document mentions", len(ps))
	}
	by := index(ps)
	if _, ok := by[uint32(0x1001)<<8|17]; ok {
		t.Error("partial mode wrote output2.primaryOutput, which the document does not mention")
	}
	if v, ok := by[uint32(0x1000)<<8|1]; !ok || v != 5 {
		t.Errorf("partial mode lost output1.input: %v %v", v, ok)
	}
}

// TestBoardSelectionFollowsPdmType: a 4-output variant must not be sent
// parameters for outputs it does not have.
func TestBoardSelectionFollowsPdmType(t *testing.T) {
	doc := map[string]any{
		"PdmDevices": []any{map[string]any{
			"pdmType": 1, // dingoPDM-Max
			"name":    "max",
			"baseId":  222,
			"outputs": []any{
				map[string]any{"number": 1, "enabled": true, "input": 1},
			},
		}},
	}
	data, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	ps, err := DeviceParams(data, 222)
	if err != nil {
		t.Fatalf("DeviceParams: %v", err)
	}
	maxBoard, _ := params.LookupBoard("dingoPDM-Max")
	want := len(params.NewRegistry(maxBoard).All())
	if len(ps) != want {
		t.Fatalf("projected %d params for a dingoPDM-Max, want %d", len(ps), want)
	}
	for _, p := range ps {
		if p.Index >= 0x1004 && p.Index < 0x1100 {
			t.Fatalf("wrote 0x%04X, which a 4-output board does not have", p.Index)
		}
	}
}

// TestMismatchedBoardIsRejected rather than silently dropping the extra slots.
func TestMismatchedBoardIsRejected(t *testing.T) {
	doc := map[string]any{
		"PdmDevices": []any{map[string]any{
			"pdmType": 1, // says Max (4 outputs) ...
			"baseId":  222,
			"outputs": []any{ // ... but carries eight
				map[string]any{"number": 1}, map[string]any{"number": 2},
				map[string]any{"number": 3}, map[string]any{"number": 4},
				map[string]any{"number": 5, "enabled": true},
				map[string]any{"number": 6}, map[string]any{"number": 7},
				map[string]any{"number": 8},
			},
		}},
	}
	data, _ := json.Marshal(doc)
	if _, err := DeviceParams(data, 222); err == nil {
		t.Fatal("expected a mismatch error for eight outputs on a four-output board")
	}
}

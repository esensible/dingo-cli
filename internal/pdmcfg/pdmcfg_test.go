package pdmcfg

import (
	"math"
	"os"
	"testing"

	"dingo-cli/internal/dingo"
)

func loadParams(t *testing.T) []dingo.Param {
	t.Helper()
	data, err := os.ReadFile("testdata/example.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	ps, err := DeviceParams(data, 222)
	if err != nil {
		t.Fatalf("DeviceParams: %v", err)
	}
	return ps
}

// TestProjectionCount: a full PDM config must project to exactly the firmware
// param count (every field of every block), proving completeness of the bridge.
func TestProjectionCount(t *testing.T) {
	if got := len(loadParams(t)); got != 2269 {
		t.Fatalf("projected %d params, want 2269", got)
	}
}

// TestProjectionValues spot-checks that representative dingoConfig fields land at
// the right (index, sub) with the right wire value (covering bool/int/float/
// enum/varmap/int8 and the singleton + array cases).
func TestProjectionValues(t *testing.T) {
	ps := loadParams(t)
	byKey := map[uint32]uint32{}
	for _, p := range ps {
		byKey[uint32(p.Index)<<8|uint32(p.SubIndex)] = p.Value
	}
	get := func(index uint16, sub uint8) (uint32, bool) {
		v, ok := byKey[uint32(index)<<8|uint32(sub)]
		return v, ok
	}

	cases := []struct {
		name  string
		index uint16
		sub   uint8
		want  uint32
	}{
		{"device.baseId", 0x0000, 0, 222},
		{"device.bitrate(canSpeed)", 0x0000, 1, 1},
		{"output1.input=Flasher1", 0x1000, 1, 119},
		{"output1.currentLimit=20.0", 0x1000, 2, math.Float32bits(20)},
		{"output1.resetCountLimit->resetLimit", 0x1000, 7, 3},
		{"output1.primaryOutput=-1", 0x1000, 17, 0xFFFFFFFF},
		{"canOutput1.input=Out1Active(87)", 0x2000, 1, 87},
		{"canOutput1.id=1280", 0x2000, 3, 1280},
		{"canOutput1.interval=100", 0x2000, 10, 100},
		{"flasher1.enabled=true", 0x1700, 0, 1},
		{"flasher1.input=AlwaysTrue(1)", 0x1700, 1, 1},
		{"flasher1.onTime=300", 0x1700, 2, 300},
		{"flasher1.single=false", 0x1700, 4, 0},
		{"wiper.speedMap[0]=Intermittent1(3)", 0x1900, 12, 3},
		{"wiper.intermitTime[0]=1000", 0x1900, 20, 1000},
		{"starter.outputsDisabled[0]=false", 0x1800, 2, 0},
		{"keypad1.model=6", 0x3000, 4, 6},
		{"keypad2.button1.faultBlinkColor", 0x3100 + 32, 21, 0},
	}
	for _, c := range cases {
		got, ok := get(c.index, c.sub)
		if !ok {
			t.Errorf("%s: no param at 0x%04X.%d", c.name, c.index, c.sub)
			continue
		}
		if got != c.want {
			t.Errorf("%s: 0x%04X.%d = 0x%X (%d), want 0x%X (%d)", c.name, c.index, c.sub, got, got, c.want, c.want)
		}
	}
}

// TestSelectByBaseId: a wrong base on a single-PDM file still resolves (uses the
// only device); a multi-device mismatch would error, but this fixture has one.
func TestSelectSinglePdm(t *testing.T) {
	data, err := os.ReadFile("testdata/example.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DeviceParams(data, 999); err != nil {
		t.Fatalf("single-PDM file should resolve regardless of base: %v", err)
	}
}

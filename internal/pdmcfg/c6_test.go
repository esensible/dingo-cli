package pdmcfg

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"dingo-cli/internal/dingo"
	"dingo-cli/internal/params"
)

// c6Runs is the "runs" part of params/testdata/c6body_v1.fw.json: the C6's
// real firmware core (tools/c6oracle) answering `apply`, `verify` and
// `read-all` for each web/examples/c6-*.json, as dingo-cli encodes it.
type c6Run struct {
	Name               string `json:"name"`
	Sent               int    `json:"sent"`
	Rejected           int    `json:"rejected"`
	WriteAllAck        bool   `json:"writeAllAck"`
	WriteCount         int    `json:"writeCount"`
	WriteCrc           string `json:"writeCrc"`
	CheckCrc           string `json:"checkCrc"`
	ReadCount          int    `json:"readCount"`
	ReadCrc            string `json:"readCrc"`
	ReadBackEqualsSent bool   `json:"readBackEqualsSent"`
	BaseAfter          int    `json:"baseAfter"`
	BurnResult         int    `json:"burnResult"`
	RebootLoad         int    `json:"rebootLoad"`
	RebootCrc          string `json:"rebootCrc"`
	Tx1s               []struct {
		ID       int      `json:"id"`
		Payloads []string `json:"payloads"`
	} `json:"tx1s"`
}

func loadC6Runs(t *testing.T) (map[string]c6Run, string) {
	t.Helper()
	data, err := os.ReadFile("../params/testdata/c6body_v1.fw.json")
	if err != nil {
		t.Fatal(err)
	}
	var rec struct {
		DefaultsCrc string  `json:"defaultsCrc"`
		Runs        []c6Run `json:"runs"`
	}
	if err := json.Unmarshal(data, &rec); err != nil {
		t.Fatal(err)
	}
	out := map[string]c6Run{}
	for _, r := range rec.Runs {
		out[r.Name] = r
	}
	return out, rec.DefaultsCrc
}

// TestC6ExamplesAgainstFirmware: each example encodes to exactly the count
// and CRC the firmware computed when it was sent those params — for the
// write (WriteAllComplete), the live config (CheckCrc) and the dump
// (ReadAll) — with nothing rejected, and still after a burn and a reboot from
// the stored config. This is `dingo apply` + `verify` + `burn` against the
// real core, minus the bus.
func TestC6ExamplesAgainstFirmware(t *testing.T) {
	runs, defaultsCrc := loadC6Runs(t)
	for _, name := range []string{"c6-empty", "c6-test"} {
		data, err := os.ReadFile("../../web/examples/" + name + ".json")
		if err != nil {
			t.Fatal(err)
		}
		b, err := DeviceBoard(data, 0x500)
		if err != nil {
			t.Fatal(err)
		}
		if b.Name != "c6body_v1" {
			t.Fatalf("%s: board %s", name, b.Name)
		}
		ps, err := DeviceParams(data, 0x500)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		crc := fmt.Sprintf("%08X", dingo.CRC(ps))
		r, ok := runs[name]
		if !ok {
			t.Fatalf("%s: not in the firmware record; rerun tools/c6oracle/run.sh", name)
		}
		if r.Sent != len(ps) {
			t.Fatalf("%s: the record was made from %d params, the encoder now gives %d; rerun tools/c6oracle/run.sh", name, r.Sent, len(ps))
		}
		if !r.WriteAllAck || r.Rejected != 0 || !r.ReadBackEqualsSent {
			t.Errorf("%s: firmware ack %v, rejected %d, read-back equal %v", name, r.WriteAllAck, r.Rejected, r.ReadBackEqualsSent)
		}
		for what, got := range map[string]int{"write": r.WriteCount, "read": r.ReadCount} {
			if got != len(ps) {
				t.Errorf("%s: firmware %s count %d, encoded %d", name, what, got, len(ps))
			}
		}
		// Burned (WriteConfig() = 1), then restored from the stored blob on
		// the next boot (ConfigLoad::Restored = 0) with the same CRC.
		if r.BurnResult != 1 || r.RebootLoad != 0 {
			t.Errorf("%s: burn result %d, reboot load %d", name, r.BurnResult, r.RebootLoad)
		}
		for what, got := range map[string]string{"write": r.WriteCrc, "check": r.CheckCrc, "read": r.ReadCrc, "after reboot": r.RebootCrc} {
			if got != crc {
				t.Errorf("%s: firmware %s CRC %s, encoded %s", name, what, got, crc)
			}
		}
		if r.BaseAfter != 0x500 {
			t.Errorf("%s: base after apply 0x%03X", name, r.BaseAfter)
		}
	}
	// c6-empty is every default, so it is also what a node that has never
	// been configured verifies as.
	if runs["c6-empty"].CheckCrc != defaultsCrc {
		t.Errorf("c6-empty CRC %s, firmware defaults CRC %s", runs["c6-empty"].CheckCrc, defaultsCrc)
	}
	// c6-test's hardware signature: 0x5F0 with byte 0 = VirtIn1 (always 1)
	// and byte 1 = Flasher1 (1 Hz), both payloads seen within a second.
	var got []string
	for _, f := range runs["c6-test"].Tx1s {
		if f.ID == 0x5F0 {
			got = f.Payloads
		}
	}
	if strings.Join(got, ",") != "0101,0100" {
		t.Errorf("c6-test: 0x5F0 payloads %v, want [0101 0100]", got)
	}
}

// TestC6Projection: the C6's blocks project, blocks it does not have are
// refused rather than dropped, and its documents must name their type.
func TestC6Projection(t *testing.T) {
	doc := func(dev string) []byte { return []byte(`{"PdmDevices":[` + dev + `]}`) }

	ps, err := DeviceParams(doc(`{"pdmType":12,"baseId":1280,
		"canInputs":[{"enabled":true,"id":1521,"startBit":0,"bitLength":1}],
		"conditions":[{"enabled":true,"input":"CanIn1Out","operator":0,"arg":1}],
		"counters":[{"enabled":true,"incInput":"Cond1","maxCount":3}],
		"flashers":[{},{},{},{"enabled":true,"input":"Counter1"}]}`), 1280)
	if err != nil {
		t.Fatal(err)
	}
	reg := params.NewRegistry(mustBoard(t, "c6body_v1"))
	got := map[string]uint32{}
	for _, p := range ps {
		d, _ := reg.LookupKey(p.Index, p.SubIndex)
		got[d.Name] = p.Value
	}
	for name, want := range map[string]uint32{
		"canInput[1].id": 1521, "condition[1].input": 3, "counter[1].incInput": 31,
		"counter[1].maxCount": 3, "flasher[4].input": 39, "flasher[4].enabled": 1, "device.baseId": 1280,
	} {
		if got[name] != want {
			t.Errorf("%s = %d, want %d", name, got[name], want)
		}
	}

	for _, c := range []struct{ dev, want string }{
		{`{"pdmType":12,"outputs":[{"enabled":true}]}`, "no firmware param for index 0x1000"},
		{`{"pdmType":12,"inputs":[{"enabled":true}]}`, "no firmware param for index 0x1200"},
		{`{"pdmType":12,"canInputs":[{},{},{},{},{},{},{},{},{"enabled":true}]}`, "no firmware param for index 0x1308"},
		{`{"pdmType":12,"keypads":[{"enabled":true}]}`, "no firmware param for index 0x3000"},
		{`{"pdmType":12,"wipers":{"enabled":true}}`, "no firmware param for index 0x1900"},
		{`{"pdmType":12,"virtualInputs":[{"var0":"Out1Active"}]}`, `unknown variable "Out1Active"`},
		{`{"pdmType":12,"virtualInputs":[{"var0":43}]}`, "var-map index 43 out of range (0..42)"},
		{`{"pdmType":13}`, "unknown pdmType 13 (valid: 0 (dingoPDM), 1 (dingoPDM-Max), 2 (PT-DPDM), 12 (c6body_v1))"},
		{`{"pdmType":"12"}`, "pdmType \"12\" is not an integer"},
	} {
		_, err := DeviceParams(doc(c.dev), 0)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want %q", c.dev, err, c.want)
		}
	}

	// Without pdmType an output-less document is not a C6: it stays the
	// historical dingoPDM default, so a C6 config must say pdmType 12.
	b, err := DeviceBoard(doc(`{"canInputs":[]}`), 0)
	if err != nil || b.Name != "dingoPDM" {
		t.Errorf("no pdmType: board %s, %v", b.Name, err)
	}
}

func mustBoard(t *testing.T, name string) params.Board {
	t.Helper()
	b, ok := params.LookupBoard(name)
	if !ok {
		t.Fatalf("no board %s", name)
	}
	return b
}

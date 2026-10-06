package ops

import (
	"encoding/binary"
	"errors"
	"math"
	"os"
	"strings"
	"testing"
	"time"

	"dingo-cli/internal/canframe"
	"dingo-cli/internal/dingo"
	"dingo-cli/internal/pdmcfg"
)

const base = 0x0DE

// fakePDM is the device side of the param protocol (enough of dingoFW's
// semantics for count + CRC verification), answering on base+0. It is driven
// by a real-time dingo.Client, so Recv really waits.
type fakePDM struct {
	store      map[uint32]uint32
	order      []dingo.Param
	staged     []dingo.Param
	burned     bool
	burnResult uint32
	version    uint32
	silent     bool
	rx         chan canframe.Frame
}

func newFakePDM() *fakePDM {
	return &fakePDM{store: map[uint32]uint32{}, burnResult: 1, rx: make(chan canframe.Frame, 8192)}
}

func frame(cmd uint8, idx uint16, sub uint8, val uint32) canframe.Frame {
	d := make([]byte, 8)
	d[0] = cmd
	binary.LittleEndian.PutUint16(d[1:3], idx)
	d[3] = sub
	binary.LittleEndian.PutUint32(d[4:8], val)
	return canframe.Frame{ID: base, Data: d}
}

func (f *fakePDM) reply(cmd uint8, idx uint16, sub uint8, val uint32) {
	f.rx <- frame(cmd, idx, sub, val)
}

func (f *fakePDM) Send(fr canframe.Frame) error {
	if fr.ID != base+1 {
		return errors.New("fake: frame to wrong id")
	}
	if f.silent {
		return nil
	}
	d := fr.Data
	cmd, idx, sub, val := d[0], binary.LittleEndian.Uint16(d[1:3]), d[3], binary.LittleEndian.Uint32(d[4:8])
	k := uint32(idx)<<8 | uint32(sub)
	switch cmd {
	case 20: // WriteAll
		f.staged = nil
		f.reply(20, 0, 0, 0)
	case 21:
		f.staged = append(f.staged, dingo.Param{Index: idx, SubIndex: sub, Value: val})
	case 22:
		f.order = append([]dingo.Param(nil), f.staged...)
		for _, p := range f.staged {
			f.store[uint32(p.Index)<<8|uint32(p.SubIndex)] = p.Value
		}
		f.reply(22, uint16(len(f.order)), 0, dingo.CRC(f.order))
	case 2:
		f.store[k] = val
		f.reply(2, idx, sub, val)
	case 1:
		f.reply(1, idx, sub, f.store[k])
	case 10:
		f.reply(10, 0, 0, 0)
		for _, p := range f.order {
			f.reply(11, p.Index, p.SubIndex, p.Value)
		}
		f.reply(12, uint16(len(f.order)), 0, dingo.CRC(f.order))
	case 34:
		f.reply(35, 0, 0, dingo.CRC(f.order))
	case 30:
		f.burned = f.burnResult == 1
		f.reply(30, 0, 0, f.burnResult)
	case 31:
		f.reply(31, 0, 0, f.version)
	}
	return nil
}

func (f *fakePDM) Recv(timeout time.Duration) (canframe.Frame, error) {
	select {
	case fr := <-f.rx:
		return fr, nil
	case <-time.After(timeout):
		return canframe.Frame{}, errors.New("timeout")
	}
}

func (f *fakePDM) Close() error { return nil }

func client(f *fakePDM) *dingo.Client {
	cl := dingo.New(f, base)
	cl.SetTimeoutScale(0.01) // keep silent-device cases fast
	return cl
}

func example(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile("../pdmcfg/testdata/example.json")
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestEncodeConfigMatchesPdmcfg(t *testing.T) {
	data := example(t)
	want, err := pdmcfg.DeviceParams(data, base)
	if err != nil {
		t.Fatal(err)
	}
	got, err := EncodeConfig(data, base, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(want) || dingo.CRC(got) != dingo.CRC(want) {
		t.Fatalf("EncodeConfig differs from pdmcfg: %d/%08X vs %d/%08X", len(got), dingo.CRC(got), len(want), dingo.CRC(want))
	}
}

func TestApplyVerifyReadAll(t *testing.T) {
	f := newFakePDM()
	cl := client(f)
	cfg, err := EncodeConfig(example(t), base, false)
	if err != nil {
		t.Fatal(err)
	}
	var after, last int
	cl.Progress = func(done, total int) { last = done }
	res, err := Apply(cl, cfg, ApplyOptions{Burn: true, AfterWrite: func(n int) { after = n }})
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied != len(cfg) || after != len(cfg) || !res.Burned || !f.burned || last != len(cfg) {
		t.Fatalf("apply result %+v after=%d progress=%d burned=%v", res, after, last, f.burned)
	}
	crc, err := Verify(cl)
	if err != nil || crc != res.CRC {
		t.Fatalf("verify = %08X, %v; want %08X", crc, err, res.CRC)
	}
	ps, rcrc, err := ReadAll(cl)
	if err != nil || len(ps) != len(cfg) || rcrc != res.CRC {
		t.Fatalf("readall: %d params crc %08X err %v", len(ps), rcrc, err)
	}
}

func TestApplyBurnRejected(t *testing.T) {
	f := newFakePDM()
	f.burnResult = 0
	cfg := []dingo.Param{{Index: 0, SubIndex: 0, Value: 222}}
	afterCalled := false
	res, err := Apply(client(f), cfg, ApplyOptions{Burn: true, AfterWrite: func(int) { afterCalled = true }})
	if err == nil || !strings.Contains(err.Error(), "burn rejected") {
		t.Fatalf("err = %v", err)
	}
	if !afterCalled || res.Applied != 1 || res.Burned {
		t.Fatalf("res = %+v afterCalled=%v", res, afterCalled)
	}
}

func TestSetGetVersion(t *testing.T) {
	f := newFakePDM()
	f.version = 0x01000305 // 5.3, build 1
	cl := client(f)
	d, raw, err := EncodeParam("output[4].currentLimit", "15")
	if err != nil {
		t.Fatal(err)
	}
	if raw != math.Float32bits(15) || d.Index != 0x1003 || d.Sub != 2 {
		t.Fatalf("encoded %s idx %04X sub %d raw %08X", d.Name, d.Index, d.Sub, raw)
	}
	if _, err := Set(cl, d, raw); err != nil {
		t.Fatal(err)
	}
	pv, err := Get(cl, d)
	if err != nil || pv.Value != float64(15) {
		t.Fatalf("get = %v, %v", pv.Value, err)
	}
	if v, err := GetRaw(cl, 0x1003, 2); err != nil || v != raw {
		t.Fatalf("getraw = %X, %v", v, err)
	}
	v, err := ReadVersion(cl)
	if err != nil || v.String() != "5.3.1" {
		t.Fatalf("version = %v, %v", v, err)
	}
	if _, _, err := EncodeParam("output[99].currentLimit", 1.0); err == nil || err.Error() != "unknown param: output[99].currentLimit" {
		t.Fatalf("unknown param err = %v", err)
	}
}

func TestSilentDevice(t *testing.T) {
	f := newFakePDM()
	f.silent = true
	start := time.Now()
	_, err := ReadVersion(client(f))
	if err == nil || !strings.Contains(err.Error(), "no response") {
		t.Fatalf("err = %v", err)
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("timeout scale not applied: took %v", el)
	}
}

func TestDevicesAndSelect(t *testing.T) {
	two := []byte(`{"PdmDevices":[{"name":"front","baseId":222,"pdmType":0},{"name":"rear","baseId":300}],
"CanboardDevices":[{"name":"cb","baseId":1792}]}`)
	es, err := Devices(two)
	if err != nil {
		t.Fatal(err)
	}
	if len(es) != 3 || es[0].Kind != "PdmDevices" || es[0].Name != "front" || *es[1].BaseID != 300 || es[1].PdmType != nil || es[2].Kind != "CanboardDevices" {
		t.Fatalf("entries = %+v", es)
	}
	b := 300
	if s, err := SelectPdm(es, &b); err != nil || s.Entry.Name != "rear" || s.Fallback {
		t.Fatalf("select 300 = %+v, %v", s, err)
	}
	b = 0x123
	if _, err := SelectPdm(es, &b); err == nil || !strings.Contains(err.Error(), `222 (0x0DE) "front", 300 (0x12C) "rear"`) {
		t.Fatalf("wrong base err = %v", err)
	}
	if _, err := SelectPdm(es, nil); err == nil || !strings.Contains(err.Error(), "pass a base id") {
		t.Fatalf("nil base err = %v", err)
	}
	// Single PDM: used regardless of base, like pdmcfg / dingo apply.
	one, _ := Devices([]byte(`{"PdmDevices":[{"name":"x","baseId":222}]}`))
	if s, err := SelectPdm(one, &b); err != nil || !s.Fallback {
		t.Fatalf("single fallback = %+v, %v", s, err)
	}
	if _, err := SelectPdm(nil, nil); err == nil || err.Error() != "no PdmDevices in file" {
		t.Fatalf("empty err = %v", err)
	}
}

func TestJSONErrorPosition(t *testing.T) {
	_, err := Devices([]byte("{\n  \"PdmDevices\": [\n    {,}\n  ]\n}"))
	if err == nil || !strings.Contains(err.Error(), "line 3, column 6") {
		t.Fatalf("err = %v", err)
	}
	_, err = Devices([]byte(`[1,2]`))
	if err == nil || !strings.Contains(err.Error(), "line 1, column 1") {
		t.Fatalf("type err = %v", err)
	}
}

func TestBoardAndParamNames(t *testing.T) {
	b, err := Board(1)
	if err != nil || b.Name != "dingoPDM-Max" {
		t.Fatalf("board 1 = %v, %v", b.Name, err)
	}
	if _, err := Board(7); err == nil || !strings.Contains(err.Error(), "0 (dingoPDM)") {
		t.Fatalf("board 7 err = %v", err)
	}
	names := ParamNames(b)
	if names[0] != "device.baseId" {
		t.Fatalf("first name %q", names[0])
	}
}

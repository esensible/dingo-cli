package dingo

import (
	"hash/crc32"
	"strings"
	"testing"

	"dingo-cli/internal/slcan"
)

const testBase = 0x0DE

func TestFrameRoundTrip(t *testing.T) {
	// Includes the int8 sign-extended value path (primaryOutput = -1).
	cases := []msg{
		{cmdWrite, 0x1003, 17, 0xFFFFFFFF},
		{cmdRead, 0x0000, 0, 0},
		{cmdWriteAllComplete, 2269, 0, 0xDEADBEEF},
	}
	for _, want := range cases {
		got := decode(slcan.Frame{Data: frameBytes(want.Cmd, want.Index, want.SubIndex, want.Value)})
		if got != want {
			t.Errorf("round-trip: got %+v want %+v", got, want)
		}
	}
}

func TestCrcOf(t *testing.T) {
	// Empty set is the CRC-32 of the empty string.
	if got := crcOf(nil); got != 0 {
		t.Errorf("crcOf(nil) = 0x%08X, want 0", got)
	}
	// crcOf must feed each value as 4 little-endian bytes, in order — cross-check
	// against the stdlib over the explicit byte layout (the firmware contract).
	ps := []Param{{0x1003, 0, 0x41A00000}, {0x0000, 0, 222}}
	wantBytes := []byte{0x00, 0x00, 0xA0, 0x41, 0xDE, 0x00, 0x00, 0x00}
	if got, want := crcOf(ps), crc32.ChecksumIEEE(wantBytes); got != want {
		t.Errorf("crcOf layout = 0x%08X, want 0x%08X", got, want)
	}
	// Order-sensitive (CRC is over the value stream in order).
	a := []Param{{0, 0, 1}, {0, 0, 2}}
	b := []Param{{0, 0, 2}, {0, 0, 1}}
	if crcOf(a) == crcOf(b) {
		t.Error("crcOf should be order-sensitive")
	}
}

func TestWriteAll(t *testing.T) {
	params := []Param{{0x1003, 0, 1}, {0x1003, 1, 1}, {0x1000, 2, 0x41A00000}}
	cases := []struct {
		name    string
		setup   func(*fakeDevice)
		wantErr string // substring; "" = success
	}{
		{"happy path", nil, ""},
		{"count mismatch", func(d *fakeDevice) { d.miscount = -1 }, "count mismatch"},
		{"crc mismatch", func(d *fakeDevice) { d.corruptCRC = true }, "CRC mismatch"},
		{"one param rejected out-of-range", func(d *fakeDevice) {
			d.rejectWrite = func(p Param) bool { return p.Index == 0x1000 && p.SubIndex == 2 }
		}, "count mismatch"}, // the count guard catches the silent rejection
		{"start never acks", func(d *fakeDevice) { d.dropFirst = requestTries }, "WriteAll start"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := newFake(testBase)
			if c.setup != nil {
				c.setup(d)
			}
			err := newTestClient(d).WriteAll(params)
			assertErr(t, err, c.wantErr)
			if c.wantErr == "" && len(d.order) != len(params) {
				t.Errorf("committed %d params, want %d", len(d.order), len(params))
			}
		})
	}
}

func TestReadAll(t *testing.T) {
	seed := []Param{{0x0000, 0, 222}, {0x1003, 0, 1}, {0x1003, 1, 1}}
	cases := []struct {
		name    string
		setup   func(*fakeDevice)
		wantN   int
		wantErr string
	}{
		{"happy path", nil, len(seed), ""},
		{"corrupt crc", func(d *fakeDevice) { d.corruptCRC = true }, 0, "CRC mismatch"},
		{"count mismatch", func(d *fakeDevice) { d.miscount = 1 }, 0, "count mismatch"},
		{"recovers from dropped prime request", func(d *fakeDevice) { d.dropFirst = 2 }, len(seed), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := newFake(testBase)
			d.order = seed
			if c.setup != nil {
				c.setup(d)
			}
			got, err := newTestClient(d).ReadAll()
			assertErr(t, err, c.wantErr)
			if c.wantErr == "" && len(got) != c.wantN {
				t.Errorf("read %d params, want %d", len(got), c.wantN)
			}
		})
	}
}

func TestSetParam(t *testing.T) {
	cases := []struct {
		name    string
		setup   func(*fakeDevice)
		wantErr string
	}{
		{"happy path", nil, ""},
		{"rejected (no ack)", func(d *fakeDevice) {
			d.rejectWrite = func(Param) bool { return true }
		}, "no ack"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := newFake(testBase)
			if c.setup != nil {
				c.setup(d)
			}
			err := newTestClient(d).SetParam(0x1000, 2, 0x41A00000)
			assertErr(t, err, c.wantErr)
		})
	}
}

func TestBurn(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		d := newFake(testBase)
		if err := newTestClient(d).Burn(); err != nil {
			t.Fatalf("burn: %v", err)
		}
		if !d.burned {
			t.Error("device not burned")
		}
	})
	t.Run("rejected", func(t *testing.T) {
		d := newFake(testBase)
		d.burnResult = 0
		assertErr(t, newTestClient(d).Burn(), "burn rejected")
	})
	t.Run("no ack (single-shot, no resend)", func(t *testing.T) {
		d := newFake(testBase)
		d.dropFirst = 1
		assertErr(t, newTestClient(d).Burn(), "no response")
	})
}

func TestVersion(t *testing.T) {
	d := newFake(testBase)
	// major=5, minor=3, build=(0<<8)|0 = 0  -> value 0x00000305
	d.version = 0x00000305
	maj, min, bld, err := newTestClient(d).Version()
	if err != nil {
		t.Fatal(err)
	}
	if maj != 5 || min != 3 || bld != 0 {
		t.Errorf("version = %d.%d.%d, want 5.3.0", maj, min, bld)
	}
}

func TestReadParamRecoversFromDrops(t *testing.T) {
	d := newFake(testBase)
	d.order = []Param{{0x0000, 0, 222}}
	d.store[key(0x0000, 0)] = 222
	d.dropFirst = 3 // device busy: first 3 reads lost, then succeeds (within 6 tries)
	v, err := newTestClient(d).ReadParam(0x0000, 0)
	if err != nil {
		t.Fatal(err)
	}
	if v != 222 {
		t.Errorf("read = %d, want 222", v)
	}
}

func assertErr(t *testing.T, err error, want string) {
	t.Helper()
	if want == "" {
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		return
	}
	if err == nil {
		t.Fatalf("expected error containing %q, got nil", want)
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("error %q does not contain %q", err.Error(), want)
	}
}

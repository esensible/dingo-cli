package dingo

import (
	"time"

	"dingo-cli/internal/slcan"
)

// fakeClock is a deterministic clock: time only advances when the code sleeps or
// when a Recv times out (modeled by fakeDevice.Recv). No real wall-time passes.
type fakeClock struct{ t time.Time }

func newClock() *fakeClock { return &fakeClock{t: time.Unix(1_000_000, 0)} }

func (c *fakeClock) Now() time.Time                  { return c.t }
func (c *fakeClock) Since(s time.Time) time.Duration { return c.t.Sub(s) }
func (c *fakeClock) Sleep(d time.Duration)           { c.t = c.t.Add(d) }

// fakeDevice is an in-memory dingoPDM that implements Transport and reproduces
// the firmware's param-protocol semantics (count + CRC), with fault-injection
// knobs for the failure modes the Client claims to handle.
type fakeDevice struct {
	base    uint16
	clock   *fakeClock
	store   map[uint32]uint32
	order   []Param
	staged  []Param
	burned  bool
	version uint32
	rx      []slcan.Frame // FIFO of queued responses

	// fault injection
	dropFirst   int              // swallow the first N inbound commands (no processing/reply)
	rejectWrite func(Param) bool // simulate out-of-range / not-found (no reply, not staged)
	corruptCRC  bool             // return a wrong CRC on complete/dump
	miscount    int              // perturb the reported staged/dump count
	burnResult  uint32           // value returned by Burn (default 1 = success)
}

func newFake(base uint16) *fakeDevice {
	return &fakeDevice{
		base: base, clock: newClock(), store: map[uint32]uint32{}, burnResult: 1,
	}
}

func key(index uint16, sub uint8) uint32 { return uint32(index)<<8 | uint32(sub) }

func (d *fakeDevice) reply(cmd uint8, idx uint16, sub uint8, val uint32) {
	d.rx = append(d.rx, slcan.Frame{ID: d.base + configTxOffset, Data: frameBytes(cmd, idx, sub, val)})
}

func (d *fakeDevice) commit() {
	d.order = append([]Param(nil), d.staged...)
	for _, p := range d.staged {
		d.store[key(p.Index, p.SubIndex)] = p.Value
	}
}

func (d *fakeDevice) Send(f slcan.Frame) error {
	if d.dropFirst > 0 {
		d.dropFirst--
		return nil // device was busy: command lost, no reply
	}
	m := decode(f)
	switch m.Cmd {
	case cmdWriteAll:
		d.staged = nil
		d.reply(cmdWriteAll, 0, 0, 0)
	case cmdWriteAllVal:
		p := Param{m.Index, m.SubIndex, m.Value}
		if d.rejectWrite != nil && d.rejectWrite(p) {
			return nil // out of range: not staged, no reply
		}
		d.staged = append(d.staged, p)
	case cmdWriteAllComplete:
		cnt := len(d.staged)
		d.commit()
		crc := crcOf(d.staged)
		if d.corruptCRC {
			crc ^= 0xFFFFFFFF
		}
		d.reply(cmdWriteAllComplete, uint16(cnt+d.miscount), 0, crc)
	case cmdWrite:
		p := Param{m.Index, m.SubIndex, m.Value}
		if d.rejectWrite != nil && d.rejectWrite(p) {
			return nil // rejected: no echo
		}
		d.store[key(m.Index, m.SubIndex)] = m.Value
		d.reply(cmdWrite, m.Index, m.SubIndex, m.Value)
	case cmdRead:
		d.reply(cmdRead, m.Index, m.SubIndex, d.store[key(m.Index, m.SubIndex)])
	case cmdReadAll:
		d.reply(cmdReadAll, 0, 0, 0)
		for _, p := range d.order {
			d.reply(cmdReadAllRsp, p.Index, p.SubIndex, p.Value)
		}
		crc := crcOf(d.order)
		if d.corruptCRC {
			crc ^= 1
		}
		d.reply(cmdReadAllComplete, uint16(len(d.order)+d.miscount), 0, crc)
	case cmdCheckCrc:
		d.reply(cmdCheckCrcRsp, 0, 0, crcOf(d.order))
	case cmdBurnSettings:
		d.burned = true
		d.reply(cmdBurnSettings, 0, 0, d.burnResult)
	case cmdVersion:
		d.reply(cmdVersion, 0, 0, d.version)
	case cmdBootloader:
		// fire-and-forget, no reply
	}
	return nil
}

func (d *fakeDevice) Recv(timeout time.Duration) (slcan.Frame, error) {
	if len(d.rx) == 0 {
		d.clock.Sleep(timeout) // a Recv timeout consumes wall-time
		return slcan.Frame{}, slcan.ErrTimeout
	}
	f := d.rx[0]
	d.rx = d.rx[1:]
	return f, nil
}

func (d *fakeDevice) Close() error { return nil }

// newTestClient wires a Client to a fake device sharing its clock.
func newTestClient(d *fakeDevice) *Client {
	return &Client{port: d, base: d.base, clock: d.clock}
}

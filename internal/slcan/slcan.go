// Package slcan implements the minimal SLCAN (serial-line CAN) transport used
// by dingoPDM / dingoFW devices over their USB CDC port.
//
// Wire format (matches the dingoConfig SlcanAdapter):
//   - open sequence: "C\r", "S<code>\r", "O\r"  (S6 = 500 kbit/s)
//   - frame:          "t" + 3 hex ID + 1 hex DLC + DLC*2 hex data + "\r"
//   - 115200 8N1, no handshake
//
// A dedicated goroutine reads the port continuously into a large buffered
// channel so high-rate bursts (e.g. a full ReadAll dump) are never dropped by
// the OS tty buffer.
package slcan

import (
	"errors"
	"fmt"
	"time"

	"go.bug.st/serial"
)

// ErrTimeout is returned by Recv when no frame arrives before the deadline.
var ErrTimeout = errors.New("slcan: receive timeout")

// Frame is a classic 11-bit CAN frame.
type Frame struct {
	ID   uint16
	Data []byte // 0..8 bytes
}

// Port is an open SLCAN connection.
type Port struct {
	p      serial.Port
	frames chan Frame
	done   chan struct{}
}

// standard SLCAN S-command bitrate codes
var bitrateCode = map[int]string{
	100000: "3", 125000: "4", 250000: "5", 500000: "6", 1000000: "8",
}

// Open opens the serial port, brings up the SLCAN channel, starts the reader,
// and lets the device settle (early commands are otherwise dropped).
func Open(name string, bitrate int) (*Port, error) {
	p, err := serial.Open(name, &serial.Mode{
		BaudRate: 115200,
		DataBits: 8,
		Parity:   serial.NoParity,
		StopBits: serial.OneStopBit,
	})
	if err != nil {
		return nil, err
	}
	if err := p.SetReadTimeout(50 * time.Millisecond); err != nil {
		p.Close()
		return nil, err
	}

	port := &Port{
		p:      p,
		frames: make(chan Frame, 16384),
		done:   make(chan struct{}),
	}

	code, ok := bitrateCode[bitrate]
	if !ok {
		code = "6" // default 500k
	}
	for _, cmd := range []string{"C\r", "S" + code + "\r", "O\r"} {
		if _, err := p.Write([]byte(cmd)); err != nil {
			p.Close()
			return nil, err
		}
	}

	go port.readLoop()
	port.Drain(1500 * time.Millisecond) // settle + discard startup chatter
	return port, nil
}

// WriteRaw opens the port and writes raw bytes with NO SLCAN framing and no
// open sequence. Old dingoPDM firmware reads up to 8 raw CDC bytes as a CAN
// frame (forcing the id itself), rather than speaking SLCAN on receive.
func WriteRaw(name string, data []byte) error {
	p, err := serial.Open(name, &serial.Mode{
		BaudRate: 115200,
		DataBits: 8,
		Parity:   serial.NoParity,
		StopBits: serial.OneStopBit,
	})
	if err != nil {
		return err
	}
	defer p.Close()
	if _, err := p.Write(data); err != nil {
		return err
	}
	// Let the bytes flush out before the deferred Close tears the port down.
	time.Sleep(200 * time.Millisecond)
	return nil
}

// Close stops the reader, closes the SLCAN channel and the serial port.
func (port *Port) Close() error {
	close(port.done)
	_, _ = port.p.Write([]byte("C\r"))
	return port.p.Close()
}

// Send transmits a CAN frame.
func (port *Port) Send(f Frame) error {
	if len(f.Data) > 8 {
		return fmt.Errorf("slcan: frame too long (%d bytes)", len(f.Data))
	}
	s := fmt.Sprintf("t%03X%X", f.ID&0x7FF, len(f.Data))
	for _, b := range f.Data {
		s += fmt.Sprintf("%02X", b)
	}
	s += "\r"
	_, err := port.p.Write([]byte(s))
	return err
}

// Recv returns the next frame, or ErrTimeout once the timeout elapses.
func (port *Port) Recv(timeout time.Duration) (Frame, error) {
	select {
	case f := <-port.frames:
		return f, nil
	case <-time.After(timeout):
		return Frame{}, ErrTimeout
	}
}

// Flush discards all currently-buffered frames without blocking, so a
// subsequent Recv returns a live frame rather than backlog.
func (port *Port) Flush() {
	for {
		select {
		case <-port.frames:
		default:
			return
		}
	}
}

// Drain discards all buffered/incoming frames for d.
func (port *Port) Drain(d time.Duration) {
	deadline := time.After(d)
	for {
		select {
		case <-port.frames:
		case <-deadline:
			return
		}
	}
}

func (port *Port) readLoop() {
	tmp := make([]byte, 4096)
	var line []byte
	for {
		select {
		case <-port.done:
			return
		default:
		}
		n, err := port.p.Read(tmp)
		if err != nil {
			select {
			case <-port.done:
				return
			default:
				continue
			}
		}
		for i := 0; i < n; i++ {
			b := tmp[i]
			if b == '\r' {
				if f, ok := parseFrame(line); ok {
					// Blocking send: never drop. If we fall behind, back-pressure
					// reaches the device via USB flow control (it blocks on TX-full).
					select {
					case port.frames <- f:
					case <-port.done:
						return
					}
				}
				line = line[:0]
			} else {
				line = append(line, b)
			}
		}
	}
}

func parseFrame(line []byte) (Frame, bool) {
	if len(line) < 5 || line[0] != 't' {
		return Frame{}, false
	}
	id, ok := hexN(line[1:4])
	if !ok {
		return Frame{}, false
	}
	dlc, ok := hexN(line[4:5])
	if !ok || dlc > 8 || len(line) < 5+int(dlc)*2 {
		return Frame{}, false
	}
	data := make([]byte, dlc)
	for i := 0; i < int(dlc); i++ {
		b, ok := hexN(line[5+i*2 : 7+i*2])
		if !ok {
			return Frame{}, false
		}
		data[i] = byte(b)
	}
	return Frame{ID: uint16(id), Data: data}, true
}

func hexN(b []byte) (uint32, bool) {
	var v uint32
	for _, c := range b {
		var d uint32
		switch {
		case c >= '0' && c <= '9':
			d = uint32(c - '0')
		case c >= 'a' && c <= 'f':
			d = uint32(c-'a') + 10
		case c >= 'A' && c <= 'F':
			d = uint32(c-'A') + 10
		default:
			return 0, false
		}
		v = v<<4 | d
	}
	return v, true
}

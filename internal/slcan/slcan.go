// Package slcan implements the minimal SLCAN (serial-line CAN) transport used
// by dingoPDM / dingoFW devices over their USB CDC port.
//
// Wire format (matches the dingoConfig SlcanAdapter):
//   - open sequence: "C\r", "S<code>\r", "O\r"  (S6 = 500 kbit/s)
//   - frame:          "t" + 3 hex ID + 1 hex DLC + DLC*2 hex data + "\r"
//   - 115200 8N1, no handshake
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
	p serial.Port
}

// standard SLCAN S-command bitrate codes
var bitrateCode = map[int]string{
	100000: "3", 125000: "4", 250000: "5", 500000: "6", 1000000: "8",
}

// Open opens the serial port and brings up the SLCAN channel.
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
	if err := p.SetReadTimeout(100 * time.Millisecond); err != nil {
		p.Close()
		return nil, err
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
	return &Port{p: p}, nil
}

// Close closes the SLCAN channel and the serial port.
func (port *Port) Close() error {
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

// Recv reads the next "t" frame, or returns ErrTimeout once the deadline passes.
func (port *Port) Recv(timeout time.Duration) (Frame, error) {
	deadline := time.Now().Add(timeout)
	for {
		line, err := port.readLine(deadline)
		if err != nil {
			return Frame{}, err
		}
		f, ok := parseFrame(line)
		if ok {
			return f, nil
		}
		// non-frame line (status/ack) — keep reading until deadline
	}
}

func (port *Port) readLine(deadline time.Time) ([]byte, error) {
	var buf []byte
	tmp := make([]byte, 64)
	for {
		n, err := port.p.Read(tmp)
		if err != nil {
			return nil, err
		}
		for i := 0; i < n; i++ {
			if tmp[i] == '\r' {
				return buf, nil
			}
			buf = append(buf, tmp[i])
		}
		if n == 0 && time.Now().After(deadline) {
			return nil, ErrTimeout
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

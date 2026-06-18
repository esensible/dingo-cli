// Package dingo implements the dingoFW parameter (SDO-style) protocol over SLCAN.
//
// Every message is a fixed 8-byte CAN frame:
//
//	data[0]   = command (MsgCmd)
//	data[1:3] = parameter index   (uint16, little-endian)
//	data[3]   = parameter subindex (uint8)
//	data[4:8] = value             (uint32, little-endian)
//
// Commands are sent to BaseId+1 (CONFIG_RX_OFFSET); responses arrive on
// BaseId+0 (CONFIG_TX_OFFSET).
package dingo

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"time"

	"dingo-cli/internal/slcan"
)

// MsgCmd values (firmware core/enums.h).
const (
	cmdRead             = 1
	cmdWrite            = 2
	cmdReadAll          = 10
	cmdReadAllRsp       = 11
	cmdReadAllComplete  = 12
	cmdWriteAll         = 20
	cmdWriteAllVal      = 21
	cmdWriteAllComplete = 22
	cmdWriteAllNotFound = 25
	cmdWriteAllOOR      = 26
	cmdBurnSettings     = 30
	cmdVersion          = 31
	cmdSleep            = 32
	cmdBootloader       = 33
	cmdCheckCrc         = 34
	cmdCheckCrcRsp      = 35
)

const (
	configRxOffset = 1 // commands to device
	configTxOffset = 0 // responses from device
)

// Param is a single configuration parameter.
type Param struct {
	Index    uint16 `json:"index"`
	SubIndex uint8  `json:"subIndex"`
	Value    uint32 `json:"value"`
}

type msg struct {
	Cmd      uint8
	Index    uint16
	SubIndex uint8
	Value    uint32
}

// Client speaks the param protocol to a device at a given base id.
type Client struct {
	port    *slcan.Port
	base    uint16
	timeout time.Duration
}

// New wraps an open SLCAN port.
func New(port *slcan.Port, base uint16) *Client {
	return &Client{port: port, base: base, timeout: 2 * time.Second}
}

func (c *Client) Close() error { return c.port.Close() }

func (c *Client) send(cmd uint8, index uint16, sub uint8, val uint32) error {
	d := make([]byte, 8)
	d[0] = cmd
	binary.LittleEndian.PutUint16(d[1:3], index)
	d[3] = sub
	binary.LittleEndian.PutUint32(d[4:8], val)
	return c.port.Send(slcan.Frame{ID: c.base + configRxOffset, Data: d})
}

// waitFor reads responses until one with the wanted command arrives.
func (c *Client) waitFor(cmd uint8, timeout time.Duration) (msg, error) {
	deadline := time.Now().Add(timeout)
	for {
		f, err := c.port.Recv(time.Until(deadline))
		if err != nil {
			return msg{}, err
		}
		if f.ID != c.base+configTxOffset || len(f.Data) < 8 {
			continue
		}
		m := decode(f)
		if m.Cmd == cmd {
			return m, nil
		}
	}
}

func decode(f slcan.Frame) msg {
	return msg{
		Cmd:      f.Data[0],
		Index:    binary.LittleEndian.Uint16(f.Data[1:3]),
		SubIndex: f.Data[3],
		Value:    binary.LittleEndian.Uint32(f.Data[4:8]),
	}
}

// ReadAll reads every parameter from the device.
func (c *Client) ReadAll() ([]Param, error) {
	if err := c.send(cmdReadAll, 0, 0, 0); err != nil {
		return nil, err
	}
	var out []Param
	deadline := time.Now().Add(10 * time.Second)
	for {
		f, err := c.port.Recv(time.Until(deadline))
		if err != nil {
			return nil, err
		}
		if f.ID != c.base+configTxOffset || len(f.Data) < 8 {
			continue
		}
		m := decode(f)
		switch m.Cmd {
		case cmdReadAllRsp:
			out = append(out, Param{Index: m.Index, SubIndex: m.SubIndex, Value: m.Value})
		case cmdReadAllComplete:
			// m.Index = count, m.Value = CRC
			if int(m.Index) != len(out) {
				return out, fmt.Errorf("read count mismatch: device=%d received=%d", m.Index, len(out))
			}
			if got := crcOf(out); got != m.Value {
				return out, fmt.Errorf("read CRC mismatch: device=%08X local=%08X", m.Value, got)
			}
			return out, nil
		}
	}
}

// WriteAll stages all params, commits them, and verifies count + CRC.
// It does not persist to flash — call Burn for that.
func (c *Client) WriteAll(params []Param) error {
	if err := c.send(cmdWriteAll, 0, 0, 0); err != nil {
		return err
	}
	// device emits a start marker; ignore any immediate response
	_, _ = c.waitFor(cmdWriteAll, 500*time.Millisecond)

	for i, p := range params {
		if err := c.send(cmdWriteAllVal, p.Index, p.SubIndex, p.Value); err != nil {
			return err
		}
		if (i+1)%50 == 0 {
			time.Sleep(10 * time.Millisecond) // pace batches, as the firmware does
		}
	}

	if err := c.send(cmdWriteAllComplete, uint16(len(params)), 0, 0); err != nil {
		return err
	}
	resp, err := c.waitFor(cmdWriteAllComplete, c.timeout)
	if err != nil {
		return fmt.Errorf("no WriteAllComplete response: %w", err)
	}
	if int(resp.Index) != len(params) {
		return fmt.Errorf("write count mismatch: device staged %d of %d", resp.Index, len(params))
	}
	if want := crcOf(params); resp.Value != want {
		return fmt.Errorf("write CRC mismatch: device=%08X local=%08X", resp.Value, want)
	}
	return nil
}

// CheckCrc asks the device for the CRC over its current live parameters.
func (c *Client) CheckCrc() (uint32, error) {
	if err := c.send(cmdCheckCrc, 0, 0, 0); err != nil {
		return 0, err
	}
	resp, err := c.waitFor(cmdCheckCrcRsp, c.timeout)
	if err != nil {
		return 0, err
	}
	return resp.Value, nil
}

// Burn persists the live config to flash/FRAM.
// NOTE: envelope confirmed (cmd 30); dispatch not fully traced — verify on hardware.
func (c *Client) Burn() error {
	return c.send(cmdBurnSettings, 0, 0, 0)
}

// Bootloader resets the device into the STM32 DFU bootloader.
// NOTE: envelope confirmed (cmd 33); verify on hardware. The device drops off
// the bus after this.
func (c *Client) Bootloader() error {
	return c.send(cmdBootloader, 0, 0, 0)
}

// crcOf computes the standard CRC-32/IEEE over each param's 4 value bytes
// (little-endian), in order — matching the firmware's accumulation.
func crcOf(params []Param) uint32 {
	buf := make([]byte, 4*len(params))
	for i, p := range params {
		binary.LittleEndian.PutUint32(buf[i*4:], p.Value)
	}
	return crc32.ChecksumIEEE(buf)
}

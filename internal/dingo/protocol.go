// Package dingo implements the dingoFW parameter (SDO-style) protocol over SLCAN.
//
// Every message is a fixed 8-byte CAN frame:
//
//	data[0]   = command (MsgCmd)
//	data[1:3] = parameter index    (uint16, little-endian)
//	data[3]   = parameter subindex (uint8)
//	data[4:8] = value              (uint32, little-endian)
//
// Commands are sent to BaseId+1 (CONFIG_RX_OFFSET); responses arrive on
// BaseId+0 (CONFIG_TX_OFFSET). The device also streams cyclic status on other
// IDs, which we ignore.
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
	cmdBurnSettings     = 30
	cmdVersion          = 31
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
	port *slcan.Port
	base uint16
}

// New wraps an open SLCAN port.
func New(port *slcan.Port, base uint16) *Client { return &Client{port: port, base: base} }

func (c *Client) Close() error { return c.port.Close() }

func (c *Client) sendBytes(d []byte) error {
	return c.port.Send(slcan.Frame{ID: c.base + configRxOffset, Data: d})
}

func frameBytes(cmd uint8, index uint16, sub uint8, val uint32) []byte {
	d := make([]byte, 8)
	d[0] = cmd
	binary.LittleEndian.PutUint16(d[1:3], index)
	d[3] = sub
	binary.LittleEndian.PutUint32(d[4:8], val)
	return d
}

func (c *Client) send(cmd uint8, index uint16, sub uint8, val uint32) error {
	return c.sendBytes(frameBytes(cmd, index, sub, val))
}

func decode(f slcan.Frame) msg {
	return msg{
		Cmd:      f.Data[0],
		Index:    binary.LittleEndian.Uint16(f.Data[1:3]),
		SubIndex: f.Data[3],
		Value:    binary.LittleEndian.Uint32(f.Data[4:8]),
	}
}

// recvResp returns the next protocol response (on base+0), skipping cyclic
// traffic, until the deadline.
func (c *Client) recvResp(deadline time.Time) (msg, bool) {
	for time.Now().Before(deadline) {
		f, err := c.port.Recv(time.Until(deadline))
		if err != nil {
			return msg{}, false
		}
		if f.ID != c.base+configTxOffset || len(f.Data) < 8 {
			continue
		}
		return decode(f), true
	}
	return msg{}, false
}

// requestBytes sends a raw 8-byte command and waits for a response with
// wantCmd, resending if nothing relevant arrives (commands can be dropped while
// the device is busy).
func (c *Client) requestBytes(d []byte, wantCmd uint8) (msg, error) {
	const tries = 6
	for i := 0; i < tries; i++ {
		if err := c.sendBytes(d); err != nil {
			return msg{}, err
		}
		deadline := time.Now().Add(1 * time.Second)
		for {
			m, ok := c.recvResp(deadline)
			if !ok {
				break // try again
			}
			if m.Cmd == wantCmd {
				return m, nil
			}
		}
	}
	return msg{}, fmt.Errorf("no response (want cmd %d) after %d tries", wantCmd, tries)
}

func (c *Client) request(cmd uint8, index uint16, sub uint8, val uint32, wantCmd uint8) (msg, error) {
	return c.requestBytes(frameBytes(cmd, index, sub, val), wantCmd)
}

// SendReadAll sends a ReadAll request without waiting (debug helper).
func (c *Client) SendReadAll() error { return c.send(cmdReadAll, 0, 0, 0) }

// ReadAll reads every parameter from the device.
//
// The device can miss a command sent while it is busy streaming, so ReadAll
// resends the request — but only until the first response arrives ("primed").
// Resending after the dump has started would queue additional full dumps, so we
// stop as soon as the device answers and then collect exactly one dump.
func (c *Client) ReadAll() ([]Param, error) {
	var out []Param
	primed := false
	var lastSend, lastRsp time.Time
	deadline := time.Now().Add(20 * time.Second)

	for time.Now().Before(deadline) {
		if !primed && time.Since(lastSend) > 800*time.Millisecond {
			if err := c.send(cmdReadAll, 0, 0, 0); err != nil {
				return nil, err
			}
			lastSend = time.Now()
		}
		m, ok := c.recvResp(time.Now().Add(300 * time.Millisecond))
		if !ok {
			if primed && time.Since(lastRsp) > 1500*time.Millisecond {
				break // dump finished (completion marker may have been dropped)
			}
			continue
		}
		switch m.Cmd {
		case cmdReadAll, cmdReadAllRsp:
			primed = true
			lastRsp = time.Now()
			if m.Cmd == cmdReadAllRsp {
				out = append(out, Param{Index: m.Index, SubIndex: m.SubIndex, Value: m.Value})
			}
		case cmdReadAllComplete:
			if int(m.Index) != len(out) {
				return out, fmt.Errorf("read count mismatch: device=%d received=%d", m.Index, len(out))
			}
			if got := crcOf(out); got != m.Value {
				return out, fmt.Errorf("read CRC mismatch: device=%08X local=%08X", m.Value, got)
			}
			return out, nil
		}
	}
	if !primed {
		return nil, fmt.Errorf("ReadAll: device not responding")
	}
	// No completion marker — verify the collected set against the device's own CRC.
	devCrc, err := c.CheckCrc()
	if err != nil {
		return out, fmt.Errorf("read ended without completion and CRC check failed (%d params): %w", len(out), err)
	}
	if got := crcOf(out); got != devCrc {
		return out, fmt.Errorf("read CRC mismatch (frames lost): device=%08X local=%08X over %d params", devCrc, got, len(out))
	}
	return out, nil
}

// WriteAll stages all params, commits them, and verifies count + CRC.
// It does not persist to flash — call Burn for that.
func (c *Client) WriteAll(params []Param) error {
	if _, err := c.request(cmdWriteAll, 0, 0, 0, cmdWriteAll); err != nil {
		return fmt.Errorf("WriteAll start: %w", err)
	}
	for i, p := range params {
		if err := c.send(cmdWriteAllVal, p.Index, p.SubIndex, p.Value); err != nil {
			return err
		}
		if (i+1)%50 == 0 {
			time.Sleep(10 * time.Millisecond) // pace batches as the firmware does
		}
	}
	resp, err := c.request(cmdWriteAllComplete, uint16(len(params)), 0, 0, cmdWriteAllComplete)
	if err != nil {
		return fmt.Errorf("WriteAll complete: %w", err)
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
	resp, err := c.request(cmdCheckCrc, 0, 0, 0, cmdCheckCrcRsp)
	if err != nil {
		return 0, err
	}
	return resp.Value, nil
}

// Burn persists the live config to flash and verifies the device's ack. The
// firmware requires the magic payload [30,1,3,8] and replies with WriteConfig()'s
// result in byte 4 (1 = success).
func (c *Client) Burn() error {
	resp, err := c.requestBytes([]byte{cmdBurnSettings, 1, 3, 8, 0, 0, 0, 0}, cmdBurnSettings)
	if err != nil {
		return err
	}
	if resp.Value&0xFF != 1 {
		return fmt.Errorf("burn rejected: device WriteConfig returned %d", resp.Value&0xFF)
	}
	return nil
}

// Bootloader resets the device into the STM32 DFU bootloader. Requires the
// "BOOTL" payload; fire-and-forget (the device resets, so there is no ack).
func (c *Client) Bootloader() error {
	return c.sendBytes([]byte{cmdBootloader, 'B', 'O', 'O', 'T', 'L', 0, 0})
}

// Version reads the firmware version (major, minor, build).
func (c *Client) Version() (major, minor, build int, err error) {
	resp, e := c.requestBytes([]byte{cmdVersion, 0, 0, 0, 0, 0, 0, 0}, cmdVersion)
	if e != nil {
		return 0, 0, 0, e
	}
	major = int(resp.Value & 0xFF)
	minor = int((resp.Value >> 8) & 0xFF)
	build = int(((resp.Value>>16)&0xFF)<<8 | ((resp.Value >> 24) & 0xFF))
	return major, minor, build, nil
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

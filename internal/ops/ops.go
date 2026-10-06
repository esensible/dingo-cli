// Package ops holds the device operations the dingo CLI exposes (apply, set,
// getn, get, verify, version, burn, read-all) as plain functions over a
// *dingo.Client, plus the pure dingoConfig-file helpers they need. The CLI
// (main.go) and the browser build (web/wasm) both call these, so there is one
// implementation of each operation; the callers only differ in how they report
// results (stdout vs a JavaScript object).
//
// Nothing here prints. Where the CLI prints between two steps of an operation
// (apply prints the "applied" line before burning), the step boundary is a
// callback so the CLI's output order is unchanged.
package ops

import (
	"fmt"
	"time"

	"dingo-cli/internal/dingo"
	"dingo-cli/internal/params"
	"dingo-cli/internal/pdmcfg"
)

// EncodeConfig projects the PDM in a dingoConfig file selected by base into wire
// params — exactly what `dingo apply` writes. The selection rule is pdmcfg's: the
// PdmDevices entry whose baseId matches, or the only entry if there is just one.
func EncodeConfig(data []byte, base uint16, partial bool) ([]dingo.Param, error) {
	return pdmcfg.DeviceParamsOpts(data, base, pdmcfg.Options{Partial: partial})
}

// ConfigBoard is the board (parameter table) EncodeConfig encodes the selected
// device against: its pdmType, else its output count.
func ConfigBoard(data []byte, base uint16) (params.Board, error) {
	return pdmcfg.DeviceBoard(data, base)
}

// ApplyOptions tunes Apply.
type ApplyOptions struct {
	// Burn persists to flash after a verified write.
	Burn bool
	// AfterWrite, when non-nil, runs after the write is verified and before
	// any burn (the CLI prints its "applied" line here).
	AfterWrite func(applied int)
}

// ApplyResult reports what Apply did. On a burn failure it is still filled in
// for the (verified) write that preceded it.
type ApplyResult struct {
	Applied int    // params written and verified by count
	CRC     uint32 // config CRC, verified against the device
	Burned  bool   // persisted to flash
}

// Apply writes cfg with WriteAll (which verifies the device's count and CRC),
// then optionally burns.
func Apply(cl *dingo.Client, cfg []dingo.Param, opt ApplyOptions) (ApplyResult, error) {
	if err := cl.WriteAll(cfg); err != nil {
		return ApplyResult{}, err
	}
	res := ApplyResult{Applied: len(cfg), CRC: dingo.CRC(cfg)}
	if opt.AfterWrite != nil {
		opt.AfterWrite(res.Applied)
	}
	if opt.Burn {
		if err := cl.Burn(); err != nil {
			return res, err
		}
		res.Burned = true
	}
	return res, nil
}

// statusOffset is CYCLIC_TX_OFFSET (core/device_config.h): a node's first
// cyclic frame is base+2.
const statusOffset = 2

// BroadcastType listens on t for up to wait for the node's first status frame
// (base+2) and returns the board type it carries: the high nibble of byte 1,
// which every PDM-type board sets to PDM_TYPE (boards/*/msg.cpp
// `GetDeviceState() + (PDM_TYPE << 4)`; c6body_v1 sends 0xC). It returns as
// soon as one arrives; seen is false if none did (the node is off the bus,
// or cyclic frames are not sent). Other traffic is consumed and discarded, so
// call it before a protocol exchange, not during one.
func BroadcastType(t dingo.Transport, base uint16, wait time.Duration) (typ int, seen bool) {
	deadline := time.Now().Add(wait)
	for {
		left := time.Until(deadline)
		if left <= 0 {
			return 0, false
		}
		f, err := t.Recv(left)
		if err != nil {
			continue
		}
		if f.ID == base+statusOffset && len(f.Data) >= 2 {
			return int(f.Data[1] >> 4), true
		}
	}
}

// CheckType refuses to write a config for board b to a node that broadcasts
// a different board type. CANBoards broadcast no type, so a CANBoard table is
// never checked.
func CheckType(b params.Board, base uint16, typ int) error {
	if b.IsCanboard || typ == b.PdmType {
		return nil
	}
	dev := "an unknown board"
	for _, o := range params.Boards() {
		if !o.IsCanboard && o.PdmType == typ {
			dev = o.Name
		}
	}
	return fmt.Errorf("the node at base 0x%03X broadcasts board type %d (%s) but the config is for %s (pdmType %d): wrong base id or wrong config",
		base, typ, dev, b.Name, b.PdmType)
}

// Burn persists the live config to flash and checks the device's ack.
func Burn(cl *dingo.Client) error { return cl.Burn() }

// Verify returns the device's CRC over its live config (`dingo verify`).
func Verify(cl *dingo.Client) (uint32, error) { return cl.CheckCrc() }

// Version is a firmware version.
type Version struct{ Major, Minor, Build int }

func (v Version) String() string { return fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Build) }

// ReadVersion reads the firmware version (`dingo version`).
func ReadVersion(cl *dingo.Client) (Version, error) {
	maj, min, bld, err := cl.Version()
	if err != nil {
		return Version{}, err
	}
	return Version{maj, min, bld}, nil
}

// ReadAll dumps every live param and returns them with their CRC (verified
// against the device's completion marker or, failing that, CheckCrc).
func ReadAll(cl *dingo.Client) ([]dingo.Param, uint32, error) {
	ps, err := cl.ReadAll()
	if err != nil {
		return nil, 0, err
	}
	return ps, dingo.CRC(ps), nil
}

// ResolveParam looks a parameter up by name (e.g. "output[4].currentLimit").
// Like `dingo set`/`getn` without -type, names resolve against
// params.DefaultBoard().
func ResolveParam(name string) (*params.Def, error) {
	return ResolveParamFor(params.DefaultBoard(), name)
}

// ResolveParamFor looks a parameter up by name in board b's table.
func ResolveParamFor(b params.Board, name string) (*params.Def, error) {
	d, ok := params.NewRegistry(b).Lookup(name)
	if !ok {
		return nil, fmt.Errorf("unknown param: %s", name)
	}
	return d, nil
}

// EncodeParam resolves name and encodes value for it (range-checked against the
// firmware table). value is a string as typed on the command line, or a
// float64/bool as JSON decodes it.
func EncodeParam(name string, value interface{}) (*params.Def, uint32, error) {
	return EncodeParamFor(params.DefaultBoard(), name, value)
}

// EncodeParamFor is EncodeParam against board b: its table, and its var map
// for a variable name ("CanIn1Out" is var 7 on a dingoPDM, 3 on c6body_v1).
func EncodeParamFor(b params.Board, name string, value interface{}) (*params.Def, uint32, error) {
	reg := params.NewRegistry(b)
	d, ok := reg.Lookup(name)
	if !ok {
		return nil, 0, fmt.Errorf("unknown param: %s", name)
	}
	v, err := reg.Encode(d, value)
	if err != nil {
		return nil, 0, err
	}
	return d, v, nil
}

// ParamValue is one named parameter as stored on the device.
type ParamValue struct {
	Def   *params.Def
	Raw   uint32      // wire value
	Value interface{} // decoded (bool, number, enum name, var name)
}

// Set writes one encoded parameter to the live config and verifies the echo
// (`dingo set`, without the optional burn).
func Set(cl *dingo.Client, d *params.Def, raw uint32) (ParamValue, error) {
	return SetFor(cl, params.DefaultBoard(), d, raw)
}

// SetFor is Set for board b (its var map names the decoded value).
func SetFor(cl *dingo.Client, b params.Board, d *params.Def, raw uint32) (ParamValue, error) {
	if err := cl.SetParam(d.Index, d.Sub, raw); err != nil {
		return ParamValue{}, err
	}
	return ParamValue{Def: d, Raw: raw, Value: params.NewRegistry(b).Decode(d, raw)}, nil
}

// Get reads one named parameter (`dingo getn`).
func Get(cl *dingo.Client, d *params.Def) (ParamValue, error) {
	return GetFor(cl, params.DefaultBoard(), d)
}

// GetFor is Get for board b (its var map names the decoded value).
func GetFor(cl *dingo.Client, b params.Board, d *params.Def) (ParamValue, error) {
	v, err := cl.ReadParam(d.Index, d.Sub)
	if err != nil {
		return ParamValue{}, err
	}
	return ParamValue{Def: d, Raw: v, Value: params.NewRegistry(b).Decode(d, v)}, nil
}

// GetRaw reads one parameter by index/subindex (`dingo get`).
func GetRaw(cl *dingo.Client, index uint16, sub uint8) (uint32, error) {
	return cl.ReadParam(index, sub)
}

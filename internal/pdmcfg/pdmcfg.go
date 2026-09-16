// Package pdmcfg reads a dingoConfig JSON file (the canonical, GUI-authored
// format) and projects a chosen PDM device directly into wire parameters for
// WriteAll. There is no intermediate model: the dingoConfig field names are
// bridged to firmware (index, subindex) here, and value types/encoding are
// reused from the params registry.
//
// A field the document does not mention is written at the FIRMWARE DEFAULT, not
// skipped. This matches the GUI, whose model objects carry field initialisers
// agreeing with the firmware defaults, so loading a partial document there still
// yields a fully-defined configuration. Skipping would instead leave the device
// holding whatever the previous config put in that field, which means the same
// JSON applied to two differently-configured devices produces two different
// devices — the document would not actually define the state it appears to.
//
// The defaults come from the params registry, never from Go zero values. That
// distinction is load-bearing: `bitrate` 0 is 1000 kbit/s rather than "unset",
// and `primaryOutput` 0 pairs an output, where "unpaired" is -1.
package pdmcfg

import (
	"encoding/json"
	"fmt"
	"sort"

	"dingo-cli/internal/dingo"
	"dingo-cli/internal/params"
)

// fieldMap bridges a dingoConfig JSON field name to a firmware subindex.
type fieldMap struct {
	json string
	sub  uint8
}

// instGroup is an instanced array of function objects (one param block per
// element, at base + arrayIndex).
type instGroup struct {
	key    string // dingoConfig JSON array key
	base   uint16
	fields []fieldMap
}

// device-level scalar fields live directly on the PdmDevice object (index 0).
var deviceFields = []fieldMap{
	{"baseId", 0}, {"bitrate", 1}, {"sleepEnabled", 2}, {"filtersEnabled", 3}, {"connectUsbToCan", 4},
}

var instGroups = []instGroup{
	{"outputs", 0x1000, []fieldMap{
		{"enabled", 0}, {"input", 1}, {"currentLimit", 2}, {"inrushCurrentLimit", 3},
		{"inrushTime", 4}, {"resetMode", 5}, {"resetTime", 6}, {"resetCountLimit", 7},
		{"pwmEnabled", 8}, {"softStartEnabled", 9}, {"variableDutyCycle", 10}, {"dutyCycleInput", 11},
		{"fixedDutyCycle", 12}, {"frequency", 13}, {"softStartRampTime", 14}, {"dutyCycleDenominator", 15},
		{"minDutyCycle", 16}, {"primaryOutput", 17},
	}},
	{"inputs", 0x1200, []fieldMap{
		{"enabled", 0}, {"mode", 1}, {"invert", 2}, {"debounceTime", 3}, {"pull", 4},
	}},
	{"canInputs", 0x1300, []fieldMap{
		{"enabled", 0}, {"timeoutEnabled", 1}, {"timeout", 2}, {"ide", 3}, {"id", 4},
		{"startBit", 5}, {"bitLength", 6}, {"factor", 7}, {"offset", 8}, {"byteOrder", 9},
		{"signed", 10}, {"operator", 11}, {"operand", 12}, {"mode", 13},
	}},
	{"canOutputs", 0x2000, []fieldMap{
		{"enabled", 0}, {"input", 1}, {"ide", 2}, {"id", 3}, {"startBit", 4}, {"bitLength", 5},
		{"factor", 6}, {"offset", 7}, {"byteOrder", 8}, {"signed", 9}, {"interval", 10},
	}},
	{"virtualInputs", 0x1400, []fieldMap{
		{"enabled", 0}, {"not0", 1}, {"var0", 2}, {"cond0", 3}, {"not1", 4}, {"var1", 5},
		{"cond1", 6}, {"not2", 7}, {"var2", 8}, {"mode", 9},
	}},
	{"conditions", 0x1500, []fieldMap{
		{"enabled", 0}, {"input", 1}, {"operator", 2}, {"arg", 3},
	}},
	{"counters", 0x1600, []fieldMap{
		{"enabled", 0}, {"incInput", 1}, {"decInput", 2}, {"resetInput", 3}, {"minCount", 4},
		{"maxCount", 5}, {"incEdge", 6}, {"decEdge", 7}, {"resetEdge", 8}, {"wrapAround", 9},
		{"holdToReset", 10}, {"resetTime", 11},
	}},
	{"flashers", 0x1700, []fieldMap{
		{"enabled", 0}, {"input", 1}, {"onTime", 2}, {"offTime", 3}, {"single", 4},
	}},
}

var wiperFields = []fieldMap{
	{"enabled", 0}, {"mode", 1}, {"slowInput", 2}, {"fastInput", 3}, {"interInput", 4},
	{"onInput", 5}, {"speedInput", 6}, {"parkInput", 7}, {"parkStopLevel", 8}, {"swipeInput", 9},
	{"washInput", 10}, {"washWipeCycles", 11},
}

var keypadFields = []fieldMap{
	{"enabled", 0}, {"id", 1}, {"timeoutEnabled", 2}, {"timeout", 3}, {"model", 4},
	{"backlightBrightness", 5}, {"dimBacklightBrightness", 6}, {"backlightButtonColor", 7},
	{"dimmingVar", 8}, {"buttonBrightness", 9}, {"dimButtonBrightness", 10},
}

var buttonFields = []fieldMap{
	{"enabled", 0}, {"mode", 1}, {"faultColor", 6}, {"faultVar", 11}, {"faultBlink", 16}, {"faultBlinkColor", 21},
}

var dialFields = []fieldMap{
	{"enabled", 0}, {"minCount", 1}, {"maxCount", 2}, {"ledOffset", 3},
}

type configFile struct {
	PdmDevices []json.RawMessage `json:"PdmDevices"`
}

// Options tunes the projection.
type Options struct {
	// Partial restores the historical behaviour of writing only the fields the
	// document mentions, leaving the device's previous value in place for
	// everything else. It exists for the "patch one field on a live device"
	// workflow; it does not produce a fully-defined device.
	Partial bool
}

// DeviceParams parses a dingoConfig file and projects the PDM device whose
// baseId matches target into wire params. If the file has exactly one PDM, it is
// used regardless of baseId.
//
// Every parameter the target board has is written: fields the document omits
// take the firmware default.
func DeviceParams(data []byte, target uint16) ([]dingo.Param, error) {
	return DeviceParamsOpts(data, target, Options{})
}

// DeviceParamsOpts is DeviceParams with explicit options.
func DeviceParamsOpts(data []byte, target uint16, opt Options) ([]dingo.Param, error) {
	var f configFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("parse dingoConfig file: %w", err)
	}
	if len(f.PdmDevices) == 0 {
		return nil, fmt.Errorf("no PdmDevices in file")
	}

	var chosen map[string]json.RawMessage
	var ids []int
	for _, raw := range f.PdmDevices {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, fmt.Errorf("parse PdmDevice: %w", err)
		}
		var bid int
		if b, ok := m["baseId"]; ok {
			json.Unmarshal(b, &bid)
		}
		ids = append(ids, bid)
		if uint16(bid) == target {
			chosen = m
		}
	}
	if chosen == nil {
		if len(f.PdmDevices) == 1 {
			json.Unmarshal(f.PdmDevices[0], &chosen)
		} else {
			return nil, fmt.Errorf("no PDM with baseId %d in file (have %v); use -base to pick one", target, ids)
		}
	}
	return project(chosen, opt)
}

// boardOf picks the parameter table to project against.
//
// pdmType is authoritative when present — it is the discriminator the GUI
// writes. Failing that, the number of outputs identifies the variant well
// enough (8 for a dingoPDM, 4 for a Max or PT-DPDM), and a document that
// matches nothing falls back to the board this CLI has always assumed.
func boardOf(m map[string]json.RawMessage) params.Board {
	if raw, ok := m["pdmType"]; ok {
		var t int
		if json.Unmarshal(raw, &t) == nil {
			for _, b := range params.Boards() {
				if !b.IsCanboard && b.PdmType == t {
					return b
				}
			}
		}
	}
	if raw, ok := m["outputs"]; ok {
		var arr []json.RawMessage
		if json.Unmarshal(raw, &arr) == nil {
			for _, b := range params.Boards() {
				if !b.IsCanboard && b.Outputs == len(arr) {
					return b
				}
			}
		}
	}
	return params.DefaultBoard()
}

// values is every scalar the document supplies, keyed by index<<8|sub.
type values map[uint32]interface{}

func key(index uint16, sub uint8) uint32 { return uint32(index)<<8 | uint32(sub) }

func project(m map[string]json.RawMessage, opt Options) ([]dingo.Param, error) {
	board := boardOf(m)
	reg := params.NewRegistry(board)

	vals := values{}

	// Device-level scalars (index 0x0000).
	for _, fm := range deviceFields {
		if err := collectField(vals, m, fm.json, 0x0000, fm.sub); err != nil {
			return nil, err
		}
	}

	// Instanced function arrays (base + array index).
	for _, g := range instGroups {
		arr, err := array(m, g.key)
		if err != nil {
			return nil, err
		}
		for i, inst := range arr {
			base := g.base + uint16(i)
			for _, fm := range g.fields {
				if err := collectField(vals, inst, fm.json, base, fm.sub); err != nil {
					return nil, err
				}
			}
		}
	}

	// Wiper (single object at 0x1900) with its two scalar arrays.
	if w, err := object(m, "wipers"); err != nil {
		return nil, err
	} else if w != nil {
		for _, fm := range wiperFields {
			if err := collectField(vals, w, fm.json, 0x1900, fm.sub); err != nil {
				return nil, err
			}
		}
		if err := collectArray(vals, w, "speedMap", 0x1900, 12); err != nil {
			return nil, err
		}
		if err := collectArray(vals, w, "intermitTime", 0x1900, 20); err != nil {
			return nil, err
		}
	}

	// Starter disable (single object at 0x1800) with the per-output disable array.
	if s, err := object(m, "starterDisable"); err != nil {
		return nil, err
	} else if s != nil {
		if err := collectField(vals, s, "enabled", 0x1800, 0); err != nil {
			return nil, err
		}
		if err := collectField(vals, s, "input", 0x1800, 1); err != nil {
			return nil, err
		}
		if err := collectArray(vals, s, "outputsDisabled", 0x1800, 2); err != nil {
			return nil, err
		}
	}

	// Keypads (base 0x3000+k), each with buttons (0x3100+k*32+b) and dials (0x3200+k*4+d).
	keypads, err := array(m, "keypads")
	if err != nil {
		return nil, err
	}
	for k, kp := range keypads {
		kbase := uint16(0x3000 + k)
		for _, fm := range keypadFields {
			if err := collectField(vals, kp, fm.json, kbase, fm.sub); err != nil {
				return nil, err
			}
		}
		btns, err := array(kp, "buttons")
		if err != nil {
			return nil, err
		}
		for b, bt := range btns {
			bbase := uint16(0x3100 + k*32 + b)
			for _, fm := range buttonFields {
				if err := collectField(vals, bt, fm.json, bbase, fm.sub); err != nil {
					return nil, err
				}
			}
			for _, a := range []struct {
				json string
				sub  uint8
			}{{"valColors", 2}, {"valVars", 7}, {"valBlink", 12}, {"blinkColors", 17}} {
				if err := collectArray(vals, bt, a.json, bbase, a.sub); err != nil {
					return nil, err
				}
			}
		}
		dials, err := array(kp, "dials")
		if err != nil {
			return nil, err
		}
		for d, dl := range dials {
			dbase := uint16(0x3200 + k*4 + d)
			for _, fm := range dialFields {
				if err := collectField(vals, dl, fm.json, dbase, fm.sub); err != nil {
					return nil, err
				}
			}
		}
	}

	// Every field the document supplied must name a real parameter; a document
	// that carries more slots than the board has is a mismatch worth failing on
	// rather than silently dropping.
	for k := range vals {
		if _, ok := reg.LookupKey(uint16(k>>8), uint8(k)); !ok {
			return nil, fmt.Errorf("no firmware param for index 0x%04X sub %d on board %s",
				uint16(k>>8), uint8(k), board.Name)
		}
	}

	// Emit, driving from the registry so nothing the board has is left out.
	defs := reg.All()
	out := make([]dingo.Param, 0, len(defs))
	for i := range defs {
		d := &defs[i]
		v, present := vals[key(d.Index, d.Sub)]
		if !present {
			if opt.Partial {
				continue
			}
			// Natural units, from the firmware's own table. Never a Go zero.
			v = d.Default
		}
		val, err := reg.Encode(d, v)
		if err != nil {
			return nil, err
		}
		out = append(out, dingo.Param{Index: d.Index, SubIndex: d.Sub, Value: val})
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Index != out[j].Index {
			return out[i].Index < out[j].Index
		}
		return out[i].SubIndex < out[j].SubIndex
	})
	return out, nil
}

// collectField records one JSON scalar. Absent or null fields are left for the
// registry default (or, with Options.Partial, left off the wire entirely).
func collectField(vals values, m map[string]json.RawMessage, jsonField string, index uint16, sub uint8) error {
	raw, ok := m[jsonField]
	if !ok {
		return nil
	}
	var v interface{}
	if err := json.Unmarshal(raw, &v); err != nil {
		return fmt.Errorf("0x%04X.%d (%s): %w", index, sub, jsonField, err)
	}
	if v == nil {
		return nil
	}
	vals[key(index, sub)] = v
	return nil
}

// collectArray records a JSON array-of-scalars into consecutive subindices.
func collectArray(vals values, m map[string]json.RawMessage, jsonField string, index uint16, subStart uint8) error {
	raw, ok := m[jsonField]
	if !ok {
		return nil
	}
	var arr []interface{}
	if err := json.Unmarshal(raw, &arr); err != nil {
		return fmt.Errorf("0x%04X (%s): %w", index, jsonField, err)
	}
	for i, v := range arr {
		if v == nil {
			continue
		}
		vals[key(index, subStart+uint8(i))] = v
	}
	return nil
}

// array returns a JSON array of objects under key, or nil if absent.
func array(m map[string]json.RawMessage, key string) ([]map[string]json.RawMessage, error) {
	raw, ok := m[key]
	if !ok {
		return nil, nil
	}
	var arr []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil, fmt.Errorf("%s: %w", key, err)
	}
	return arr, nil
}

// object returns a JSON object under key, or nil if absent.
func object(m map[string]json.RawMessage, key string) (map[string]json.RawMessage, error) {
	raw, ok := m[key]
	if !ok {
		return nil, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, fmt.Errorf("%s: %w", key, err)
	}
	return obj, nil
}

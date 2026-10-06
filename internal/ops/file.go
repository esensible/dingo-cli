package ops

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"dingo-cli/internal/params"
)

// Entry is one device entry in a dingoConfig file.
type Entry struct {
	Kind    string // top-level array key, e.g. "PdmDevices", "CanboardDevices"
	Name    string // "name" field ("" if absent)
	BaseID  *int   // "baseId" field, nil if absent or not an integer
	PdmType *int   // "pdmType" field, nil if absent or not an integer
}

// Devices lists every device entry in a dingoConfig file: each element of each
// top-level array, PdmDevices first, then the other kinds alphabetically, each
// in file order. Malformed JSON is reported with its line and column.
func Devices(data []byte) ([]Entry, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(data, &top); err != nil {
		return nil, JSONError(data, err)
	}
	if top == nil {
		return nil, errors.New("dingoConfig file is JSON null; expected an object with a PdmDevices array")
	}
	keys := make([]string, 0, len(top))
	for k := range top {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if (keys[i] == "PdmDevices") != (keys[j] == "PdmDevices") {
			return keys[i] == "PdmDevices"
		}
		return keys[i] < keys[j]
	})
	var out []Entry
	for _, k := range keys {
		raw := bytes.TrimSpace(top[k])
		if len(raw) == 0 || raw[0] != '[' {
			if k == "PdmDevices" {
				return nil, fmt.Errorf("PdmDevices is not an array")
			}
			continue
		}
		var arr []json.RawMessage
		if err := json.Unmarshal(raw, &arr); err != nil {
			return nil, fmt.Errorf("%s: %w", k, err)
		}
		for i, el := range arr {
			var m map[string]json.RawMessage
			if err := json.Unmarshal(el, &m); err != nil {
				if k == "PdmDevices" {
					return nil, fmt.Errorf("PdmDevices[%d] is not an object: %w", i, err)
				}
				continue
			}
			e := Entry{Kind: k}
			if v, ok := m["name"]; ok {
				_ = json.Unmarshal(v, &e.Name)
			}
			e.BaseID = intField(m, "baseId")
			e.PdmType = intField(m, "pdmType")
			out = append(out, e)
		}
	}
	return out, nil
}

func intField(m map[string]json.RawMessage, k string) *int {
	v, ok := m[k]
	if !ok {
		return nil
	}
	var n int
	if json.Unmarshal(v, &n) != nil {
		return nil
	}
	return &n
}

// Selection is the PdmDevices entry an apply/encode would use.
type Selection struct {
	Entry Entry
	// Fallback is true when base was given, did not match, and the entry was
	// used anyway because it is the file's only PDM (pdmcfg's rule, and so
	// `dingo apply`'s). The params then carry the file's baseId, not base.
	Fallback bool
}

// SelectPdm picks the PdmDevices entry for base, mirroring pdmcfg's rule (the
// entry whose baseId matches — the last one if several do — or the only entry if
// there is just one), but with errors that list what the file contains. A nil
// base means "the file's only PDM".
func SelectPdm(entries []Entry, base *int) (Selection, error) {
	var pdms []Entry
	var others []string
	for _, e := range entries {
		if e.Kind == "PdmDevices" {
			pdms = append(pdms, e)
		} else {
			others = append(others, e.Kind)
		}
	}
	if len(pdms) == 0 {
		msg := "no PdmDevices in file"
		if len(others) > 0 {
			msg += fmt.Sprintf(" (it has %d other entries: %s)", len(others), strings.Join(uniq(others), ", "))
		}
		return Selection{}, errors.New(msg)
	}
	if base == nil {
		if len(pdms) == 1 {
			return Selection{Entry: pdms[0]}, nil
		}
		return Selection{}, fmt.Errorf("file has %d PdmDevices entries; pass a base id to choose one: %s",
			len(pdms), describe(pdms))
	}
	var hit *Entry
	for i := range pdms {
		if pdms[i].BaseID != nil && *pdms[i].BaseID == *base {
			hit = &pdms[i]
		} else if pdms[i].BaseID == nil && *base == 0 {
			hit = &pdms[i] // pdmcfg reads an absent/non-integer baseId as 0
		}
	}
	if hit != nil {
		return Selection{Entry: *hit}, nil
	}
	if len(pdms) == 1 {
		return Selection{Entry: pdms[0], Fallback: true}, nil
	}
	return Selection{}, fmt.Errorf("no PdmDevices entry with baseId %d (0x%03X); file has: %s",
		*base, *base, describe(pdms))
}

func describe(pdms []Entry) string {
	parts := make([]string, len(pdms))
	for i, e := range pdms {
		id := "no baseId"
		if e.BaseID != nil {
			id = fmt.Sprintf("%d (0x%03X)", *e.BaseID, *e.BaseID)
		}
		if e.Name != "" {
			id += fmt.Sprintf(" %q", e.Name)
		}
		parts[i] = id
	}
	return strings.Join(parts, ", ")
}

func uniq(ss []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range ss {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// JSONError rewrites an encoding/json error over data to say where in the text
// it is (line and column, 1-based) when the error carries an offset.
func JSONError(data []byte, err error) error {
	var syn *json.SyntaxError
	var typ *json.UnmarshalTypeError
	switch {
	case errors.As(err, &syn):
		l, c := lineCol(data, syn.Offset)
		return fmt.Errorf("malformed JSON at line %d, column %d (byte %d): %v", l, c, syn.Offset, syn)
	case errors.As(err, &typ):
		l, c := lineCol(data, typ.Offset)
		where := ""
		if typ.Field != "" {
			where = " in field " + typ.Field
		}
		return fmt.Errorf("unexpected JSON %s at line %d, column %d%s (expected %s)", typ.Value, l, c, where, typ.Type)
	}
	return fmt.Errorf("parse dingoConfig file: %w", err)
}

// lineCol converts a byte offset as encoding/json reports it (the number of
// bytes consumed when the error was detected) to a 1-based line and column.
func lineCol(data []byte, off int64) (int, int) {
	if off > int64(len(data)) {
		off = int64(len(data))
	}
	if off < 1 {
		return 1, 1
	}
	pos := int(off) - 1 // the offending byte
	line := 1 + bytes.Count(data[:pos], []byte("\n"))
	col := pos - bytes.LastIndexByte(data[:pos], '\n')
	return line, col
}

// Board returns the parameter table for a dingoConfig pdmType (a PDM variant;
// CANBoard is not a PdmDevice).
func Board(pdmType int) (params.Board, error) {
	var valid []string
	for _, b := range params.Boards() {
		if b.IsCanboard {
			continue
		}
		if b.PdmType == pdmType {
			return b, nil
		}
		valid = append(valid, fmt.Sprintf("%d (%s)", b.PdmType, b.Name))
	}
	return params.Board{}, fmt.Errorf("unknown pdmType %d (valid: %s)", pdmType, strings.Join(valid, ", "))
}

// ParamNames lists every parameter name for a board, in registry order.
func ParamNames(b params.Board) []string {
	defs := params.NewRegistry(b).All()
	out := make([]string, len(defs))
	for i, d := range defs {
		out[i] = d.Name
	}
	return out
}

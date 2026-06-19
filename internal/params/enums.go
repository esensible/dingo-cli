package params

import "strings"

// Enum tables, mirroring DingoPDM_FW/core/enums.h. Each enum is an ORDERED list
// so decode is deterministic: the first entry for a given value is the canonical
// name. Later entries with the same value are accepted aliases on input (e.g.
// "Intel" for LittleEndian) but never emitted. Config values may be given as an
// enumerator name (case-insensitive) or the raw integer.
type enumEntry struct {
	name string
	val  uint32
}

var enumDefs = map[string][]enumEntry{
	"CanBitrate": {
		{"1000K", 0}, {"500K", 1}, {"250K", 2}, {"125K", 3}, {"100K", 4},
	},
	"ByteOrder": {
		{"LittleEndian", 0}, {"Intel", 0}, {"BigEndian", 1}, {"Motorola", 1},
	},
	"InputMode": {
		{"Momentary", 0}, {"Latching", 1},
	},
	"InputEdge": {
		{"Rising", 0}, {"Falling", 1}, {"Both", 2},
	},
	"InputPull": {
		{"None", 0}, {"Up", 1}, {"Down", 2},
	},
	"Operator": {
		{"Equal", 0}, {"NotEqual", 1}, {"GreaterThan", 2}, {"LessThan", 3},
		{"GreaterThanOrEqual", 4}, {"LessThanOrEqual", 5}, {"BitwiseAnd", 6}, {"BitwiseNand", 7},
	},
	"BoolOperator": {
		{"And", 0}, {"Or", 1}, {"Nor", 2},
	},
	"ProfetResetMode": {
		{"None", 0}, {"Count", 1}, {"Endless", 2},
	},
	"WiperMode": {
		{"DigIn", 0}, {"IntIn", 1}, {"MixIn", 2},
	},
	"WiperSpeed": {
		{"Park", 0}, {"Slow", 1}, {"Fast", 2},
		{"Intermittent1", 3}, {"Intermittent2", 4}, {"Intermittent3", 5},
		{"Intermittent4", 6}, {"Intermittent5", 7}, {"Intermittent6", 8},
	},
	"KeypadModel": {
		{"Blink2Key", 0}, {"Blink4Key", 1}, {"Blink5Key", 2}, {"Blink6Key", 3},
		{"Blink8Key", 4}, {"Blink10Key", 5}, {"Blink12Key", 6}, {"Blink15Key", 7},
		{"Blink15Key2Dial", 8}, {"Grayhill1Key", 10}, {"Grayhill6Key", 20},
		{"Grayhill8Key", 21}, {"Grayhill12Key", 22}, {"Grayhill15Key", 23}, {"Grayhill20Key", 24},
	},
}

// canonical[enum][value] = the name decode should emit (first declared).
var canonical = map[string]map[uint32]string{}

func init() {
	for enum, entries := range enumDefs {
		m := map[uint32]string{}
		for _, e := range entries {
			if _, seen := m[e.val]; !seen {
				m[e.val] = e.name
			}
		}
		canonical[enum] = m
	}
}

// EnumValue resolves an enumerator name (case-insensitive) within an enum type.
func EnumValue(enum, name string) (uint32, bool) {
	want := strings.ToLower(strings.TrimSpace(name))
	for _, e := range enumDefs[enum] {
		if strings.ToLower(e.name) == want {
			return e.val, true
		}
	}
	return 0, false
}

// EnumName returns the canonical name for a value, or "" if unknown.
func EnumName(enum string, val uint32) string {
	if m, ok := canonical[enum]; ok {
		return m[val]
	}
	return ""
}

// EnumNames lists the valid enumerator names for an enum (declaration order).
func EnumNames(enum string) []string {
	entries := enumDefs[enum]
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.name)
	}
	return out
}

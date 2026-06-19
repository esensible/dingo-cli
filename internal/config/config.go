// Package config turns a name->value configuration object into wire parameters
// and back. It is pure (no I/O, no process exit), so the apply/dump pipelines are
// unit-testable independently of the transport and the CLI.
package config

import (
	"fmt"
	"sort"
	"strings"

	"dingo-cli/internal/dingo"
	"dingo-cli/internal/params"
)

// Resolve converts a name->value object into wire params, sorted by index/sub
// for deterministic output. It reports ALL bad keys at once (not just the first)
// so a user fixing a config sees every problem in one pass.
func Resolve(raw map[string]interface{}) ([]dingo.Param, error) {
	out := make([]dingo.Param, 0, len(raw))
	var errs []string
	for name, v := range raw {
		d, ok := params.Lookup(name)
		if !ok {
			errs = append(errs, "unknown param: "+name)
			continue
		}
		val, err := params.Encode(d, v)
		if err != nil {
			errs = append(errs, err.Error())
			continue
		}
		out = append(out, dingo.Param{Index: d.Index, SubIndex: d.Sub, Value: val})
	}
	if len(errs) > 0 {
		sort.Strings(errs)
		return nil, fmt.Errorf("%d config error(s):\n  %s", len(errs), strings.Join(errs, "\n  "))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Index != out[j].Index {
			return out[i].Index < out[j].Index
		}
		return out[i].SubIndex < out[j].SubIndex
	})
	return out, nil
}

// Named decodes wire params into a name->value object for dumps. Params not in
// the registry are keyed by their raw "0xINDEX.SUB" address.
func Named(ps []dingo.Param) map[string]interface{} {
	m := make(map[string]interface{}, len(ps))
	for _, p := range ps {
		if d, ok := params.LookupKey(p.Index, p.SubIndex); ok {
			m[d.Name] = params.Decode(d, p.Value)
		} else {
			m[fmt.Sprintf("0x%04X.%d", p.Index, p.SubIndex)] = p.Value
		}
	}
	return m
}

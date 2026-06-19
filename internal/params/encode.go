package params

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Encode converts a config value (as produced by encoding/json: float64, bool,
// or string) into the 32-bit wire value for this parameter's type, validating
// against the firmware's range so out-of-range values fail here with a clear
// message instead of being silently rejected by the device.
func Encode(d *Def, v interface{}) (uint32, error) {
	switch d.Type {
	case TBool:
		bv, err := toBool(v)
		if err != nil {
			return 0, fmt.Errorf("%s: %w", d.Name, err)
		}
		if bv {
			return 1, nil
		}
		return 0, nil

	case TU8, TU16, TU32:
		n, err := toInt(v)
		if err != nil {
			return 0, fmt.Errorf("%s: %w", d.Name, err)
		}
		width := map[Type]int64{TU8: 0xFF, TU16: 0xFFFF, TU32: 0xFFFFFFFF}[d.Type]
		if n < 0 || n > width {
			return 0, fmt.Errorf("%s: value %d out of range for %s", d.Name, n, d.Type)
		}
		if err := d.checkRange(float64(n)); err != nil {
			return 0, err
		}
		return uint32(n), nil

	case TI8:
		n, err := toInt(v)
		if err != nil {
			return 0, fmt.Errorf("%s: %w", d.Name, err)
		}
		if n < -128 || n > 127 {
			return 0, fmt.Errorf("%s: value %d out of range for int8", d.Name, n)
		}
		if err := d.checkRange(float64(n)); err != nil {
			return 0, err
		}
		return uint32(int32(n)), nil // sign-extend, matching firmware ReadParam

	case TFloat:
		f, err := toFloat(v)
		if err != nil {
			return 0, fmt.Errorf("%s: %w", d.Name, err)
		}
		if err := d.checkRange(f); err != nil {
			return 0, err
		}
		return math.Float32bits(float32(f)), nil

	case TEnum:
		var val uint32
		if s, ok := v.(string); ok {
			ev, ok := EnumValue(d.Enum, s)
			if !ok {
				return 0, fmt.Errorf("%s: unknown %s value %q (valid: %s)",
					d.Name, d.Enum, s, strings.Join(EnumNames(d.Enum), ", "))
			}
			val = ev
		} else {
			n, err := toInt(v)
			if err != nil {
				return 0, fmt.Errorf("%s: %w", d.Name, err)
			}
			if n < 0 || n > 0xFF {
				return 0, fmt.Errorf("%s: enum value %d out of range", d.Name, n)
			}
			val = uint32(n)
		}
		if err := d.checkRange(float64(val)); err != nil {
			return 0, fmt.Errorf("%s (enum %s)", err, d.Enum)
		}
		return val, nil

	case TVarMap:
		if s, ok := v.(string); ok {
			if idx, ok := VarIndex(s); ok {
				return uint32(idx), nil
			}
			return 0, fmt.Errorf("%s: unknown variable %q", d.Name, s)
		}
		n, err := toInt(v)
		if err != nil {
			return 0, fmt.Errorf("%s: %w", d.Name, err)
		}
		if n < 0 || n >= int64(VarMapSize()) {
			return 0, fmt.Errorf("%s: var-map index %d out of range (0..%d)", d.Name, n, VarMapSize()-1)
		}
		return uint32(n), nil
	}
	return 0, fmt.Errorf("%s: unhandled type %s", d.Name, d.Type)
}

// checkRange validates a natural-units value against the firmware Min/Max.
func (d *Def) checkRange(v float64) error {
	if v < d.Min || v > d.Max {
		return fmt.Errorf("%s: value %v out of firmware range [%v, %v]", d.Name, v, d.Min, d.Max)
	}
	return nil
}

// Decode renders a raw wire value as a typed, human-friendly config value (for
// named dumps): bool, number, float, canonical enum name, or var name.
func Decode(d *Def, raw uint32) interface{} {
	switch d.Type {
	case TBool:
		return raw != 0
	case TU8, TU16, TU32:
		return raw
	case TI8:
		return int32(int8(raw))
	case TFloat:
		return float64(math.Float32frombits(raw))
	case TEnum:
		if n := EnumName(d.Enum, raw); n != "" {
			return n
		}
		return raw
	case TVarMap:
		if n := VarName(uint16(raw)); n != "" {
			return n
		}
		return raw
	}
	return raw
}

func toBool(v interface{}) (bool, error) {
	switch x := v.(type) {
	case bool:
		return x, nil
	case float64:
		return x != 0, nil
	case string:
		bv, err := strconv.ParseBool(strings.TrimSpace(x))
		if err != nil {
			return false, fmt.Errorf("invalid bool %q", x)
		}
		return bv, nil
	}
	return false, fmt.Errorf("expected bool, got %T", v)
}

func toInt(v interface{}) (int64, error) {
	switch x := v.(type) {
	case float64:
		if x != math.Trunc(x) {
			return 0, fmt.Errorf("expected integer, got %v", x)
		}
		return int64(x), nil
	// Native integer types (e.g. produced by Decode, for in-memory round-trips).
	case int:
		return int64(x), nil
	case int32:
		return int64(x), nil
	case int64:
		return x, nil
	case uint32:
		return int64(x), nil
	case uint64:
		return int64(x), nil
	case string:
		s := strings.TrimSpace(x)
		neg := false
		if strings.HasPrefix(s, "-") {
			neg, s = true, s[1:]
		}
		var n int64
		var err error
		if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
			n, err = strconv.ParseInt(s[2:], 16, 64)
		} else {
			n, err = strconv.ParseInt(s, 10, 64)
		}
		if err != nil {
			return 0, fmt.Errorf("invalid integer %q", x)
		}
		if neg {
			n = -n
		}
		return n, nil
	case bool:
		if x {
			return 1, nil
		}
		return 0, nil
	}
	return 0, fmt.Errorf("expected number, got %T", v)
}

func toFloat(v interface{}) (float64, error) {
	switch x := v.(type) {
	case float64:
		return x, nil
	case float32:
		return float64(x), nil
	case int32:
		return float64(x), nil
	case uint32:
		return float64(x), nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if err != nil {
			return 0, fmt.Errorf("invalid number %q", x)
		}
		return f, nil
	}
	return 0, fmt.Errorf("expected number, got %T", v)
}

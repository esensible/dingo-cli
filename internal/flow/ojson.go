package flow

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
)

// An order-preserving JSON tree. Graph edits rewrite the dingoConfig text, and
// a person reads that text in the editor next to the graph: re-marshalling
// through map[string]any would reorder every key and turn a one-field change
// into a whole-file diff. Scalars keep their literal text (so 1 stays 1, not
// 1.0, and an untouched number is byte-identical).

type jkind byte

const (
	jObject jkind = 'o'
	jArray  jkind = 'a'
	jScalar jkind = 's'
)

type jnode struct {
	kind  jkind
	keys  []string // object
	vals  []*jnode // object values, parallel to keys
	items []*jnode // array
	raw   string   // scalar literal (number, string with quotes, true, false, null)
}

func parseJSON(data []byte) (*jnode, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	n, err := readNode(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("unexpected data after the top-level JSON value")
	}
	return n, nil
}

func readNode(dec *json.Decoder) (*jnode, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return nodeFrom(dec, tok)
}

func nodeFrom(dec *json.Decoder, tok json.Token) (*jnode, error) {
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			n := &jnode{kind: jObject}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				k, ok := kt.(string)
				if !ok {
					return nil, fmt.Errorf("object key is %T, not a string", kt)
				}
				v, err := readNode(dec)
				if err != nil {
					return nil, err
				}
				n.keys = append(n.keys, k)
				n.vals = append(n.vals, v)
			}
			if _, err := dec.Token(); err != nil { // '}'
				return nil, err
			}
			return n, nil
		case '[':
			n := &jnode{kind: jArray}
			for dec.More() {
				v, err := readNode(dec)
				if err != nil {
					return nil, err
				}
				n.items = append(n.items, v)
			}
			if _, err := dec.Token(); err != nil { // ']'
				return nil, err
			}
			return n, nil
		}
		return nil, fmt.Errorf("unexpected %v", t)
	case json.Number:
		return &jnode{kind: jScalar, raw: t.String()}, nil
	case string:
		return jString(t), nil
	case bool:
		if t {
			return &jnode{kind: jScalar, raw: "true"}, nil
		}
		return &jnode{kind: jScalar, raw: "false"}, nil
	case nil:
		return &jnode{kind: jScalar, raw: "null"}, nil
	}
	return nil, fmt.Errorf("unexpected token %T", tok)
}

// ---- constructors

func jString(s string) *jnode {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return &jnode{kind: jScalar, raw: string(bytes.TrimRight(b.Bytes(), "\n"))}
}

func jBool(v bool) *jnode {
	if v {
		return &jnode{kind: jScalar, raw: "true"}
	}
	return &jnode{kind: jScalar, raw: "false"}
}

func jInt(v int64) *jnode { return &jnode{kind: jScalar, raw: strconv.FormatInt(v, 10)} }

func jFloat(v float64) *jnode {
	b, err := json.Marshal(v) // shortest round-trip form, as encoding/json writes floats
	if err != nil {
		b = []byte("0")
	}
	return &jnode{kind: jScalar, raw: string(b)}
}

func jObj() *jnode { return &jnode{kind: jObject} }
func jArr() *jnode { return &jnode{kind: jArray} }

// ---- access

// get returns an object member (nil if n is not an object or has no such key).
func (n *jnode) get(key string) *jnode {
	if n == nil || n.kind != jObject {
		return nil
	}
	for i, k := range n.keys {
		if k == key {
			return n.vals[i]
		}
	}
	return nil
}

// set replaces an object member, or appends it.
func (n *jnode) set(key string, v *jnode) {
	for i, k := range n.keys {
		if k == key {
			n.vals[i] = v
			return
		}
	}
	n.keys = append(n.keys, key)
	n.vals = append(n.vals, v)
}

// index returns an array element (nil if out of range or not an array).
func (n *jnode) index(i int) *jnode {
	if n == nil || n.kind != jArray || i < 0 || i >= len(n.items) {
		return nil
	}
	return n.items[i]
}

// value decodes a scalar: float64, bool, string or nil (nil also for a
// non-scalar or a missing node).
func (n *jnode) value() any {
	if n == nil || n.kind != jScalar {
		return nil
	}
	var v any
	if json.Unmarshal([]byte(n.raw), &v) != nil {
		return nil
	}
	return v
}

func (n *jnode) str() (string, bool) {
	s, ok := n.value().(string)
	return s, ok
}

func (n *jnode) float() (float64, bool) {
	f, ok := n.value().(float64)
	return f, ok
}

func (n *jnode) boolean() (bool, bool) {
	b, ok := n.value().(bool)
	return b, ok
}

// ---- output (the layout json.MarshalIndent(v, "", "  ") produces)

func (n *jnode) marshal() []byte {
	var b bytes.Buffer
	n.write(&b, "")
	return b.Bytes()
}

func (n *jnode) write(b *bytes.Buffer, indent string) {
	inner := indent + "  "
	switch n.kind {
	case jObject:
		if len(n.keys) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteString("{\n")
		for i, k := range n.keys {
			b.WriteString(inner)
			b.WriteString(jString(k).raw)
			b.WriteString(": ")
			n.vals[i].write(b, inner)
			if i < len(n.keys)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent)
		b.WriteByte('}')
	case jArray:
		if len(n.items) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[\n")
		for i, v := range n.items {
			b.WriteString(inner)
			v.write(b, inner)
			if i < len(n.items)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(indent)
		b.WriteByte(']')
	default:
		b.WriteString(n.raw)
	}
}

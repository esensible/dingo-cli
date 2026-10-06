// Package flow projects one PdmDevices entry of a dingoConfig file onto the
// node graph drawn by Cory Grant's React Flow editor (dingoConfig
// web/ClientApp, vendored at web/vendor/dingoconfig-flow), and applies the
// editor's edits back to the config text.
//
// It is a port of dingoConfig's web/Components/Devices/FwDevice/Flow
// (FlowGraph.cs + FlowNodeTypes.cs, development @ c2056f7) onto dingo-cli's own
// board tables: the var map comes from internal/params (the C6 table is checked
// against the firmware), the JSON field names from internal/pdmcfg. The config
// stays the single source of truth, exactly as in dingoConfig: a node is an
// enabled function slot, an edge is a function input set to another function's
// var-map index, and only node positions are stored separately, in the
// device's "flowLayout" object ({ "<nodeId>": { "x": .., "y": .. } }, the field
// dingoConfig's FwDevice.FlowLayout serialises to), with the same node ids
// ("device", "<kind>-<number>"), so a device laid out in one tool looks the same
// in the other.
package flow

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"dingo-cli/internal/dingo"
	"dingo-cli/internal/ops"
	"dingo-cli/internal/params"
	"dingo-cli/internal/pdmcfg"
)

// DeviceNodeID is the id of the node holding the device's own variables.
const DeviceNodeID = "device"

const (
	inPrefix    = "in:"
	outPrefix   = "out:"
	columnWidth = 360.0
	nodeGap     = 40.0
	layoutKey   = "flowLayout"
)

// Categories, as dingoConfig's FlowCategory enum names them (the editor uses
// them for colours and the minimap).
const (
	catDevice = "Device"
	catSource = "Source"
	catLogic  = "Logic"
	catSink   = "Sink"
)

var (
	tBool    = []string{"bool"}
	tNumeric = []string{"int", "float"}
	tAny     = []string{"bool", "int", "float"}
	tInt     = []string{"int"}
)

// ---- the graph the editor draws (FlowGraphDto, camelCase) -------------------

type Handle struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	DataTypes []string `json:"dataTypes"`
	Var       *string  `json:"var"`
	Connected bool     `json:"connected"`
}

type Node struct {
	ID        string   `json:"id"`
	Category  string   `json:"category"`
	Label     string   `json:"label"`
	Subtitle  string   `json:"subtitle"`
	X         float64  `json:"x"`
	Y         float64  `json:"y"`
	Enabled   bool     `json:"enabled"`
	Deletable bool     `json:"deletable"`
	Inputs    []Handle `json:"inputs"`
	Outputs   []Handle `json:"outputs"`
}

type Edge struct {
	ID           string `json:"id"`
	Source       string `json:"source"`
	SourceHandle string `json:"sourceHandle"`
	Target       string `json:"target"`
	TargetHandle string `json:"targetHandle"`
	Var          string `json:"var"`
}

type Graph struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

// SlotInfo is every function slot of the board, enabled or not: what the page
// needs for "Add function" (free slots) and the remove confirmation.
type SlotInfo struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Type       string `json:"type"`  // "Virtual Input"
	Label      string `json:"label"` // "Virtual Input 3"
	Name       string `json:"name"`
	Enabled    bool   `json:"enabled"`
	OnCanvas   bool   `json:"onCanvas"`
	References int    `json:"references"` // inputs (on any function) that use one of its variables
}

// ---- node kinds (FlowNodeTypes.All, same order) ------------------------------

type varDef struct {
	name     string // internal/params var-map name ("VirtIn3")
	label    string // output handle label
	dataType string
}

type inputDef struct {
	key   string
	label string
	types []string
	path  []any // from the slot object: string keys and int array indexes
}

type kindDef struct {
	kind, label, category string
	key                   string // dingoConfig JSON key on the device object
	singleton             bool
	defaultName           string // default function name (+ number unless singleton)
	count                 func(params.Board) int
	vars                  func(b params.Board, n int, obj *jnode) []varDef
	inputs                func(b params.Board, obj *jnode) []inputDef
}

func one(name, label, dt string) func(params.Board, int, *jnode) []varDef {
	return func(_ params.Board, n int, _ *jnode) []varDef {
		return []varDef{{fmt.Sprintf(name, n), label, dt}}
	}
}

func in(key, label string, types []string) inputDef {
	return inputDef{key: key, label: label, types: types, path: []any{key}}
}

func fixed(defs ...inputDef) func(params.Board, *jnode) []inputDef {
	return func(params.Board, *jnode) []inputDef { return defs }
}

var kinds = []*kindDef{
	{kind: "digitalInput", label: "Digital Input", category: catSource, key: "inputs", defaultName: "digitalInput",
		count: func(b params.Board) int { return b.DigInputs },
		vars:  one("DigIn%d", "State", "bool"), inputs: fixed()},
	{kind: "canInput", label: "CAN Input", category: catSource, key: "canInputs", defaultName: "canInput",
		count: func(b params.Board) int { return b.CanInputs },
		vars: func(_ params.Board, n int, _ *jnode) []varDef {
			return []varDef{{fmt.Sprintf("CanIn%dOut", n), "State", "bool"}, {fmt.Sprintf("CanIn%dVal", n), "Value", "float"}}
		},
		inputs: fixed()},
	{kind: "keypad", label: "Keypad", category: catSource, key: "keypads", defaultName: "keypad",
		count: func(b params.Board) int { return b.Keypads }, vars: keypadVars, inputs: keypadInputs},
	{kind: "virtualInput", label: "Virtual Input", category: catLogic, key: "virtualInputs", defaultName: "virtualInput",
		count: func(b params.Board) int { return b.VirtInputs },
		vars:  one("VirtIn%d", "State", "bool"),
		inputs: fixed(in("var0", "Var 0", tBool), in("var1", "Var 1", tBool), in("var2", "Var 2", tBool))},
	{kind: "condition", label: "Condition", category: catLogic, key: "conditions", defaultName: "condition",
		count: func(b params.Board) int { return b.Conditions },
		vars:  one("Cond%d", "Value", "bool"), inputs: fixed(in("input", "Input", tAny))},
	{kind: "counter", label: "Counter", category: catLogic, key: "counters", defaultName: "counter",
		count: func(b params.Board) int { return b.Counters },
		vars:  one("Counter%d", "Value", "int"),
		inputs: fixed(in("incInput", "Increment", tBool), in("decInput", "Decrement", tBool), in("resetInput", "Reset", tBool))},
	{kind: "flasher", label: "Flasher", category: catLogic, key: "flashers", defaultName: "flasher",
		count: func(b params.Board) int { return b.Flashers },
		vars:  one("Flasher%d", "State", "bool"), inputs: fixed(in("input", "Input", tBool))},
	{kind: "output", label: "Output", category: catSink, key: "outputs", defaultName: "output",
		count: func(b params.Board) int { return b.Outputs },
		vars: func(_ params.Board, n int, _ *jnode) []varDef {
			return []varDef{
				{fmt.Sprintf("Out%dActive", n), "On", "bool"},
				{fmt.Sprintf("Out%dCurrent", n), "Current", "float"},
				{fmt.Sprintf("Out%dOvercurrent", n), "Overcurrent", "bool"},
				{fmt.Sprintf("Out%dFault", n), "Fault", "bool"},
			}
		},
		inputs: fixed(in("input", "Input", tBool), in("dutyCycleInput", "Duty Cycle", tNumeric))},
	{kind: "canOutput", label: "CAN Output", category: catSink, key: "canOutputs", defaultName: "canOutput",
		count: func(b params.Board) int { return b.CanOutputs },
		vars:  func(params.Board, int, *jnode) []varDef { return nil }, inputs: fixed(in("input", "Input", tAny))},
	{kind: "wiper", label: "Wiper", category: catSink, key: "wipers", singleton: true, defaultName: "wiper",
		count: func(b params.Board) int { return boolCount(b.HasWipers) },
		vars: func(params.Board, int, *jnode) []varDef {
			return []varDef{
				{"WiperSlowOut", "Slow Output", "bool"}, {"WiperFastOut", "Fast Output", "bool"},
				{"WiperParkOut", "Park Output", "bool"}, {"WiperInterOut", "Inter Output", "bool"},
				{"WiperWashOut", "Wash Output", "bool"}, {"WiperSwipeOut", "Swipe Output", "bool"},
			}
		},
		inputs: fixed(in("onInput", "On", tBool), in("slowInput", "Slow", tBool), in("fastInput", "Fast", tBool),
			in("interInput", "Intermittent", tBool), in("speedInput", "Speed", tInt), in("parkInput", "Park", tBool),
			in("swipeInput", "Swipe", tBool), in("washInput", "Wash", tBool))},
	{kind: "starterDisable", label: "Starter Disable", category: catSink, key: "starterDisable", singleton: true, defaultName: "starterDisable",
		count: func(b params.Board) int { return boolCount(b.HasStarter) },
		vars:  func(params.Board, int, *jnode) []varDef { return nil }, inputs: fixed(in("input", "Input", tBool))},
}

func boolCount(b bool) int {
	if b {
		return 1
	}
	return 0
}

// Keypad button/dial labels are the button's/dial's own name (dingoConfig
// names keypad variables "keypad1 - button3" and labels them "button3").
func childName(obj *jnode, arrKey string, i int, def string) string {
	if s, ok := obj.get(arrKey).index(i).get("name").str(); ok && s != "" {
		return s
	}
	return def
}

func keypadVars(b params.Board, k int, obj *jnode) []varDef {
	var out []varDef
	for i := 1; i <= b.KeypadButtons; i++ {
		out = append(out, varDef{fmt.Sprintf("Keypad%dButton%d", k, i), childName(obj, "buttons", i-1, fmt.Sprintf("button%d", i)), "bool"})
	}
	for i := 1; i <= b.KeypadDials; i++ {
		out = append(out, varDef{fmt.Sprintf("Keypad%dDial%d", k, i), childName(obj, "dials", i-1, fmt.Sprintf("dial%d", i)), "int"})
	}
	for i := 1; i <= b.KeypadAnalogs; i++ {
		out = append(out, varDef{fmt.Sprintf("Keypad%dAnalog%d", k, i), fmt.Sprintf("analogIn%d", i-1), "float"})
	}
	return out
}

func keypadInputs(b params.Board, obj *jnode) []inputDef {
	out := []inputDef{in("dimmingVar", "Dimming", tBool)}
	for i := 1; i <= b.KeypadButtons; i++ {
		name := childName(obj, "buttons", i-1, fmt.Sprintf("button%d", i))
		for v := 0; v < 4; v++ {
			out = append(out, inputDef{key: fmt.Sprintf("button%d.var%d", i, v), label: fmt.Sprintf("%s val %d", name, v),
				types: tBool, path: []any{"buttons", i - 1, "valVars", v}})
		}
		out = append(out, inputDef{key: fmt.Sprintf("button%d.fault", i), label: name + " fault",
			types: tBool, path: []any{"buttons", i - 1, "faultVar"}})
	}
	return out
}

// ---- the model -----------------------------------------------------------

type slot struct {
	m  *model
	kd *kindDef
	n  int // 1-based (array index + 1)
}

func (s *slot) id() string { return fmt.Sprintf("%s-%d", s.kd.kind, s.n) }

func (s *slot) label() string {
	if s.kd.singleton {
		return s.kd.label
	}
	return fmt.Sprintf("%s %d", s.kd.label, s.n)
}

func (s *slot) defaultName() string {
	if s.kd.singleton {
		return s.kd.defaultName
	}
	return fmt.Sprintf("%s%d", s.kd.defaultName, s.n)
}

// obj is the slot's JSON object, nil while the file does not have it (the
// encoder then writes the firmware defaults: disabled, every input 0).
func (s *slot) obj() *jnode {
	v := s.m.dev.get(s.kd.key)
	if s.kd.singleton {
		if v != nil && v.kind == jObject {
			return v
		}
		return nil
	}
	if o := v.index(s.n - 1); o != nil && o.kind == jObject {
		return o
	}
	return nil
}

// ensure returns the slot's object, creating it (and any earlier array
// elements, as disabled defaults) so a field can be written.
func (s *slot) ensure() (*jnode, error) {
	if o := s.obj(); o != nil {
		return o, nil
	}
	v := s.m.dev.get(s.kd.key)
	if s.kd.singleton {
		if v != nil && v.kind != jObject && v.raw != "null" {
			return nil, fmt.Errorf("%s is not an object", s.kd.key)
		}
		o := jObj()
		o.set("name", jString(s.defaultName()))
		o.set("enabled", jBool(false))
		s.m.dev.set(s.kd.key, o)
		return o, nil
	}
	if v == nil || v.raw == "null" {
		v = jArr()
		s.m.dev.set(s.kd.key, v)
	}
	if v.kind != jArray {
		return nil, fmt.Errorf("%s is not an array", s.kd.key)
	}
	for len(v.items) < s.n {
		k := len(v.items) + 1
		o := jObj()
		o.set("name", jString(fmt.Sprintf("%s%d", s.kd.defaultName, k)))
		o.set("number", jInt(int64(k)))
		o.set("enabled", jBool(false))
		v.items = append(v.items, o)
	}
	o := v.items[s.n-1]
	if o.kind != jObject {
		return nil, fmt.Errorf("%s[%d] is not an object", s.kd.key, s.n-1)
	}
	return o, nil
}

func (s *slot) name() string {
	if n, ok := s.obj().get("name").str(); ok && n != "" {
		return n
	}
	return s.defaultName()
}

func (s *slot) enabled() bool {
	b, _ := s.obj().get("enabled").boolean()
	return b
}

func (s *slot) inputs() []inputDef { return s.kd.inputs(s.m.board, s.obj()) }

type varInfo struct {
	index    int
	owner    *slot // nil: a device variable
	label    string
	dataType string
}

type model struct {
	data  []byte
	doc   *jnode
	dev   *jnode
	board params.Board
	reg   *params.Registry
	base  uint16 // the entry's baseId (what encode/apply target)

	slots       []*slot
	byID        map[string]*slot
	vars        map[int]*varInfo
	varsByOwner map[*slot][]*varInfo
	deviceVars  []*varInfo
}

func load(data []byte, base *int) (*model, error) {
	entries, err := ops.Devices(data)
	if err != nil {
		return nil, err
	}
	sel, err := ops.SelectPdm(entries, base)
	if err != nil {
		return nil, err
	}
	doc, err := parseJSON(data)
	if err != nil {
		return nil, ops.JSONError(data, err)
	}
	pdms := doc.get("PdmDevices")
	idx := -1
	if base != nil && !sel.Fallback {
		for i, e := range pdms.items { // the last match, as pdmcfg selects
			bid, ok := e.get("baseId").float()
			if (ok && int(bid) == *base) || (!ok && *base == 0) {
				idx = i
			}
		}
	}
	if idx < 0 {
		idx = 0 // the file's only PDM (SelectPdm has checked there is one)
	}
	dev := pdms.index(idx)
	if dev == nil || dev.kind != jObject {
		return nil, fmt.Errorf("PdmDevices[%d] is not an object", idx)
	}
	m := &model{data: data, doc: doc, dev: dev}
	if sel.Entry.BaseID != nil {
		m.base = uint16(*sel.Entry.BaseID)
	}
	one := jObj()
	one.set("PdmDevices", &jnode{kind: jArray, items: []*jnode{dev}})
	if m.board, err = pdmcfg.DeviceBoard(one.marshal(), 0); err != nil {
		return nil, err
	}
	m.reg = params.NewRegistry(m.board)
	m.index()
	return m, nil
}

// index (re)builds the slots and the var table. Labels depend on names in the
// JSON, so it runs again after an edit.
func (m *model) index() {
	m.slots = nil
	m.byID = map[string]*slot{}
	m.vars = map[int]*varInfo{}
	m.varsByOwner = map[*slot][]*varInfo{}
	m.deviceVars = nil

	// Device variables (owner nil). Index 0 ("None", AlwaysFalse) is "not
	// connected" and gets no handle.
	for _, d := range []varDef{{"AlwaysTrue", "Always On", "bool"}, {"State", "State", "int"},
		{"BoardTemp", "Temperature", "float"}, {"BattVolt", "Battery Voltage", "float"}} {
		if i, ok := m.reg.VarIndex(d.name); ok {
			v := &varInfo{index: int(i), label: d.label, dataType: d.dataType}
			m.vars[v.index] = v
			m.deviceVars = append(m.deviceVars, v)
		}
	}
	for _, kd := range kinds {
		for n := 1; n <= kd.count(m.board); n++ {
			s := &slot{m: m, kd: kd, n: n}
			m.slots = append(m.slots, s)
			m.byID[s.id()] = s
			for _, d := range kd.vars(m.board, n, s.obj()) {
				i, ok := m.reg.VarIndex(d.name)
				if !ok {
					continue // a var this board does not have (checked by the tests)
				}
				v := &varInfo{index: int(i), owner: s, label: d.label, dataType: d.dataType}
				m.vars[v.index] = v
				m.varsByOwner[s] = append(m.varsByOwner[s], v)
			}
		}
	}
}

// inputValue reads an input's var-map index: a number, or a var name as the
// CLI accepts ("CanIn1Out"); absent or unreadable is 0 (not connected).
func (m *model) inputValue(obj *jnode, in inputDef) int {
	n := walk(obj, in.path)
	switch v := n.value().(type) {
	case float64:
		if v >= 0 && v == math.Trunc(v) {
			return int(v)
		}
	case string:
		if i, ok := m.reg.VarIndex(v); ok {
			return int(i)
		}
		if i, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return i
		}
	}
	return 0
}

func walk(n *jnode, path []any) *jnode {
	for _, p := range path {
		switch k := p.(type) {
		case string:
			n = n.get(k)
		case int:
			n = n.index(k)
		}
		if n == nil {
			return nil
		}
	}
	return n
}

// setPath writes v at path below obj, creating objects/arrays (padded with
// defaults) on the way.
func setPath(obj *jnode, path []any, v *jnode) error {
	cur := obj
	for i, p := range path {
		last := i == len(path)-1
		switch k := p.(type) {
		case string:
			if cur.kind != jObject {
				return fmt.Errorf("%v: not an object", path[:i])
			}
			if last {
				cur.set(k, v)
				return nil
			}
			next := cur.get(k)
			if next == nil || next.raw == "null" {
				if _, isIdx := path[i+1].(int); isIdx {
					next = jArr()
				} else {
					next = jObj()
				}
				cur.set(k, next)
			}
			cur = next
		case int:
			if cur.kind != jArray {
				return fmt.Errorf("%v: not an array", path[:i])
			}
			parentKey, _ := path[i-1].(string)
			for len(cur.items) <= k {
				cur.items = append(cur.items, padElement(parentKey, len(cur.items)))
			}
			if last {
				cur.items[k] = v
				return nil
			}
			cur = cur.items[k]
		}
	}
	return nil
}

// padElement is a default array element for the arrays an input lives in.
func padElement(arrKey string, i int) *jnode {
	switch arrKey {
	case "buttons":
		o := jObj()
		o.set("name", jString(fmt.Sprintf("button%d", i+1)))
		o.set("number", jInt(int64(i+1)))
		return o
	}
	return jInt(0) // valVars and other var-map index arrays
}

type nodeInputs struct {
	id     string
	slot   *slot // nil: the device node
	inputs []inputDef
}

// deviceInputs: dingoConfig's device node takes muteCanTxInput and
// forceSleepInput, which dingo-cli's firmware tables (dingoPDM v7, the C6's
// dingoFW 0.5.8 core) do not have, so the device node has no inputs here.
func (m *model) deviceInputs() []inputDef { return nil }

func (m *model) allInputs(slots []*slot) []nodeInputs {
	out := make([]nodeInputs, 0, len(slots)+1)
	for _, s := range slots {
		out = append(out, nodeInputs{s.id(), s, s.inputs()})
	}
	return append(out, nodeInputs{DeviceNodeID, nil, m.deviceInputs()})
}

func (m *model) get(ni nodeInputs, in inputDef) int {
	if ni.slot == nil {
		return m.inputValue(m.dev, in)
	}
	return m.inputValue(ni.slot.obj(), in)
}

func (m *model) put(ni nodeInputs, in inputDef, index int) error {
	if m.get(ni, in) == index {
		return nil // nothing changes (e.g. disconnecting an input that is not connected): leave the text alone
	}
	var obj *jnode
	if ni.slot == nil {
		obj = m.dev
	} else {
		o, err := ni.slot.ensure()
		if err != nil {
			return err
		}
		obj = o
	}
	return setPath(obj, in.path, jInt(int64(index)))
}

func (m *model) sourceSlot(index int) *slot {
	if index == 0 {
		return nil
	}
	if v, ok := m.vars[index]; ok {
		return v.owner
	}
	return nil
}

func varStr(i int) *string { s := strconv.Itoa(i); return &s }

func outputHandle(v *varInfo, connected map[int]bool) Handle {
	return Handle{ID: outPrefix + strconv.Itoa(v.index), Label: v.label, DataTypes: []string{v.dataType},
		Var: varStr(v.index), Connected: connected[v.index]}
}

// build is FlowGraph.Build. With persist, positions assigned to nodes that
// have none are written to flowLayout (dingoConfig saves them so they stay
// stable); without, the config is left untouched.
func (m *model) build(persist bool) Graph {
	var visible []*slot
	visibleIDs := map[string]bool{}
	for _, s := range m.slots {
		if s.enabled() {
			visible = append(visible, s)
			visibleIDs[s.id()] = true
		}
	}
	// Disabled slots still referenced by an enabled input are shown too
	// (dimmed) so the connection isn't hidden.
	for _, ni := range m.allInputs(append([]*slot(nil), visible...)) {
		for _, in := range ni.inputs {
			if src := m.sourceSlot(m.get(ni, in)); src != nil && !visibleIDs[src.id()] {
				visibleIDs[src.id()] = true
				visible = append(visible, src)
			}
		}
	}
	order := map[*slot]int{}
	for i, s := range m.slots {
		order[s] = i
	}
	sortSlots(visible, order)
	visibleIDs[DeviceNodeID] = true

	edges := []Edge{}
	connectedOut := map[int]bool{}
	connectedIn := map[string]bool{}
	for _, ni := range m.allInputs(visible) {
		for _, in := range ni.inputs {
			idx := m.get(ni, in)
			v, ok := m.vars[idx]
			if idx == 0 || !ok {
				continue
			}
			src := DeviceNodeID
			if v.owner != nil {
				src = v.owner.id()
			}
			if !visibleIDs[src] {
				continue
			}
			th := inPrefix + in.key
			edges = append(edges, Edge{ID: ni.id + ":" + in.key, Source: src, SourceHandle: outPrefix + strconv.Itoa(idx),
				Target: ni.id, TargetHandle: th, Var: strconv.Itoa(idx)})
			connectedOut[idx] = true
			connectedIn[ni.id+":"+th] = true
		}
	}

	inputHandles := func(id string, ins []inputDef) []Handle {
		hs := make([]Handle, 0, len(ins))
		for _, in := range ins {
			h := inPrefix + in.key
			hs = append(hs, Handle{ID: h, Label: in.label, DataTypes: in.types, Connected: connectedIn[id+":"+h]})
		}
		return hs
	}

	devOut := make([]Handle, 0, len(m.deviceVars))
	for _, v := range m.deviceVars {
		devOut = append(devOut, outputHandle(v, connectedOut))
	}
	devName, _ := m.dev.get("name").str()
	nodes := []Node{{ID: DeviceNodeID, Category: catDevice, Label: devName, Subtitle: m.board.Name,
		Enabled: true, Deletable: false, Inputs: inputHandles(DeviceNodeID, m.deviceInputs()), Outputs: devOut}}
	for _, s := range visible {
		outs := []Handle{}
		for _, v := range m.varsByOwner[s] {
			outs = append(outs, outputHandle(v, connectedOut))
		}
		nodes = append(nodes, Node{ID: s.id(), Category: s.kd.category, Label: s.name(), Subtitle: s.label(),
			Enabled: s.enabled(), Deletable: true, Inputs: inputHandles(s.id(), s.inputs()), Outputs: outs})
	}
	return Graph{Nodes: m.applyLayout(nodes, persist), Edges: edges}
}

func sortSlots(ss []*slot, order map[*slot]int) {
	for i := 1; i < len(ss); i++ { // insertion sort: stable, tiny n
		for j := i; j > 0 && order[ss[j]] < order[ss[j-1]]; j-- {
			ss[j], ss[j-1] = ss[j-1], ss[j]
		}
	}
}

func (m *model) position(id string) (x, y float64, ok bool) {
	p := m.dev.get(layoutKey).get(id)
	x, okx := p.get("x").float()
	y, oky := p.get("y").float()
	return x, y, okx && oky
}

func (m *model) setPosition(id string, x, y float64) {
	l := m.dev.get(layoutKey)
	if l == nil || l.kind != jObject {
		l = jObj()
		m.dev.set(layoutKey, l)
	}
	p := jObj()
	p.set("x", jFloat(x))
	p.set("y", jFloat(y))
	l.set(id, p)
}

// applyLayout is FlowGraph.ApplyLayout: saved positions are used, and nodes
// without one are stacked at the bottom of a column for their category
// (sources | logic | outputs).
func (m *model) applyLayout(nodes []Node, persist bool) []Node {
	bottoms := map[int]float64{}
	var placed, unplaced []Node
	for _, n := range nodes {
		if x, y, ok := m.position(n.ID); ok {
			c := column(n)
			if b, seen := bottoms[c]; !seen || y+estimateHeight(n) > b {
				bottoms[c] = y + estimateHeight(n)
			}
			n.X, n.Y = x, y
			placed = append(placed, n)
		} else {
			unplaced = append(unplaced, n)
		}
	}
	for _, n := range unplaced {
		c := column(n)
		y := 0.0
		if b, ok := bottoms[c]; ok {
			y = b + nodeGap
		}
		n.X, n.Y = float64(c)*columnWidth, y
		if persist {
			m.setPosition(n.ID, n.X, n.Y)
		}
		bottoms[c] = y + estimateHeight(n)
		placed = append(placed, n)
	}
	return placed
}

func column(n Node) int {
	switch n.Category {
	case catLogic:
		return 1
	case catSink:
		return 2
	}
	return 0
}

// estimateHeight mirrors FlowGraph.EstimateHeight (and the collapse threshold
// of 8 in FunctionNode.jsx).
func estimateHeight(n Node) float64 {
	rows := func(hs []Handle) int {
		if len(hs) > 8 {
			c := 0
			for _, h := range hs {
				if h.Connected {
					c++
				}
			}
			return c + 1
		}
		return len(hs)
	}
	return float64(52 + 22*(rows(n.Inputs)+rows(n.Outputs)) + 16)
}

func (m *model) slotInfos(g Graph) []SlotInfo {
	onCanvas := map[string]bool{}
	for _, n := range g.Nodes {
		onCanvas[n.ID] = true
	}
	out := make([]SlotInfo, 0, len(m.slots))
	for _, s := range m.slots {
		out = append(out, SlotInfo{ID: s.id(), Kind: s.kd.kind, Type: s.kd.label, Label: s.label(), Name: s.name(),
			Enabled: s.enabled(), OnCanvas: onCanvas[s.id()], References: m.countReferences(s)})
	}
	return out
}

func (m *model) varIndices(s *slot) map[int]bool {
	set := map[int]bool{}
	for _, v := range m.varsByOwner[s] {
		set[v.index] = true
	}
	return set
}

// countReferences is FlowGraph.CountReferences.
func (m *model) countReferences(s *slot) int {
	idx := m.varIndices(s)
	n := 0
	for _, ni := range m.allInputs(m.slots) {
		for _, in := range ni.inputs {
			if idx[m.get(ni, in)] {
				n++
			}
		}
	}
	return n
}

// ---- edits (FlowEditorTab's JSInvokable handlers + FlowGraph's mutators) -----

// EditReq is one edit from the editor. Op is one of:
//
//	connect    {source, sourceHandle, target, targetHandle}  OnConnect
//	disconnect {target, targetHandle}
//	delete     {nodeIds, edges: [{target, targetHandle}]}   OnDeleted
//	move       {moves: [{id, x, y}]}                          OnNodesMoved
//	add        {id, x?, y?}       enable a free slot at a position (Add Function)
//	remove     {id}               disable and disconnect its users (Remove)
//	set        {id, field, value} one property of a function (properties panel)
type EditReq struct {
	Op           string    `json:"op"`
	Source       string    `json:"source"`
	SourceHandle string    `json:"sourceHandle"`
	Target       string    `json:"target"`
	TargetHandle string    `json:"targetHandle"`
	NodeIDs      []string  `json:"nodeIds"`
	Edges        []EdgeRef `json:"edges"`
	Moves        []Move    `json:"moves"`
	ID           string    `json:"id"`
	X            *float64  `json:"x"`
	Y            *float64  `json:"y"`
	Field        string    `json:"field"`
	Value        any       `json:"value"`
}

type EdgeRef struct {
	Target       string `json:"target"`
	TargetHandle string `json:"targetHandle"`
}

type Move struct {
	ID string  `json:"id"`
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
}

func (m *model) findInput(nodeID, handle string) (nodeInputs, inputDef, bool) {
	if !strings.HasPrefix(handle, inPrefix) {
		return nodeInputs{}, inputDef{}, false
	}
	key := handle[len(inPrefix):]
	var ni nodeInputs
	if nodeID == DeviceNodeID {
		ni = nodeInputs{DeviceNodeID, nil, m.deviceInputs()}
	} else if s := m.byID[nodeID]; s != nil {
		ni = nodeInputs{s.id(), s, s.inputs()}
	} else {
		return nodeInputs{}, inputDef{}, false
	}
	for _, in := range ni.inputs {
		if in.key == key {
			return ni, in, true
		}
	}
	return nodeInputs{}, inputDef{}, false
}

// connect is FlowGraph.Connect: the target input takes the source's var-map
// index, if its data type is one the input accepts.
func (m *model) connect(sourceHandle, target, targetHandle string) error {
	var v *varInfo
	if strings.HasPrefix(sourceHandle, outPrefix) {
		if i, err := strconv.Atoi(sourceHandle[len(outPrefix):]); err == nil {
			v = m.vars[i]
		}
	}
	if v == nil {
		return fmt.Errorf("unknown source variable %q", sourceHandle)
	}
	ni, in, ok := m.findInput(target, targetHandle)
	if !ok {
		return fmt.Errorf("unknown target input %s %q", target, targetHandle)
	}
	accepts := false
	for _, t := range in.types {
		if t == v.dataType {
			accepts = true
		}
	}
	if !accepts {
		return fmt.Errorf("%s accepts %s, not %s", in.label, strings.Join(in.types, "/"), v.dataType)
	}
	return m.put(ni, in, v.index)
}

func (m *model) disconnect(target, targetHandle string) error {
	if ni, in, ok := m.findInput(target, targetHandle); ok {
		return m.put(ni, in, 0)
	}
	return nil
}

// remove is FlowGraph.Remove: disable the slot and disconnect every input
// that used its variables.
func (m *model) remove(s *slot) error {
	if s.obj() != nil && s.enabled() {
		s.obj().set("enabled", jBool(false))
	}
	idx := m.varIndices(s)
	for _, ni := range m.allInputs(m.slots) {
		for _, in := range ni.inputs {
			if idx[m.get(ni, in)] {
				if err := m.put(ni, in, 0); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (m *model) apply(e EditReq) error {
	switch e.Op {
	case "connect":
		return m.connect(e.SourceHandle, e.Target, e.TargetHandle)
	case "disconnect":
		return m.disconnect(e.Target, e.TargetHandle)
	case "delete":
		for _, r := range e.Edges {
			if err := m.disconnect(r.Target, r.TargetHandle); err != nil {
				return err
			}
		}
		for _, id := range e.NodeIDs {
			if s := m.byID[id]; s != nil {
				if err := m.remove(s); err != nil {
					return err
				}
			}
		}
		return nil
	case "move":
		for _, mv := range e.Moves {
			if mv.ID != DeviceNodeID && m.byID[mv.ID] == nil {
				return fmt.Errorf("move: no node %q", mv.ID)
			}
			if math.IsNaN(mv.X) || math.IsNaN(mv.Y) || math.IsInf(mv.X, 0) || math.IsInf(mv.Y, 0) {
				return fmt.Errorf("move: %s: position is not finite", mv.ID)
			}
			m.setPosition(mv.ID, mv.X, mv.Y)
		}
		return nil
	case "add":
		s := m.byID[e.ID]
		if s == nil {
			return fmt.Errorf("add: no function slot %q", e.ID)
		}
		o, err := s.ensure()
		if err != nil {
			return err
		}
		o.set("enabled", jBool(true))
		if e.X != nil && e.Y != nil {
			m.setPosition(s.id(), *e.X, *e.Y)
		}
		return nil
	case "remove":
		s := m.byID[e.ID]
		if s == nil {
			return fmt.Errorf("remove: no function slot %q", e.ID)
		}
		return m.remove(s)
	case "set":
		return m.setField(e.ID, e.Field, e.Value)
	}
	return fmt.Errorf("unknown edit op %q (connect, disconnect, delete, move, add, remove, set)", e.Op)
}

// ---- properties ----------------------------------------------------------

// Field is one editable property of a function: a scalar firmware parameter
// that is not a var-map reference (those are the wires).
type Field struct {
	Field   string   `json:"field"` // dingoConfig JSON field
	Param   string   `json:"param"` // dingo-cli parameter name ("canOutput[1].id")
	Type    string   `json:"type"`  // bool, uint8, uint16, uint32, int8, float, enum
	Enum    []string `json:"enum,omitempty"`
	Values  []int    `json:"values,omitempty"` // enum values, parallel to Enum
	Min     float64  `json:"min"`
	Max     float64  `json:"max"`
	Default any      `json:"default"`
	Value   any      `json:"value"`   // the file's value, else the default
	Present bool     `json:"present"` // the file sets it
}

// Props is a function's properties panel.
type Props struct {
	ID      string  `json:"id"`
	Kind    string  `json:"kind"`
	Label   string  `json:"label"`
	Name    string  `json:"name"`
	Enabled bool    `json:"enabled"`
	Fields  []Field `json:"fields"`
	Missing string  `json:"missing,omitempty"` // what is only editable in the JSON
}

func (m *model) fieldDefs(s *slot) ([]pdmcfg.Field, []*params.Def, error) {
	base, fields, ok := pdmcfg.BlockFields(s.kd.key)
	if !ok {
		return nil, nil, fmt.Errorf("%s: no parameter table for %q", s.id(), s.kd.key)
	}
	index := base + uint16(s.n-1)
	var fs []pdmcfg.Field
	var defs []*params.Def
	for _, f := range fields {
		d, ok := m.reg.LookupKey(index, f.Sub)
		if !ok || d.Type == params.TVarMap {
			continue
		}
		fs = append(fs, f)
		defs = append(defs, d)
	}
	return fs, defs, nil
}

func (m *model) props(id string) (Props, error) {
	s := m.byID[id]
	if s == nil {
		if id == DeviceNodeID {
			return Props{}, fmt.Errorf("the device node has no properties panel (edit the device fields in the JSON)")
		}
		return Props{}, fmt.Errorf("no function slot %q", id)
	}
	fs, defs, err := m.fieldDefs(s)
	if err != nil {
		return Props{}, err
	}
	p := Props{ID: s.id(), Kind: s.kd.kind, Label: s.label(), Name: s.name(), Enabled: s.enabled(), Fields: []Field{}}
	obj := s.obj()
	for i, f := range fs {
		d := defs[i]
		if f.JSON == "enabled" {
			continue
		}
		fd := Field{Field: f.JSON, Param: d.Name, Type: d.Type.String(), Min: d.Min, Max: d.Max, Default: d.Default}
		if d.Type == params.TEnum {
			fd.Enum = params.EnumNames(d.Enum)
			for _, n := range fd.Enum {
				v, _ := params.EnumValue(d.Enum, n)
				fd.Values = append(fd.Values, int(v))
			}
		}
		if d.Type == params.TBool {
			fd.Default = d.Default != 0
		}
		fd.Value = fd.Default
		if v := obj.get(f.JSON).value(); v != nil {
			fd.Value, fd.Present = v, true
		}
		p.Fields = append(p.Fields, fd)
	}
	switch s.kd.kind {
	case "keypad":
		p.Missing = "buttons (modes, colours, blink) and dials"
	case "wiper":
		p.Missing = "speedMap and intermitTime"
	case "starterDisable":
		p.Missing = "outputsDisabled"
	}
	return p, nil
}

// setField writes one property, validated against the firmware parameter's
// type and range. "name" and "enabled" are accepted too.
func (m *model) setField(id, field string, value any) error {
	s := m.byID[id]
	if s == nil {
		return fmt.Errorf("set: no function slot %q", id)
	}
	if field == "name" {
		str, ok := value.(string)
		if !ok {
			return fmt.Errorf("set %s.name: want a string, got %T", id, value)
		}
		o, err := s.ensure()
		if err != nil {
			return err
		}
		o.set("name", jString(str))
		return nil
	}
	fs, defs, err := m.fieldDefs(s)
	if err != nil {
		return err
	}
	for i, f := range fs {
		if f.JSON != field {
			continue
		}
		d := defs[i]
		raw, err := m.reg.Encode(d, value)
		if err != nil {
			return fmt.Errorf("set %s.%s: %w", id, field, err)
		}
		var v *jnode
		switch d.Type {
		case params.TBool:
			v = jBool(raw != 0)
		case params.TFloat:
			v = jFloat(float64(math.Float32frombits(raw)))
			if f, ok := value.(float64); ok {
				v = jFloat(f) // keep what was typed (0.1, not 0.10000000149011612)
			}
		case params.TI8:
			v = jInt(int64(int32(raw)))
		default: // unsigned ints and enums: the number (dingoConfig writes enums as numbers)
			v = jInt(int64(raw))
		}
		o, err := s.ensure()
		if err != nil {
			return err
		}
		o.set(field, v)
		return nil
	}
	return fmt.Errorf("set %s: %q is not an editable field (fields: name, %s)", id, field, fieldNames(fs))
}

func fieldNames(fs []pdmcfg.Field) string {
	var ns []string
	for _, f := range fs {
		ns = append(ns, f.JSON)
	}
	return strings.Join(ns, ", ")
}

// ---- entry points --------------------------------------------------------

// View is a graph of a config, for display.
type View struct {
	Board   string     `json:"board"`
	PdmType int        `json:"pdmType"`
	Name    string     `json:"name"`
	BaseID  int        `json:"baseId"`
	Graph   Graph      `json:"graph"`
	Slots   []SlotInfo `json:"slots"`
}

// Result is a View after an edit, with the new config text and its encoding.
type Result struct {
	View
	Config  string `json:"config"`
	Changed bool   `json:"changed"`
	Count   int    `json:"count"`
	CRC     uint32 `json:"crc"`
}

func (m *model) view(g Graph) View {
	name, _ := m.dev.get("name").str()
	return View{Board: m.board.Name, PdmType: m.board.PdmType, Name: name, BaseID: int(m.base), Graph: g, Slots: m.slotInfos(g)}
}

// Build returns the graph of the PdmDevices entry for base (nil: the file's
// only PDM). It does not change the config: positions it assigns are only
// written by an edit, as dingoConfig writes them when the tab first builds.
func Build(data []byte, base *int) (View, error) {
	m, err := load(data, base)
	if err != nil {
		return View{}, err
	}
	return m.view(m.build(false)), nil
}

// Properties returns the properties panel of one function.
func Properties(data []byte, base *int, id string) (Props, error) {
	m, err := load(data, base)
	if err != nil {
		return Props{}, err
	}
	return m.props(id)
}

// Edit applies one edit and returns the new config text with its graph. As in
// dingoConfig, building the graph first saves the positions of nodes that had
// none, so the layout the person was looking at is what gets stored. The new
// text must still encode (the same check `dingo apply` makes); its param count
// and CRC are returned.
func Edit(data []byte, base *int, e EditReq) (Result, error) {
	m, err := load(data, base)
	if err != nil {
		return Result{}, err
	}
	m.build(true)
	if err := m.apply(e); err != nil {
		return Result{}, err
	}
	m.index()
	g := m.build(true)
	out := m.doc.marshal()
	if bytes.HasSuffix(bytes.TrimRight(data, " \t\r"), []byte("\n")) {
		out = append(out, '\n')
	}
	ps, err := ops.EncodeConfig(out, m.base, false)
	if err != nil {
		return Result{}, fmt.Errorf("the edited config does not encode: %w", err)
	}
	return Result{View: m.view(g), Config: string(out), Changed: !bytes.Equal(out, data), Count: len(ps), CRC: dingo.CRC(ps)}, nil
}

// ParseEdit decodes an edit from JSON.
func ParseEdit(text []byte) (EditReq, error) {
	var e EditReq
	dec := json.NewDecoder(bytes.NewReader(text))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&e); err != nil {
		return EditReq{}, fmt.Errorf("edit: %w", err)
	}
	return e, nil
}

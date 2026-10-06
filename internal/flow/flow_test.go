package flow

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"dingo-cli/internal/dingo"
	"dingo-cli/internal/ops"
	"dingo-cli/internal/params"
)

func example(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "web", "examples", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func crcOf(t *testing.T, data []byte, base uint16) uint32 {
	t.Helper()
	ps, err := ops.EncodeConfig(data, base, false)
	if err != nil {
		t.Fatal(err)
	}
	return dingo.CRC(ps)
}

func edit(t *testing.T, data []byte, e EditReq) Result {
	t.Helper()
	r, err := Edit(data, nil, e)
	if err != nil {
		t.Fatalf("edit %+v: %v", e, err)
	}
	return r
}

// device returns the (only) PdmDevices entry of a config text, decoded.
func device(t *testing.T, text string) map[string]any {
	t.Helper()
	var f struct{ PdmDevices []map[string]any }
	if err := json.Unmarshal([]byte(text), &f); err != nil {
		t.Fatal(err)
	}
	return f.PdmDevices[0]
}

func elem(t *testing.T, dev map[string]any, key string, i int) map[string]any {
	t.Helper()
	arr, _ := dev[key].([]any)
	if i >= len(arr) {
		t.Fatalf("%s has %d elements, want index %d", key, len(arr), i)
	}
	return arr[i].(map[string]any)
}

func nodeIDs(g Graph) []string {
	var ids []string
	for _, n := range g.Nodes {
		ids = append(ids, n.ID)
	}
	return ids
}

func edgeSet(g Graph) map[string]string {
	m := map[string]string{}
	for _, e := range g.Edges {
		m[e.ID] = e.Source + "/" + e.SourceHandle
	}
	return m
}

func findNode(g Graph, id string) *Node {
	for i := range g.Nodes {
		if g.Nodes[i].ID == id {
			return &g.Nodes[i]
		}
	}
	return nil
}

// Every var-map index (but 0, "not connected") has exactly one owner: the
// device node or one function slot. A var the projection does not own would
// draw no wire.
func TestVarMapFullyOwned(t *testing.T) {
	for _, pdmType := range []int{0, 1, 12} {
		b, err := ops.Board(pdmType)
		if err != nil {
			t.Fatal(err)
		}
		m := &model{dev: jObj(), board: b, reg: params.NewRegistry(b)}
		m.index()
		for i := 1; i < m.reg.VarMapSize(); i++ {
			if _, ok := m.vars[i]; !ok {
				t.Errorf("%s: var %d (%s) has no owner", b.Name, i, m.reg.VarName(uint16(i)))
			}
		}
		if len(m.vars) != m.reg.VarMapSize()-1 {
			t.Errorf("%s: %d owned vars, var map has %d", b.Name, len(m.vars), m.reg.VarMapSize())
		}
	}
}

func TestC6Graph(t *testing.T) {
	v, err := Build(example(t, "c6-test.json"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if v.Board != "c6body_v1" || v.BaseID != 0x500 {
		t.Fatalf("board %s base %d", v.Board, v.BaseID)
	}
	want := []string{"device", "virtualInput-1", "flasher-1", "canOutput-1", "canOutput-2"}
	if got := nodeIDs(v.Graph); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("nodes %v, want %v", got, want)
	}
	wantEdges := map[string]string{
		"virtualInput-1:var0": "device/out:1", // AlwaysTrue
		"virtualInput-1:var1": "device/out:1",
		"flasher-1:input":     "virtualInput-1/out:19",
		"canOutput-1:input":   "virtualInput-1/out:19",
		"canOutput-2:input":   "flasher-1/out:27",
	}
	got := edgeSet(v.Graph)
	if len(got) != len(wantEdges) {
		t.Fatalf("edges %v, want %v", got, wantEdges)
	}
	for id, src := range wantEdges {
		if got[id] != src {
			t.Errorf("edge %s from %q, want %q", id, got[id], src)
		}
	}
	dev := findNode(v.Graph, "device")
	if dev.Label != "c6-body-test" || dev.Subtitle != "c6body_v1" || len(dev.Inputs) != 0 {
		t.Errorf("device node %+v", dev)
	}
	// The C6 has no temperature or battery sense: AlwaysTrue and State only.
	if len(dev.Outputs) != 2 || dev.Outputs[0].Label != "Always On" || dev.Outputs[1].DataTypes[0] != "int" {
		t.Errorf("device outputs %+v", dev.Outputs)
	}
	fl := findNode(v.Graph, "flasher-1")
	if fl.Label != "blink-1hz (Flasher1 = var 27)" || fl.Subtitle != "Flasher 1" || fl.Category != "Logic" ||
		len(fl.Outputs) != 1 || *fl.Outputs[0].Var != "27" || !fl.Outputs[0].Connected || !fl.Inputs[0].Connected {
		t.Errorf("flasher node %+v", fl)
	}
	// Default layout: columns by category, stacked.
	if vi := findNode(v.Graph, "virtualInput-1"); vi.X != 360 || vi.Y != 0 {
		t.Errorf("virtualInput-1 at %v,%v", vi.X, vi.Y)
	}
	if co := findNode(v.Graph, "canOutput-2"); co.X != 720 || co.Y <= 0 {
		t.Errorf("canOutput-2 at %v,%v", co.X, co.Y)
	}
	// 8+8+8+8+4+4 slots, two of them on the canvas besides the device.
	if len(v.Slots) != 40 {
		t.Errorf("%d slots", len(v.Slots))
	}
}

func TestBenchToggleGraph(t *testing.T) {
	v, err := Build(example(t, "bench-toggle.json"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if v.Board != "dingoPDM" {
		t.Fatalf("board %s", v.Board)
	}
	want := "device,canInput-1,canInput-2,canInput-3,condition-1,counter-1,output-1,output-2,output-3,output-4,canOutput-1,canOutput-2,canOutput-3,canOutput-4,canOutput-5"
	if got := strings.Join(nodeIDs(v.Graph), ","); got != want {
		t.Fatalf("nodes %s\nwant  %s", got, want)
	}
	wantEdges := map[string]string{
		"output-1:input":     "condition-1/out:123",
		"output-2:input":     "canInput-2/out:9",
		"output-3:input":     "device/out:1",
		"output-4:input":     "canInput-3/out:11",
		"condition-1:input":  "counter-1/out:155", // int into an any-typed input
		"counter-1:incInput": "canInput-1/out:7",
		"canOutput-1:input":  "output-1/out:87",
		"canOutput-2:input":  "output-2/out:91",
		"canOutput-3:input":  "device/out:1",
		"canOutput-4:input":  "output-3/out:95",
		"canOutput-5:input":  "output-4/out:99",
	}
	got := edgeSet(v.Graph)
	if len(got) != len(wantEdges) {
		t.Fatalf("edges %v", got)
	}
	for id, src := range wantEdges {
		if got[id] != src {
			t.Errorf("edge %s from %q, want %q", id, got[id], src)
		}
	}
	// The dingoPDM device node has temperature and battery voltage.
	if n := len(findNode(v.Graph, "device").Outputs); n != 4 {
		t.Errorf("device outputs: %d", n)
	}
	if o := findNode(v.Graph, "output-1"); len(o.Inputs) != 2 || o.Inputs[1].DataTypes[1] != "float" || len(o.Outputs) != 4 {
		t.Errorf("output node %+v", o)
	}
}

// A connection sets the target input to the source's var-map index, and only
// that changes in the encoding.
func TestConnect(t *testing.T) {
	data := example(t, "c6-test.json")
	r := edit(t, data, EditReq{Op: "connect", Source: "flasher-1", SourceHandle: "out:27", Target: "virtualInput-1", TargetHandle: "in:var2"})
	if got := elem(t, device(t, r.Config), "virtualInputs", 0)["var2"]; got != 27.0 {
		t.Fatalf("var2 = %v, want 27", got)
	}
	if edgeSet(r.Graph)["virtualInput-1:var2"] != "flasher-1/out:27" {
		t.Errorf("no edge: %v", edgeSet(r.Graph))
	}
	if r.CRC == crcOf(t, data, 0x500) || r.CRC != crcOf(t, []byte(r.Config), 0x500) || !r.Changed {
		t.Errorf("crc %08X vs original %08X", r.CRC, crcOf(t, data, 0x500))
	}
	// The same through the CLI's param name: virtualInput[1].var2 is the only param that differs.
	before, _ := ops.EncodeConfig(data, 0x500, false)
	after, _ := ops.EncodeConfig([]byte(r.Config), 0x500, false)
	var diff []string
	for i := range before {
		if before[i] != after[i] {
			d, _ := params.NewRegistry(mustBoard(t, 12)).LookupKey(after[i].Index, after[i].SubIndex)
			diff = append(diff, d.Name)
		}
	}
	if strings.Join(diff, ",") != "virtualInput[1].var2" {
		t.Errorf("params changed: %v", diff)
	}
}

func mustBoard(t *testing.T, pdmType int) params.Board {
	b, err := ops.Board(pdmType)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Connecting an input of a slot the file does not have yet creates it (and
// the slots before it) as disabled defaults; the projection still encodes.
func TestConnectCreatesSlot(t *testing.T) {
	data := example(t, "c6-test.json")
	r := edit(t, data, EditReq{Op: "connect", SourceHandle: "out:27", Target: "condition-3", TargetHandle: "in:input"})
	dev := device(t, r.Config)
	conds := dev["conditions"].([]any)
	if len(conds) != 3 {
		t.Fatalf("conditions: %v", conds)
	}
	c3 := conds[2].(map[string]any)
	if c3["input"] != 27.0 || c3["enabled"] != false || c3["name"] != "condition3" || c3["number"] != 3.0 {
		t.Errorf("condition 3: %v", c3)
	}
	// condition-3 is disabled, so it is not a node and the wire is not drawn.
	if findNode(r.Graph, "condition-3") != nil {
		t.Error("disabled condition-3 is on the canvas")
	}
	r2 := edit(t, []byte(r.Config), EditReq{Op: "add", ID: "condition-3", X: ptr(500), Y: ptr(600)})
	if n := findNode(r2.Graph, "condition-3"); n == nil || n.X != 500 || n.Y != 600 || !n.Enabled {
		t.Fatalf("added condition-3: %+v", n)
	}
	if edgeSet(r2.Graph)["condition-3:input"] != "flasher-1/out:27" {
		t.Errorf("edges %v", edgeSet(r2.Graph))
	}
}

func ptr(f float64) *float64 { return &f }

func itoa(i int) string { return strconv.Itoa(i) }

func TestTypeMismatchRejected(t *testing.T) {
	data := example(t, "c6-test.json")
	cases := []struct {
		e    EditReq
		want string
	}{
		// CanIn1Val (float) into a flasher's bool input.
		{EditReq{Op: "connect", SourceHandle: "out:4", Target: "flasher-1", TargetHandle: "in:input"}, "Input accepts bool, not float"},
		// Counter1 value (int) into a virtual input.
		{EditReq{Op: "connect", SourceHandle: "out:39", Target: "virtualInput-1", TargetHandle: "in:var0"}, "Var 0 accepts bool, not int"},
		// State (int) into a counter's increment.
		{EditReq{Op: "connect", SourceHandle: "out:2", Target: "counter-1", TargetHandle: "in:incInput"}, "Increment accepts bool, not int"},
		{EditReq{Op: "connect", SourceHandle: "out:99", Target: "flasher-1", TargetHandle: "in:input"}, "unknown source variable"},
		{EditReq{Op: "connect", SourceHandle: "out:1", Target: "flasher-9", TargetHandle: "in:input"}, "unknown target input"},
	}
	for _, c := range cases {
		if _, err := Edit(data, nil, c.e); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%+v: err %v, want %q", c.e, err, c.want)
		}
	}
	// Any-typed inputs take every type: a float into a CAN output and a condition.
	for _, target := range []string{"canOutput-1", "condition-1"} {
		edit(t, data, EditReq{Op: "connect", SourceHandle: "out:4", Target: target, TargetHandle: "in:input"})
	}
	// dingoPDM: a float current into an output's duty cycle (int/float) is fine, into its bool input not.
	bt := example(t, "bench-toggle.json")
	edit(t, bt, EditReq{Op: "connect", SourceHandle: "out:88", Target: "output-1", TargetHandle: "in:dutyCycleInput"})
	if _, err := Edit(bt, nil, EditReq{Op: "connect", SourceHandle: "out:88", Target: "output-2", TargetHandle: "in:input"}); err == nil {
		t.Error("float into an output's bool input was accepted")
	}
}

// Deleting a wire clears the input; deleting a node disables it and clears
// every input that used it.
func TestDelete(t *testing.T) {
	data := example(t, "c6-test.json")
	r := edit(t, data, EditReq{Op: "delete", Edges: []EdgeRef{{Target: "canOutput-2", TargetHandle: "in:input"}}})
	if got := elem(t, device(t, r.Config), "canOutputs", 1)["input"]; got != 0.0 {
		t.Fatalf("canOutput-2 input = %v", got)
	}
	if _, ok := edgeSet(r.Graph)["canOutput-2:input"]; ok {
		t.Error("edge still drawn")
	}
	if r.CRC == crcOf(t, data, 0x500) {
		t.Error("crc unchanged")
	}

	// virtualInput-1 feeds flasher-1 and canOutput-1.
	r = edit(t, data, EditReq{Op: "delete", NodeIDs: []string{"virtualInput-1"}})
	dev := device(t, r.Config)
	if vi := elem(t, dev, "virtualInputs", 0); vi["enabled"] != false || vi["var0"] != 1.0 {
		t.Errorf("virtualInput-1: %v (disabled, own inputs kept)", vi)
	}
	if elem(t, dev, "flashers", 0)["input"] != 0.0 || elem(t, dev, "canOutputs", 0)["input"] != 0.0 {
		t.Errorf("users not disconnected: %v", dev)
	}
	if elem(t, dev, "canOutputs", 1)["input"] != 27.0 {
		t.Error("an unrelated input was cleared")
	}
	if findNode(r.Graph, "virtualInput-1") != nil {
		t.Error("removed node still on the canvas")
	}

	// The device node is not deletable; "remove" is the same as deleting a node.
	r2 := edit(t, data, EditReq{Op: "remove", ID: "virtualInput-1"})
	if r2.CRC != r.CRC {
		t.Errorf("remove crc %08X, delete %08X", r2.CRC, r.CRC)
	}
	v, _ := Build(data, nil)
	for _, s := range v.Slots {
		if s.ID == "virtualInput-1" && (s.References != 2 || !s.Enabled || !s.OnCanvas) {
			t.Errorf("slot %+v: want 2 references", s)
		}
	}
}

// A disabled function that an enabled input still uses is drawn (dimmed), so
// the connection is not hidden.
func TestDisabledSourceShown(t *testing.T) {
	data := example(t, "c6-test.json")
	r := edit(t, data, EditReq{Op: "set", ID: "flasher-1", Field: "enabled", Value: false})
	n := findNode(r.Graph, "flasher-1")
	if n == nil || n.Enabled {
		t.Fatalf("flasher-1: %+v", n)
	}
	if edgeSet(r.Graph)["canOutput-2:input"] != "flasher-1/out:27" {
		t.Error("wire from the disabled flasher hidden")
	}
}

// Positions live in the device's flowLayout ({"<id>": {"x", "y"}}, dingoConfig's
// field), survive a round trip, and do not change the encoding.
func TestPositions(t *testing.T) {
	data := example(t, "c6-test.json")
	before, _ := Build(data, nil)
	r := edit(t, data, EditReq{Op: "move", Moves: []Move{{ID: "flasher-1", X: 412.5, Y: -37.25}}})
	if r.CRC != crcOf(t, data, 0x500) {
		t.Error("a move changed the CRC")
	}
	layout, ok := device(t, r.Config)["flowLayout"].(map[string]any)
	if !ok {
		t.Fatalf("no flowLayout: %s", r.Config)
	}
	// Every node on the canvas got its position saved; the moved one has the new one.
	if len(layout) != len(before.Graph.Nodes) {
		t.Errorf("flowLayout has %d entries, canvas %d", len(layout), len(before.Graph.Nodes))
	}
	if p := layout["flasher-1"].(map[string]any); p["x"] != 412.5 || p["y"] != -37.25 {
		t.Errorf("flasher-1 saved at %v", p)
	}
	after, err := Build([]byte(r.Config), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range after.Graph.Nodes {
		b := findNode(before.Graph, n.ID)
		if n.ID == "flasher-1" {
			if n.X != 412.5 || n.Y != -37.25 {
				t.Errorf("flasher-1 read back at %v,%v", n.X, n.Y)
			}
		} else if n.X != b.X || n.Y != b.Y {
			t.Errorf("%s moved from %v,%v to %v,%v", n.ID, b.X, b.Y, n.X, n.Y)
		}
	}
	// The text form is dingoConfig's: "flowLayout": { "flasher-1": { "x": 412.5, "y": -37.25 }, ...
	if !strings.Contains(r.Config, "\"flowLayout\": {\n        \"device\": {\n          \"x\": 0,\n          \"y\": 0\n        },") {
		t.Errorf("flowLayout text:\n%s", r.Config)
	}
	// Another edit keeps the stored positions.
	r2 := edit(t, []byte(r.Config), EditReq{Op: "connect", SourceHandle: "out:1", Target: "canOutput-2", TargetHandle: "in:input"})
	if p := device(t, r2.Config)["flowLayout"].(map[string]any)["flasher-1"].(map[string]any); p["x"] != 412.5 {
		t.Errorf("position lost: %v", p)
	}
	if _, err := Edit(data, nil, EditReq{Op: "move", Moves: []Move{{ID: "nope-1"}}}); err == nil {
		t.Error("move of an unknown node accepted")
	}
}

// Parsing and writing back an untouched file is byte-identical, so an edit
// changes only what it edits.
func TestTextPreserved(t *testing.T) {
	for _, name := range []string{"c6-test.json", "c6-empty.json", "bench-toggle.json"} {
		data := example(t, name)
		doc, err := parseJSON(data)
		if err != nil {
			t.Fatal(err)
		}
		out := doc.marshal()
		if strings.TrimRight(string(data), "\n") != string(out) {
			t.Errorf("%s: re-marshal differs", name)
		}
	}
	// A connect on a laid-out file changes exactly one line.
	data := example(t, "c6-test.json")
	laid := edit(t, data, EditReq{Op: "move", Moves: []Move{{ID: "device", X: 0, Y: 0}}}).Config
	r := edit(t, []byte(laid), EditReq{Op: "connect", SourceHandle: "out:1", Target: "virtualInput-1", TargetHandle: "in:var2"})
	a, b := strings.Split(laid, "\n"), strings.Split(r.Config, "\n")
	if len(a) != len(b) {
		t.Fatalf("line count %d -> %d", len(a), len(b))
	}
	var changed []string
	for i := range a {
		if a[i] != b[i] {
			changed = append(changed, b[i])
		}
	}
	if len(changed) != 1 || strings.TrimSpace(changed[0]) != `"var2": 1,` {
		t.Errorf("changed lines: %q", changed)
	}
}

func TestKeypadInputs(t *testing.T) {
	data := example(t, "bench-toggle.json")
	// Button 3's second value var ← AlwaysTrue: keypads[0].buttons[2].valVars[1].
	r := edit(t, data, EditReq{Op: "connect", SourceHandle: "out:1", Target: "keypad-1", TargetHandle: "in:button3.var1"})
	kp := elem(t, device(t, r.Config), "keypads", 0)
	btns := kp["buttons"].([]any)
	if len(btns) != 3 {
		t.Fatalf("buttons %v", btns)
	}
	if vv := btns[2].(map[string]any)["valVars"].([]any); len(vv) != 2 || vv[1] != 1.0 {
		t.Errorf("valVars %v", vv)
	}
	ps, err := ops.EncodeConfig([]byte(r.Config), 1792, false)
	if err != nil {
		t.Fatal(err)
	}
	reg := params.NewRegistry(mustBoard(t, 0))
	d, _ := reg.Lookup("keypad[1].button[3].vars[2]")
	for _, p := range ps {
		if p.Index == d.Index && p.SubIndex == d.Sub && p.Value != 1 {
			t.Errorf("keypad[1].button[3].vars[2] encodes %d", p.Value)
		}
	}
	// Keypad 1's button 3 is a bool source: into an output.
	b3, _ := reg.VarIndex("Keypad1Button3")
	r2 := edit(t, data, EditReq{Op: "connect", SourceHandle: "out:" + itoa(int(b3)), Target: "output-1", TargetHandle: "in:input"})
	if elem(t, device(t, r2.Config), "outputs", 0)["input"] != float64(b3) {
		t.Errorf("output-1 input is not Keypad1Button3 (%d)", b3)
	}
	// keypad-1 is disabled, so the wire's source is drawn dimmed.
	if n := findNode(r2.Graph, "keypad-1"); n == nil || n.Enabled || n.Outputs[2].Label != "button3" || len(n.Outputs) != 26 {
		t.Errorf("keypad-1 node %+v", n)
	}
}

// Inputs given as var names (as the CLI accepts) are read as their index.
func TestVarNamesRead(t *testing.T) {
	data := []byte(`{"PdmDevices":[{"pdmType":12,"name":"n","baseId":1280,
		"flashers":[{"enabled":true,"input":"CanIn1Out"}],"canInputs":[{"enabled":true}]}]}`)
	v, err := Build(data, nil)
	if err != nil {
		t.Fatal(err)
	}
	if edgeSet(v.Graph)["flasher-1:input"] != "canInput-1/out:3" {
		t.Errorf("edges %v", edgeSet(v.Graph))
	}
}

func TestProperties(t *testing.T) {
	data := example(t, "c6-test.json")
	p, err := Properties(data, nil, "canOutput-1")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]Field{}
	for _, f := range p.Fields {
		got[f.Field] = f
	}
	if f := got["id"]; f.Value != 1520.0 || !f.Present || f.Param != "canOutput[1].id" || f.Type != "uint32" {
		t.Errorf("id field %+v", f)
	}
	if _, ok := got["input"]; ok {
		t.Error("var-map field listed as a property (it is a wire)")
	}
	if f := got["byteOrder"]; f.Type != "enum" || f.Enum[1] != "Intel" || f.Values[2] != 1 {
		t.Errorf("byteOrder %+v", f)
	}
	r := edit(t, data, EditReq{Op: "set", ID: "canOutput-1", Field: "id", Value: 1521.0})
	if elem(t, device(t, r.Config), "canOutputs", 0)["id"] != 1521.0 || r.CRC == crcOf(t, data, 0x500) {
		t.Error("id not set")
	}
	r = edit(t, data, EditReq{Op: "set", ID: "canOutput-1", Field: "byteOrder", Value: "BigEndian"})
	if elem(t, device(t, r.Config), "canOutputs", 0)["byteOrder"] != 1.0 {
		t.Error("enum by name not stored as its number")
	}
	r = edit(t, data, EditReq{Op: "set", ID: "flasher-1", Field: "name", Value: "slow blink"})
	if findNode(r.Graph, "flasher-1").Label != "slow blink" {
		t.Error("rename not shown")
	}
	for _, e := range []EditReq{
		{Op: "set", ID: "canOutput-1", Field: "bitLength", Value: 40.0},
		{Op: "set", ID: "canOutput-1", Field: "input", Value: 1.0},
		{Op: "set", ID: "canOutput-1", Field: "nope", Value: 1.0},
	} {
		if _, err := Edit(data, nil, e); err == nil {
			t.Errorf("%+v accepted", e)
		}
	}
}

func TestParseEdit(t *testing.T) {
	e, err := ParseEdit([]byte(`{"op":"move","moves":[{"id":"device","x":1,"y":2}]}`))
	if err != nil || e.Moves[0].Y != 2 {
		t.Fatal(e, err)
	}
	if _, err := ParseEdit([]byte(`{"op":"connect","sourceHandel":"out:1"}`)); err == nil {
		t.Error("misspelt field accepted")
	}
}

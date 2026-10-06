//go:build js && wasm

// Command wasm is the browser build of dingo-cli: it exposes the CLI's encoding
// (internal/pdmcfg, internal/params) and parameter protocol (internal/dingo,
// via internal/ops) as globalThis.dingo, with the CAN transport supplied by
// JavaScript (e.g. Web Bluetooth to a CAN bridge). See web/README.md for the
// contract.
//
// Every exported function is called on the JS event loop. Device operations
// therefore run in a goroutine and settle a Promise from there: blocking inside
// the callback would deadlock the js/wasm runtime, because the transport's
// send() Promise can only settle once control returns to JS.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"runtime/debug"
	"sync"
	"time"

	"syscall/js"

	"dingo-cli/internal/canframe"
	"dingo-cli/internal/dingo"
	"dingo-cli/internal/flow"
	"dingo-cli/internal/ops"
	"dingo-cli/internal/params"
	"dingo-cli/internal/pdmcfg"
)

// build is set by web/build.sh (-ldflags "-X main.build=...").
var build = ""

const (
	rxQueueSize = 16384           // matches slcan's receive buffer (a full ReadAll dump fits)
	sendTimeout = 5 * time.Second // how long a transport.send() Promise may take to settle
)

var (
	jsObject     = js.Global().Get("Object")
	jsUint8Array = js.Global().Get("Uint8Array")
	jsArray      = js.Global().Get("Array")
	jsPromise    = js.Global().Get("Promise")
)

// ---- transport -------------------------------------------------------------

// jsTransport is a dingo.Transport over the app's send() and pushFrame().
type jsTransport struct {
	mu      sync.Mutex
	send    js.Value // the app's transport object (has .send)
	rx      chan canframe.Frame
	dropped int // frames discarded because rx was full (since the last reset)
}

var tr = &jsTransport{rx: make(chan canframe.Frame, rxQueueSize)}

// timeoutScale multiplies protocol response timeouts; tests only (see
// dingo._setTimeoutScale). 1 in production.
var timeoutScale = 1.0

func (t *jsTransport) transport() (js.Value, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.send, t.send.Truthy()
}

// push queues a received frame without blocking, dropping the oldest on overflow.
func (t *jsTransport) push(f canframe.Frame) {
	for {
		select {
		case t.rx <- f:
			return
		default:
		}
		select {
		case <-t.rx:
			t.mu.Lock()
			t.dropped++
			t.mu.Unlock()
		default:
		}
	}
}

// reset discards stale frames (cyclic status that arrived while idle) and the
// drop counter, so an operation starts from live traffic.
func (t *jsTransport) reset() {
	for {
		select {
		case <-t.rx:
		default:
			t.mu.Lock()
			t.dropped = 0
			t.mu.Unlock()
			return
		}
	}
}

func (t *jsTransport) droppedCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.dropped
}

func (t *jsTransport) Send(f canframe.Frame) (err error) {
	obj, ok := t.transport()
	if !ok {
		return errNoTransport
	}
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("transport.send(0x%03X) threw: %s", f.ID, describePanic(r))
		}
	}()
	data := jsUint8Array.New(len(f.Data))
	js.CopyBytesToJS(data, f.Data)
	res := obj.Call("send", f.ID, data)
	if !isThenable(res) {
		return nil // a synchronous send that did not throw succeeded
	}
	return await(res, scaled(sendTimeout), fmt.Sprintf("transport.send(0x%03X)", f.ID))
}

func (t *jsTransport) Recv(timeout time.Duration) (canframe.Frame, error) {
	if timeout <= 0 {
		select {
		case f := <-t.rx:
			return f, nil
		default:
			return canframe.Frame{}, errRecvTimeout
		}
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case f := <-t.rx:
		return f, nil
	case <-timer.C:
		return canframe.Frame{}, errRecvTimeout
	}
}

func (t *jsTransport) Close() error { return nil }

var (
	errNoTransport = errors.New("no transport: call dingo.setTransport({ send(id, data) { ... } }) first")
	errRecvTimeout = errors.New("receive timeout")
)

func isThenable(v js.Value) bool {
	return v.Type() == js.TypeObject && v.Get("then").Type() == js.TypeFunction
}

// await blocks the calling goroutine (never the event loop) until the Promise
// settles or timeout passes.
func await(p js.Value, timeout time.Duration, what string) error {
	ch := make(chan error, 1)
	var onOK, onErr js.Func
	onOK = js.FuncOf(func(js.Value, []js.Value) any { ch <- nil; return nil })
	onErr = js.FuncOf(func(_ js.Value, args []js.Value) any {
		reason := "rejected"
		if len(args) > 0 {
			reason = jsErrorString(args[0])
		}
		ch <- fmt.Errorf("%s rejected: %s", what, reason)
		return nil
	})
	release := func() { onOK.Release(); onErr.Release() }
	p.Call("then", onOK, onErr)
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-ch:
		release()
		return err
	case <-timer.C:
		// Keep the callbacks alive until the Promise does settle, or JS would
		// call a released function.
		go func() { <-ch; release() }()
		return fmt.Errorf("%s did not settle within %v", what, timeout)
	}
}

func jsErrorString(v js.Value) string {
	switch v.Type() {
	case js.TypeUndefined, js.TypeNull:
		return v.Type().String()
	case js.TypeString:
		return v.String()
	case js.TypeObject:
		if m := v.Get("message"); m.Type() == js.TypeString {
			if n := v.Get("name"); n.Type() == js.TypeString && n.String() != "Error" {
				return n.String() + ": " + m.String()
			}
			return m.String()
		}
	}
	return js.Global().Call("String", v).String()
}

func scaled(d time.Duration) time.Duration {
	if timeoutScale == 1 {
		return d
	}
	return time.Duration(float64(d) * timeoutScale)
}

// ---- results ---------------------------------------------------------------

type obj = map[string]any

func fail(format string, a ...any) obj { return obj{"ok": false, "error": fmt.Sprintf(format, a...)} }

func hex8(v uint32) string { return fmt.Sprintf("%08X", v) }

func paramsJS(ps []dingo.Param) []any {
	out := make([]any, len(ps))
	for i, p := range ps {
		out[i] = obj{"index": int(p.Index), "sub": int(p.SubIndex), "value": int(p.Value)}
	}
	return out
}

func describePanic(r any) string {
	if e, ok := r.(js.Error); ok {
		return jsErrorString(e.Value)
	}
	return fmt.Sprint(r)
}

// toJS converts a result tree (maps, slices, scalars) to a JS value.
func toJS(v any) js.Value {
	switch x := v.(type) {
	case obj:
		o := jsObject.New()
		for k, e := range x {
			o.Set(k, toJS(e))
		}
		return o
	case []any:
		a := jsArray.New(len(x))
		for i, e := range x {
			a.SetIndex(i, toJS(e))
		}
		return a
	case []string:
		a := jsArray.New(len(x))
		for i, e := range x {
			a.SetIndex(i, e)
		}
		return a
	case nil:
		return js.Null()
	}
	return js.ValueOf(v)
}

// promise runs fn in a goroutine and returns a Promise that always resolves,
// to fn's result or to {ok:false,error} if fn panics.
func promise(op string, fn func() obj) js.Value {
	var exec js.Func
	exec = js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve := args[0]
		go func() {
			var res obj
			func() {
				defer func() {
					if r := recover(); r != nil {
						res = fail("%s: internal error: %s\n%s", op, describePanic(r), debug.Stack())
					}
				}()
				res = fn()
			}()
			var v js.Value
			func() {
				defer func() {
					if r := recover(); r != nil {
						v = toJS(fail("%s: could not build result: %s", op, describePanic(r)))
					}
				}()
				v = toJS(res)
			}()
			resolve.Invoke(v)
		}()
		return nil
	})
	p := jsPromise.New(exec)
	exec.Release() // the executor has already run
	return p
}

// resolved returns an already-resolved Promise (for argument errors and busy).
func resolved(r obj) js.Value { return jsPromise.Call("resolve", toJS(r)) }

// ---- device operations -----------------------------------------------------

var (
	busyMu sync.Mutex
	busyOp string
)

func acquire(op string) (string, bool) {
	busyMu.Lock()
	defer busyMu.Unlock()
	if busyOp != "" {
		return busyOp, false
	}
	busyOp = op
	return "", true
}

func releaseBusy() {
	busyMu.Lock()
	busyOp = ""
	busyMu.Unlock()
}

// deviceOp validates base, takes the single device-operation slot, and runs fn
// with a client in a goroutine. pre runs before the slot is taken (argument
// checks); a non-nil result from it resolves immediately.
func deviceOp(op string, args []js.Value, pre func() obj, fn func(cl *dingo.Client, base uint16) obj) any {
	base, err := baseArg(args, 0)
	if err != nil {
		return resolved(fail("%s: %v", op, err))
	}
	if pre != nil {
		if r := pre(); r != nil {
			return resolved(r)
		}
	}
	if cur, ok := acquire(op); !ok {
		return resolved(fail("busy: %s in progress", cur))
	}
	return promise(op, func() obj {
		defer releaseBusy()
		if _, ok := tr.transport(); !ok {
			return fail("%s: %v", op, errNoTransport)
		}
		tr.reset()
		cl := dingo.New(tr, base)
		cl.SetTimeoutScale(timeoutScale)
		res := fn(cl, base)
		if ok, _ := res["ok"].(bool); !ok {
			if n := tr.droppedCount(); n > 0 {
				res["error"] = fmt.Sprintf("%s (note: %d received frames were dropped because the %d-frame receive queue overflowed)",
					res["error"], n, rxQueueSize)
			}
		}
		return res
	})
}

// devErr formats a protocol failure with which device and frames were involved.
func devErr(op string, base uint16, err error) obj {
	if errors.Is(err, errNoTransport) {
		return fail("%s: %v", op, err)
	}
	return fail("%s: PDM at base 0x%03X (commands to 0x%03X, responses on 0x%03X): %v",
		op, base, base+1, base, err)
}

func baseArg(args []js.Value, i int) (uint16, error) {
	if len(args) <= i || args[i].Type() != js.TypeNumber {
		return 0, fmt.Errorf("base must be a number (the PDM's base CAN id, e.g. 222 = 0x0DE)")
	}
	f := args[i].Float()
	if f != float64(int(f)) || f < 0 || f > 0x7FE {
		return 0, fmt.Errorf("base %v is not an integer CAN id in 0..0x7FE (commands go to base+1)", f)
	}
	return uint16(f), nil
}

func optsArg(args []js.Value, i int) js.Value {
	if len(args) > i && args[i].Type() == js.TypeObject {
		return args[i]
	}
	return js.Undefined()
}

func optBool(opts js.Value, k string) (bool, error) {
	if opts.Type() != js.TypeObject {
		return false, nil
	}
	v := opts.Get(k)
	switch v.Type() {
	case js.TypeUndefined, js.TypeNull:
		return false, nil
	case js.TypeBoolean:
		return v.Bool(), nil
	}
	return false, fmt.Errorf("opts.%s must be a boolean, got %s", k, v.Type())
}

// progressFn adapts opts.onProgress to dingo.Client.Progress, throttled so a
// 2000-param write does not make 2000 JS calls. A throwing callback is
// reported in the result (progressError) and not called again; it never
// aborts the operation.
func progressFn(opts js.Value, perr *string) func(done, total int) {
	if opts.Type() != js.TypeObject || opts.Get("onProgress").Type() != js.TypeFunction {
		return nil
	}
	cb := opts.Get("onProgress")
	last := time.Time{}
	return func(done, total int) {
		if *perr != "" {
			return
		}
		if total > 0 && done != total && time.Since(last) < 50*time.Millisecond {
			return
		}
		if total <= 0 && time.Since(last) < 50*time.Millisecond {
			return
		}
		last = time.Now()
		func() {
			defer func() {
				if r := recover(); r != nil {
					*perr = "onProgress threw: " + describePanic(r)
				}
			}()
			o := jsObject.New()
			o.Set("done", done)
			if total > 0 {
				o.Set("total", total)
			} else {
				o.Set("total", js.Null())
			}
			cb.Invoke(o)
		}()
	}
}

func withProgressErr(r obj, perr string) obj {
	if perr != "" {
		r["progressError"] = perr
	}
	return r
}

func deviceVersion(_ js.Value, args []js.Value) any {
	return deviceOp("deviceVersion", args, nil, func(cl *dingo.Client, base uint16) obj {
		v, err := ops.ReadVersion(cl)
		if err != nil {
			return devErr("deviceVersion", base, err)
		}
		return obj{"ok": true, "major": v.Major, "minor": v.Minor, "build": v.Build, "text": v.String()}
	})
}

func checkCrc(_ js.Value, args []js.Value) any {
	return deviceOp("checkCrc", args, nil, func(cl *dingo.Client, base uint16) obj {
		crc, err := ops.Verify(cl)
		if err != nil {
			return devErr("checkCrc", base, err)
		}
		return obj{"ok": true, "crc": hex8(crc)}
	})
}

func burn(_ js.Value, args []js.Value) any {
	return deviceOp("burn", args, nil, func(cl *dingo.Client, base uint16) obj {
		if err := ops.Burn(cl); err != nil {
			return devErr("burn", base, err)
		}
		return obj{"ok": true}
	})
}

func readAll(_ js.Value, args []js.Value) any {
	opts := optsArg(args, 1)
	return deviceOp("readAll", args, nil, func(cl *dingo.Client, base uint16) obj {
		var perr string
		cl.Progress = progressFn(opts, &perr)
		ps, crc, err := ops.ReadAll(cl)
		if err != nil {
			return withProgressErr(devErr("readAll", base, err), perr)
		}
		if cl.Progress != nil {
			cl.Progress(len(ps), len(ps)) // the total is known only once the dump completes
		}
		return withProgressErr(obj{"ok": true, "count": len(ps), "crc": hex8(crc), "params": paramsJS(ps)}, perr)
	})
}

// prepared is a config encoded for apply/encode.
type prepared struct {
	sel   ops.Selection
	board params.Board
	cfg   []dingo.Param
}

// prepare selects and encodes the PDM exactly as `dingo apply -base base`
// would, with errors that say what the file contains.
func prepare(text string, base *int, partial bool) (prepared, error) {
	data := []byte(text)
	entries, err := ops.Devices(data)
	if err != nil {
		return prepared{}, err
	}
	sel, err := ops.SelectPdm(entries, base)
	if err != nil {
		return prepared{}, err
	}
	target := uint16(0)
	if base != nil {
		target = uint16(*base)
	} else if sel.Entry.BaseID != nil {
		target = uint16(*sel.Entry.BaseID)
	}
	board, err := pdmcfg.DeviceBoard(data, target)
	if err != nil {
		return prepared{}, err
	}
	cfg, err := ops.EncodeConfig(data, target, partial)
	if err != nil {
		return prepared{}, err
	}
	return prepared{sel: sel, board: board, cfg: cfg}, nil
}

func entryObj(e ops.Entry) obj {
	o := obj{"kind": e.Kind, "name": e.Name, "baseId": nil, "pdmType": nil}
	if e.BaseID != nil {
		o["baseId"] = *e.BaseID
	}
	if e.PdmType != nil {
		o["pdmType"] = *e.PdmType
	}
	return o
}

func fallbackWarning(p prepared, base uint16) string {
	if !p.sel.Fallback {
		return ""
	}
	fileID := "no baseId"
	if p.sel.Entry.BaseID != nil {
		fileID = fmt.Sprintf("baseId %d (0x%03X)", *p.sel.Entry.BaseID, *p.sel.Entry.BaseID)
	}
	return fmt.Sprintf("the file's only PDM has %s, not %d (0x%03X); it was used anyway (dingo apply's rule), and its params set the device's baseId from the file",
		fileID, base, base)
}

func apply(_ js.Value, args []js.Value) any {
	const op = "apply"
	opts := optsArg(args, 2)
	var p prepared
	var burnOpt, partial bool
	var text string
	pre := func() obj {
		if len(args) < 2 || args[1].Type() != js.TypeString {
			return fail("%s: jsonText must be the dingoConfig file contents as a string", op)
		}
		text = args[1].String()
		var err error
		if burnOpt, err = optBool(opts, "burn"); err != nil {
			return fail("%s: %v", op, err)
		}
		if partial, err = optBool(opts, "partial"); err != nil {
			return fail("%s: %v", op, err)
		}
		return nil
	}
	return deviceOp(op, args, pre, func(cl *dingo.Client, base uint16) obj {
		b := int(base)
		var err error
		if p, err = prepare(text, &b, partial); err != nil {
			return fail("%s: %v", op, err)
		}
		var perr string
		cl.Progress = progressFn(opts, &perr)
		res, err := ops.Apply(cl, p.cfg, ops.ApplyOptions{Burn: burnOpt})
		out := obj{"applied": res.Applied, "crc": hex8(res.CRC), "burned": res.Burned,
			"partial": partial, "board": p.board.Name}
		if w := fallbackWarning(p, base); w != "" {
			out["warning"] = w
		}
		if err != nil {
			e := devErr(op, base, err)
			if res.Applied > 0 {
				e = devErr(op, base, fmt.Errorf("applied %d params (count + CRC verified) but burn failed: %w", res.Applied, err))
			} else {
				out["crc"] = hex8(dingo.CRC(p.cfg))
			}
			for k, v := range e {
				out[k] = v
			}
			return withProgressErr(out, perr)
		}
		out["ok"] = true
		return withProgressErr(out, perr)
	})
}

// paramArgs resolves the name argument against the CLI's registry.
func paramName(args []js.Value, i int, op string) (string, obj) {
	if len(args) <= i || args[i].Type() != js.TypeString {
		return "", fail("%s: name must be a string such as \"output[4].currentLimit\" (see dingo.paramNames())", op)
	}
	return args[i].String(), nil
}

func pvObj(pv ops.ParamValue, b params.Board) obj {
	return obj{"ok": true, "name": pv.Def.Name, "value": pv.Value, "raw": int(pv.Raw),
		"index": int(pv.Def.Index), "sub": int(pv.Def.Sub), "board": b.Name}
}

// optBoard is opts.pdmType's board (the parameter table and var map a name
// and value resolve against); absent means params.DefaultBoard().
func optBoard(opts js.Value) (params.Board, error) {
	if opts.Type() != js.TypeObject {
		return params.DefaultBoard(), nil
	}
	v := opts.Get("pdmType")
	switch v.Type() {
	case js.TypeUndefined, js.TypeNull:
		return params.DefaultBoard(), nil
	case js.TypeNumber:
		if v.Float() == float64(v.Int()) {
			return ops.Board(v.Int())
		}
	}
	return params.Board{}, fmt.Errorf("opts.pdmType must be an integer board type")
}

func setParam(_ js.Value, args []js.Value) any {
	const op = "setParam"
	opts := optsArg(args, 3)
	var def *params.Def
	var raw uint32
	var burnOpt bool
	var board params.Board
	pre := func() obj {
		name, bad := paramName(args, 1, op)
		if bad != nil {
			return bad
		}
		if len(args) < 3 {
			return fail("%s: missing value for %s", op, name)
		}
		var val any
		switch v := args[2]; v.Type() {
		case js.TypeNumber:
			val = v.Float()
		case js.TypeBoolean:
			val = v.Bool()
		case js.TypeString:
			val = v.String()
		default:
			return fail("%s: value for %s must be a number, boolean or string, got %s", op, name, v.Type())
		}
		var err error
		if board, err = optBoard(opts); err != nil {
			return fail("%s: %v", op, err)
		}
		if def, raw, err = ops.EncodeParamFor(board, name, val); err != nil {
			return fail("%s: %v", op, err)
		}
		if burnOpt, err = optBool(opts, "burn"); err != nil {
			return fail("%s: %v", op, err)
		}
		return nil
	}
	return deviceOp(op, args, pre, func(cl *dingo.Client, base uint16) obj {
		pv, err := ops.SetFor(cl, board, def, raw)
		if err != nil {
			return devErr(op, base, err)
		}
		r := pvObj(pv, board)
		r["burned"] = false
		if burnOpt {
			if err := ops.Burn(cl); err != nil {
				e := devErr(op, base, fmt.Errorf("set %s but burn failed: %w", def.Name, err))
				for k, v := range e {
					r[k] = v
				}
				return r
			}
			r["burned"] = true
		}
		return r
	})
}

func getParam(_ js.Value, args []js.Value) any {
	const op = "getParam"
	opts := optsArg(args, 2)
	var def *params.Def
	var board params.Board
	pre := func() obj {
		name, bad := paramName(args, 1, op)
		if bad != nil {
			return bad
		}
		var err error
		if board, err = optBoard(opts); err != nil {
			return fail("%s: %v", op, err)
		}
		if def, err = ops.ResolveParamFor(board, name); err != nil {
			return fail("%s: %v", op, err)
		}
		return nil
	}
	return deviceOp(op, args, pre, func(cl *dingo.Client, base uint16) obj {
		pv, err := ops.GetFor(cl, board, def)
		if err != nil {
			return devErr(op, base, err)
		}
		return pvObj(pv, board)
	})
}

// ---- pure functions --------------------------------------------------------

// sync runs a pure function, returning a resolved Promise and never panicking.
func syncOp(op string, fn func() obj) js.Value {
	var res obj
	func() {
		defer func() {
			if r := recover(); r != nil {
				res = fail("%s: internal error: %s", op, describePanic(r))
			}
		}()
		res = fn()
	}()
	return resolved(res)
}

func encode(_ js.Value, args []js.Value) any {
	const op = "encode"
	return syncOp(op, func() obj {
		if len(args) < 1 || args[0].Type() != js.TypeString {
			return fail("%s: jsonText must be the dingoConfig file contents as a string", op)
		}
		var basePtr *int
		if len(args) > 1 && args[1].Type() != js.TypeUndefined && args[1].Type() != js.TypeNull {
			b, err := baseArg(args, 1)
			if err != nil {
				return fail("%s: %v", op, err)
			}
			bi := int(b)
			basePtr = &bi
		}
		p, err := prepare(args[0].String(), basePtr, false)
		if err != nil {
			return fail("%s: %v", op, err)
		}
		out := obj{"ok": true, "name": p.sel.Entry.Name, "pdmType": p.board.PdmType, "board": p.board.Name,
			"baseId": nil, "count": len(p.cfg), "crc": hex8(dingo.CRC(p.cfg)), "params": paramsJS(p.cfg)}
		if p.sel.Entry.BaseID != nil {
			out["baseId"] = *p.sel.Entry.BaseID
		}
		if basePtr != nil {
			if w := fallbackWarning(p, uint16(*basePtr)); w != "" {
				out["warning"] = w
			}
		}
		return out
	})
}

func devices(_ js.Value, args []js.Value) any {
	const op = "devices"
	return syncOp(op, func() obj {
		if len(args) < 1 || args[0].Type() != js.TypeString {
			return fail("%s: jsonText must be the dingoConfig file contents as a string", op)
		}
		es, err := ops.Devices([]byte(args[0].String()))
		if err != nil {
			return fail("%s: %v", op, err)
		}
		list := make([]any, len(es))
		for i, e := range es {
			list[i] = entryObj(e)
		}
		return obj{"ok": true, "devices": list}
	})
}

func paramNames(_ js.Value, args []js.Value) any {
	const op = "paramNames"
	return syncOp(op, func() obj {
		b := params.DefaultBoard()
		if len(args) > 0 && args[0].Type() != js.TypeUndefined && args[0].Type() != js.TypeNull {
			if args[0].Type() != js.TypeNumber || args[0].Float() != float64(args[0].Int()) {
				return fail("%s: pdmType must be an integer", op)
			}
			var err error
			if b, err = ops.Board(args[0].Int()); err != nil {
				return fail("%s: %v", op, err)
			}
		}
		return obj{"ok": true, "board": b.Name, "pdmType": b.PdmType, "names": ops.ParamNames(b)}
	})
}

// ---- logic graph (internal/flow) -------------------------------------------

// plain converts a result struct to the obj/[]any tree toJS takes, through its
// JSON form (so the field names are the struct's json tags).
func plain(v any) (obj, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var o obj
	if err := json.Unmarshal(b, &o); err != nil {
		return nil, err
	}
	return o, nil
}

// optBase reads an optional base id argument (undefined/null: the file's only PDM).
func optBase(args []js.Value, i int) (*int, error) {
	if len(args) <= i || args[i].Type() == js.TypeUndefined || args[i].Type() == js.TypeNull {
		return nil, nil
	}
	b, err := baseArg(args, i)
	if err != nil {
		return nil, err
	}
	bi := int(b)
	return &bi, nil
}

func graph(_ js.Value, args []js.Value) any {
	const op = "graph"
	return syncOp(op, func() obj {
		if len(args) < 1 || args[0].Type() != js.TypeString {
			return fail("%s: jsonText must be the dingoConfig file contents as a string", op)
		}
		base, err := optBase(args, 1)
		if err != nil {
			return fail("%s: %v", op, err)
		}
		v, err := flow.Build([]byte(args[0].String()), base)
		if err != nil {
			return fail("%s: %v", op, err)
		}
		o, err := plain(v)
		if err != nil {
			return fail("%s: %v", op, err)
		}
		o["ok"] = true
		return o
	})
}

func graphEdit(_ js.Value, args []js.Value) any {
	const op = "graphEdit"
	return syncOp(op, func() obj {
		if len(args) < 2 || args[0].Type() != js.TypeString {
			return fail("%s: expected (jsonText: string, edit: object, base?)", op)
		}
		var text string
		switch args[1].Type() {
		case js.TypeString:
			text = args[1].String()
		case js.TypeObject:
			text = js.Global().Get("JSON").Call("stringify", args[1]).String()
		default:
			return fail("%s: edit must be an object such as {op:'connect', sourceHandle, target, targetHandle}", op)
		}
		e, err := flow.ParseEdit([]byte(text))
		if err != nil {
			return fail("%s: %v", op, err)
		}
		base, err := optBase(args, 2)
		if err != nil {
			return fail("%s: %v", op, err)
		}
		r, err := flow.Edit([]byte(args[0].String()), base, e)
		if err != nil {
			return fail("%s: %v", op, err)
		}
		o, err := plain(r)
		if err != nil {
			return fail("%s: %v", op, err)
		}
		o["ok"] = true
		o["crc"] = hex8(r.CRC)
		return o
	})
}

func graphNode(_ js.Value, args []js.Value) any {
	const op = "graphNode"
	return syncOp(op, func() obj {
		if len(args) < 2 || args[0].Type() != js.TypeString || args[1].Type() != js.TypeString {
			return fail("%s: expected (jsonText: string, nodeId: string, base?)", op)
		}
		base, err := optBase(args, 2)
		if err != nil {
			return fail("%s: %v", op, err)
		}
		p, err := flow.Properties([]byte(args[0].String()), base, args[1].String())
		if err != nil {
			return fail("%s: %v", op, err)
		}
		o, err := plain(p)
		if err != nil {
			return fail("%s: %v", op, err)
		}
		o["ok"] = true
		return o
	})
}

// ---- transport registration ------------------------------------------------

func setTransport(_ js.Value, args []js.Value) any {
	if len(args) < 1 || args[0].Type() != js.TypeObject || args[0].Get("send").Type() != js.TypeFunction {
		return toJS(fail("setTransport: expected an object with a send(id, data) method"))
	}
	tr.mu.Lock()
	tr.send = args[0]
	tr.mu.Unlock()
	return toJS(obj{"ok": true})
}

var okPush js.Value // cached {ok:true} so pushFrame allocates nothing on success

func pushFrame(_ js.Value, args []js.Value) (ret any) {
	defer func() {
		if r := recover(); r != nil {
			ret = toJS(fail("pushFrame: %s", describePanic(r)))
		}
	}()
	if len(args) < 2 || args[0].Type() != js.TypeNumber {
		return toJS(fail("pushFrame: expected (id: number, data: Uint8Array)"))
	}
	id := args[0].Int()
	if float64(id) != args[0].Float() || id < 0 || id > 0x7FF {
		return toJS(fail("pushFrame: id %v is not a standard 11-bit CAN id", args[0].Float()))
	}
	d := args[1]
	if !d.InstanceOf(jsUint8Array) {
		if d.Type() == js.TypeObject && (jsArray.Call("isArray", d).Bool() || d.InstanceOf(js.Global().Get("ArrayBuffer"))) {
			d = jsUint8Array.New(d)
		} else {
			return toJS(fail("pushFrame: data must be a Uint8Array"))
		}
	}
	n := d.Get("length").Int()
	if n > 8 {
		return toJS(fail("pushFrame: %d data bytes; a classic CAN frame carries at most 8", n))
	}
	buf := make([]byte, n)
	js.CopyBytesToGo(buf, d)
	tr.push(canframe.Frame{ID: uint16(id), Data: buf})
	return okPush
}

func setTimeoutScale(_ js.Value, args []js.Value) any {
	if len(args) < 1 || args[0].Type() != js.TypeNumber || args[0].Float() <= 0 || args[0].Float() > 10 {
		return toJS(fail("_setTimeoutScale: expected a number in (0, 10]"))
	}
	timeoutScale = args[0].Float()
	return toJS(obj{"ok": true, "scale": timeoutScale})
}

func buildString() string {
	if build != "" {
		return build
	}
	if bi, ok := debug.ReadBuildInfo(); ok {
		var rev, t, mod string
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				rev = s.Value
			case "vcs.time":
				t = s.Value
			case "vcs.modified":
				if s.Value == "true" {
					mod = "-dirty"
				}
			}
		}
		if rev != "" {
			if len(rev) > 7 {
				rev = rev[:7]
			}
			return rev + mod + " " + t
		}
	}
	return "unknown"
}

func main() {
	okPush = toJS(obj{"ok": true})
	jsObject.Call("freeze", okPush)

	fns := map[string]func(js.Value, []js.Value) any{
		"setTransport":     setTransport,
		"pushFrame":        pushFrame,
		"deviceVersion":    deviceVersion,
		"checkCrc":         checkCrc,
		"readAll":          readAll,
		"apply":            apply,
		"burn":             burn,
		"setParam":         setParam,
		"getParam":         getParam,
		"encode":           encode,
		"devices":          devices,
		"paramNames":       paramNames,
		"graph":            graph,
		"graphEdit":        graphEdit,
		"graphNode":        graphNode,
		"_setTimeoutScale": setTimeoutScale,
	}
	d := jsObject.New()
	for name, fn := range fns {
		d.Set(name, js.FuncOf(fn)) // never released: they live as long as the page
	}
	d.Set("info", toJS(obj{"module": "dingo-cli", "go": runtime.Version(), "build": buildString()}))
	d.Set("ready", jsPromise.Call("resolve", true))
	js.Global().Set("dingo", d)

	select {} // keep the Go runtime alive to serve callbacks
}

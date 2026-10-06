# dingo-cli in the browser (Go → WebAssembly)

`web/dingo.wasm` is the dingo CLI's own encoder and parameter protocol compiled
to WebAssembly. A browser app supplies the CAN transport (e.g. Web Bluetooth to
an ESP32 CAN bridge); everything else — dingoConfig → params, WriteAll with
count + CRC verification, burn, read-all, named params — is the same Go code
`dingo apply/set/getn/verify/version/burn` runs, through `internal/ops`.

| file | what |
|---|---|
| `wasm/main.go` | the wasm entry (`js && wasm`); registers `globalThis.dingo` |
| `dingo-loader.js` | ES module: `loadDingo(url)` → `globalThis.dingo` |
| `build.sh` | builds `dingo.wasm`, copies `wasm_exec.js` (run in the container) |
| `test/wasm.test.mjs` | Node end-to-end tests (real wasm, JS fake PDM, native golden; the C6 examples against a fake node holding the C6 firmware's own table and CRCs from `internal/params/testdata/c6body_v1.fw.json`) |
| `test/golden/` | native Go: prints what the CLI encodes for a file (test oracle) |
| `examples/` | `bench-toggle.json` (a dingoPDM), `c6-empty.json` / `c6-test.json` (the C6 body node, `pdmType` 12) |
| `vendor/dingoconfig-flow/` | Cory Grant's dingoConfig React Flow editor, vendored **unmodified** (MIT; `VENDORED.md` says which commit) |
| `flow.js` | the Logic view's adapter: a fake Blazor `dotnet` for that editor, routed to `graphEdit` |
| `dingo.wasm`, `wasm_exec.js`, `flow-editor/` | build outputs |

## Build and test (inside the dev container)

```
podman exec dingo-web bash -lc 'cd /workspace && web/build.sh && node web/test/wasm.test.mjs'
```

`build.sh` (no argument, or `wasm` / `flow` for one part):

- **wasm:** `GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w -X main.build=…" -o web/dingo.wasm ./web/wasm`,
  and copies `$(go env GOROOT)/misc/wasm/wasm_exec.js` next to it.
- **flow:** builds the vendored editor with its own `package-lock.json` and
  `vite.config.js` (Vite 8, Node ≥ 20.19) into `web/flow-editor/flow-editor.{js,css}`.
  It builds in a copy under `/tmp/dingoconfig-flow-build` (`FLOW_BUILD_DIR`), so
  `node_modules` never enters the repo; `npm ci` (network) runs only when the
  lockfile changed. The page itself stays build-free plain ES modules: it
  `import()`s the bundle when the Logic view opens.

The test needs Go too (it runs `go run ./web/test/golden` for the native golden).

Size (Go 1.22.6): `dingo.wasm` 3,812,396 bytes (with `internal/flow`; 3,464,495 before).
`flow-editor.js` 407,618 bytes (128 kB gzip), `flow-editor.css` 19,316 bytes.

## Loading

```js
import { loadDingo } from "./dingo-loader.js";
const dingo = await loadDingo();            // default "./dingo.wasm" (relative to the page)
```

`loadDingo(source)` takes a URL/string to fetch, or the module bytes
(`ArrayBuffer`/typed array). It loads `wasm_exec.js` from next to the loader if
`globalThis.Go` is not already defined, uses `instantiateStreaming` when the
server sends `application/wasm` and falls back to `arrayBuffer()` otherwise,
starts the Go program, awaits `dingo.ready`, and returns `globalThis.dingo`.
It is idempotent (later calls return the same instance) and, unlike the
operations below, **throws** if the module cannot be loaded.

## The `dingo` object

### Conventions

- Every operation returns a **Promise that always resolves** (never rejects) to a
  plain object: `{ ok: true, ... }` or `{ ok: false, error: "<message>" }`.
  Errors say which operation, which device, and why, e.g.
  `deviceVersion: PDM at base 0x0DE (commands to 0x0DF, responses on 0x0DE): no response (want cmd 31) after 6 tries`.
  Go panics are recovered and reported as `"<op>: internal error: ..."`.
- `base` is the PDM's base CAN id as a number (integer 0..0x7FE; firmware default
  222 = 0x0DE). Commands go to `base+1`, responses arrive on `base`.
- `crc` is always an 8-digit uppercase hex string (`"1A2B3C4D"`), as `dingo verify` prints.
- `params` are `[{ index, sub, value }]`, `value` the raw 32-bit wire value as an
  unsigned number (floats are their IEEE-754 bit pattern, int8 is sign-extended).
- **One device operation at a time.** A second device call while one is in
  flight resolves immediately to `{ ok:false, error:"busy: <op> in progress" }`.
  The pure functions are never blocked.
- Each device operation discards frames queued while idle before it starts, so it
  works from live traffic.

### Transport

```ts
dingo.setTransport({ send(id: number, data: Uint8Array): Promise<void> }) → { ok } | { ok:false, error }
```
`send` must put ONE standard-id CAN frame on the bus (DLC = `data.length`, 8 for
every protocol command). A rejected Promise is a send error
(`transport.send(0x0DF) rejected: <reason>`); a synchronous throw is also caught
(`... threw: <reason>`); a Promise that has not settled after 5 s is an error
(`... did not settle within 5s`). A non-Promise return counts as success. Sends
are awaited one at a time, so a slow link applies back-pressure.

```ts
dingo.pushFrame(id: number, data: Uint8Array) → { ok: true } | { ok:false, error }
```
Call for every received CAN frame, at any time. It copies the bytes into a
16,384-frame Go channel and returns at once (the `{ok:true}` is a shared frozen
object; nothing is allocated). When the queue is full the oldest frame is
dropped; if an operation then fails, its error says how many frames were dropped.
Invalid input (id outside 0..0x7FF, more than 8 bytes, not a `Uint8Array`/array)
returns `{ ok:false, error }` and queues nothing.

With no transport set, every device operation resolves
`{ ok:false, error:"<op>: no transport: call dingo.setTransport({ send(id, data) { ... } }) first" }`.

### Device operations

| call | resolves to (on success) | CLI equivalent |
|---|---|---|
| `deviceVersion(base)` | `{ ok, major, minor, build, text }` (`text` = `"5.3.258"`) | `dingo version` |
| `checkCrc(base)` | `{ ok, crc }` | `dingo verify` |
| `readAll(base, opts?)` | `{ ok, count, crc, params }` | (read-all dump, count + CRC verified) |
| `apply(base, jsonText, opts?)` | `{ ok, applied, crc, burned, partial, board, warning? }` | `dingo apply [-burn] [-partial]` |
| `burn(base)` | `{ ok }` | `dingo burn` |
| `setParam(base, name, value, opts?)` | `{ ok, name, value, raw, index, sub, board, burned }` | `dingo set [-burn] [-type T] name value` |
| `getParam(base, name, opts?)` | `{ ok, name, value, raw, index, sub, board }` | `dingo getn [-type T] -name name` |

- **apply** `opts = { burn?: boolean, partial?: boolean, onProgress?: ({done,total}) => void }`.
  Selects the `PdmDevices` entry whose `baseId` equals `base`; a file with
  exactly one PDM is used regardless of `base`, exactly as `dingo apply` does —
  then `warning` says so, because the written params set the device's baseId from
  the file. With several PDMs and no match:
  `apply: no PdmDevices entry with baseId 291 (0x123); file has: 222 (0x0DE) "front", 300 (0x12C) "rear"`.
  It encodes (every board param, absent fields at firmware default; with
  `partial`, only fields the file sets), runs WriteAll (verifies count + CRC),
  then burns if asked. `board` is the parameter table used (`"dingoPDM"`, …).
  If the write succeeded but the burn failed, the result is `ok:false` and
  still carries `applied`, `crc`, `burned:false`, with
  `error: "apply: PDM at base 0x0DE (...): applied 2269 params (count + CRC verified) but burn failed: burn rejected: device WriteConfig returned 0"`.
- **readAll / apply progress**: `opts.onProgress({ done, total })`, throttled to
  about every 50 ms plus the final call. For apply `total` is the param count.
  For readAll the device does not announce the size, so `total` is `null` until
  the final call (`done === total === count`). A throwing callback does not abort
  the operation; it is not called again and the result carries
  `progressError: "onProgress threw: ..."`.
- **setParam / getParam** names are the CLI's (`output[4].currentLimit`,
  `device.canSpeed`, `keypad[1].button[3].colors[2]`, …) and, like the CLI,
  resolve against the **dingoPDM (dingopdm_v7)** table (see `paramNames()`)
  unless `opts.pdmType` names another board (12 for the C6 body node, whose
  var map differs: `"CanIn1Out"` is 3 there, 7 on a dingoPDM).
  `value` may be a number, boolean or string (enum and var-map names such as
  `"250K"`, `"Flasher1"` are accepted; a string is parsed exactly as the CLI
  argument). It is range-checked before anything is sent. `value` in the result
  is decoded (number, boolean, enum or variable name); `raw` is the wire value.
  `opts = { burn?: boolean, pdmType?: number }` (getParam: `{ pdmType? }`);
  `board` in the result is the table used.
- **burn** is sent once (never resent, as a resend would re-flash); a non-1
  result is `burn rejected: device WriteConfig returned N`.

### Pure functions (no transport, never busy)

| call | resolves to |
|---|---|
| `encode(jsonText, base?)` | `{ ok, name, pdmType, board, baseId, count, crc, params, warning? }` |
| `devices(jsonText)` | `{ ok, devices: [{ kind, name, baseId, pdmType }] }` |
| `paramNames(pdmType?)` | `{ ok, board, pdmType, names: [...] }` |
| `graph(jsonText, base?)` | `{ ok, board, pdmType, name, baseId, graph: { nodes, edges }, slots }` |
| `graphEdit(jsonText, edit, base?)` | `{ ok, config, changed, count, crc, board, name, baseId, graph, slots }` |
| `graphNode(jsonText, nodeId, base?)` | `{ ok, id, kind, label, name, enabled, fields: [...], missing? }` |

The `graph*` functions are the Logic view (see "Logic graph" below).

- `encode` is exactly what `apply` would write (non-partial). With `base`
  omitted, the file must have one PDM; otherwise the error lists them
  (`encode: file has 2 PdmDevices entries; pass a base id to choose one: ...`).
  `pdmType` is the board actually used (from the file's `pdmType`, else its
  output count, else dingoPDM); `baseId` is the entry's own `baseId` (or `null`).
- `devices` lists every element of every top-level array: `kind` is the array key
  (`"PdmDevices"` first, then `"BlinkMarineKeypads"`, `"CanboardDevices"`, … in
  alphabetical order); `baseId`/`pdmType` are `null` when absent.
- `paramNames()` lists the dingoPDM names, i.e. what `setParam`/`getParam`
  accept by default. `paramNames(pdmType)` lists another board's table
  (`paramNames(12)`: the C6 body node, `c6body_v1`), which `setParam`/`getParam`
  use when given the same `opts.pdmType`.
- A `pdmType` the table does not know (anything but 0, 1, 2, 12) is an error:
  `unknown pdmType 13 (valid: 0 (dingoPDM), 1 (dingoPDM-Max), 2 (PT-DPDM), 12 (c6body_v1))`.
  The C6 body node's documents must carry `pdmType: 12`; an entry without
  `pdmType` and without outputs is taken as a dingoPDM.
- Malformed JSON is reported with its position:
  `encode: malformed JSON at line 3, column 6 (byte 26): invalid character ',' looking for beginning of object key string`.

### Other members

- `dingo.info` → `{ module: "dingo-cli", go: "go1.22.6", build: "<git describe> <UTC build time>" }`.
- `dingo.ready` → a Promise resolving to `true` (already resolved once
  `globalThis.dingo` exists; awaited by the loader).
- `dingo._setTimeoutScale(f)` → `{ ok, scale }`. **Tests only.** Multiplies the
  protocol's response timeouts (and the 5 s send timeout) by `f` in (0, 10], so
  the silent-device paths take milliseconds instead of seconds. Write pacing is
  not scaled, and the CLI's timing is unaffected. Never call it in the app.

## Logic graph (`internal/flow`, `flow.js`, `vendor/dingoconfig-flow`)

The page's **Logic** section draws the loaded config with Cory Grant's
dingoConfig flow editor (React Flow), vendored unmodified. In dingoConfig the
editor talks to Blazor (`dotnet.invokeMethodAsync`) and `FlowGraph.cs` maps
the device config to the graph and edits back. Here `flow.js` is the fake
`dotnet`, and `internal/flow` is the Go port of `FlowGraph.cs` +
`FlowNodeTypes.cs` (dingoConfig `development` @ `c2056f7`) on dingo-cli's own
board tables, exposed as `dingo.graph` / `graphEdit` / `graphNode`.

- **Model (same as dingoConfig):** the config is the only truth. A node is an
  enabled function slot (`<kind>-<n>`, n = array position + 1, e.g.
  `virtualInput-1`, `canOutput-2`; singletons `wiper-1`, `starterDisable-1`)
  plus the `device` node (Always On, State, and Temperature/Battery Voltage
  where the board has them). An edge is a function input whose value is
  another function's var-map index (`out:<index>` → `in:<field>`). A disabled
  function that an enabled input still uses is drawn dimmed.
- **Edits:** `connect` sets the input to the source's index if its data type
  is accepted (bool/int/float per input, FlowNodeTypes' rules; e.g. a
  condition or CAN output takes any, a flasher only bool, a wiper's speed only
  int). `delete` sets inputs to 0 and disables nodes, disconnecting every input
  that used them. `add` enables a slot (creating it, and earlier array
  elements, as disabled defaults when the file is shorter). `set` writes one
  property, range-checked by the param table. The result is re-encoded (it
  must still encode, as `apply` would) and returns count + CRC.
- **Positions** go in the PdmDevices entry: `"flowLayout": { "<nodeId>":
  { "x": .., "y": .. } }` — dingoConfig's `FwDevice.FlowLayout` field and node
  ids, so a device laid out in one tool opens the same in the other. The
  encoder ignores it (moving nodes never changes the CRC). As in dingoConfig,
  nodes without a position are stacked in three columns (sources | logic |
  outputs) and those positions are saved by the first edit.
- **Text:** edits keep key order and number literals (an order-preserving JSON
  tree, written 2-space indented like `JSON.stringify(x, null, 2)`), so a
  connect changes one line.

Covered: dingoPDM / dingoPDM-Max (digital inputs, CAN inputs, keypads, virtual
inputs, conditions, counters, flashers, outputs incl. duty-cycle input, CAN
outputs, wiper, starter disable) and c6body_v1 (CAN in/out, virtual inputs,
conditions, counters, flashers). Not covered: analog inputs and digital
outputs (PT-DPDM analog, CANBoard; pdmcfg does not encode them), the device
node's Mute CAN TX / Force Sleep inputs (not in dingo-cli's firmware tables),
live values.

## How it is wired

- `internal/canframe` holds the CAN `Frame` type; `slcan.Frame` is an alias of
  it. `internal/dingo` names frames through canframe, so it (and `ops`, `pdmcfg`,
  `params`) builds for js/wasm without `internal/slcan`, whose serial-port
  dependency does not.
- `internal/ops` is the shared operation layer; `main.go` and `wasm/main.go` both
  call it. `dingo.Client` gained a `Progress` hook and `SetTimeoutScale` (used
  only by this build's tests); the wire protocol, timing constants and encoding
  are unchanged.
- Calls from JS run on the event loop, so each device operation runs in a
  goroutine and resolves its Promise from there; the transport awaits the app's
  `send()` Promise from that goroutine.

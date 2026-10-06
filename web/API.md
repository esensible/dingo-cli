# window.api — dingo-web

The page at http://localhost:5173 (`web/index.html`) exposes one object,
`window.api`, for an AI agent (Claude in Chrome) or a person at the console.
Each button on the page calls the same functions, so what a person sees is
what an agent gets.

```
Chrome ──Web Bluetooth──▶ hilux ESP32-C6 (CAN bridge, hilux/wireless-can/BRIDGE.md) ──CAN 500k──▶ dingoPDM(s)
          web/ble.js                                     web/dingo.wasm (dingo-cli protocol + encoder)
```

## Conventions

- **Call `await api.describe()` first.** It lists every function with its args,
  return shape and an example, plus the workflow, skills and notes. It is built
  from the same registry that implements the functions, so it always matches them.
- Every function is async, **never throws**, and resolves to plain JSON:
  `{ ok: true, ... }` or `{ ok: false, error, hint? }`. Results hold no typed
  arrays or class instances: bytes are hex strings, and CRCs come as a number
  plus `crcHex`.
- Positional args come first, then one options object for `opts.*`:
  `api.apply(222, cfg, { burn: true })`. One object with the positional names
  also works: `api.version({ base: 222 })`. Calling an unknown name such as
  `api.foo()` returns an error that lists the real functions.
- Base and CAN ids take numbers or `"0x.."` strings.
- **Device ops run one at a time.** A second call while one runs returns
  `{ ok:false, error:"busy: <op> running" }`. Device ops auto-connect to the
  remembered `hilux` device, set the bridge filter to `[[base, 0x7FF]]`, and add
  `elapsedMs` to the result.
- Large results are paged. Follow `nextOffset` until it is `null`.

## Functions

| function | does | returns (besides `ok`) |
|---|---|---|
| `describe()` | tool list, workflow, skills, notes | `name, version, summary, workflow[], functions[], skills[], notes[]` |
| `status()` | connection, WASM, busy op and progress, filter, C6 counters | `connection, filter[], stats, wasm, busy, confirmedBases[], lastError` |
| `connect()` / `disconnect()` | BLE link to the C6 (never opens the chooser from script) | `state, deviceName, deviceId, already` |
| `listen({ms, ids, max})` | bus monitor, like `dingo listen`; puts the previous filter back afterwards | `totalFrames, distinctIds, bridgeRxDropped, ids:[{id,idHex,count,hz,dlc,lastHex}]` |
| `discover({ms, bases, minRun, maxProbes})` | finds every dingoFW node (PDMs and the C6) from its status frame (base+2: 8 bytes, byte 1 = board type << 4 + state 0-3, 10 Hz, base+1 silent), then confirms each with a version request. Status-shaped frames at another rate are reported in `ignored` and get no request; explicit `bases` are probed unchecked | `nodes:[{base,baseHex,version,type,board}], pdms (same list, older name), unconfirmed[], ignored[], candidates[]` |
| `version(base)` | firmware version; also marks the base as confirmed | `major, minor, build, text` |
| `verify(base, config?)` | device CRC; with a config, compares it to the encoded CRC | `crc, crcHex, expected?, matches?, warning?` (config's baseId ≠ base) |
| `readParams(base, {offset, limit, refresh})` | full read-all, paged and cached | `count, crcHex, params:[{index,indexHex,sub,value}], nextOffset` |
| `encode(config, base?, {params, offset, limit})` | **dry run**: count + CRC, no hardware | `name, pdmType, board, baseId, count, crc, crcHex, warning?` |
| `devices(config)` | devices in a config | `devices:[{kind,name,baseId,baseHex,pdmType}]` |
| `graph(config, base?)` | the config's logic as a node graph (the Logic view); no hardware | `board, name, baseId, graph:{nodes,edges}, slots[]` |
| `graphEdit(config, edit, base?)` | one graph edit → new config text: `connect`, `disconnect`, `delete`, `move`, `add`, `remove`, `set` | `config, changed, count, crc, crcHex, graph, slots` |
| `graphNode(config, id, base?)` | one function's properties (scalar params, with type/range/enum) | `id, kind, label, name, enabled, fields[], missing?` |
| `apply(base, config, {burn, partial, allowBaseChange, allowTypeMismatch})` | like `dingo apply`: board type checked, then WriteAll, count + CRC verified | `applied, crc, crcHex, burned, partial, board, typeCheck, warning?` |
| `burn(base)` | persist the live config to flash | `burned` |
| `setParam(base, name, value, {burn, pdmType})` / `getParam(base, name, {pdmType})` | one named param, like `dingo set` / `dingo getn` (names such as `output[1].currentLimit`), resolved on board `pdmType` (default 0) | `name, value, raw, index, sub, board` |
| `paramNames({filter, pdmType, offset, limit})` | names accepted by set/getParam | `total, names[], nextOffset` |
| `sendFrame(id, hex)` | one raw frame, like `dingo tx` | `idHex, dlc, dataHex` |
| `filter(entries?)` | get or set the bridge rx filter | `filter[], device[], text` |
| `skills()` / `skill(name, {offset, maxChars})` | skills served from `web/skills/` | `skills[]` / `markdown, totalChars, nextOffset` |
| `log({last})` | app log ring buffer (500 lines) | `lines[]` |

## Workflow and safety

`status` → `skill('web-api')` + `skill('dingopdm-config')` → `discover` → build
the config → `encode` → `apply` (no burn) → `verify(base, cfg)` until
`matches: true` → `burn` **only when asked**.

These guards are enforced in code:

- **Unconfirmed base:** `apply`, `burn` and `setParam` first send a version
  request to the base. If nothing answers, they refuse.
- **Base id mismatch:** `apply` refuses a config whose `baseId` differs from
  the target base, unless `allowBaseChange` is set. The WASM, like the CLI,
  applies a single-PDM file to any base, which would rewrite the device's id.
- **Board type mismatch:** `apply` listens up to 350 ms for the node's status
  frame (base+2), whose byte 1 high nibble is the board type it was built as
  (0 dingoPDM, 1 dingoPDM-Max, 2 PT-DPDM, 12 the C6 body node), and refuses a
  config whose `pdmType` differs, unless `allowTypeMismatch` is set. A node
  that sends nothing in that window is applied unchecked (logged as a warning);
  `typeCheck` in the result says which happened.

`verify(base, cfg)` with a config whose `baseId` is not `base` still answers,
with a `warning`. The page's buttons go further: while a config is in the
editor, Encode, Verify, Apply and Burn act on the config's `baseId` and are
blocked (inline, with a "Use 0x…" button) while the Base id field names
another node. Version, Listen and Burn with an empty editor use the field.

## The Logic view

**Show logic graph** draws the config in the editor with Cory Grant's
dingoConfig flow editor (vendored unmodified in `web/vendor/dingoconfig-flow`;
`web/flow.js` is its adapter). No device is needed. Drag from an output to an
input to wire it, Delete/Backspace to remove (functions are disabled after an
inline confirm), drag nodes to lay them out, the gear opens a properties panel
(name, enabled, the function's scalar parameters; inputs are the wires; keypad
buttons/dials, wiper speed map and starter outputs are edited in the JSON).
**Add function…** enables a free slot. Every edit goes through
`api.graphEdit` and rewrites the config text in the editor; the info line
shows the new param count and CRC (what Encode will report). Node positions
are stored in the device's `flowLayout`, as dingoConfig stores them; they do
not change the CRC. The graph calls are not logged and not shown in Result
(every drag is one); errors appear under the Logic heading.

## The C6 body node (`c6body_v1`)

The hilux C6 runs the dingoFW core (hilux `wireless-can/NODE.md`) and is a node
like any PDM: a `PdmDevices` entry with `pdmType: 12`, default base 0x500,
blocks `canInputs`/`canOutputs`/`virtualInputs`/`conditions` (8 each),
`counters`/`flashers` (4 each), 385 params, a 43-entry var map of its own.
`discover()` lists it (board `c6body_v1`, type 12) next to any PDM. Examples: `web/examples/c6-empty.json` (all defaults, CRC
`0x19879C6B`, also the CRC of a never-configured node) and
`web/examples/c6-test.json` (CRC `0xC1E4D8D1`; puts 0x5F0 = `01 0x` on the bus,
byte 1 toggling at 1 Hz). dingo-cli's table for it is checked against the
firmware itself: `tools/c6oracle` (see the main README).

## Access: the CAN bridge role

The C6 serves the bridge only to a device that is paired with it **and** has
the CAN bridge role in its pairing record. Both are done on the Kindle page
(Settings → Bluetooth): **Pair new device** with *CAN bridge* chosen, then
click Connect here while the pairing window is open (macOS asks to pair once);
or, for a computer that is already paired, tap its name and turn *CAN bridge*
on. Granting it needs a second tap on the Kindle. No further prompt or
credential exists on this page.

Two errors are not fixed by retrying, and `api.*` says so in `hint`:

- **`This computer isn't allowed to use the CAN bridge — grant it the CAN
  bridge role on the Kindle`** — the C6 refused (ATT Insufficient
  Authorization). `connect` releases the link at once (the C6 has one
  connection, which the iPhone key needs) and auto-reconnect stops.
  On macOS Chrome cannot say *why* a GATT operation failed: it does not
  translate CoreBluetooth's ATT errors, so every refusal arrives as
  `NotSupportedError: GATT operation failed for unknown reason.`
  (`device/bluetooth/bluetooth_device_mac.mm` → `GATT_UNKNOWN_FAILURE` in
  blink's `bluetooth_error.cc`); where Chrome does translate it, it is
  `SecurityError: GATT operation not authorized.` `ble.js` therefore maps a
  refusal by operation: either error on the `rx` subscribe, a `filter` write or
  read, or a `stats` read. A `tx` write without response gets no reply, so a
  refused one is only visible in the C6's log.
- **old pairing** — the link drops while connecting (or `gatt.connect()` fails
  "for unknown reason"): this computer most likely still holds a pairing the C6
  has forgotten (Forget on the Kindle, or the C6 lost it). macOS encrypts with
  the old key, the C6 rejects it, and macOS disconnects and never re-pairs by
  itself. The error then ends with: forget `hilux` in macOS System Settings →
  Bluetooth, PAIR on the Kindle with the CAN bridge role, connect again. Chrome
  passes on no reason for the drop, so this too is inferred from the symptom.

## Skills

`web/sync-skills.sh` (run it in the container) does the following:

- copies `.claude/skills/*/SKILL.md` and any `assets/` into `web/skills/<name>/`;
- copies `internal/pdmcfg/testdata/example.json` to
  `skills/dingopdm-config/assets/example.json`;
- writes `web/skills/index.json`.

`web/skills/web-api/SKILL.md` (name `dingo-web-api`) is written for this page.
It covers the CLI → api mapping, the workflow and the safety rules.

## Transport details (web/ble.js)

- **Connect order:** `getDevices()` first. If Chrome says the device is "no
  longer in range", it calls `watchAdvertisements()`, waits for one
  advertisement, then connects. `requestDevice` (the chooser) runs only from a
  click: Connect opens it only when nothing is remembered, or when Chrome has
  not granted the remembered device the bridge service (`SecurityError` from
  `getPrimaryService`, error code `SERVICE_NOT_GRANTED`); "Choose device…"
  always opens it. Script calls never do.
- **Notifications before filter:** the code subscribes to `rx` before it writes
  the filter, because the C6 discards frames that match while nothing is
  subscribed.
- **Write queue:** all GATT operations go through one queue. Chrome rejects
  concurrent ones.
- **tx batching:** up to 8 frames go in one write. 8 is the CLI's burst size;
  the PDM's CAN mailbox drops longer bursts.
- **Early acknowledgement:** `send()` resolves as soon as the frame is queued,
  as long as the backlog fits in one write. This lets frames batch even though
  the WASM awaits each send. A write that fails later makes the next `send()`
  reject.
- **Small MTU:** if a multi-frame write fails, the frames are retried in
  smaller writes. The C6 rejects a write as a whole, so nothing is sent twice.
- **Reconnect:** after an unexpected disconnect it retries 3 times with backoff
  and writes the filter again. The state then becomes `connected` or `failed`.

## Tests

```
podman exec dingo-web bash -lc 'cd /workspace && node web/test/api.test.mjs'
```

- **Page logic:** `test/ui.test.mjs` tests `ui.js` (Base id parsing, the
  config/Base id guard, node labels, examples, listen/discover HTML) without a DOM.
- **Fakes:** `test/fake-bluetooth.mjs` fakes Web Bluetooth, the C6 bridge
  (including a refused role, in both of Chrome's forms, and a stale pairing), a
  dingoPDM and the CAN bus. `test/fake-dingo.mjs` is a JS stand-in for the WASM
  contract.
- **Real WASM:** the last two tests load the real `web/dingo.wasm` and run
  `encode` → `apply` → `verify` → `readParams` → `burn` → `setParam`/`getParam`
  against the fake PDM, and the C6 example through the same path (type check
  included) against a fake node broadcasting type 12.

---
name: dingo-web-api
description: >-
  How to do with window.api in the dingo-web page (Chrome, Web Bluetooth to the
  hilux C6 CAN bridge) everything the other skills do with the `dingo` CLI:
  discover PDMs, dry-run encode a dingoConfig, apply, verify, burn, read and
  set parameters, listen to the bus. Includes the CLI → api mapping, the
  connect/encode/apply/verify/burn workflow, and the safety rules. Read this
  first, then dingopdm-config before building a config.
---

# dingo-web-api — driving dingoPDMs from `window.api`

This page (http://localhost:5173) programs dingoPDM modules **without the USB
cable**: Chrome → Web Bluetooth → the `hilux` ESP32-C6 → CAN bus → PDM(s). The
`dingopdm-config` and `dingopdm-hardware` skills are written for the `dingo` CLI;
everything they say about the **config JSON, var-map, enums and wiring applies
unchanged**. Only the way you *run* a command differs: instead of a shell
command you call an async function on `window.api` from page JavaScript.

## Calling convention

- Every function is `async` and **never throws**: `const r = await api.fn(...)`.
  It resolves to plain JSON: `{ ok: true, ... }` or
  `{ ok: false, error: "...", hint?: "what to do next" }`. Always check `r.ok`.
- `await api.describe()` is the tool list (every function, its args, return shape,
  an example). Call it first; it is generated from the code, so it is current.
- Positional args first, then one options object for the `opts.*` args:
  `api.apply(222, cfg, { burn: false })`. One object with the positional names also
  works: `api.version({ base: 222 })`.
- Base ids / CAN ids accept numbers (`222`, `0x642`) or strings (`"0x0DE"`).
  Results give both forms (`base` + `baseHex`, `crc` + `crcHex`).
- A `config` is the dingoConfig **object** or its JSON text. You never need a file.
- Big results are paged — follow `nextOffset` until it is `null`
  (`readParams`, `encode` with `params:true`, `skill`, `paramNames`).
- One device operation at a time. A second call while one runs returns
  `{ ok:false, error:"busy: apply running" }` — wait, then retry.
  `api.status().busy` shows what is running and its progress.

## CLI → api mapping

| `dingo` CLI (in the skills) | `window.api` | notes |
|---|---|---|
| `dingo apply -base B file.json` | `api.apply(B, cfg)` | full apply: absent fields reset to firmware defaults; count + CRC verified; **live only** |
| `dingo apply -base B -burn file.json` | `api.apply(B, cfg, { burn: true })` | only when the user asked to persist (or apply, verify, then `api.burn(B)`) |
| `dingo apply -partial -base B file.json` | `api.apply(B, cfg, { partial: true })` | writes only fields present; device CRC then ≠ file CRC |
| `dingo verify -base B` | `api.verify(B)` | device live-config CRC |
| *(compare file vs device)* | `api.verify(B, cfg)` | `matches: true` ⇔ device holds exactly `cfg` |
| `dingo version -base B` | `api.version(B)` | also marks B as confirmed for writes |
| `dingo burn -base B` | `api.burn(B)` | persist live config to flash |
| `dingo set -base B [-type T] <name> <value> [-burn]` | `api.setParam(B, name, value, { burn, pdmType: T })` | echo-verified; T = the node's board type (default 0) |
| `dingo getn -base B [-type T] -name <name>` | `api.getParam(B, name, { pdmType: T })` | |
| `dingo get -index I -sub S` | `api.readParams(B)` and find `{index, sub}` | whole dump, count + CRC checked, paged |
| `dingo listen -secs N` | `api.listen({ ms: N*1000 })` | distinct ids, count, Hz, last payload |
| watch `0x642` byte 4 with `dingo listen` | `api.listen({ ms: 2000, ids: [0x642] })` | e.g. CANBoard DI bits in `lastHex` byte 4 |
| `dingo tx -id ID -data HEX` | `api.sendFrame(ID, "HEX")` | raw frame, DLC = bytes given |
| `dingo pulse ...` | loop `api.sendFrame` with waits | no single call |
| *(no CLI equivalent)* | `api.discover()` | finds every node (PDMs and the C6) from its status frame's board type and confirms each with `version` |
| *(no CLI equivalent)* | `api.encode(cfg, B)` | **dry run**: param count + CRC, no hardware |
| *(no CLI equivalent)* | `api.devices(cfg)` | the devices/baseIds inside a config |
| `-port /dev/cu.usbmodem…` | — | not needed; the link is BLE. `api.connect()` / auto-connect |
| `-bitrate` | — | fixed by the C6's CAN setup (500 k) |
| `dingo bootloader`, `dingo raw` | — | not available over the bridge (needs USB) |
| `dingo -h` | `api.describe()` | |

Other: `api.status()` (connection, WASM, busy op, bridge counters, filter),
`api.log({ last: 100 })` (timestamped events — read this when something fails),
`api.filter()` / `api.filter([[id, mask]])` (bridge receive filter, low level),
`api.paramNames({ filter: 'output[0]' })` (names for set/getParam, if the WASM
build exports them), `api.skills()` / `api.skill(name, { offset })`.

## Workflow (do these in order)

1. **`await api.status()`.** `connection.state` should become `connected` (device
   ops auto-connect). If any call says *no remembered 'hilux' device*, a person
   must click the page's **Connect** button once (Chrome only opens the Bluetooth
   chooser for a real click) — ask them; you cannot do it from script.
   If it says *this computer isn't allowed to use the CAN bridge*, the C6 has
   not given this computer the CAN bridge role: a person must grant it on the
   Kindle (Settings → Bluetooth). If it mentions an *old pairing*, they must
   forget `hilux` in macOS Bluetooth settings and PAIR again on the Kindle.
   Do not retry either; stop and ask.
   If `wasm.loaded` is false and `wasm.error` is set, the encoder is missing —
   report it; nothing else can work.
2. **Read the skills**: this one, then `api.skill('dingopdm-config')` in chunks
   (and `dingopdm-hardware` for DT pins / CANBoard wiring).
3. **Find the device**: `await api.discover()` →
   `nodes: [{ base, baseHex, version, type, board }]` (`pdms` is the same list
   under its older name). Use only a base listed there (or one `api.version(B)`
   answered). If several nodes are on the bus (e.g. a dingoPDM at 0x700 and the
   C6 at 0x500), confirm with the user which one to change. discover sends a
   version request only to bases whose status frame runs at 10 Hz; others of
   that shape (e.g. the C6's 1 Hz presence heartbeat 0x401) are listed in
   `ignored`. `api.discover({ bases: [B] })` probes B unchecked: use it only
   for a base you know is a dingo node, since a probe on a live bus is a frame
   to B+1.
4. **Build the config** as a JS object per `dingopdm-config`. The complete
   example file that skill refers to (`internal/pdmcfg/testdata/example.json`)
   is served here:
   `const ex = await (await fetch('./skills/dingopdm-config/assets/example.json')).json()`
   — copy it and edit, as that skill recommends. Its
   `PdmDevices[i].baseId` must be the target base. Check with
   `api.devices(cfg)`.
5. **Dry run**: `await api.encode(cfg, B)` → `{ count, crcHex }`. Any error here
   is a config problem — fix it before touching hardware.
6. **Apply live**: `await api.apply(B, cfg)` (no burn). Success means the device
   staged and committed exactly `count` params with the expected CRC.
7. **Verify**: `await api.verify(B, cfg)` → `matches: true`, `crcHex` equal to the
   encode `crcHex`. Let the user test the behaviour now (the config is live but
   reverts on power-cycle).
8. **Burn only when asked**: `await api.burn(B)` (or `apply(..., { burn: true })`
   when the user explicitly asked for apply + burn in one go).

```js
const cfg = { PdmDevices: [{ baseId: 222, /* ... per dingopdm-config ... */ }],
              CanboardDevices: [], DbcDevices: [], BlinkMarineKeypads: [], GrayhillKeypads: [] };
const found = await api.discover();             // { nodes: [{ base: 222, baseHex: '0x0DE', version: '0.4.12', type: 0, board: 'dingoPDM' }] }
const dry   = await api.encode(cfg, 222);         // { count: 1234, crcHex: '0x1A2B3C4D' }
const done  = await api.apply(222, cfg);          // { applied: 1234, crcHex: '0x1A2B3C4D', burned: false }
const chk   = await api.verify(222, cfg);         // { matches: true }
// only if the user asked:  await api.burn(222)
```

## The C6 body node (board `c6body_v1`)

The hilux XIAO ESP32-C6 runs the dingoFW core itself and is configured,
verified and burned **exactly like a PDM**, with these differences:

- Its config is a `PdmDevices` entry with **`pdmType: 12`** (required: an
  entry with no `pdmType` and no outputs is taken as a dingoPDM). Default base
  **0x500 (1280)**; it answers on 0x500, takes commands on 0x501, and sends
  status on 0x502 (always) and 0x503/0x504 (when inputs/counters are enabled).
- Blocks: `canInputs` (8), `canOutputs` (8), `virtualInputs` (8),
  `conditions` (8), `counters` (4), `flashers` (4), same field names as on a
  PDM. No `outputs`, `inputs`, `wipers`, `starterDisable` or `keypads` yet;
  including one fails `encode` with *no firmware param for index …*. 385 params.
- **Its var map is not a PDM's** (43 entries): AlwaysFalse 0, AlwaysTrue 1,
  State 2, CanIn*n*Out 3+2(n−1), CanIn*n*Val 4+2(n−1), VirtIn1–8 19–26,
  Flasher1–4 27–30, Cond1–8 31–38, Counter1–4 39–42. Var fields also accept
  these names as strings (`"input": "VirtIn1"`). For `setParam`/`getParam`
  pass `{ pdmType: 12 }`, or a var name resolves to the PDM's index.
  `api.paramNames({ pdmType: 12 })` lists its parameter names.
- `discover()` lists it as board `c6body_v1` (type 12); `api.version(0x500)`
  confirms it too.
- Examples served by this page: `./examples/c6-empty.json` (every default:
  CRC `0x19879C6B`, which is also what a never-configured node verifies as)
  and `./examples/c6-test.json` (VirtIn1 = always on → 0x5F0 byte 0 = 01;
  Flasher1 → 0x5F0 byte 1 toggling 00/01 at 1 Hz; CRC `0xC1E4D8D1`).

```js
const cfg = await (await fetch('./examples/c6-test.json')).json();
await api.version(0x500);                    // confirms the base
await api.encode(cfg, 0x500);                // { board: 'c6body_v1', count: 385, crcHex: '0xC1E4D8D1' }
await api.apply(0x500, cfg);                 // typeCheck: { deviceType: 12, matches: true }
await api.verify(0x500, cfg);                // { matches: true }
await api.listen({ ms: 2000, ids: [0x5F0] }); // lastHex 0101 or 0100
```

`apply` reads the board type every node broadcasts (high nibble of byte 1 of
its base+2 status frame: 0 dingoPDM, 1 Max, 2 PT-DPDM, 12 C6) and refuses a
config whose `pdmType` differs (`opts.allowTypeMismatch` overrides). The
result's `typeCheck` says what it saw.

## Safety rules

- **Always `encode` first**; never send a config that did not encode cleanly.
- **Use the config's `baseId` as the base** for encode/apply/verify. `verify`
  returns a `warning` when they differ (its `matches` then compares a config
  for another node); `apply` refuses.
- **`apply` without burn, then `verify`.** Burn only when the user asks. An
  un-burned config is undone by a power-cycle — that is the safety net.
- **Never touch a base id you have not confirmed** with `discover` / `version`.
  (`apply` / `burn` / `setParam` refuse an unconfirmed base anyway, after
  probing it.) Never guess a base, and never write to a CANBoard base (0x640…).
- A full `apply` resets every parameter not in the file to its firmware
  default. That is the intended behaviour for a complete config; use
  `partial: true` only for a deliberate small patch, and say so.
- Outputs drive real loads (motors, lamps, a starter). Before applying a config
  that changes which outputs turn on, tell the user what will switch.
- On `{ ok:false }`: read `error` and `hint`, then `api.status()` and
  `api.log({ last: 50 })`. Do not blindly retry writes; `busy` is the only error
  that just means "wait".
- `sendFrame` puts raw frames on a live vehicle bus — only with a clear reason
  (e.g. the CANBoard command id 0x643 test from `dingopdm-hardware`).

## How it works (for diagnosing)

- The C6 exposes a GATT "CAN bridge": frames written to `tx` go on the bus;
  bus frames matching the bridge **filter** come back as notifications. The
  filter is empty after every connect; each device op sets it to `[[base, 0x7FF]]`
  (replies arrive on `base+0`, commands go to `base+1`; the PDM's 10 Hz status
  frames on `base+2..` are not forwarded). `listen` temporarily sets `[[0,0]]`
  (everything) and restores the previous filter.
- The dingo parameter protocol and config encoding run in a Go→WASM module —
  the same code as the CLI — so `encode` CRCs equal the CLI's and the device's.
- `api.status().stats` = bridge counters since C6 boot (`tx_ok`, `tx_err`,
  `rx_forwarded`, `rx_dropped`); rising `tx_err` = frames not acknowledged on
  the bus (PDM off / bus wiring / bitrate); rising `rx_dropped` = BLE link too slow
  for the forwarded traffic (use a narrower `listen` with `ids`).

---
name: dingopdm-config
description: >-
  Generate and edit dingoConfig JSON configuration files for dingoPDM
  power-distribution modules, and apply them to a device with the dingo-cli tool.
  Use whenever the task is to configure dingoPDM outputs / inputs / CAN
  inputs+outputs / virtual-input logic / conditions / counters / flashers /
  wiper / starter / keypads, drive a CANBoard from a PDM, or write a config to
  hardware. Covers the exact JSON schema, the variable (var-map) reference
  indices, all enum values, and the behavioral semantics needed to build a
  correct config from scratch.
---

# dingoPDM configuration (dingoConfig JSON)

A **dingoPDM** is a CAN-connected automotive power-distribution module (8 solid-state
outputs with current sensing, 2 digital inputs, plus CAN-driven logic). It is
configured by a **dingoConfig `.json` file** — the canonical format authored by the
dingoConfig GUI and consumed by `dingo-cli`.

Upstream projects:
- dingoPDM firmware: https://github.com/corygrant/DingoPDM_FW
- dingoConfig GUI (file format owner): https://github.com/corygrant/dingoConfig

This skill is everything needed to **hand-write or edit** that JSON correctly. To
**apply** a file to a device, use the `dingo` CLI:
`dingo apply [-port <port>] [-base <id>] [-burn] <file.json>` — flags and the file
may be given in any order. Run `dingo -h` / `dingo <cmd> -h` for the full surface. The CLI only reads the file (never rewrites it), selects the PDM whose
`baseId` matches `-base`, and verifies the device's parameter count + CRC, so a
successful `apply` means the device holds exactly the file.

`-port` is the device's serial port (macOS: typically `/dev/cu.usbmodem*`; Linux:
`/dev/ttyACM*`). `-base` is the target device's `baseId` (default 222). `-burn`
persists to flash; without it the config is live but reverts on power-cycle.

A complete, real example file lives at `internal/pdmcfg/testdata/example.json` —
read it for the full shape; start from a copy and edit.

## Core rules (read first)

- **All enums and all variable references are plain integers** in the JSON (never
  strings). E.g. `"resetMode": 2`, `"mode": 0`, `"input": 119`.
- **CAN ids are decimal integers** — JSON has no hex, so write `0x642` as `1602`.
- **Floats** are JSON numbers (`"currentLimit": 13`, `"arg": 13.5`). Integer-valued
  floats may be written without a decimal.
- **Arrays are addressed by position, not by `number`.** `outputs[0]` is Output 1,
  `outputs[3]` is Output 4 — 0-based array index `i` = hardware unit `i+1` = the
  var-map "n" of `i+1`. Every object also carries a `"name"` (free text) and a
  1-based `"number"`; both are cosmetic (the projection ignores them), but keep
  `number` == position+1 for GUI compatibility. (Keypad `buttons`/`dials` objects
  additionally carry `keypadNumber`, the 1-based owning keypad.)
- **What you omit resets to the firmware default on `apply`.** `apply` first resets
  every parameter to its firmware default, then applies what the file contains — so
  an omitted field, or an omitted array *tail* (e.g. only `outputs[0..3]`), takes the
  firmware default (NOT JSON zero). A minimal/partial file is therefore valid to
  `apply`. (Arrays must be a dense prefix from index 0 — you can't skip the middle,
  because position is the instance index.)
- **For a file you will also open in the dingoConfig GUI, keep objects and arrays
  complete.** The GUI fills missing JSON with type-zero (e.g. `currentLimit` 0, not
  the firmware default 20), so a partial file looks wrong there. The reliable way to
  author a complete file is to **copy `internal/pdmcfg/testdata/example.json` and edit
  it** — it contains every object with firmware-default values. Per-field default
  values are not all enumerated in this skill; that example is the source for them.
- Full-PDM array counts: `inputs` 2, `outputs` 8, `canInputs` 32, `canOutputs` 32,
  `virtualInputs` 16, `flashers` 4, `counters` 4, `conditions` 32, `keypads` 2
  (each 20 buttons, 2 dials); `wipers` and `starterDisable` are single objects.
  Reduced variants (dingoPDM-Max = 4 outputs) just use shorter arrays.

## Top-level structure

```json
{
  "PdmDevices": [ { /* one PDM device, see below */ } ],
  "CanboardDevices": [],
  "DbcDevices": [],
  "BlinkMarineKeypads": [],
  "GrayhillKeypads": []
}
```

All five keys are present. **Only `PdmDevices` is meaningful to dingo-cli** (it
programs PDMs). Leave the other four as-is (`[]` or whatever the GUI wrote);
dingo-cli ignores them. A file may contain multiple PDMs — `apply` picks the one
matching `-base`.

## PdmDevice

| field | type | meaning |
|---|---|---|
| `pdmType` | int | 0 = dingoPDM. Identifier; not written to the device. |
| `name` | string | label; not written to the device. |
| `baseId` | int | device CAN base id, 0..0x7FF (default 222 / 0x0DE). Used to select the device and is itself written. |
| `sleepEnabled` | bool | enable low-power sleep (see Sleep/wake). |
| `filtersEnabled` | bool | enable the CAN acceptance filter. |
| `connectUsbToCan` | bool | bridge USB<->CAN (keep true for normal use). |
| `bitrate` | enum CanBitrate | CAN speed. All bus nodes (PDM, CANBoards, keypads) must match. |

Then these arrays/objects (full-PDM counts):

`inputs` [2], `outputs` [8], `canInputs` [32], `canOutputs` [32],
`virtualInputs` [16], `wipers` {single object}, `flashers` [4],
`starterDisable` {single object}, `counters` [4], `conditions` [32],
`keypads` [2].

## Variables (the var-map) — used by every `input`/`var` field

Any field that selects "what drives this" (`output.input`, `virtualInput.var0/1/2`,
`condition.input`, `counter.incInput`, `flasher.input`, `wiper.*Input`,
`canOutput.input`, `keypad.dimmingVar`, button `valVars`, …) is an **integer index
into this global variable list**. An output/flasher/etc. is considered ON while its
referenced variable is non-zero/true.

| index | variable | notes |
|---|---|---|
| 0 | AlwaysFalse | constant 0 |
| 1 | AlwaysTrue | constant 1 |
| 2 | State | DeviceState, **numeric**: Run=0, Sleep=1, OverTemp=2, Error=3 (isolate one state via a condition — see conditions) |
| 3 | BoardTemp | board temperature |
| 4 | BattVolt | battery voltage |
| 5 | DigIn1 | PDM digital input 1 |
| 6 | DigIn2 | PDM digital input 2 |
| 7 + 2·(n-1) | CanIn{n} **Out** | boolean result of CAN input n (n=1..32) |
| 8 + 2·(n-1) | CanIn{n} **Val** | decoded numeric value of CAN input n |
| 71 + (n-1) | VirtIn{n} | virtual input n (n=1..16) |
| 87 + 4·(n-1) | Out{n} **Active** | output n on (n=1..8) |
| 88 + 4·(n-1) | Out{n} **Current** | output n measured current |
| 89 + 4·(n-1) | Out{n} **Overcurrent** | output n overcurrent flag |
| 90 + 4·(n-1) | Out{n} **Fault** | output n fault flag |
| 119 + (n-1) | Flasher{n} | n=1..4 |
| 123 + (n-1) | Cond{n} | n=1..32 |
| 155 + (n-1) | Counter{n} | n=1..4 |
| 159..164 | Wiper Slow/Fast/Park/Inter/Wash/Swipe out | in that order |
| 165 + 26·(k-1) | Keypad{k} block (k=1,2) | within block: button{b} = base+(b-1); dial{d} = base+20+(d-1); analog{a} = base+22+(a-1) |

Total var-map size = 217 (indices 0..216). Worked examples: `DigIn1`=5,
`AlwaysTrue`=1, `Flasher1`=119, `Out1Active`=87, `Out4Active`=87+4·(4-1)=99,
`Out8Fault`=90+4·(8-1)=118, `CanIn1Out`=7, `CanIn2Out`=9, `CanIn3Out`=7+2·(3-1)=11,
`CanIn32Out`=69 (`CanIn32Val`=70), `VirtIn1`=71, `Cond1`=123, `Counter1`=155,
`Keypad1Button3`=165+(3-1)=167, `Keypad2Dial1`=191+20=211.

Notes on variables:
- **Boolean consumers** (`output.input`, `flasher.input`, `virtualInput.varN`, etc.)
  treat the variable as `!= 0`. Wiring a *numeric* var (`BattVolt`, `BoardTemp`,
  `Out{n}Current`, `CanIn{n}Val`, `Counter{n}`) straight into a boolean input means
  "on whenever non-zero" — usually not what you want. To threshold a numeric value,
  route it through a **condition** (→ `Cond{n}`) or a CAN input's `Out`, then
  reference that boolean.
- **Units** of the analog system vars: `BattVolt` = volts, `BoardTemp` = °C,
  `Out{n}Current` = amps. (A low-voltage condition's `arg` is therefore in volts.)
- A function with `enabled: false` outputs its variable as 0/false.

## Enums (integer values)

- **CanBitrate** (`bitrate`): 1000K=0, 500K=1, 250K=2, 125K=3, 100K=4
- **ByteOrder** (`byteOrder`): LittleEndian/Intel=0, BigEndian/Motorola=1
- **InputMode** (`mode` on inputs / canInputs / virtualInputs): Momentary=0, Latching=1
  - Momentary = the var tracks the live level (true while asserted).
  - Latching = the var toggles on each rising edge.
- **InputPull** (digital input `pull`): None=0, Up=1, Down=2
- **InputEdge** (counter `incEdge`/`decEdge`/`resetEdge`): Rising=0, Falling=1, Both=2
- **Operator** (canInput `operator`, condition `operator`): Equal=0, NotEqual=1,
  GreaterThan=2, LessThan=3, GreaterThanOrEqual=4, LessThanOrEqual=5, BitwiseAnd=6,
  BitwiseNand=7
- **BoolOperator** (virtualInput `cond0`/`cond1`): And=0, Or=1, Nor=2
- **ProfetResetMode** (output `resetMode`): None=0, Count=1, Endless=2
- **WiperMode** (`wipers.mode`): DigIn=0, IntIn=1, MixIn=2
- **WiperSpeed** (`wipers.speedMap[]`): Park=0, Slow=1, Fast=2, Intermittent1=3 …
  Intermittent6=8
- **KeypadModel** (`keypads.model`): Blink2Key=0, Blink4Key=1, Blink5Key=2,
  Blink6Key=3, Blink8Key=4, Blink10Key=5, Blink12Key=6, Blink15Key=7,
  Blink15Key2Dial=8, Grayhill1Key=10, Grayhill6Key=20, Grayhill8Key=21,
  Grayhill12Key=22, Grayhill15Key=23, Grayhill20Key=24

## Function field reference

### outputs[] (solid-state output, current-limited)
`enabled` bool · `currentLimit` A float 0..100 (running limit) · `inrushCurrentLimit`
A float 0..100 (allowed during inrush window) · `inrushTime` ms (inrush window after
turn-on) · `resetMode` ProfetResetMode · `resetTime` ms (retry interval) ·
`resetCountLimit` 0..20 (max retries for Count mode) · `input` var ref (output ON
while true) · `pwmEnabled` bool · `softStartEnabled` bool · `variableDutyCycle` bool ·
`dutyCycleInput` var ref · `fixedDutyCycle` 0..100 · `frequency` Hz 0..400 ·
`softStartRampTime` ms · `dutyCycleDenominator` 1..5000 · `minDutyCycle` 0..100 ·
`primaryOutput` int8 (-1 = standalone; else a 0-based output index to gang/follow).

Overcurrent behavior: while ON, current above `currentLimit` (after the inrush
window) or above `inrushCurrentLimit` (during it) trips the output OFF.
- `None`: latch off (Fault) immediately — requires power cycle to recover.
- `Count`: retry every `resetTime` ms up to `resetCountLimit` times, then latch off
  (Fault, power-cycle to clear). The retry count resets to 0 whenever the output is
  commanded off (its `input` goes false).
- `Endless`: retry every `resetTime` ms forever.
The output is never held on during/after an overcurrent — it fails safe to OFF. A
hardware fault (dead short/over-temp) latches off regardless of mode. Choosing by load:
motors/pumps → `Count` or `Endless` (self-recover from transient trips); lamps/fixed
relays → `Count`, or `None` to hard-latch on fault. If a scenario doesn't specify,
`Count` with `resetCountLimit` 3-5 is a safe default.
Inrush: for `inrushTime` ms after turn-on, the limit is `inrushCurrentLimit`; after
that, `currentLimit`. Set inrush ≥ motor/lamp surge and `inrushTime` long enough to
cover startup but short enough to still protect a stalled load.
**Match limits to the physical channel:** on a standard dingoPDM, Outputs 1–2 are
13 A pins and Outputs 3–8 are 8 A pins (see the `dingopdm-hardware` skill). Set the
**continuous `currentLimit` at or below the channel rating**. `inrushCurrentLimit`
*may* exceed the channel rating to pass a brief motor/lamp surge, as long as it is
bounded by a short `inrushTime` — e.g. the window-lift example below allows 80 A for
800 ms on a 13 A channel. Don't leave the template default (`inrushCurrentLimit` 50)
on a load that can't actually tolerate that surge.

**Gating / overriding an output:** an output has exactly one driver (`input`) and no
separate inhibit/disable field (the only built-in force-off is `starterDisable`, and
that's specific to engine cranking). To force an output off under some condition, fold
it into the driver via a virtualInput — set `output.input` to a `VirtIn{n}` computed
as `normalDriver AND NOT override` (see virtualInputs for the exact field values).

### inputs[] (digital inputs, 2)
`enabled` · `invert` bool · `mode` InputMode · `debounceTime` ms · `pull` InputPull.
Exposes `DigIn{n}` (n = array position + 1). For a maintained/level switch closed while ON:
`mode`=Momentary (the var follows the contact), and set `invert`/`pull` to match
wiring (switch-to-ground + `pull`=Up needs `invert`=true so closed→true). For a
**momentary push-button that toggles** an output on/off (each press flips it):
`mode`=Latching — `DigIn{n}` then flips on each press (starts false at boot), and you
drive the output directly from it. Latching behaves the same on `inputs`,
`canInputs`, and `virtualInputs`. Set `enabled: true` on any input you reference —
a disabled input is not scanned, so treat its `DigIn{n}` as unavailable (0).

### canInputs[] (decode a CAN signal, 32)
`enabled` · `timeoutEnabled` bool · `timeout` ms · `ide` bool (extended id) ·
`id` CAN id · `startBit` 0..63 · `bitLength` 1..32 · `byteOrder` ByteOrder ·
`signed` bool · `factor` float · `offset` float · `operator` Operator ·
`operand` float · `mode` InputMode.
- `id` is the CAN id as a **decimal integer** (0x642 → 1602). Set `ide`=false for a
  standard 11-bit id (0..0x7FF); `ide`=true for an extended 29-bit id (put the full
  29-bit value, as decimal, in `id`).
- `startBit` is the **absolute bit index in the frame**: byte B, bit b = `8*B + b`
  (LittleEndian/Intel). So byte0 bit0 = 0; byte4 bit0 = 32. BigEndian/Motorola uses a
  different bit numbering — prefer LittleEndian for single-bit flags.
- Decodes the frame field to **`CanIn{n}Val`** = raw·factor + offset.
- **`CanIn{n}Out`** = boolean result of `Val <operator> operand`, then InputMode.
  `operand` is in the **same decoded/engineering units as `Val`** (after factor+offset)
  — e.g. for RPM>500 use `operand`=500, not the raw count.
- **Threshold a CAN signal here** (in this canInput's `operator`/`operand`, then use
  `CanIn{n}Out`). Use a separate `condition` only to threshold a *non-CAN* variable
  (BattVolt, a counter, etc.) or to compare `CanIn{n}Val` against something else.
- To turn "bit B of a frame == 1" into a boolean: `startBit`=B, `bitLength`=1,
  `factor`=1, `offset`=0, `operator`=0 (Equal), `operand`=1, `mode`=0; reference
  **`CanIn{n}Out`** in logic.
- **Enable `timeoutEnabled` with a `timeout`** for anything safety-relevant: on loss
  of frames, both Val and Out force to 0 (fail-safe off).

### canOutputs[] (transmit a CAN signal, 32)
`enabled` · `input` var ref (the value to send) · `ide` · `id` · `startBit` ·
`bitLength` · `byteOrder` · `signed` · `factor` · `offset` · `interval` ms.
- Encodes `input`'s value (·factor+offset) into the frame, sent every `interval` ms.
  `bitLength` must cover the value's range (a boolean needs 1; a 0..255 counter needs 8).
- `id`/`ide`/`startBit` as for canInputs (decimal id; `ide`=true for 29-bit;
  `startBit` = `8*byte + bit`). To send a boolean state into a byte, use
  `bitLength`=1 at `startBit` = `8*byte`.
- **Multiple canOutputs with the same `id` are merged into one frame.** The frame's
  DLC is auto-sized to the highest byte any of them writes (writing any bit in byte N forces DLC = N+1; entries sharing an `id` should share one `interval`). Use a second canOutput on
  the same id at a higher `startBit` to pad the DLC if a receiver requires a minimum
  length.

### virtualInputs[] (boolean logic, 16)
`enabled` · `not0` `var0` `cond0` · `not1` `var1` `cond1` · `not2` `var2` · `mode`.
Computes `(±var0 cond0 ±var1) cond1 ±var2`, where each `varN` is a var-map index,
`notN` inverts **its own operand `varN`**, and `condN` is BoolOperator (And/Or/Nor).
Exposes `VirtIn{n}`. `mode` Momentary tracks the level.

For a **two-term** expression, set `var2`=0 (AlwaysFalse) and **`cond1`=Or** — the
trailing `... OR false` is a no-op regardless of the first operator. Do NOT use
`cond1`=And with `var2`=0 (that forces the whole result false), nor `cond1`=Nor (that
inverts it). Worked example — "DigIn2 AND NOT Cond1": `var0`=6, `not0`=false,
`cond0`=0 (And), `var1`=123 (Cond1), `not1`=true, `cond1`=1 (Or), `var2`=0,
`not2`=false, `mode`=0. This is the standard way to gate an output: point the
output's `input` at this `VirtIn{n}`.

### conditions[] (compare a value, 32)
`enabled` · `input` var ref · `operator` Operator · `arg` float (in the `input` var's
units). Exposes `Cond{n}` = `value(input) <operator> arg`. E.g. low-voltage:
input=BattVolt(4), operator=LessThan(3), arg=11.5. To act only in a specific
device state — e.g. over-temperature: input=State(2), operator=Equal(0), arg=2 →
`Cond{n}` is true only when State==OverTemp. (Wiring `State` straight into a
boolean input would be true in Sleep and Error too, since both are non-zero.)

### counters[] (4)
`enabled` · `incInput` `decInput` `resetInput` var refs · `minCount` `maxCount` 0..255 ·
`incEdge` `decEdge` `resetEdge` InputEdge · `wrapAround` bool · `holdToReset` bool ·
`resetTime` ms. Exposes `Counter{n}` = the current count (a **numeric** var — threshold
it via a condition to use as a boolean). An "edge" is a transition of the referenced
var's boolean (non-zero) state per `incEdge`/`decEdge`. **`maxCount` clamps the count**
(template default 10) — raise it (up to 255) for open-ended counting. `minCount` is the
decrement floor; with `wrapAround` the count rolls between `minCount` and `maxCount`.

### flashers[] (4)
`enabled` · `single` bool (one cycle vs continuous) · `input` var ref (runs while
true) · `onTime` `offTime` ms. Exposes `Flasher{n}`.

### wipers {} (single object)
`enabled` · `mode` WiperMode · `slowInput` `fastInput` `interInput` `onInput`
`speedInput` `parkInput` `swipeInput` `washInput` var refs · `parkStopLevel` bool ·
`washWipeCycles` 0..10 · `speedMap` [8] of WiperSpeed · `intermitTime` [6] ms.
- **`mode` chooses how speed is selected:** `DigIn` (0) uses the discrete `slowInput` /
  `fastInput` / `interInput` booleans (speedInput/speedMap ignored); `IntIn` (1) uses
  `speedInput` — a **numeric** var whose value 0..7 indexes `speedMap[value]`, each entry
  a WiperSpeed (Slow/Fast/Intermittent1..6/Park) — (discrete inputs ignored); `MixIn`
  (2) uses both. `onInput` is the master on; `washInput`/`swipeInput`/`parkInput` apply
  in all modes.
- `speedMap` [8] = the WiperSpeed for selector positions 0..7 (e.g. `[3,4,5,6,7,8,1,2]`
  = Intermittent1..6, Slow, Fast). `intermitTime[i]` = the dwell (ms) for Intermittent(i+1).
- Output vars (var-map 159..164, in order): `WiperSlowOut`, `WiperFastOut`,
  `WiperParkOut`, `WiperInterOut`, `WiperWashOut`, `WiperSwipeOut` — point the relevant
  output `input`s at these. **At Fast speed BOTH `WiperSlowOut` and `WiperFastOut` are
  asserted** (Slow asserts only SlowOut), so wire the motor's slow brush to SlowOut and
  the fast brush to FastOut.
- `parkInput` = the park-position switch var; `parkStopLevel` picks which level of it
  means "at park" (false = parked when low, true = parked when high). Leave both at
  default if there's no park switch.

### starterDisable {} (single object)
`enabled` · `input` var ref (asserted while cranking) · `outputsDisabled` [8] bool
(which outputs to force off while `input` is true).

### keypads[] (2; CAN keypads)
`enabled` · `id` node id 0..127 · `timeoutEnabled` · `timeout` ms · `model` KeypadModel ·
`backlightBrightness` 0..63 · `dimBacklightBrightness` 0..63 · `backlightButtonColor`
(BlinkMarineBacklightColor) · `dimmingVar` var ref · `buttonBrightness` 0..63 ·
`dimButtonBrightness` 0..63 · `buttons` [20] · `dials` [2].
- button (also carries `keypadNumber` = owning keypad, 1-based, and `number`):
  `enabled` · `mode` InputMode · `valColors`[4] (BlinkMarineButtonColor) · `faultColor`
  (BlinkMarineButtonColor) · `valVars`[4] var refs · `faultVar` var ref · `valBlink`[4]
  bool · `faultBlink` bool · `blinkColors`[4] (BlinkMarineButtonColor) ·
  `faultBlinkColor` (BlinkMarineButtonColor).
- dial (also carries `keypadNumber`, `number`): `enabled` · `minCount` 0..16 ·
  `maxCount` 0..16 · `ledOffset` 0..16. Its var `Keypad{k}Dial{d}` is **numeric** (the
  current count, `minCount..maxCount`) — use it for numeric consumers like wiper
  `speedInput`, sizing `maxCount` to the consumer's range (e.g. 7 for the 8 speedMap
  positions). `dimmingVar` true selects the `dim*Brightness` values instead of the full
  `*Brightness`.
- **BlinkMarineButtonColor** (button colors): Off=0, Red=1, Green=2, Orange=3, Blue=4,
  Violet=5, Cyan=6, White=7. **BlinkMarineBacklightColor** (`backlightButtonColor`):
  Off=0, Red=1, Green=2, Blue=3, Yellow=4, Cyan=5, Violet=6, White=7, Amber=8,
  YellowGreen=9. (The two palettes differ — e.g. Blue is 4 for buttons but 3 for
  backlight — don't mix them.)
- Keypad var-map sub-layout (the 26 vars/keypad in the Variables table): button1..20 =
  base+0..+19, dial1..2 = base+20..+21, analog1..4 = base+22..+25 (Keypad1 base = 165,
  Keypad2 base = 191).
- **A button's pressed state is its var** `Keypad{k}Button{b}` (the sub-layout index
  above). With button `mode`=Momentary it's true while held; `mode`=Latching it flips
  on each press (Latching applies to keypad buttons too). **To drive an output/logic
  from a button, reference that var** in the consumer's `input`/`varN`.
- `valVars`/`valColors`/`valBlink` are **LED feedback, not the button's state**: LED
  shows `valColors[i]` while `valVars[i]` is true (`valBlink[i]` blinks it between
  `valColors[i]` and `blinkColors[i]`); e.g. set `valVars[0]` to the output's
  `Out{n}Active` to light the button when the load is on. `faultVar` true **overrides**
  the value colors with `faultColor` (`faultBlink` blinks between `faultColor` and
  `faultBlinkColor`).
- **Always emit 20 button objects and 2 dial objects per keypad regardless of
  `model`**; leave unused ones `enabled:false`.
- The 4 keypad **analog** vars (`base+22..+25`) are read-only hardware inputs (rotary/
  analog); there is no analog config object — just reference the var if needed.
- `id` is the keypad's CANopen node id — match the hardware (it does not affect the
  var-map). Enable `timeoutEnabled`/`timeout` so a lost keypad fails its button vars to
  0 (like canInputs). Set unused `valVars` slots to 0 (AlwaysFalse).
- Example — button 1 toggles Output 1, LED green while the load is on:
  `keypads[0].buttons[0].mode`=1 (Latching), `outputs[0].input`=165 (Keypad1Button1),
  `keypads[0].buttons[0].valVars[0]`=87 (Out1Active), `…valColors[0]`=2 (Green).

## Templates (complete default objects)

The skill is self-contained: build a file by starting from these objects, which carry
**every field at its firmware default**. Repeat each per array slot, setting `number`
(and button/dial `keypadNumber`) to the 1-based position and `name` to anything; change
only the fields you need — the rest stay at these defaults. Omitting a field is also
legal for `apply` (it then takes the firmware default), but keep objects complete for a
file you'll open in the GUI.

**Required keys / smallest file:** for `apply`, only `PdmDevices` with a device that has
a `baseId` is strictly needed — the smallest valid file is
`{"PdmDevices":[{"baseId":222}],"CanboardDevices":[],"DbcDevices":[],"BlinkMarineKeypads":[],"GrayhillKeypads":[]}`
and every unspecified parameter resets to its firmware default. Include all five
top-level keys and complete objects when the file will also be opened in the GUI.

File skeleton (full PDM — 2 inputs, 8 outputs, 32 canInputs, 32 canOutputs, 16
virtualInputs, 4 flashers, 4 counters, 32 conditions, 2 keypads):

```json
{
  "PdmDevices": [{
    "pdmType": 0, "name": "myPdm", "baseId": 222,
    "sleepEnabled": false, "filtersEnabled": false, "connectUsbToCan": true, "bitrate": 1,
    "inputs": [ /* input × 2 */ ],
    "outputs": [ /* output × 8 */ ],
    "canInputs": [ /* canInput × 32 */ ],
    "canOutputs": [ /* canOutput × 32 */ ],
    "virtualInputs": [ /* virtualInput × 16 */ ],
    "wipers": { /* wiper */ },
    "flashers": [ /* flasher × 4 */ ],
    "starterDisable": { /* starterDisable */ },
    "counters": [ /* counter × 4 */ ],
    "conditions": [ /* condition × 32 */ ],
    "keypads": [ /* keypad × 2 */ ]
  }],
  "CanboardDevices": [], "DbcDevices": [], "BlinkMarineKeypads": [], "GrayhillKeypads": []
}
```

Default objects (copy + set `number`/`name`):

```json
output      {"enabled":false,"name":"output1","number":1,"currentLimit":20,"resetCountLimit":3,"resetMode":0,"resetTime":1000,"inrushCurrentLimit":50,"inrushTime":1000,"input":0,"pwmEnabled":false,"softStartEnabled":false,"variableDutyCycle":false,"dutyCycleInput":0,"fixedDutyCycle":100,"frequency":100,"softStartRampTime":0,"dutyCycleDenominator":100,"minDutyCycle":0,"primaryOutput":-1}

input       {"enabled":false,"name":"digitalInput1","number":1,"invert":false,"mode":0,"debounceTime":20,"pull":0}

canInput    {"name":"canInput1","number":1,"enabled":false,"timeoutEnabled":false,"timeout":1000,"ide":false,"startBit":0,"bitLength":8,"factor":1,"offset":0,"byteOrder":0,"signed":false,"operator":0,"operand":0,"mode":0,"id":0}

canOutput   {"name":"canOutput1","number":1,"enabled":false,"input":0,"ide":false,"startBit":0,"bitLength":8,"factor":1,"offset":0,"byteOrder":0,"signed":false,"interval":1000,"id":0}

virtualInput {"name":"virtualInput1","number":1,"enabled":false,"not0":false,"var0":0,"cond0":0,"not1":false,"var1":0,"cond1":0,"not2":false,"var2":0,"mode":0}

condition   {"name":"condition1","number":1,"enabled":false,"input":0,"operator":0,"arg":0}

counter     {"name":"counter1","number":1,"enabled":false,"incInput":0,"decInput":0,"resetInput":0,"minCount":0,"maxCount":10,"incEdge":0,"decEdge":0,"resetEdge":0,"wrapAround":false,"holdToReset":false,"resetTime":2000}

flasher     {"name":"flasher1","number":1,"enabled":false,"single":false,"input":0,"onTime":500,"offTime":500}

wipers      {"name":"wiper","enabled":false,"mode":0,"slowInput":0,"fastInput":0,"interInput":0,"onInput":0,"speedInput":0,"parkInput":0,"parkStopLevel":false,"swipeInput":0,"washInput":0,"washWipeCycles":3,"speedMap":[3,4,5,6,7,8,1,2],"intermitTime":[1000,2000,3000,4000,5000,6000]}

starterDisable {"name":"starterDisable","enabled":false,"input":0,"outputsDisabled":[false,false,false,false,false,false,false,false]}

keypad      {"name":"keypad1","number":1,"enabled":false,"id":0,"timeoutEnabled":false,"timeout":0,"model":6,"backlightBrightness":63,"dimBacklightBrightness":32,"backlightButtonColor":0,"dimmingVar":0,"buttonBrightness":63,"dimButtonBrightness":32,"buttons":[ /* button × 20 */ ],"dials":[ /* dial × 2 */ ]}

button      {"name":"button1","keypadNumber":1,"number":1,"enabled":false,"mode":0,"valColors":[0,0,0,0],"faultColor":0,"valVars":[0,0,0,0],"faultVar":0,"valBlink":[false,false,false,false],"faultBlink":false,"blinkColors":[0,0,0,0],"faultBlinkColor":0}

dial        {"name":"dial1","keypadNumber":1,"number":1,"enabled":false,"minCount":0,"maxCount":16,"ledOffset":0}
```

## Sleep / wake (when `sleepEnabled` is true)

The device sleeps after ~30 s of: no outputs on, no USB, and no CAN traffic. It wakes
on a transition of **digital input 1** (only DI1 wakes among the inputs), CAN bus
activity, or USB. Waking is a full reboot. Digital-input state alone does not keep it
awake — to stay awake while a master switch is on, drive an output from that switch so
"an output is on" holds the sleep timer off.

## Driving a CANBoard from a PDM

A CANBoard is a separate device on the CAN bus (default base **0x640**), typically
powered from a PDM output. It is "dumb": fixed message layout, not configured by this
file. The PDM reads its inputs and commands its outputs via CAN in/out entries:

- CANBoard **broadcasts** on `base+2` = **0x642**: byte 4 = digital inputs (bit0=DI1 …
  bit7=DI8, 1 = asserted); byte 6 = output states (bit0=DO1…bit3=DO4); byte 7 = heartbeat.
- CANBoard **receives commands** on `base+3` = **0x643**, **DLC ≥ 4 required**: byte0
  bit0 = DO1, byte1 bit0 = DO2, byte2 bit0 = DO3, byte3 bit0 = DO4 (0x01 = on).

To **read CANBoard DI{n}** on the PDM — a canInput:
`{ "enabled": true, "ide": false, "id": 1602, "startBit": 32+(n-1), "bitLength": 1, "operator": 0,
"operand": 1, "byteOrder": 0, "factor": 1, "offset": 0, "timeoutEnabled": true,
"timeout": 500, "mode": 0, ... }` (0x642 = 1602; byte 4 bit0 is absolute bit 32, so
DI1→32, DI2→33). Use that slot's `CanIn{slot}Out` variable in logic.

To **command CANBoard DO{n}** from the PDM — a canOutput driving the bit, plus a pad
to satisfy DLC ≥ 4:
`{ "enabled": true, "ide": false, "input": <var>, "id": 1603, "startBit": (n-1)*8, "bitLength": 1,
"interval": 100, ... }` and a second canOutput `{ "enabled": true, "input": 0,
"id": 1603, "startBit": 24, "bitLength": 1, "interval": 100, ... }` (0x643 = 1603;
the pad at byte 3 forces DLC 4). Commanding DO4 alone (byte 3) already yields DLC 4,
so a pad is only needed when the highest output you write sits below byte 3.

The CANBoard's analog inputs (AI1–AI5) are also broadcast, but their exact byte
positions and scaling are **not documented here** — read them from the firmware DBC
(`dingoFW/dbc`) or `dingoFW` source before relying on them; don't guess.

## Glossary / behavior notes

- `State` (var 2) = DeviceState: Run=0, Sleep=1, OverTemp=2, Error=3.
- `connectUsbToCan` false = the device does NOT bridge USB traffic onto CAN (or vice
  versa); keep it true unless you deliberately want to isolate USB from the bus.
- output `primaryOutput` (int8): -1 = standalone. Set it to another output's **0-based**
  index to **gang** this output to that one (e.g. to follow Output 1, set `0`) — the
  follower mirrors the primary's on/off and its current sums into the primary; the
  follower's own `input` is ignored.
- counter `holdToReset`: when true, the counter resets only after `resetInput` is held
  for `resetTime` ms, instead of on a single reset edge.
- WiperMode: DigIn=0 (discrete speed inputs), IntIn=1 (numeric speed selector —
  `speedInput` indexes `speedMap`; handles all speeds, not just intermittent),
  MixIn=2 (both).

## Worked example — reversible window lift

Master toggle on PDM IN1 powers a CANBoard (PDM OUT4); a momentary up/down switch on
CANBoard IN1(UP)/IN2(DOWN); a relay on CANBoard OUT1 sets direction (off=UP, on=DOWN);
PDM OUT1 drives the motor. Resulting PDM config (key fields):

- `inputs[0]` (DigIn1, master): enabled, mode 0 (Momentary), pull 1 (Up), invert true.
- `outputs[3]` (OUT4, CANBoard power): enabled, input 5 (DigIn1), currentLimit 1,
  resetMode 1 (Count), resetCountLimit 5, resetTime 1000.
- `canInputs[0]` (CANBoard UP): id 1602, startBit 32, bitLength 1, operator 0, operand 1,
  timeoutEnabled true, timeout 500. → CanIn1Out = var 7.
- `canInputs[1]` (CANBoard DOWN): id 1602, startBit 33, bitLength 1, operator 0,
  operand 1, timeoutEnabled true, timeout 500. → CanIn2Out = var 9.
- `virtualInputs[0]` (UP or DOWN): enabled, var0 7, cond0 1 (Or), var1 9, cond1 1,
  var2 0, mode 0. → VirtIn1 = var 71.
- `outputs[0]` (OUT1, motor): enabled, input 71 (VirtIn1), currentLimit 13,
  inrushCurrentLimit 80, inrushTime 800, resetMode 1 (Count), resetTime 10000,
  resetCountLimit 5.
- `canOutputs[0]` (direction = DOWN): enabled, input 9 (CanIn2Out), id 1603,
  startBit 0, bitLength 1, interval 100.
- `canOutputs[1]` (DLC pad): enabled, input 0 (AlwaysFalse), id 1603, startBit 24,
  bitLength 1, interval 100.
- `device`: sleepEnabled true.

Logic: master on → OUT4 powers CANBoard (and keeps the PDM awake); UP or DOWN → OUT1
drives the motor; DOWN → relay on (direction down), else off (up); neither → no motor
power, relay idle. CAN-input timeouts make a missing CANBoard fail safe to off.

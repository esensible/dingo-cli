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
**apply** a file to a device, use the `dingo` CLI (`dingo apply <file.json> -port
<port> [-base <id>] [-burn]`); run `dingo -h` / `dingo <cmd> -h` for its full
surface. The CLI only reads the file (never rewrites it), selects the PDM whose
`baseId` matches `-base`, and verifies the device's parameter count + CRC, so a
successful `apply` means the device holds exactly the file.

A complete, real example file lives at `internal/pdmcfg/testdata/example.json` —
read it for the full shape; start from a copy and edit.

## Core rules (read first)

- **All enums and all variable references are plain integers** in the JSON (never
  strings). E.g. `"resetMode": 2`, `"mode": 0`, `"input": 119`.
- **Floats** are JSON numbers (`"currentLimit": 13`, `"arg": 13.5`). Integer-valued
  floats may be written without a decimal.
- Every function object has a `"name"` (free text) and a 1-based `"number"`. The
  **`number` must equal its position in the array** (outputs[0].number == 1). They
  are identifiers only; they map to no device parameter.
- The CLI iterates the **actual array lengths** in the file, so reduced-output
  variants (dingoPDM-Max = 4 outputs) just have shorter arrays. Default full PDM
  counts are below.
- Defaults / `false` / `0` are written explicitly (the GUI never omits fields). When
  hand-writing, include every field of any object you create, or copy a full object
  from `example.json` and change what you need.

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
| `bitrate` | enum CanBitrate | CAN speed. |

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
| 2 | State | device state |
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
| 165..216 | Keypad vars | per keypad: 20 buttons, 2 dials, 4 analog (26 each) |

Total var-map size = 217 (indices 0..216). Examples: `DigIn1`=5, `AlwaysTrue`=1,
`Flasher1`=119, `Out1Active`=87, `CanIn1Out`=7, `CanIn2Out`=9, `VirtIn1`=71.

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
hardware fault (dead short/over-temp) latches off regardless of mode.
Inrush: for `inrushTime` ms after turn-on, the limit is `inrushCurrentLimit`; after
that, `currentLimit`. Set inrush ≥ motor/lamp surge and `inrushTime` long enough to
cover startup but short enough to still protect a stalled load.

### inputs[] (digital inputs, 2)
`enabled` · `invert` bool · `mode` InputMode · `debounceTime` ms · `pull` InputPull.
Exposes `DigIn{number}`. For a level switch that is closed while ON: `mode`=Momentary,
and set `invert`/`pull` to match wiring (switch-to-ground + `pull`=Up needs
`invert`=true so closed→true).

### canInputs[] (decode a CAN signal, 32)
`enabled` · `timeoutEnabled` bool · `timeout` ms · `ide` bool (extended id) ·
`id` CAN id · `startBit` 0..63 · `bitLength` 1..32 · `byteOrder` ByteOrder ·
`signed` bool · `factor` float · `offset` float · `operator` Operator ·
`operand` float · `mode` InputMode.
- Decodes the frame field to **`CanIn{n}Val`** = raw·factor + offset.
- **`CanIn{n}Out`** = boolean result of `Val <operator> operand`, then InputMode.
- To turn "bit B of a frame == 1" into a boolean: `startBit`=B, `bitLength`=1,
  `factor`=1, `offset`=0, `operator`=0 (Equal), `operand`=1, `mode`=0; reference
  **`CanIn{n}Out`** in logic.
- **Enable `timeoutEnabled` with a `timeout`** for anything safety-relevant: on loss
  of frames, both Val and Out force to 0 (fail-safe off).

### canOutputs[] (transmit a CAN signal, 32)
`enabled` · `input` var ref (the value to send) · `ide` · `id` · `startBit` ·
`bitLength` · `byteOrder` · `signed` · `factor` · `offset` · `interval` ms.
- Encodes `input`'s value (·factor+offset) into the frame, sent every `interval` ms.
- **Multiple canOutputs with the same `id` are merged into one frame.** The frame's
  DLC is auto-sized to the highest byte any of them writes. Use a second canOutput on
  the same id at a higher `startBit` to pad the DLC if a receiver requires a minimum
  length.

### virtualInputs[] (boolean logic, 16)
`enabled` · `not0` `var0` `cond0` · `not1` `var1` `cond1` · `not2` `var2` · `mode`.
Computes `(±var0 cond0 ±var1) cond1 ±var2`, where `notN` inverts that term and
`condN` is BoolOperator (And/Or/Nor). Exposes `VirtIn{n}`. For a simple two-term OR,
set `var2`=0 (AlwaysFalse) and `cond1`=Or. `mode` Momentary tracks the level.

### conditions[] (compare a value, 32)
`enabled` · `input` var ref · `operator` Operator · `arg` float. Exposes `Cond{n}`
= `value(input) <operator> arg`. E.g. low-voltage: input=BattVolt(4), operator=LessThan(3),
arg=11.5.

### counters[] (4)
`enabled` · `incInput` `decInput` `resetInput` var refs · `minCount` `maxCount` 0..255 ·
`incEdge` `decEdge` `resetEdge` InputEdge · `wrapAround` bool · `holdToReset` bool ·
`resetTime` ms. Exposes `Counter{n}`.

### flashers[] (4)
`enabled` · `single` bool (one cycle vs continuous) · `input` var ref (runs while
true) · `onTime` `offTime` ms. Exposes `Flasher{n}`.

### wipers {} (single object)
`enabled` · `mode` WiperMode · `slowInput` `fastInput` `interInput` `onInput`
`speedInput` `parkInput` `swipeInput` `washInput` var refs · `parkStopLevel` bool ·
`washWipeCycles` int · `speedMap` [8] of WiperSpeed · `intermitTime` [6] ms.

### starterDisable {} (single object)
`enabled` · `input` var ref (asserted while cranking) · `outputsDisabled` [8] bool
(which outputs to force off while `input` is true).

### keypads[] (2; CAN keypads)
`enabled` · `id` node id 0..127 · `timeoutEnabled` · `timeout` · `model` KeypadModel ·
`backlightBrightness` 0..63 · `dimBacklightBrightness` 0..63 · `backlightButtonColor` ·
`dimmingVar` var ref · `buttonBrightness` 0..63 · `dimButtonBrightness` 0..63 ·
`buttons` [20] · `dials` [2].
- button: `enabled` · `mode` · `valColors`[4] · `faultColor` · `valVars`[4] var refs ·
  `faultVar` · `valBlink`[4] bool · `faultBlink` · `blinkColors`[4] · `faultBlinkColor`.
- dial: `enabled` · `minCount` · `maxCount` · `ledOffset`.

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
`{ "enabled": true, "id": 1602, "startBit": 32+(n-1), "bitLength": 1, "operator": 0,
"operand": 1, "byteOrder": 0, "factor": 1, "offset": 0, "timeoutEnabled": true,
"timeout": 500, "mode": 0, ... }` (0x642 = 1602; byte 4 bit0 is absolute bit 32, so
DI1→32, DI2→33). Use that slot's `CanIn{slot}Out` variable in logic.

To **command CANBoard DO{n}** from the PDM — a canOutput driving the bit, plus a pad
to satisfy DLC ≥ 4:
`{ "enabled": true, "input": <var>, "id": 1603, "startBit": (n-1)*8, "bitLength": 1,
"interval": 100, ... }` and a second canOutput `{ "enabled": true, "input": 0,
"id": 1603, "startBit": 24, "bitLength": 1, "interval": 100, ... }` (0x643 = 1603;
the pad at byte 3 forces DLC 4).

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

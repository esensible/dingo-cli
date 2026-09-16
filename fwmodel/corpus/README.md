# The corpus: what each config actually does

Every config here is described in terms of **behaviour**, not field values, so a
rewritten equivalent can be judged on what it does rather than on whether its
JSON diffs cleanly. Where a behaviour depends on a firmware quirk, the quirk is
named.

Var-map indices are quoted for `dingopdm_v7` (`VAR_MAP_SIZE = 217`):

| block | indices |
|---|---|
| AlwaysFalse / AlwaysTrue / State / BoardTemp / BattVolt | 0–4 |
| DigIn1–2 | 5–6 |
| CanIn*n* (`Out` at 7+2(n−1), `Val` at 8+2(n−1)) | 7–70 |
| VirtIn1–16 | 71–86 |
| Out*n* (`Active`,`Current`,`Overcurrent`,`Fault`) | 87–118 |
| Flasher1–4 | 119–122 |
| Cond1–32 | 123–154 |
| Counter1–4 | 155–158 |
| Wiper | 159–164 |
| Keypads | 165–216 |

---

## `engine-repin.json` — deployed, baseId 512 (0x200)

The hard case. A three-button gesture start/stop state machine built from two
counters, plus a heater toggle built from a third.

### Physical wiring

| | source | meaning |
|---|---|---|
| DigIn1 | pull-up, inverted, 20 ms debounce | `HEATER_SW` dash button |
| DigIn2 | pull-up, inverted, 20 ms debounce | `PARK_BRAKE_REQ` switch |
| CanIn1 | 0x642 bit 32 (CANBoard DI1) | washer button |
| CanIn2 | 0x642 bit 39 (CANBoard DI8) | horn button |
| CanIn3 | 0x300 bit 0 (from the lights PDM) | brake pedal |

All three CAN inputs have `timeoutEnabled` with a 500 ms timeout, so a silent
bus reads as "nothing pressed" rather than freezing the last state.

Outputs: 1 starter solenoid, 2 coil ballast (run), 3 washer pump, 4 alternator
field + ECU, 5 wiper motor feed, 6 coil direct (start bypass), 7 horn,
8 CAN-bus 12 V (hard-wired to `AlwaysTrue`, i.e. permanently on).

CAN out 0x301 bit 0 `ENGINE_RUNNING`, bit 1 `HEATER_REQ`; 0x643 bit 8 `IC_PARK`,
bit 24 a padding bit tied to `AlwaysFalse` so the frame reaches the DLC the
instrument cluster expects.

### The logic, in words

```
CHORD        = brake AND washer                        (VirtIn1)
START_REQ    = CHORD AND horn                          (VirtIn2)
CRANKED      = crank-latch >= 1                        (Cond2 over Counter2)
ARMED        = CHORD AND CRANKED                       (VirtIn3)
ENGINE_RUN   = run-latch >= 1                          (Cond1 over Counter1)
IGN          = ENGINE_RUN OR START_REQ                 (VirtIn4)

crank-latch  : set on RISING START_REQ, cleared on FALLING CHORD   (max 1)
run-latch    : set on FALLING ARMED,    cleared on RISING CHORD    (max 1)
```

Read as a state machine:

1. **Idle.** Nothing latched. The horn works (`HORN_GATE = horn AND NOT CHORD`),
   the washer pump does not (it is gated on `ENGINE_RUN`).
2. **Arm.** Driver holds brake + washer. `CHORD` rises, which *decrements*
   `run-latch` — already 0, so nothing happens; this is the same edge that later
   stops the engine.
3. **Crank.** Driver adds the horn. `START_REQ` rises: outputs 1 and 6 energise
   (starter and the ballast-bypass coil feed), and `IGN` energises outputs 2 and
   4. The rising edge also sets `crank-latch`, so `CRANKED` becomes true and,
   because the driver is still holding the chord, `ARMED` becomes true.
4. **Release the horn.** `START_REQ` falls, starter drops out. `ARMED` stays
   true because `CHORD` and `CRANKED` are both still true.
5. **Release the chord.** `CHORD` falls. Two things happen on that edge:
   `ARMED` falls, and its *falling* edge increments `run-latch` → `ENGINE_RUN`
   latches true; and `crank-latch` decrements on the falling `CHORD` → `CRANKED`
   returns false. The engine is now running on the latch alone: `IGN` holds
   outputs 2 and 4, and output 5 (wiper feed) follows `ENGINE_RUN` directly.
6. **Stop.** Press brake + washer again. `CHORD` rises, `run-latch` decrements
   to 0, `ENGINE_RUN` drops, `IGN` drops, the engine dies. `CRANKED` is false so
   `ARMED` never rises and the latch does not immediately re-set.

The design is neat: the *release* of the gesture starts the engine and the
*press* of the same gesture stops it, so a single button combination is both the
start and the kill, and the only latch state is two counters at 0 or 1.

### Secondary behaviours

* `WASHER_PUMP = washer AND NOT brake AND ENGINE_RUN` (VirtIn5) — the only
  three-term virtual input in the file, and the only user of the `var2` slot.
* `HORN_GATE = horn AND NOT CHORD` (VirtIn6) — the horn is suppressed while the
  gesture is being made, so cranking does not sound the horn.
* Heater: `HEATER_PRESS = HEATER_SW AND ENGINE_RUN` (VirtIn7) increments
  `heater-latch`, a `maxCount = 1, wrapAround = true` counter — i.e. a **toggle**,
  not a latch. `HEATER_LATCHED` (Cond3) drives
  `HEATER_REQ = HEATER_LATCHED AND ENGINE_RUN` (VirtIn8) onto 0x301 bit 1, which
  the lights PDM reads to switch its heater fan.
* `PARK_BRAKE_LAMP = PARK_BRAKE_REQ AND ENGINE_RUN` (VirtIn9) → 0x643 bit 8.

### Behaviours that come from firmware quirks

* **`heater-latch` uses `resetEdge = Falling` on `ENGINE_RUN`.** Because
  `counter.cpp`'s reset branch `return`s before the `bLastReset = *pResetInput`
  at the bottom of `Update()`, a Falling reset latches into reset at the first
  falling edge and stays there until the input goes high again. The observable
  effect is "the heater toggle is forced off and held off whenever the engine is
  not running", which is what the author wanted — but obtained by accident, and
  only for a signal that goes high again. This is a legitimate, deployed
  construct — the model implements it exactly as the firmware does, and no rule
  here forbids it. It is worth knowing about because it is *surprising*: a
  `Falling` reset does not mean "reset once, on the falling edge".
  `engine-repin-reference.json` shows the quirk-free rewrite that behaves
  identically — compute `NOT_ENGINE_RUN` in a virtual input and reset on
  `Rising` against that — and `equiv.py` proves the two are cycle-identical.
* Output 8 references `AlwaysTrue` (index 1) and CAN out 4 references
  `AlwaysFalse` (index 0). Index 0 is a legitimate *value* here; it is only a
  sentinel in `virtualInputs[].var2`.

### Known hazard, reproduced by `traces/engine-stop-hazard.json`

Using the washer while on the brake **is** the stop gesture, and nothing guards
against it. `VirtIn5` shows the author was aware of the overlap (it excludes
`brake` from the pump), but `CHORD` has no such exclusion, so the run-latch still
decrements. A rewrite that "helpfully" adds a guard has changed the program:
this trace must keep failing to be safe and keep behaving identically.

---

## `engine-wipers-off.json` — deployed variant

Byte-for-byte `engine-repin.json` except that output 5 becomes

```json
{"enabled": false, "number": 5}
```

That one line is the most informative object in the whole corpus:

* A real deployed config already uses **sparse slot objects** — every other field
  is absent. Any tool that writes these documents must still work alongside ones
  like this one.
* The author disabled the output *explicitly* rather than dropping the array
  entry, which is exactly right. It used to be load-bearing: `dingo-cli`'s
  `pdmcfg.go emitField()` skipped absent fields, so a dropped entry would have
  left the previous config on the device and the wiper feed live. `dingo apply`
  now writes every parameter the board has, defaulting anything the document
  omits, so a dropped entry would disable the output rather than leave it live —
  but being explicit is still the right habit, and `apply -partial` restores the
  old skip-absent behaviour.

Use it as the minimal-diff pair: a rewrite of the engine config with the wiper
output disabled must differ from the full version in exactly output 5, and must
be observationally identical to this file.

---

## `lights-repin.json` — deployed, baseId 222 (0xDE)

Four flashers, two counters, two conditions, eight virtual inputs. Simpler
state, richer timing.

### Physical wiring

| | source | meaning |
|---|---|---|
| DigIn1 | pull-up, inverted | `REV_REQ` reverse-gear switch |
| DigIn2 | pull-up, inverted | `BRAKE_REQ` brake-light switch |
| CanIn1–6 | 0x642 bits 33–38 (CANBoard DI2–DI7) | blink-left, blink-right, park, low, high, flick |
| CanIn7–8 | 0x301 bits 0–1 (from the engine PDM) | engine running, heater request |

Outputs: 1 brake, 2 heater fan, 3 park lamps, 4 left indicator, 5 low beam,
6 right indicator, 7 high beam, 8 reverse lamps.
CAN out 0x300 bit 0 `BRAKE_REQ` → the engine PDM's CanIn3.

### Direct pass-throughs

`brake ← DigIn2`, `park ← CanIn3`, `low-beam ← CanIn4`, `heater-fan ← CanIn8`.
`REVERSE_OUT = REV_REQ AND engine-running` (VirtIn7) → output 8, so the reverse
lamps are inhibited with the engine off.

### Indicators

`LEFT_REQ` (VirtIn3) and `RIGHT_REQ` (VirtIn4) are **pass-through virtual
inputs**: `CanIn1 OR AlwaysFalse` and `CanIn2 OR AlwaysFalse`. They exist only to
give the flasher a named input; `Flasher1` and `Flasher2` could read the CAN
inputs directly. A rewrite is free to elide them — that is precisely the kind of
difference the equivalence relation is designed to permit — but eliding them
changes which VI slots are occupied, so check with `equiv.py` rather than by eye.

`Flasher1`/`Flasher2` run 350 ms on, 350 ms off while their request is held.
Output routing goes through:

```
LEFT_OUT  = (left-flash  AND NOT HAZARD_ON) OR hazard-flash     (VirtIn5)
RIGHT_OUT = (right-flash AND NOT HAZARD_ON) OR hazard-flash     (VirtIn6)
```

Both are genuine three-term virtual inputs, and both use the `(A op B) op C`
shape with `op0 = AND`, `op1 = OR`. When hazards are on, the per-side flashers
are muted and both sides follow the single `hazard-flash` so the two lamps are in
phase.

### The hazard gesture — a hold timer, not a latch

```
HAZARD      = high-stalk AND NOT flick                 (VirtIn2)
Flasher3    = 50 ms on / 50 ms off, gated by HAZARD
Counter1    = counts RISING edges of Flasher3, max 5, reset on HAZARD
HAZARD_ON   = Counter1 >= 3                            (Cond1)
Flasher4    = 350/350, gated by HAZARD_ON
```

Holding the high-beam stalk *without* pressing flick runs a 50/50 ms tick into a
counter; three ticks (~200 ms in the model) arm `HAZARD_ON`. Release the stalk
and the counter resets, so this is a hold-to-activate, not a latch.

The reset again relies on the `counter.cpp` quirk: `resetEdge = Falling` on
`HAZARD` means the counter is held at zero for as long as `HAZARD` is low, which
is what makes "release to cancel" work. The quirk-free rewrite is a `NOT HAZARD`
virtual input with `resetEdge = Rising`, exactly as in the engine reference.

Note the gesture overloading: `flick` both cancels the hazard hold and, combined
with `low` and `high`, toggles the high beam. Holding the stalk *and* tapping
flick does not arm hazards.

### High beam — a wrapAround toggle with a forced-off condition

```
HIGH_BEAM_PRESS = high AND low AND flick               (VirtIn8)
Counter2        = increments on RISING HIGH_BEAM_PRESS,
                  maxCount 1, wrapAround TRUE          -> toggle
                  reset on FALLING CanIn4 (low beam)   -> held off while low is off
HIGH_BEAM_ON    = Counter2 >= 1                        (Cond2)
HIGH_BEAM_OUT   = HIGH_BEAM_ON AND low                 (VirtIn1) -> output 7
```

The low-beam interlock is expressed **twice**: once as the counter reset and once
as the `AND low` in VirtIn1. Only the second is quirk-free. A rewrite that drops
the redundant one is still equivalent; one that drops the *quirk-free* one and
keeps the quirk-dependent one is not.

---

## Reference and adversarial material

### `engine-repin-reference.json` (generated by `tools/mkreference.py`)

A rewrite of the engine config that must behave identically to it. Deliberately
different from the input in every way the equivalence relation says is free:

* all eight collections at full board length, every field of every slot explicit;
* every virtual-input slot renumbered (a new `VirtIn1 = NOT_ENGINE_RUN` is
  inserted at the front and everything shifts up one), so every var reference in
  the document changes;
* `heater-latch`'s reset re-expressed through the quirk-free path.

`tools/runcases.py` proves it observationally identical to `engine-repin.json`
across all three engine traces.

### `adversarial/` (generated by `tools/mkadversarial.py`)

Wrong/right pairs, generated by `tools/mkadversarial.py`. Each pair differs in
one specific way where the "wrong" half looks plausible but is not equivalent;
they exist so the suite can check that the model actually discriminates rather
than calling everything equivalent. `tools/runcases.py` runs them.

### Imported for schema reference only

* `window.json` — from `dingoConfig/configs/`, untracked. A minimal power-window
  example in the **superseded** CAN-input schema (`startingByte`/`dlc`/`onVal`
  instead of `startBit`/`bitLength`/`operand`) with short collections. Useful as
  a "what the GUI will silently accept and mis-interpret" sample; do not use it
  as a semantic target, its var indices belong to an older var map.
* `example.json` — from `dingo-cli/internal/pdmcfg/testdata/`. The CLI's own
  fixture; kept so a config change can be checked against what the CLI already
  parses.
* `dingoConfig/configs/TestBench.json` (48 KB, **not copied** — read it in
  place) is the only full-length-collection sample in existence. It is also in
  the superseded schema, carries a stale top-level `PdmMaxDevices` key, and
  writes explicit zeros for `currentLimit`/`debounceTime`/`inrushTime`. Worth one
  read to see what a full document looks like; not worth using as a target.

---

## Traces

All in `traces/`. They describe the **device boundary** — physical pin levels and
CAN frames — and never name a slot or a var index, which is what lets one trace
drive two configs that number their slots differently.

| trace | drives | exercises |
|---|---|---|
| `engine-gesture.json` | engine | full start → run → stop cycle, horn gating, washer gating, heater toggle (twice), park-brake lamp, and the "heater does nothing with the engine off" case |
| `engine-stop-hazard.json` | engine | washing the screen while braking stops the engine |
| `lights-stalk.json` | lights | brake, reverse, park, low beam, both indicators, flick-alone, high-beam toggle on and off, the hazard hold gesture, and the low-beam-off interlock |
| `can-quiet.json` | either | `canInput` timeout paths — the only trace that reaches `CheckTimeout`. A config that drops `timeoutEnabled`/`timeout` passes every other trace. |
| `abc-truthtable.json` | adversarial | all eight A/B/C combinations, single-bit walks, and — load-bearing — a section where C is **held** while A and B change, plus simultaneous multi-bit changes |

The held-operand section of `abc-truthtable.json` is not decoration. A stale read
of an intermediate term is invisible unless that term changes while the other
operand is already asserted, or the two change in the same step. The first
version of that trace walked one bit at a time between long holds and the
wrongly-ordered `a3-slotorder-wrong.json` passed it. **Any trace set used as an
equivalence oracle must include concurrent and adjacent transitions.**

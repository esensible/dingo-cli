# `fwmodel` — a behavioural model of the dingoPDM firmware

**This directory is Python. The rest of this repository is Go.** Nothing here is
built, imported or invoked by the `dingo` CLI; `go build ./...` ignores it. It
lives in this repo because this is the repository that deals in dingoConfig
documents, and the model's only subject is what one of those documents *does*.

It answers one question, without hardware:

> I changed this config. Does it still behave the same?

It is an independent reimplementation of the firmware's `CyclicUpdate()` in
Python — the fixed category evaluation order, the var maps for all four board
variants, virtual inputs, counters, conditions, flashers, digital and CAN
inputs, and CAN output frame packing. Given two configs and a stimulus trace it
reports whether they produce identical observable behaviour, cycle by cycle.

It has already earned its keep: it proved a hand-edited lights config
observationally identical to the deployed one, and it proved a rewrite of the
engine config that shares almost none of the original's integers — every virtual
input slot renumbered, every collection expanded to full length, a firmware
quirk re-expressed through a different construct — to be the same program.

## Quick start

Python 3 (tested on 3.12 and 3.14), standard library only — no dependencies.

```sh
cd model && ./selftest.py      # validate the model against the firmware source
cd tools && ./runcases.py      # the regression suite (12 cases)
```

Both should print all-ok. `selftest.py` is the one to run first and the one to
trust least silently: it is 49 assertions, each citing the `dingoFW` file it
encodes, and it is what stands between you and a confidently wrong answer.

## Using it

**Are these two configs the same program?**

```sh
cd model
./equiv.py ../corpus/engine-repin.json ../corpus/engine-repin-reference.json \
    --trace ../corpus/traces/engine-gesture.json \
            ../corpus/traces/engine-stop-hazard.json \
            ../corpus/traces/can-quiet.json
```

Exit status 0 means identical on every cycle of every trace. Non-zero prints the
first divergence: the cycle, the signal, and both values.

Equivalence is defined on what leaves the device. The observation vector is each
physical output (keyed by **pin number** — a pin is part of the contract and may
not be renumbered) and each CAN output value (keyed by **(id, startBit,
bitLength)** — its position in the frame, not its slot). Everything else is
free: slot numbers for virtual inputs, conditions, counters and flashers,
redundant pass-through virtual inputs, names, and any internal signal that never
reaches a pin or the bus. That freedom is the point — it is what lets the model
confirm that a reorganised document is unchanged in behaviour.

Default tolerance is zero cycles, deliberately. `--tolerance N` permits an
N-cycle lag, but a one-cycle difference is also the exact signature of a wrong
slot ordering, so a clean 0 is much stronger evidence than a tolerated 1.

**Does this config fully define the device?**

```sh
./equiv.py cfg.json --self-contained --trace ../corpus/traces/engine-gesture.json
```

Checks the document leaves nothing to whatever the device previously held. (The
deployed `engine-repin.json` deliberately fails this — 28 unwritten
`canOutputs` — and `runcases.py` records that as a known gap, not a regression.)

**What does this config actually do?**

```sh
./show.py ../corpus/engine-repin.json ../corpus/traces/engine-gesture.json
./show.py cfg.json trace.json --vars VirtIn1 Cond1 Counter1
```

A human-readable transition dump. `--vars` exposes named internal signals.

## Writing a trace

A trace is stimulus at the **device boundary** — pin levels and CAN frames on the
wire. It never names a slot or a var-map index, which is precisely what lets one
trace drive two configs that number their slots differently.

```json
{
  "name": "engine gesture: start then stop",
  "steps": [
    {"ms": 200, "pins": {"1": 0, "2": 0}, "bits": {"0x642:32": 0}},
    {"ms": 100, "bits": {"0x642:32": 1}}
  ]
}
```

`pins` are 1-based and *before* inversion; `bits` are `"<canid>:<startbit>"`.
Both are sticky. `bytes` sets a whole payload, `quiet` stops transmitting an id
(the only way to exercise `canInput` timeouts). Full format in
`model/trace.py`; worked examples in `corpus/traces/`.

**Trace coverage is the whole game, and it is hand-written.** There is no
coverage metric here — nothing tells you which var-map slots or state
transitions a trace set never reaches, so a difference in a path no trace
exercises passes silently. One concrete lesson is baked into the corpus:
`a3-slotorder-wrong.json` passed the first version of `abc-truthtable.json` and
was only caught once a section was added where one operand is **held** while the
others change. A stale read of an intermediate term is invisible unless that
term changes while another operand is already asserted, or two change in the
same step. **Any trace set used as an oracle must include concurrent and
adjacent transitions.**

## What this does NOT model

Read this before trusting a green run. `model/dingosim.py` carries the same list
at the top of the file, in more detail.

* **Analogue anything.** Output current is pinned at **zero**. So
  `currentLimit`, `inrushCurrentLimit`, `inrushTime`, `resetMode`, `resetTime`
  and `resetCountLimit` have **no effect on any result here** — and those are
  precisely the fields that protect real wiring. A config that defaulted every
  output to 20 A would pass this entire suite. `OutNCurrent` / `OutNOvercurrent`
  / `OutNFault` are pinned at 0 and a config whose logic reads them is refused
  rather than silently passed. **Current limits and inrush are a human review
  item; this tool cannot help with them.**
* **Device-level settings**, which never enter a cycle at all: `bitrate`,
  `baseId`, sleep, CAN filters, USB-to-CAN. Two configs differing only in
  bitrate are "equivalent" here, and that is correct for a *logic* oracle and
  wrong if you were hoping it checked the device would talk to the bus.
* **PWM, soft start, and primary/follower output pairing.**
* **Wiper, starter-disable, keypads, neopixels, DBC devices, sleep.** Configs
  using them are refused, not approximated.
* **CAN arbitration, bus load, TX mailbox depth, frame loss, RX ordering.**
  Trace frames are all delivered at the top of the cycle.
* **Real loop timing.** `chThdSleepMilliseconds(2)` plus execution time is
  modelled as exactly 2 ms per cycle. Flasher periods, debounce windows and
  `holdToReset` are only as accurate as that assumption. Comparisons *between
  two configs* are unaffected (both get the same clock); any claim about
  absolute timing against hardware is not supported.
* **f32.** Floats are Python doubles. Only matters for `Condition`
  Equal/NotEqual on scaled CAN values.
* **Applying a config.** The model starts from a config; the param protocol,
  CRC and FRAM are `dingo apply`'s business, not this tool's.

## Where this approach is unsound

The model is independent of `dingo-cli`, but it is **not** independent of one
person's reading of the firmware. A misreading of `CyclicUpdate` would make the
model wrong and `selftest.py` would still pass, because it encodes the same
reading. The mitigations are partial and worth knowing:

* every assertion in `selftest.py` cites its firmware file, so a reviewer can
  check it against the source rather than against the model;
* `a1-nand-s0-*` cross-checks two independent lowerings against each other
  rather than against a hand-written expectation.

The real fix is a second reader on `model/dingosim.py`'s `step()` against
`dingoFW`'s `core/device.cpp`. **No hardware has ever been in this loop.**

## Firmware behaviour worth knowing

Findings from building the model. These are properties of the firmware, not of
this tool.

* **The var map is not portable between board variants.** `VirtIn1` is 71 on
  `dingopdm_v7`, 79 on `pt-dpdm4_1`, 51 on `canboard_v2`. Worse, `dingopdm_v7`
  and `dingopdmmax_v1` **agree** on `VirtIn1` and diverge after it — `Cond1` is
  123 against 107, `Counter1` 155 against 139 — so a v7 config written to a Max
  points every condition and counter reference into the output block, and every
  symptom looks like a logic bug. (`internal/params` in this repo is
  board-parameterised for the same reason.)
* **`counter.cpp`'s reset branch `return`s before updating `bLastReset`.** A
  `resetEdge = Falling` counter therefore latches into reset at the first
  falling edge and is *held* there until the input goes high again — it does not
  mean "reset once, on the falling edge". Two deployed configs rely on this and
  it is genuinely useful, but it surprises people. `corpus/README.md` documents
  the quirk-free rewrite, and `equiv.py` proves it identical.
* **Virtual input `Nor` (enum 2) implements NAND, not NOR.**
* **`Condition` operator 7 (`BitwiseNand`) is always true** — broken. But
  `canInputs[].operator = 7` is a different code path and works correctly, so a
  blanket rejection of operator 7 would reject a working construct.
* **Slot order is evaluation order within a category**, and categories run in a
  fixed order. A producer in a higher slot than its consumer is read one cycle
  stale. This is the single most common way a "cosmetic" reorganisation changes
  behaviour, and it is what `a3-slotorder-*` exists to demonstrate.
* **A `wrapAround` counter with `maxCount = 1` and a virtual input in Latching
  mode are exactly equivalent**, same cycle. A toggle therefore costs no
  counter — which matters when the ceiling is four.
* **`wipers` and `starterDisable` are silently discarded by the dingoConfig GUI
  on load** (`protected set`, no `[JsonInclude]`) while still being written on
  save. Anything in those blocks vanishes the first time someone opens the file.
  A dingoConfig bug, worth fixing upstream.
* **The GUI and the firmware disagree about PT-DPDM's var map.**
  `pdm-definitions.json` says 4 digital inputs and no analogue inputs;
  `boards/pt-dpdm4_1/port.h` has 2 and 2, making `VirtIn1` 73 by one and 79 by
  the other. A PT-DPDM config cannot be both correct on the device and correctly
  displayed until that is resolved. This model follows the **firmware**.

## Layout

```
model/          the model itself
  varmap.py       board definitions and var-map layout (InitVarMap order)
  dingosim.py     the simulator; its non-modelling caveats are at the top
  trace.py        trace format and runner
  equiv.py        two-config equivalence CLI
  show.py         human-readable transition dump for one config
  selftest.py     49 assertions validating the model against firmware source
corpus/         configs and stimulus
  README.md       what each config DOES, in plain language — read this one
  *.json          deployed configs, the reference rewrite, schema samples
  traces/         stimulus at the device boundary (pin levels + CAN frames)
  adversarial/    generated wrong/right pairs
tools/
  runcases.py     the suite runner
  mkreference.py  regenerates corpus/engine-repin-reference.json
  mkadversarial.py regenerates corpus/adversarial/*.json
```

`corpus/README.md` is the most useful document here after this one: it describes
the deployed engine and lights configs as state machines in plain language,
rather than as field values, which is the only practical way to judge whether a
rewrite still does the right thing.

## Provenance

Built during an exploration of a configuration DSL for dingoPDM. The DSL was
dropped; the model outlived it because it is useful on its own — it validates
*any* config change, however the config was produced. The acceptance criteria
that encoded DSL-specific policy were left behind with it, including a
"`resetEdge` must be `Rising`" rule that was reversed: deployed configs
legitimately use `Falling`, and the model implements it as the firmware does.

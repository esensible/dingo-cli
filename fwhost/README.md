# `fwhost` — the real dingoFW logic, compiled for the host

A spike answering one question: can the firmware's own `CyclicUpdate()` be run
on a laptop, so that "does this config still behave the same?" is answered by
the firmware rather than by a reimplementation of it?

**Yes.** Every logic translation unit in `dingoFW` — including `core/device.cpp`,
which holds `CyclicUpdate()` and `InitVarMap()` — compiles **unmodified** against
a small shim. No upstream change is required.

```
$ DINGOFW=../../dingoFW ./build.sh
built build/fwhost  (board dingopdm_v7, firmware .../dingoFW)

$ ./build/fwhost ../fwmodel/corpus/engine-repin.json \
                 ../fwmodel/corpus/traces/engine-gesture.json
{"_meta":{"config":"engine-repin","baseId":512,...,"varMapSize":217}}
{"cycle":0,"ms":0,"label":"power-on idle","obs":{"out1":0,...}}
...
```

Tested with Apple clang 17 on arm64 macOS. No container, no Go, no ChibiOS, no
cross-compiler. `c++ -std=c++20` and the firmware checkout is the whole
toolchain.

## What is real and what is shimmed

Compiled from `dingoFW` **verbatim** (tag `v0.5.8`):

| | |
|---|---|
| `core/device.cpp` | `CyclicUpdate()`, `InitVarMap()`, `States()`, `InitDevice()` |
| `core/config_handler.cpp` | `ApplyAllConfig()` / `ApplyConfig()`, follower pairing |
| `core/param_registry.cpp`, `core/param_protocol.cpp` | the real parameter table, defaults, ranges and wire protocol |
| `core/status.cpp` | |
| `functions/` | virtual_input, condition, counter, flasher, digital_input, digital_output, can_input, can_outputs, input, starter, profet, pwm, wiper (all 4), keypad (all 6) |
| `utils/` | dbc, crc |
| `boards/<board>/hw_devices.cpp` | the real per-board object table |

Shimmed (`shim/`, ~330 lines of headers):

| file | lines | what it stands in for |
|---|---|---|
| `hal.h` | 190 | `msg_t`, `ioline_t`, `palRead/Write/SetLine`, the `CANRxFrame`/`CANTxFrame` structs **copied verbatim from `CANv1/hal_can_lld.h`** (the SID/EID union aliasing in `can_outputs.cpp` depends on the exact layout), `I2CConfig`, `PWMDriver`/`PWMConfig`, `chVTGetSystemTimeX`, `chThdSleep*`, `THD_WORKING_AREA` |
| `board.h` | 80 | just the `LINE_*` names, as distinct integers. The real one is 1232 lines of STM32 GPIO tables |
| `ch.hpp` | 25 | `chibios_rt::BaseStaticThread<N>` with `setName`/`start`, so the thread objects in `device.cpp` compile. They are never started |
| `ch.h`, `mcu_utils.h`, `msg.h` | 35 | trivial |

Host backend (`src/host_io.cpp`, `src/host_stubs*.cpp`, ~245 lines): a virtual
millisecond clock, a virtual GPIO array, real RX/TX mailbox queues, and no-op
stand-ins for the CAN driver, USB, FRAM, LEDs, ADC, MCP9808 and sleep. About 35
of those lines are one-line MCP9808 methods.

**Total shim: ~575 lines**, of which ~130 are mechanical `LINE_*`/`MCP9808`
tables. The original estimate of ~120 lines for the `functions/` half was
right; `core/device.cpp` roughly quadrupled it, but it never got hard — it was
one compile-error-at-a-time for an afternoon, and nothing needed a judgement
call about behaviour.

Runner and loader (`src/main.cpp`, `src/loader.cpp`, `src/json.cpp`, ~660
lines) are not shim: they are the trace format, a small JSON reader, and the
dingoConfig-field → `(index, subindex)` bridge ported from `dingo-cli`'s
`internal/pdmcfg/pdmcfg.go`. Values go into `stConfig` through the firmware's
own `WriteParam()`, so type conversion, range checks and defaults are the
firmware's, and running this exercises `pdmcfg.go`'s mapping too.

## Interface

Matches `fwmodel/model/`: same trace format (`pins`, `bits`, `bytes`, `quiet`,
`loud`, `ms`/`cycles`, `label`), same observation vector — physical outputs
keyed by output number, CAN outputs keyed by `(ide, id, startBit, bitLength)`.

One deliberate difference: `fwmodel` records the CAN output's *source variable*
at the moment `canOutputs.Update()` runs. `fwhost` records what the firmware
actually **put on the bus** — it decodes the field back out of the frame posted
to the TX mailbox. To make that observable every cycle rather than every
`interval` ms, every CAN output's interval is forced to 1 ms before
`ApplyAllConfig()`; interval affects transmit cadence only (frame grouping and
DLC come from id/ide/startBit/bitLength), so the values are untouched. The
firmware posts no frame on cycle 0, so CAN keys are absent there.

## Cross-check against the Python model

`crosscheck.py` runs both over `fwmodel/corpus/`; `fuzz.py` runs both over
randomly generated configs and traces.

```
$ FWMODEL=../fwmodel/model python3 crosscheck.py
ok   lights-repin.json x lights-stalk.json  (6690 cycles)
...
cases with differences: 7 of 18       <- all 7 are divergence #1, cycle 0 only

$ FWMODEL=../fwmodel/model python3 fuzz.py 200
cycle0   70          <- divergence #1
ok       130         <- bit-identical on every cycle of every observable
```

With the four divergences below excluded, **200 random configs × 1500–4000
cycles each are bit-identical**. `dingosim.py` is a very good reimplementation.

### Divergence 1 — the Starter gate delays every output by one cycle at power-on

`CyclicUpdate()` calls `pf[i].Update(starter.fVal[i])` at the **top** of the
cycle, and `starter.Update()` near the bottom. On cycle 0 `starter.fVal[]` is
still zero-initialised, so `bOutEnabled` is false and **every output is forced
off for the first cycle regardless of its input**. `dingosim.py`'s `_profet()`
reads the output's own input variable and has no starter gate at all.

*Whose fault:* the model's. It shows on any config with an output tied to
`AlwaysTrue` (the engine config's output 8, CAN-bus 12 V) and on 35% of fuzz
cases. Cycle 0 only, when `starterDisable` is off — but when `starterDisable`
is **on**, the disable decision lags its input by a full cycle forever, which
the model cannot express (it refuses such configs, so it is a gap rather than a
wrong answer).

Fix in `_profet`: gate on a `starter` value computed at the end of the previous
`step()`.

### Divergence 2 — `Condition` `BitwiseNand` produces a *negative* value

```cpp
// functions/condition.cpp
case Operator::BitwiseNand:
    fVal = ~((uint16_t)(*pInput) & (uint16_t)(pConfig->fArg));
```

`~` integer-promotes `uint16_t` to `int`, so the result is `-1`, `-16`, `-4` …
`dingosim.py` stores `(~x) & 0xFFFFFFFF`, i.e. `4294967295`. Both are truthy,
so the model's headline claim ("operator 7 is always true") holds — but the
**value** differs, and it is observable:

```
Condition2 = (Condition1 > 0), Condition1 = BitwiseNand:
  fwhost (firmware):  out1 = 0 forever
  dingosim:           out1 = 1 forever
```

Any config that feeds a `BitwiseNand` condition into a comparison or a CAN
output diverges. *Whose fault:* the model's.

### Divergence 3 — `Counter::Update()` re-reads its inputs through pointers

```cpp
    if (Edge::Check(pConfig->eIncEdge, bLastInc, *pIncInput)) { fVal++; ... }
    ...
    bLastInc   = *pIncInput;     // pointer deref, AFTER fVal changed
    bLastReset = *pResetInput;
```

`dingosim.py` snapshots `inc`/`dec`/`rst` into locals at the top of `_counter()`
and stores those stale snapshots at the bottom. The two agree unless one of the
counter's three inputs is **the counter's own output** — the only value that
changes between the top and the bottom of `Update()`.

Minimal repro (`tests/t5-counter-self-reset.json`): a counter with
`resetInput = its own var`, `resetEdge = Both`, incremented by a pulse.

```
firmware:  counts 1, 2, 3, 4          (bLastReset takes the post-increment value)
dingosim:  counts 1 then resets to 0 on the next cycle, every time
```

*Whose fault:* the model's. A self-referencing counter is odd but legal and
nothing rejects it.

### Divergence 4 — signed CAN input + bitwise operator on a negative value

```cpp
// functions/can_input.cpp
case Operator::BitwiseAnd:
    fOutput = input.Check(..., ((uint32_t)fVal & (uint32_t)pConfig->fOperand) > 0);
```

`(uint32_t)` of a **negative float** is undefined behaviour in C++. Clang on
arm64 emits `fcvtzu`, which saturates to 0, so the AND is 0 and the operator is
false. `dingosim.py` does Python's two's-complement `int(-6) & 2 == 2`, i.e.
true.

```
4-bit signed CAN field, operator BitwiseAnd, operand 2:
  raw 0b1010 (= -6):  fwhost out = 0   dingosim out = 1
  raw 0b0110 (= +6):  fwhost out = 1   dingosim out = 1
```

*Whose fault:* **the firmware's** — it is UB. The Cortex-M4 target uses
`VCVT.U32.F32`, which saturates the same way as the arm64 host, so `fwhost`
predicts the device correctly and `dingosim` does not. But the construct should
be fixed upstream (see below), and a host build on x86 would give a third
answer.

### Not a divergence, but worth knowing

* **`fwmodel`'s CAN observable is pre-encode.** It records the source variable,
  not the frame. A counter at 5 routed into a 1-bit CAN field reads as `5.0` in
  `dingosim` and `1` on the wire. Two configs that differ only in `factor` can
  therefore compare unequal in `dingosim` while being identical on the bus, and
  a quantisation change can compare equal while not being. `fwhost` observes the
  frame.
* **`fwmodel`'s first CAN transmit is one interval early.** `_can_outputs()`
  starts `next_tx` at 0 and transmits on cycle 0; `CanOutput::CheckTxTime()`
  starts `nLastTxTime` at 0 and first transmits at `t >= interval`. Invisible
  through `dingosim`'s observable, visible if you ever look at frames.

### What the cross-check validates in the other direction

`varmap.sh` derives each board's var-map layout from the firmware's own
`InitVarMap()` by locating known object addresses in `pVarMap[]`. All four
boards match `fwmodel/model/varmap.py` and `fwmodel/corpus/README.md` exactly:

| board | size | DigIn1 | CanIn1Out | VirtIn1 | Out1Active | Flasher1 | Cond1 | Counter1 |
|---|---|---|---|---|---|---|---|---|
| dingopdm_v7 | 217 | 5 | 7 | 71 | 87 | 119 | 123 | 155 |
| dingopdmmax_v1 | 201 | 5 | 7 | 71 | 87 | 103 | 107 | 139 |
| pt-dpdm4_1 | 209 | 5 | 15 | 79 | 95 | 111 | 115 | 147 |
| canboard_v2 | 75 | 3 | 35 | 51 | — | 59 | 63 | 71 |

That includes the two warnings in `fwmodel`'s README: v7 and Max agree on
`VirtIn1 = 71` and diverge at `Cond1` (123 vs 107); `pt-dpdm4_1`'s `VirtIn1` is
79 by the firmware where `pdm-definitions.json` says 73.

Beyond that, `crosscheck.py`'s 11 clean corpus cases and `fuzz.py`'s 130 clean
random cases independently confirm the substance of `fwmodel/model/selftest.py`'s
49 assertions — category evaluation order, slot order within a category, the
one-cycle staleness of a later-category producer, virtual-input NAND, the
counter reset latch, latching vs momentary, debounce, timeouts, flasher timing,
DBC little/big-endian and signed decode, CAN frame grouping and DLC.

## `selftest.py` — the two behaviours a reimplementation gets wrong

```
$ python3 selftest.py
ok   virtual input Nor(2) is NAND
ok   counter counts while reset input is high
ok   Falling reset fires
ok   counter HELD at 0 while reset input stays low (3 inc pulses ignored)
ok   counter counts again once reset input goes high
ok   Condition BitwiseNand(15) of 0 is -1 (not 4294967295)
ok   Condition BitwiseNand(15) of 15 is -16
ok   Condition BitwiseAnd(15) of 15 is 15
ok   every output is forced off on cycle 0 by the ungated starter value
ok   signed CAN value -6 AND 2 is FALSE on ARM (uint32 cast saturates)
ok   signed CAN value 6 AND 2 is true
```

These are assertions about **executed firmware object code**, not about anyone's
reading of it — which is the whole point of the exercise.

## Upstream: no patch required, two worth offering

`core/device.cpp` needed **no change**. The predicted hard part was not hard:
`ch.hpp`, `hal.h` and `hw_devices.h` shim cleanly, and the thread objects
compile without ever being started.

Two optional contributions, in order of value:

**1. Fix the undefined float→unsigned conversions (a real bug, worth sending).**

```diff
--- a/functions/can_input.cpp
+++ b/functions/can_input.cpp
     case Operator::BitwiseAnd:
-        fOutput = input.Check(pConfig->eMode, false, ((uint32_t)fVal & (uint32_t)pConfig->fOperand) > 0);
+        fOutput = input.Check(pConfig->eMode, false, ((uint32_t)(int32_t)fVal & (uint32_t)(int32_t)pConfig->fOperand) > 0);
         break;
     case Operator::BitwiseNand:
-        fOutput = input.Check(pConfig->eMode, false, !(((uint32_t)fVal & (uint32_t)pConfig->fOperand) > 0));
+        fOutput = input.Check(pConfig->eMode, false, !(((uint32_t)(int32_t)fVal & (uint32_t)(int32_t)pConfig->fOperand) > 0));
```

Going via `int32_t` is defined for any in-range value and gives the
two's-complement answer a user expects from a signed signal. The same applies to
`condition.cpp`'s `(uint16_t)(*pInput)`, and while there, `BitwiseNand`'s
`~(...)` result being negative is almost certainly not intended — a
`!(a & b) ? 1.0f : 0.0f` would make operator 7 usable instead of
unconditionally-true.

**2. `#ifndef HOST_BUILD` around the thread/init half of `device.cpp`.**

Guard `DeviceThread`, `SlowThread`, `InitDevice()` and `States()` — everything
from `struct DeviceThread` to the end of `States()` — leaving the globals,
`CyclicUpdate()` and `InitVarMap()` unguarded. That removes the need to shim
`ch.hpp`, `MCP9808`, `Led`, `InitAdc`/`GetBattVolt`/`GetVDDA`, `InitUsb`,
`InitCan`, `i2cStart`, `InitConfig`, `InitInfoMsgs` and the sleep pair: roughly
80 of the shim's 575 lines, and the two least pleasant files in it. Splitting
`CyclicUpdate`/`InitVarMap` into their own TU would do the same thing more
cleanly but is a bigger diff.

It is worth being clear that this is a convenience, not a blocker: the spike
works today against an unmodified `v0.5.8`.

Two smaller inconsistencies noticed in passing, neither affecting the target
build: `functions/analog_input.cpp` calls `GetAdcVolts()`, which only
`pt-dpdm4_1` and `canboard_v2` declare in their `port.h`; and `InitDevice()` has
four instances of `if (!f() == HAL_RET_SUCCESS)`, which parses as
`(f() == 0) == 0` and is accidentally correct but reads as a bug and warns under
`-Wlogical-not-parentheses`.

## Limitations

Same shape as `fwmodel`'s, with two fewer:

* **Output current is pinned at 0** (`GetAdcRaw()` returns 0), so overcurrent,
  fault, inrush, `resetMode` and `currentLimit` are unreachable. Unlike
  `fwmodel`, the real `Profet::Update()` state machine runs, so the *structure*
  is right — only the stimulus is missing. Feeding a current profile in is a
  small change to `host_stubs.cpp` and would lift this limitation entirely.
* **Wiper, starter-disable and keypads compile and run** (`fwmodel` refuses
  them), but nothing injects keypad CAN traffic, so keypad button state stays 0.
* Timing is exactly 2 ms per cycle, like `fwmodel`. `chThdSleepMilliseconds(2)`
  plus execution time is not exactly 2 ms on hardware.
* `float` is real `float` here, not a double — one fidelity gain over `fwmodel`
  for `Condition` Equal/NotEqual on scaled CAN values.
* CAN arbitration, bus load, TX mailbox depth and RX ordering are not modelled;
  trace frames are delivered at the top of the cycle.
* Flash/FRAM persistence is stubbed. The param protocol itself is real, so
  driving a config in over the wire (`WriteAll`/`WriteAllVal`/`WriteAllComplete`
  frames) instead of through the loader is possible and would test `dingo apply`
  end to end. Not done here.

## Layout

```
build.sh        BOARD=… MAIN=… OUT=… ; DINGOFW points at the firmware checkout
varmap.sh       print every board's var map, derived from InitVarMap()
selftest.py     assertions about executed firmware behaviour
crosscheck.py   fwmodel corpus, both engines, cycle by cycle
fuzz.py         randomised differential testing against fwmodel
shim/           the ChibiOS/board stand-in headers
src/            host backend, JSON reader, dingoConfig loader, trace runner
tests/          focused configs and traces for selftest.py
```

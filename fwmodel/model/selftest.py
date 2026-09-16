#!/usr/bin/env python3
"""Validate the model itself against facts read out of the firmware source.

Every assertion below cites the firmware line it encodes. If one of these fails,
the MODEL is wrong, not the config under test. Run this before trusting any
equiv.py result.
"""

from __future__ import annotations

import sys

from dingosim import (BOOL_AND, BOOL_NOR, BOOL_OR, CYCLE_MS, EDGE_FALLING,
                      EDGE_RISING, MODE_LATCHING, MODE_MOMENTARY, OP_BITNAND,
                      OP_GE, Sim, load_device)
from varmap import ANCHORS, BOARDS, SIZES

FAILURES = []


def check(name: str, got, want, cite: str) -> None:
    if got != want:
        FAILURES.append(f"{name}: got {got!r}, want {want!r}   [{cite}]")
    else:
        print(f"  ok  {name}")


def dev(**kw):
    d = {"pdmType": 0, "name": "t", "baseId": 222}
    d.update(kw)
    return {"PdmDevices": [d]}


def sim(**kw):
    return Sim(load_device(dev(**kw)))


def run(s, n, **step):
    for _ in range(n):
        s.step(**step)


# ---------------------------------------------------------------------------
print("var map layout  [dingoFW core/device.cpp InitVarMap + boards/*/port.h]")
for board, size in SIZES.items():
    check(f"{board} VAR_MAP_SIZE", BOARDS[board].size, size, "port.h")
for board, name, idx in ANCHORS:
    check(f"{board}.{name}", BOARDS[board].index(name), idx, "InitVarMap order")

# ---------------------------------------------------------------------------
print("\nvirtual input")
B = BOARDS["dingopdm_v7"]
TRUE, FALSE = B.index("AlwaysTrue"), B.index("AlwaysFalse")

# opcode 2 "Nor" implements NAND: virtual_input.cpp
#   case BoolOperator::Nor: bResultSec0 = !bResult0 || !bResult1;
s = sim(virtualInputs=[
    {"number": 1, "enabled": True, "var0": TRUE, "var1": TRUE,
     "cond0": BOOL_NOR, "var2": 0},
    {"number": 2, "enabled": True, "var0": TRUE, "var1": FALSE,
     "cond0": BOOL_NOR, "var2": 0},
])
run(s, 2)
check("Nor(T,T) == 0 (NAND, not NOR)", s.var[B.index("VirtIn1")], 0.0,
      "virtual_input.cpp BoolOperator::Nor")
check("Nor(T,F) == 1 (NAND, not NOR)", s.var[B.index("VirtIn2")], 1.0,
      "virtual_input.cpp BoolOperator::Nor")

# var2 == 0 is the two-term sentinel: cond1 and not2 are never consulted.
s = sim(virtualInputs=[
    {"number": 1, "enabled": True, "var0": TRUE, "var1": TRUE, "cond0": BOOL_AND,
     "cond1": BOOL_NOR, "not2": True, "var2": 0},
])
run(s, 2)
check("var2==0 -> two-term, cond1/not2 ignored", s.var[B.index("VirtIn1")], 1.0,
      "virtual_input.cpp `if (pConfig->nVar2 == 0)`")

# var2 == 0 as a *term* is impossible: index 0 is AlwaysFalse AND the sentinel.
# So `X op AlwaysFalse` in the third position cannot be expressed at all.

# The firmware guard `if ((pVar0 == 0) || (pVar1 == 0)) return;` compares
# POINTERS. pVarMap[0] = &ALWAYS_FALSE is non-null, so the guard never fires and
# var0 == 0 means "always false", not "disabled".
s = sim(virtualInputs=[
    {"number": 1, "enabled": True, "var0": 0, "var1": TRUE, "cond0": BOOL_OR,
     "var2": 0},
])
run(s, 2)
check("var0==0 reads AlwaysFalse (guard is dead code)",
      s.var[B.index("VirtIn1")], 1.0, "device.cpp pVarMap[0] = &ALWAYS_FALSE")

# Latching mode toggles on each rising edge of the combined result.
s = sim(inputs=[{"number": 1, "enabled": True, "debounceTime": 0}],
        virtualInputs=[{"number": 1, "enabled": True, "var0": B.index("DigIn1"),
                        "var1": TRUE, "cond0": BOOL_AND, "var2": 0,
                        "mode": MODE_LATCHING}])
run(s, 5, pins={1: 0})
run(s, 5, pins={1: 1})
first = s.var[B.index("VirtIn1")]
run(s, 5, pins={1: 0})
run(s, 5, pins={1: 1})
check("latching VI toggles on rising edge", (first, s.var[B.index("VirtIn1")]),
      (1.0, 0.0), "input.cpp Input::Check InputMode::Latching")

# ---------------------------------------------------------------------------
print("\ncondition")
# BitwiseNand: fVal = ~((uint16)a & (uint16)b). Integer-promoted ~ is never 0,
# so the condition is unconditionally true regardless of its inputs.
s = sim(conditions=[{"number": 1, "enabled": True, "input": FALSE,
                     "operator": OP_BITNAND, "arg": 0}])
run(s, 2)
check("Condition op 7 (BitwiseNand) is always true",
      bool(s.var[B.index("Cond1")]), True, "condition.cpp Operator::BitwiseNand")

# ---------------------------------------------------------------------------
print("\ncounter")
# counter.cpp resets with an early `return` that skips `bLastReset = *pResetInput`
# at the bottom of Update(), so the edge test degenerates to a level test.
#   Rising  -> held in reset while the input is HIGH
#   Falling -> latches into reset at the first falling edge and stays there
#              until the input goes HIGH again (a counter with a Falling reset
#              and a signal that has ever gone low is pinned at 0)
s = sim(inputs=[{"number": 1, "enabled": True, "debounceTime": 0},
                {"number": 2, "enabled": True, "debounceTime": 0}],
        counters=[{"number": 1, "enabled": True,
                   "incInput": B.index("DigIn1"), "incEdge": EDGE_RISING,
                   "resetInput": B.index("DigIn2"), "resetEdge": EDGE_FALLING,
                   "minCount": 0, "maxCount": 9}])
run(s, 3, pins={1: 0, 2: 1})       # reset high, never yet fallen
for _ in range(3):
    run(s, 2, pins={1: 1, 2: 1})
    run(s, 2, pins={1: 0, 2: 1})
check("counter counts while Falling-reset input is high",
      s.var[B.index("Counter1")], 3.0, "counter.cpp Edge::Check")
run(s, 2, pins={1: 0, 2: 0})       # reset falls
check("Falling reset zeroes the counter", s.var[B.index("Counter1")], 0.0,
      "counter.cpp reset branch")
for _ in range(3):                  # try to count again with reset input LOW
    run(s, 2, pins={1: 1, 2: 0})
    run(s, 2, pins={1: 0, 2: 0})
check("Falling reset stays latched while input is low (the bug)",
      s.var[B.index("Counter1")], 0.0,
      "counter.cpp `return` skips bLastReset update")

# Rising reset: level-held while HIGH, releases when LOW.
s = sim(inputs=[{"number": 1, "enabled": True, "debounceTime": 0},
                {"number": 2, "enabled": True, "debounceTime": 0}],
        counters=[{"number": 1, "enabled": True,
                   "incInput": B.index("DigIn1"), "incEdge": EDGE_RISING,
                   "resetInput": B.index("DigIn2"), "resetEdge": EDGE_RISING,
                   "minCount": 0, "maxCount": 9}])
run(s, 3, pins={1: 0, 2: 0})
for _ in range(2):
    run(s, 2, pins={1: 1, 2: 0})
    run(s, 2, pins={1: 0, 2: 0})
check("Rising-reset counter counts while reset low",
      s.var[B.index("Counter1")], 2.0, "counter.cpp")
run(s, 4, pins={1: 0, 2: 1})
check("Rising reset holds at 0 while input high", s.var[B.index("Counter1")],
      0.0, "counter.cpp")
run(s, 2, pins={1: 0, 2: 0})
for _ in range(2):
    run(s, 2, pins={1: 1, 2: 0})
    run(s, 2, pins={1: 0, 2: 0})
check("Rising reset releases when input goes low",
      s.var[B.index("Counter1")], 2.0, "counter.cpp")

# minCount is consulted ONLY when decrementing from exactly 0. Decrementing from
# any value > 0 is a plain fVal--, so the counter can sit BELOW minCount.
s = sim(inputs=[{"number": 1, "enabled": True, "debounceTime": 0},
                {"number": 2, "enabled": True, "debounceTime": 0}],
        counters=[{"number": 1, "enabled": True,
                   "incInput": B.index("DigIn1"), "incEdge": EDGE_RISING,
                   "decInput": B.index("DigIn2"), "decEdge": EDGE_RISING,
                   "minCount": 3, "maxCount": 9}])
run(s, 3, pins={1: 0, 2: 0})
for _ in range(2):                  # count to 2
    run(s, 2, pins={1: 1, 2: 0})
    run(s, 2, pins={1: 0, 2: 0})
for _ in range(2):                  # decrement twice: 2 -> 1 -> 0
    run(s, 2, pins={1: 0, 2: 1})
    run(s, 2, pins={1: 0, 2: 0})
check("decrement ignores minCount above 0", s.var[B.index("Counter1")], 0.0,
      "counter.cpp decrement branch")
run(s, 2, pins={1: 0, 2: 1})        # decrement from 0 -> minCount
check("decrement from 0 jumps to minCount", s.var[B.index("Counter1")], 3.0,
      "counter.cpp `if (fVal == 0)`")

# wrapAround + maxCount 1 is the toggle idiom (0 -> 1 -> 0 -> 1 ...)
s = sim(inputs=[{"number": 1, "enabled": True, "debounceTime": 0}],
        counters=[{"number": 1, "enabled": True,
                   "incInput": B.index("DigIn1"), "incEdge": EDGE_RISING,
                   "minCount": 0, "maxCount": 1, "wrapAround": True}])
run(s, 3, pins={1: 0})
seq = []
for _ in range(4):
    run(s, 2, pins={1: 1})
    seq.append(s.var[B.index("Counter1")])
    run(s, 2, pins={1: 0})
check("wrapAround max=1 toggles", seq, [1.0, 0.0, 1.0, 0.0],
      "counter.cpp increment branch")

# ---------------------------------------------------------------------------
print("\ncategory order and staleness  [device.cpp CyclicUpdate]")


def press(s):
    """Raise pin 1 and return on the cycle DigIn1 actually goes high.

    digital_input.cpp only re-evaluates once (SYS_TIME - nLastTrigTime) >
    nDebounceTime, and nLastTrigTime is set on the cycle the level changes. With
    debounceTime 0 that is strictly the NEXT cycle, so the pin change costs one
    cycle before it reaches the var map. Call this so the assertions below are
    about the category order, not about debounce.
    """
    s.step(pins={1: 1})                       # level change seen, var unchanged
    s.step(pins={1: 1})                       # DigIn1 -> 1 on this cycle
    assert s.var[B.index("DigIn1")] == 1.0


# CyclicUpdate runs: outputs, digIn, canOut, virtIn, flashers, counters,
# conditions. So an output reading a virtual input sees LAST cycle's value.
s = sim(inputs=[{"number": 1, "enabled": True, "debounceTime": 0}],
        virtualInputs=[{"number": 1, "enabled": True,
                        "var0": B.index("DigIn1"), "var1": TRUE,
                        "cond0": BOOL_AND, "var2": 0}],
        outputs=[{"number": 1, "enabled": True, "input": B.index("VirtIn1")}])
run(s, 5, pins={1: 0})
press(s)                # DigIn1 and VirtIn1 both go high on this cycle
check("output still low the cycle its VI rises", s.var[B.index("Out1Active")],
      0.0, "CyclicUpdate: outputs before virtIn")
s.step(pins={1: 1})
check("output follows one cycle later", s.var[B.index("Out1Active")], 1.0,
      "CyclicUpdate: outputs before virtIn")

# A virtual input reading a condition is one cycle stale (conditions run last).
s = sim(inputs=[{"number": 1, "enabled": True, "debounceTime": 0}],
        conditions=[{"number": 1, "enabled": True, "input": B.index("DigIn1"),
                     "operator": OP_GE, "arg": 1}],
        virtualInputs=[{"number": 1, "enabled": True, "var0": B.index("Cond1"),
                        "var1": TRUE, "cond0": BOOL_AND, "var2": 0}])
run(s, 5, pins={1: 0})
press(s)                # DigIn1 and Cond1 both go high on this cycle
check("VI reading a Condition lags one cycle", s.var[B.index("VirtIn1")], 0.0,
      "CyclicUpdate: virtIn before conditions")
s.step(pins={1: 1})
check("VI catches up next cycle", s.var[B.index("VirtIn1")], 1.0,
      "CyclicUpdate")

# VI -> VI within the same cycle only when the producer has the LOWER slot.
s = sim(inputs=[{"number": 1, "enabled": True, "debounceTime": 0}],
        virtualInputs=[
            {"number": 1, "enabled": True, "var0": B.index("DigIn1"),
             "var1": TRUE, "cond0": BOOL_AND, "var2": 0},
            {"number": 2, "enabled": True, "var0": B.index("VirtIn1"),
             "var1": TRUE, "cond0": BOOL_AND, "var2": 0},
        ])
run(s, 5, pins={1: 0})
press(s)
check("VI2 reading VI1 is same-cycle (producer slot is lower)",
      s.var[B.index("VirtIn2")], 1.0, "CyclicUpdate loop is in slot order")

s = sim(inputs=[{"number": 1, "enabled": True, "debounceTime": 0}],
        virtualInputs=[
            {"number": 1, "enabled": True, "var0": B.index("VirtIn2"),
             "var1": TRUE, "cond0": BOOL_AND, "var2": 0},
            {"number": 2, "enabled": True, "var0": B.index("DigIn1"),
             "var1": TRUE, "cond0": BOOL_AND, "var2": 0},
        ])
run(s, 5, pins={1: 0})
press(s)
check("VI1 reading VI2 is stale (producer slot is higher)",
      s.var[B.index("VirtIn1")], 0.0, "CyclicUpdate loop is in slot order")
s.step(pins={1: 1})
check("VI1 catches up the next cycle", s.var[B.index("VirtIn1")], 1.0,
      "CyclicUpdate loop is in slot order")

# Counter reads a VI from the same cycle (counters run after virtIn).
s = sim(inputs=[{"number": 1, "enabled": True, "debounceTime": 0}],
        virtualInputs=[{"number": 1, "enabled": True,
                        "var0": B.index("DigIn1"), "var1": TRUE,
                        "cond0": BOOL_AND, "var2": 0}],
        counters=[{"number": 1, "enabled": True, "incInput": B.index("VirtIn1"),
                   "incEdge": EDGE_RISING, "minCount": 0, "maxCount": 9}])
run(s, 5, pins={1: 0})
press(s)
check("counter sees this cycle's VI", s.var[B.index("Counter1")], 1.0,
      "CyclicUpdate: virtIn before counters")

# Condition reads a counter from the same cycle (conditions run after counters).
s = sim(inputs=[{"number": 1, "enabled": True, "debounceTime": 0}],
        counters=[{"number": 1, "enabled": True, "incInput": B.index("DigIn1"),
                   "incEdge": EDGE_RISING, "minCount": 0, "maxCount": 9}],
        conditions=[{"number": 1, "enabled": True, "input": B.index("Counter1"),
                     "operator": OP_GE, "arg": 1}])
run(s, 5, pins={1: 0})
press(s)
check("condition sees this cycle's counter", s.var[B.index("Cond1")], 1.0,
      "CyclicUpdate: counters before conditions")

# ---------------------------------------------------------------------------
print("\nflasher")
# bSingleCycle is in Config_Flasher but flasher.cpp never reads it.
a = sim(virtualInputs=[], flashers=[{"number": 1, "enabled": True,
                                     "input": 1, "onTime": 10, "offTime": 10,
                                     "single": False}])
bb = sim(flashers=[{"number": 1, "enabled": True, "input": 1,
                    "onTime": 10, "offTime": 10, "single": True}])
sa, sb = [], []
for _ in range(60):
    a.step(); bb.step()
    sa.append(a.var[B.index("Flasher1")])
    sb.append(bb.var[B.index("Flasher1")])
check("`single` has no effect", sa, sb, "flasher.cpp never reads bSingleCycle")
check("flasher actually oscillates", len(set(sa)), 2, "flasher.cpp")

# ---------------------------------------------------------------------------
print()
if FAILURES:
    print(f"{len(FAILURES)} MODEL FAILURES:")
    for f in FAILURES:
        print("  " + f)
    sys.exit(1)
print("model self-test: all assertions match the firmware source")

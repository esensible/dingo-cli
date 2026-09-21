#!/usr/bin/env python3
"""Assertions about the host-compiled firmware's behaviour.

Unlike fwmodel/model/selftest.py these do not encode anyone's *reading* of the
firmware -- they run the firmware's own object code and assert what a
reimplementation is most likely to get wrong.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FWHOST = os.path.join(HERE, "build", "fwhost")
T = os.path.join(HERE, "tests")

fails = []


def run(cfg, tr, vars_=None):
    cmd = [FWHOST, os.path.join(T, cfg), os.path.join(T, tr)]
    if vars_:
        cmd += ["--vars", ",".join(str(v) for v in vars_)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    return [json.loads(l) for l in p.stdout.splitlines() if "_meta" not in l]


def check(name, got, want):
    if got == want:
        print(f"ok   {name}")
    else:
        print(f"FAIL {name}\n       got  {got}\n       want {want}")
        fails.append(name)


# --- 1. BoolOperator::Nor (enum 2) implements NAND, not NOR -----------------
# functions/virtual_input.cpp:  case BoolOperator::Nor: !bResult0 || !bResult1
rows = run("t1-nand.json", "t1-trace.json")
# sample the last cycle of each 40 ms (20-cycle) section, after the one-cycle
# output lag has settled
tbl = {rows[i]["label"]: rows[i]["obs"]["out1"] for i in (19, 39, 59, 79)}
check("virtual input Nor(2) is NAND",
      [tbl["A=0 B=0"], tbl["A=1 B=0"], tbl["A=0 B=1"], tbl["A=1 B=1"]],
      [1, 1, 1, 0])          # a true NOR would be [1, 0, 0, 0]

# --- 2. counter.cpp reset branch returns before bLastReset is updated -------
# So a Falling reset LATCHES: the counter is held at 0 for as long as the
# reset input stays low, not just for the one cycle of the falling edge.
rows = run("t2-counter-reset.json", "t2-trace.json", [155])
counter = [r["obs"]["var155"] for r in rows]
labels = [r["label"] for r in rows]


def last_of(label):
    idx = max(i for i, l in enumerate(labels) if l == label)
    return counter[idx]


check("counter counts while reset input is high", last_of("counter>=1 -> out1 on"), 2)
check("Falling reset fires", last_of("B falling -> reset fires"), 0)
check("counter HELD at 0 while reset input stays low (3 inc pulses ignored)",
      last_of("held in reset?"), 0)
check("counter counts again once reset input goes high",
      last_of("counter should be 1 again"), 1)

# --- 3. condition.cpp BitwiseNand yields a NEGATIVE value -------------------
# fVal = ~((uint16_t)a & (uint16_t)b);  the ~ integer-promotes to int.
rows = run("t3-cond-bitnand.json", "t3-trace.json", [8, 123, 124])
vals = {}
for r in rows:
    vals[r["label"]] = (r["obs"]["var123"], r["obs"]["var124"])
check("Condition BitwiseNand(15) of 0 is -1 (not 4294967295)",
      vals["val=0"][0], -1)
check("Condition BitwiseNand(15) of 15 is -16", vals["val=15"][0], -16)
check("Condition BitwiseAnd(15) of 15 is 15", vals["val=15"][1], 15)

# --- 4. the Starter gate delays every output by one cycle at power-on -------
# core/device.cpp: pf[i].Update(starter.fVal[i]) runs BEFORE starter.Update(),
# so on cycle 0 starter.fVal[] is still zero and every output is forced off.
rows = run("t1-nand.json", "t1-trace.json")
# out1 follows VirtIn1 (NAND of two zeroes = true) but cannot be on at cycle 0
check("every output is forced off on cycle 0 by the ungated starter value",
      (rows[0]["obs"]["out1"], rows[2]["obs"]["out1"]), (0, 1))

# --- 5. signed CAN input + BitwiseAnd on a negative value ------------------
# can_input.cpp casts a negative float to uint32_t -- undefined behaviour;
# ARM saturates to 0 so the operator is false, where a two's-complement
# reimplementation makes it true.
rows = run("t6-signed-bitand.json", "t6-trace.json", [7, 8])
by = {}
for r in rows:
    by[r["label"]] = (r["obs"]["var8"], r["obs"]["var7"])
check("signed CAN value -6 AND 2 is FALSE on ARM (uint32 cast saturates)",
      by["raw=10 signed=-6"], (-6, 0))
check("signed CAN value 6 AND 2 is true", by["raw=6 signed=6"], (6, 1))

print()
print(f"{len(fails)} failure(s)")
sys.exit(1 if fails else 0)

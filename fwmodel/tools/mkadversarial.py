#!/usr/bin/env python3
"""Generate corpus/adversarial/*.json -- wrong/right config pairs.

Each case is a PAIR of documents that differ in one specific way, where the
"wrong" half looks plausible but is not equivalent to the "right" half. They
exist to check that the model actually discriminates: an oracle that called
these pairs equivalent would be missing the firmware behaviour they turn on
(slot evaluation order, De Morgan lowering, latch-vs-toggle, counter bounds).

Run ../tools/runcases.py to execute them all.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "model")))
OUTDIR = os.path.normpath(os.path.join(HERE, "..", "corpus", "adversarial"))
os.makedirs(OUTDIR, exist_ok=True)

from mkreference import (AND, FALLING, LATCHING, MOMENTARY, NAND, OR,  # noqa
                         RISING, can_in, can_out, cond, counter, dig_in,
                         flasher, output, virt)

F, T = 0, 1
DIGIN, VI, COND, CTR = 5, 71, 123, 155
GE = 4
NUM = {"inputs": 2, "outputs": 8, "canInputs": 32, "canOutputs": 32,
       "virtualInputs": 16, "conditions": 32, "counters": 4, "flashers": 4}
MK = {"inputs": dig_in, "outputs": output, "canInputs": can_in,
      "canOutputs": can_out, "virtualInputs": virt, "conditions": cond,
      "counters": counter, "flashers": flasher}


def device(name, **groups):
    dev = {"pdmType": 0, "name": name, "baseId": 512, "sleepEnabled": False,
           "filtersEnabled": False, "connectUsbToCan": True, "bitrate": 1}
    for key, count in NUM.items():
        given = groups.get(key, [])
        dev[key] = list(given) + [MK[key](n)
                                  for n in range(len(given) + 1, count + 1)]
    return {"PdmDevices": [dev], "CanboardDevices": [], "DbcDevices": [],
            "BlinkMarineKeypads": [], "GrayhillKeypads": []}


def write(fname, doc):
    p = os.path.join(OUTDIR, fname)
    with open(p, "w") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")
    print("wrote", os.path.basename(p))


# Three switches on the CANBoard's 0x642 byte 4 give A, B, C for the logic cases.
A = 7          # CanIn1Out  (0x642 bit 32)
Bv = 9         # CanIn2Out  (0x642 bit 33)
Cv = 11        # CanIn3Out  (0x642 bit 34)
SWITCHES = [can_in(1, "A", True, 1602, 32, 1, 0, 1, True, 500),
            can_in(2, "B", True, 1602, 33, 1, 0, 1, True, 500),
            can_in(3, "C", True, 1602, 34, 1, 0, 1, True, 500)]


# ---------------------------------------------------------------------------
# A1  NOT(A AND B) AND C -- the form the primitive cannot express in one slot.
#
# (X op Y) op Z has no NOT on the intermediate result. Level-2 can produce
# S0 AND C, S0 OR C, and NAND(S0, C) = !S0 OR !C -- but NOT !S0 AND C. The only
# correct lowering allocates a second virtual input.
# ---------------------------------------------------------------------------
write("a1-nand-s0-wrong.json", device(
    "a1-wrong",
    canInputs=SWITCHES,
    virtualInputs=[
        # The tempting single-slot encoding: NAND at level 2.
        # Computes !(A AND B) OR !C, not !(A AND B) AND C.
        virt(1, "OUT", True, var0=A, cond0=AND, var1=Bv, cond1=NAND, var2=Cv),
    ],
    outputs=[output(1, "lamp", True, VI + 0)]))

write("a1-nand-s0-right.json", device(
    "a1-right",
    canInputs=SWITCHES,
    virtualInputs=[
        virt(1, "NOT_AB", True, var0=A, cond0=NAND, var1=Bv),   # !(A AND B)
        virt(2, "OUT", True, var0=VI + 0, cond0=AND, var1=Cv),
    ],
    outputs=[output(1, "lamp", True, VI + 1)]))

write("a1-nand-s0-reference.json", device(
    "a1-reference",
    canInputs=SWITCHES,
    virtualInputs=[
        # Independent third encoding of the same function, for cross-checking:
        # De Morgan -- (!A OR !B) AND C.
        virt(1, "NOT_A_OR_NOT_B", True, not0=True, var0=A, cond0=OR,
             not1=True, var1=Bv),
        virt(2, "OUT", True, var0=VI + 0, cond0=AND, var1=Cv),
    ],
    outputs=[output(1, "lamp", True, VI + 1)]))


# ---------------------------------------------------------------------------
# A3  Slot ordering within a category.
#
# Same logic, producer placed after the consumer. Legal, loads fine, and wrong
# by exactly one 2 ms cycle on every transition.
# ---------------------------------------------------------------------------
write("a3-slotorder-right.json", device(
    "a3-right",
    canInputs=SWITCHES,
    virtualInputs=[
        virt(1, "AB", True, var0=A, cond0=AND, var1=Bv),
        virt(2, "ABC", True, var0=VI + 0, cond0=AND, var1=Cv),
    ],
    outputs=[output(1, "lamp", True, VI + 1)]))

write("a3-slotorder-wrong.json", device(
    "a3-wrong",
    canInputs=SWITCHES,
    virtualInputs=[
        virt(1, "ABC", True, var0=VI + 1, cond0=AND, var1=Cv),
        virt(2, "AB", True, var0=A, cond0=AND, var1=Bv),
    ],
    outputs=[output(1, "lamp", True, VI + 0)]))


# ---------------------------------------------------------------------------
# A4  Latch encodings. Three ways to build "A sets it, B clears it".
#
#   counter : maxCount 1, inc on A rising, dec on B rising, wrapAround FALSE
#             -> a true set/reset latch. Costs a counter AND a condition.
#   wrap    : maxCount 1, wrapAround TRUE, inc on A rising, no dec
#             -> a TOGGLE, not a latch. Same shape, completely different
#                behaviour. This is the easiest latch bug to ship.
#   vi mode : virtual input with mode = Latching
#             -> also a toggle (Input::Check flips bOut on each rising edge),
#                and it costs no counter. Equivalent to `wrap`, not to `counter`.
# ---------------------------------------------------------------------------
write("a4-latch-counter.json", device(
    "a4-counter",
    canInputs=SWITCHES,
    counters=[counter(1, "latch", True, inc=A, inc_edge=RISING, dec=Bv,
                      dec_edge=RISING, lo=0, hi=1, wrap=False)],
    conditions=[cond(1, "LATCHED", True, CTR + 0, GE, 1)],
    outputs=[output(1, "lamp", True, COND + 0)]))

write("a4-latch-wrap-toggle.json", device(
    "a4-wrap",
    canInputs=SWITCHES,
    counters=[counter(1, "toggle", True, inc=A, inc_edge=RISING, lo=0, hi=1,
                      wrap=True)],
    conditions=[cond(1, "LATCHED", True, CTR + 0, GE, 1)],
    outputs=[output(1, "lamp", True, COND + 0)]))

write("a4-latch-vi-mode.json", device(
    "a4-vimode",
    canInputs=SWITCHES,
    virtualInputs=[virt(1, "TOGGLE", True, var0=A, cond0=AND, var1=T,
                        mode=LATCHING)],
    outputs=[output(1, "lamp", True, VI + 0)]))


# ---------------------------------------------------------------------------
# A5  Counter boundaries. minCount is only consulted when decrementing from
# exactly 0, and wrapAround wraps the increment to 0 rather than to minCount.
# ---------------------------------------------------------------------------
write("a5-counter-bounds.json", device(
    "a5-bounds",
    canInputs=SWITCHES,
    counters=[
        counter(1, "min3max5", True, inc=A, inc_edge=RISING, dec=Bv,
                dec_edge=RISING, lo=3, hi=5, wrap=False),
        counter(2, "wrap-min3max5", True, inc=A, inc_edge=RISING, dec=Bv,
                dec_edge=RISING, lo=3, hi=5, wrap=True),
    ],
    conditions=[cond(1, "c1ge3", True, CTR + 0, GE, 3),
                cond(2, "c2ge3", True, CTR + 1, GE, 3)],
    outputs=[output(1, "lamp1", True, COND + 0),
             output(2, "lamp2", True, COND + 1)]))

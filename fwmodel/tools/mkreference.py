#!/usr/bin/env python3
"""Generate corpus/engine-repin-reference.json.

This is a hand-built rewrite of engine-repin.json that must behave identically
to it. It is deliberately different from the input in every way the equivalence
relation says is free, which is what makes it a real test of the oracle: a
document sharing almost no integers with the original, proven to be the same
program.

  * every collection is full length (2/8/32/32/16/32/4/4), every field of every
    slot explicit -- so the GUI's var-map arithmetic cannot change what it
    means, and the document fully defines the device on its own;
  * the virtual-input slots are ALL renumbered (a new VI1 is inserted at the
    front and everything shifts up one), so every var reference in the document
    changes;
  * counter 3's reset is re-expressed. The original uses resetEdge=Falling on
    Cond1 ENGINE_RUN, which only does the right thing because of the missing
    `bLastReset` update in counter.cpp. The reference instead computes
    NOT_ENGINE_RUN in a virtual input and resets on Rising against that, which
    is the same behaviour through the supported path:
        Falling on X   -> held in reset while X is LOW  (via the bug)
        Rising  on !X  -> held in reset while X is LOW  (by design)
    Both are one cycle stale relative to Cond1 -- the original because
    conditions update after counters, the rewrite because conditions update
    after virtual inputs -- so the timing is identical too. equiv.py proves it.

Run:  ./mkreference.py   (writes ../corpus/engine-repin-reference.json)
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PATH = os.path.normpath(os.path.join(HERE, "..", "corpus",
                                    "engine-repin-reference.json"))

# dingopdm_v7 var map
F, T = 0, 1
DIGIN = 5                     # DigIn1 = 5, DigIn2 = 6
CANIN = 7                     # CanIn<n>Out = 7 + 2(n-1)
VI = 71                       # VirtIn<n> = 71 + (n-1)
OUTBASE = 87                      # Out<n>Active = 87 + 4(n-1)
COND = 123                    # Cond<n> = 123 + (n-1)
CTR = 155                     # Counter<n> = 155 + (n-1)

AND, OR, NAND = 0, 1, 2
RISING, FALLING, BOTH = 0, 1, 2
MOMENTARY, LATCHING = 0, 1


def dig_in(n, name="", enabled=False, invert=False, mode=MOMENTARY,
           debounce=20, pull=0):
    return {"name": name, "number": n, "enabled": enabled, "invert": invert,
            "mode": mode, "debounceTime": debounce, "pull": pull}


def output(n, name="", enabled=False, inp=0, limit=20.0, inrush=50.0,
           inrush_ms=1000, reset_mode=0, reset_ms=1000, reset_count=3):
    return {"name": name, "number": n, "enabled": enabled, "input": inp,
            "currentLimit": limit, "inrushCurrentLimit": inrush,
            "inrushTime": inrush_ms, "resetMode": reset_mode,
            "resetTime": reset_ms, "resetCountLimit": reset_count,
            "pwmEnabled": False, "softStartEnabled": False,
            "variableDutyCycle": False, "dutyCycleInput": 0,
            "fixedDutyCycle": 100, "frequency": 100, "softStartRampTime": 0,
            "dutyCycleDenominator": 100, "minDutyCycle": 0,
            "primaryOutput": -1}


def can_in(n, name="", enabled=False, cid=0, start=0, length=1, op=0,
           operand=1, timeout_en=False, timeout=500):
    # "id" is emitted BEFORE "ide": CanInput.Id's C# setter assigns
    # Ide = (id > 2047) and System.Text.Json applies members in document order.
    return {"name": name, "number": n, "enabled": enabled,
            "timeoutEnabled": timeout_en, "timeout": timeout, "id": cid,
            "ide": cid > 2047, "startBit": start, "bitLength": length,
            "factor": 1, "offset": 0, "byteOrder": 0, "signed": False,
            "operator": op, "operand": operand, "mode": MOMENTARY}


def can_out(n, name="", enabled=False, inp=0, cid=0, start=0, length=1,
            interval=100):
    return {"name": name, "number": n, "enabled": enabled, "input": inp,
            "id": cid, "ide": cid > 2047, "startBit": start,
            "bitLength": length, "factor": 1, "offset": 0, "byteOrder": 0,
            "signed": False, "interval": interval}


def virt(n, name="", enabled=False, not0=False, var0=0, cond0=AND,
         not1=False, var1=0, cond1=AND, not2=False, var2=0, mode=MOMENTARY):
    # cond1/not2 are forced to their type defaults in two-term mode (var2 == 0),
    # because virtual_input.cpp never reads them there and a non-default value
    # implies behaviour the document does not have.
    if var2 == 0:
        cond1, not2 = AND, False
    return {"name": name, "number": n, "enabled": enabled, "not0": not0,
            "var0": var0, "cond0": cond0, "not1": not1, "var1": var1,
            "cond1": cond1, "not2": not2, "var2": var2, "mode": mode}


def cond(n, name="", enabled=False, inp=0, op=0, arg=0):
    return {"name": name, "number": n, "enabled": enabled, "input": inp,
            "operator": op, "arg": arg}


def counter(n, name="", enabled=False, inc=0, inc_edge=RISING, dec=0,
            dec_edge=RISING, reset=0, lo=0, hi=10, wrap=False,
            hold=False, hold_ms=2000):
    # resetEdge is ALWAYS Rising: counter.cpp's reset branch returns before the
    # bLastReset update, so Falling latches the counter at zero permanently.
    return {"name": name, "number": n, "enabled": enabled, "incInput": inc,
            "decInput": dec, "resetInput": reset, "minCount": lo,
            "maxCount": hi, "incEdge": inc_edge, "decEdge": dec_edge,
            "resetEdge": RISING, "wrapAround": wrap, "holdToReset": hold,
            "resetTime": hold_ms}


def flasher(n, name="", enabled=False, inp=0, on=500, off=500):
    return {"name": name, "number": n, "enabled": enabled, "single": False,
            "input": inp, "onTime": on, "offTime": off}


# --- named signals ---------------------------------------------------------
WASHER = CANIN + 2 * 0        # CanIn1Out  washer   (0x642 bit 32, CANBoard DI1)
HORN = CANIN + 2 * 1          # CanIn2Out  horn     (0x642 bit 39, DI8)
BRAKE = CANIN + 2 * 2         # CanIn3Out  brake    (0x300 bit 0, lights PDM)
HEATER_SW = DIGIN + 0
PARK_BRAKE_REQ = DIGIN + 1

V_NOT_RUN = VI + 0            # VirtIn1   (new)
V_CHORD = VI + 1              # VirtIn2
V_START_REQ = VI + 2          # VirtIn3
V_ARMED = VI + 3              # VirtIn4
V_IGN = VI + 4                # VirtIn5
V_WASHER_PUMP = VI + 5        # VirtIn6
V_HORN_GATE = VI + 6          # VirtIn7
V_HEATER_PRESS = VI + 7       # VirtIn8
V_HEATER_REQ = VI + 8         # VirtIn9
V_PARK_LAMP = VI + 9          # VirtIn10

C_ENGINE_RUN = COND + 0
C_CRANKED = COND + 1
C_HEATER_LATCHED = COND + 2

GE = 4                        # Operator::GreaterThanOrEqual

dev = {
    "pdmType": 0,
    "name": "engine-repin-reference",
    "baseId": 512,
    "sleepEnabled": False,
    "filtersEnabled": False,
    "connectUsbToCan": True,
    "bitrate": 1,
    "inputs": [
        dig_in(1, "HEATER_SW", True, invert=True, pull=1, debounce=20),
        dig_in(2, "PARK_BRAKE_REQ", True, invert=True, pull=1, debounce=20),
    ],
    "outputs": [
        output(1, "starter-solenoid", True, V_START_REQ, 13, 40, 500, 1, 1000, 5),
        output(2, "coil-ballast-run", True, V_IGN, 10, 20, 300, 1, 1000, 5),
        output(3, "washer-pump", True, V_WASHER_PUMP, 8, 15, 300, 1, 1000, 5),
        output(4, "alt-field+ecu", True, V_IGN, 8, 15, 300, 1, 1000, 5),
        output(5, "wiper", True, C_ENGINE_RUN, 8, 40, 1000, 2, 500, 5),
        output(6, "coil-direct-start", True, V_START_REQ, 8, 15, 300, 1, 1000, 5),
        output(7, "horn", True, V_HORN_GATE, 8, 12, 300, 1, 1000, 5),
        output(8, "canbus-12v", True, T, 5, 8, 300, 1, 1000, 5),
    ] + [output(n) for n in range(9, 9)],
    "canInputs": [
        can_in(1, "washer(DI1)", True, 1602, 32, 1, 0, 1, True, 500),
        can_in(2, "horn(DI8)", True, 1602, 39, 1, 0, 1, True, 500),
        can_in(3, "brake(lights)", True, 768, 0, 1, 0, 1, True, 500),
    ] + [can_in(n) for n in range(4, 33)],
    "canOutputs": [
        can_out(1, "ENGINE_RUNNING", True, C_ENGINE_RUN, 769, 0, 1, 100),
        can_out(2, "HEATER_REQ", True, V_HEATER_REQ, 769, 1, 1, 100),
        can_out(3, "IC_PARK", True, V_PARK_LAMP, 1603, 8, 1, 100),
        can_out(4, "dlc-pad", True, F, 1603, 24, 1, 100),
    ] + [can_out(n) for n in range(5, 33)],
    "virtualInputs": [
        virt(1, "NOT_ENGINE_RUN", True, not0=True, var0=C_ENGINE_RUN,
             cond0=AND, var1=T),
        virt(2, "CHORD", True, var0=BRAKE, cond0=AND, var1=WASHER),
        virt(3, "START_REQ", True, var0=V_CHORD, cond0=AND, var1=HORN),
        virt(4, "ARMED", True, var0=V_CHORD, cond0=AND, var1=C_CRANKED),
        virt(5, "IGN", True, var0=C_ENGINE_RUN, cond0=OR, var1=V_START_REQ),
        virt(6, "WASHER_PUMP", True, var0=WASHER, cond0=AND, not1=True,
             var1=BRAKE, cond1=AND, var2=C_ENGINE_RUN),
        virt(7, "HORN_GATE", True, var0=HORN, cond0=AND, not1=True,
             var1=V_CHORD),
        virt(8, "HEATER_PRESS", True, var0=HEATER_SW, cond0=AND,
             var1=C_ENGINE_RUN),
        virt(9, "HEATER_REQ", True, var0=C_HEATER_LATCHED, cond0=AND,
             var1=C_ENGINE_RUN),
        virt(10, "PARK_BRAKE_LAMP", True, var0=PARK_BRAKE_REQ, cond0=AND,
             var1=C_ENGINE_RUN),
    ] + [virt(n) for n in range(11, 17)],
    "conditions": [
        cond(1, "ENGINE_RUN", True, CTR + 0, GE, 1),
        cond(2, "CRANKED", True, CTR + 1, GE, 1),
        cond(3, "HEATER_LATCHED", True, CTR + 2, GE, 1),
    ] + [cond(n) for n in range(4, 33)],
    "counters": [
        counter(1, "run-latch", True, inc=V_ARMED, inc_edge=FALLING,
                dec=V_CHORD, dec_edge=RISING, reset=F, lo=0, hi=1),
        counter(2, "crank-latch", True, inc=V_START_REQ, inc_edge=RISING,
                dec=V_CHORD, dec_edge=FALLING, reset=F, lo=0, hi=1),
        counter(3, "heater-latch", True, inc=V_HEATER_PRESS, inc_edge=RISING,
                dec=F, reset=V_NOT_RUN, lo=0, hi=1, wrap=True),
        counter(4),
    ],
    "flashers": [flasher(n) for n in range(1, 5)],
}

doc = {"PdmDevices": [dev], "CanboardDevices": [], "DbcDevices": [],
       "BlinkMarineKeypads": [], "GrayhillKeypads": []}

with open(OUT_PATH, "w") as fh:
    json.dump(doc, fh, indent=2)
    fh.write("\n")
print(f"wrote {OUT_PATH}")

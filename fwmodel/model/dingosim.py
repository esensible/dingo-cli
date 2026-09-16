"""An independent cycle-accurate model of the dingoFW logic engine.

Written from the firmware source only (no reference to dingo-cli), so a config
can be judged against firmware behaviour rather than against the config tool's
own understanding of it.

Sources transcribed:
  core/device.cpp            CyclicUpdate()   -- category order, var map wiring
  functions/virtual_input.*  VirtualInput::Update()
  functions/counter.*        Counter::Update()
  functions/condition.*      Condition::Update()
  functions/flasher.*        Flasher::Update()
  functions/digital_input.*  Digital_Input::Update()
  functions/can_input.*      CanInput::CheckMsg() / CheckTimeout()
  functions/can_outputs.*    CanOutputs::InitAllFrames() / Update()
  functions/input.*          Input::Check()      (momentary / latching)
  functions/profet.*         Profet::Update()    (ideal-current subset)
  utils/dbc.cpp              Dbc::Decode*/Encode*

=============================================================================
WHAT THIS MODEL DOES NOT MODEL  (read this before trusting a green run)
=============================================================================
  * Analogue anything. Output current is always 0, so Overcurrent/Fault states
    are unreachable, resetMode/currentLimit/inrushLimit/inrushTime have no
    effect, and OutNCurrent/OutNOvercurrent/OutNFault vars are pinned at 0.
    A config whose logic reads OutNFault/OutNOvercurrent cannot be validated
    here -- the checker refuses such configs rather than silently passing them.
  * PWM, soft start, primary/follower output pairing.
  * Wiper, starter-disable, keypads, neopixels, DBC devices, sleep.
    Configs using them are refused, not approximated.
  * CAN arbitration, bus load, TX mailbox depth, frame loss, RX ordering.
    RX frames supplied by a trace are all delivered at the top of the cycle.
  * Real loop jitter. chThdSleepMilliseconds(2) plus execution time is modelled
    as exactly 2 ms per cycle. Anything whose behaviour depends on the true
    period (flasher on/off times, debounce, counter holdToReset) is therefore
    only as accurate as that assumption. Comparisons between two configs are
    unaffected (both get the same clock); comparisons against hardware are not.
  * float is modelled as Python float (double). The firmware uses f32. This
    only matters for Condition Equal/NotEqual on scaled CAN values.
  * Config apply / param protocol / CRC / FRAM. The model starts from a config,
    it does not model writing one.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from varmap import BOARDS, BY_PDM_TYPE, Board

CYCLE_MS = 2  # core/device.cpp DeviceThread: chThdSleepMilliseconds(2)

# --------------------------------------------------------------------------
# enums (core/enums.h)
# --------------------------------------------------------------------------
OP_EQ, OP_NE, OP_GT, OP_LT, OP_GE, OP_LE, OP_BITAND, OP_BITNAND = range(8)
BOOL_AND, BOOL_OR, BOOL_NOR = range(3)   # "Nor" == 2 but implements NAND
EDGE_RISING, EDGE_FALLING, EDGE_BOTH = range(3)
MODE_MOMENTARY, MODE_LATCHING = range(2)
RESET_NONE, RESET_COUNT, RESET_ENDLESS = range(3)
BYTEORDER_LE, BYTEORDER_BE = range(2)


class Unsupported(Exception):
    """The config uses a feature this model refuses to approximate."""


# --------------------------------------------------------------------------
# Defaults for absent fields.
#
# FW_DEFAULTS is the firmware param table (DingoPDM_FW param_defs.h, as
# transcribed in dingo-cli internal/params/registry.go). The dingoConfig GUI's
# C# field initialisers agree with it on every field that matters (currentLimit
# 20, inrushCurrentLimit 50, inrushTime/resetTime 1000, resetCountLimit 3,
# debounceTime 20, counter maxCount 10 / resetTime 2000, flasher 500/500,
# canInput timeout 1000 / bitLength 8 / factor 1.0, bitrate 1, connectUsbToCan
# true), so "what the GUI shows" and "what a factory-default device holds" are
# the same table. Type-zero is NOT what either of them does.
#
# The real hazard is different, and ADV_DEFAULTS models it:
#   dingo-cli's pdmcfg.go emitField() SKIPS an absent or null field entirely.
#   Nothing is written, so the *device keeps whatever it already had* -- the
#   previous config, not a default. A document that leaves fields out is
#   therefore only well-defined on a factory-fresh device.
#
# ADV_DEFAULTS substitutes a deliberately different legal value for every
# unspecified field. If a document's behaviour changes between FW_DEFAULTS and
# ADV_DEFAULTS, the document is under-specified: re-flashing it over an existing
# config can change what the vehicle does. See equiv.py --self-contained.
# --------------------------------------------------------------------------
FW_DEFAULTS: Dict[str, Dict[str, Any]] = {
    "device": {"baseId": 222, "bitrate": 1, "sleepEnabled": False,
               "filtersEnabled": False, "connectUsbToCan": True},
    "outputs": {"enabled": False, "input": 0, "currentLimit": 20.0,
                "inrushCurrentLimit": 50.0, "inrushTime": 1000, "resetMode": 0,
                "resetTime": 1000, "resetCountLimit": 3},
    "inputs": {"enabled": False, "mode": 0, "invert": False,
               "debounceTime": 20, "pull": 0},
    "canInputs": {"enabled": False, "timeoutEnabled": False, "timeout": 1000,
                  "ide": 0, "id": 0, "startBit": 0, "bitLength": 8,
                  "factor": 1.0, "offset": 0.0, "byteOrder": 0, "signed": False,
                  "operator": 0, "operand": 0.0, "mode": 0},
    "canOutputs": {"enabled": False, "input": 0, "ide": 0, "id": 0,
                   "startBit": 0, "bitLength": 8, "factor": 1.0, "offset": 0.0,
                   "byteOrder": 0, "signed": False, "interval": 1000},
    "virtualInputs": {"enabled": False, "not0": False, "var0": 0, "cond0": 0,
                      "not1": False, "var1": 0, "cond1": 0, "not2": False,
                      "var2": 0, "mode": 0},
    "conditions": {"enabled": False, "input": 0, "operator": 0, "arg": 0.0},
    "counters": {"enabled": False, "incInput": 0, "decInput": 0, "resetInput": 0,
                 "minCount": 0, "maxCount": 10, "incEdge": 0, "decEdge": 0,
                 "resetEdge": 0, "wrapAround": False, "holdToReset": False,
                 "resetTime": 2000},
    "flashers": {"enabled": False, "input": 0, "onTime": 500, "offTime": 500,
                 "single": False},
}

def _adversarial(group: str, key: str, val: Any) -> Any:
    """A legal-but-different value, standing in for 'whatever was on the device'."""
    if isinstance(val, bool):
        return not val
    if key in ("input", "var0", "var1", "var2", "incInput", "decInput",
               "resetInput", "dutyCycleInput"):
        return 1          # AlwaysTrue instead of AlwaysFalse
    if key in ("cond0", "cond1"):
        return BOOL_OR    # Or instead of And
    if key in ("incEdge", "decEdge", "resetEdge"):
        return EDGE_BOTH
    if key == "operator":
        return OP_NE
    if key == "mode":
        return MODE_LATCHING
    if key == "maxCount":
        return 255
    if key == "minCount":
        return 0
    if isinstance(val, float):
        return val + 1.0
    if isinstance(val, int):
        return val + 1
    return val


ADV_DEFAULTS: Dict[str, Dict[str, Any]] = {
    grp: {k: _adversarial(grp, k, v) for k, v in fields.items()}
    for grp, fields in FW_DEFAULTS.items()
}

# For slots the document never mentions at all, "enabled" stays False for the
# internal function blocks -- an unmentioned virtual input or counter that
# nothing reads genuinely cannot change behaviour, and flipping it on would
# produce noise rather than findings.
#
# Outputs and CAN outputs are the exception, and the important one: a slot the
# document does not mention is a slot dingo-cli does not write, so a physical
# circuit or a bus signal the previous config energised STAYS energised. Model
# that as enabled + AlwaysTrue, so any document that fails to say "output 6 is
# off" is caught.
for _g in ADV_DEFAULTS:
    ADV_DEFAULTS[_g]["enabled"] = _g in ("outputs", "canOutputs")
ADV_DEFAULTS["outputs"]["input"] = 1
ADV_DEFAULTS["canOutputs"]["input"] = 1

DEFAULT_POLICIES = {"firmware": FW_DEFAULTS, "gui": FW_DEFAULTS,
                    "adversarial": ADV_DEFAULTS}


# --------------------------------------------------------------------------
# DBC codec (utils/dbc.cpp)
# --------------------------------------------------------------------------
def decode_int(data: Sequence[int], start_bit: int, bit_len: int,
               byte_order: int, signed: bool) -> int:
    if bit_len == 0 or bit_len > 32:
        return 0
    if byte_order == BYTEORDER_BE:
        value = 0
        byte_i, bit_i = start_bit // 8, start_bit % 8
        for i in range(bit_len):
            if byte_i < len(data) and (data[byte_i] >> bit_i) & 1:
                value |= 1 << (bit_len - 1 - i)
            bit_i -= 1
            if bit_i < 0:
                bit_i, byte_i = 7, byte_i + 1
    else:
        raw = 0
        for i in range(8):
            raw |= (data[i] if i < len(data) else 0) << (i * 8)
        value = (raw >> start_bit) & ((1 << bit_len) - 1)
    if signed and (value & (1 << (bit_len - 1))):
        value -= 1 << bit_len
    # firmware returns int32_t
    value &= 0xFFFFFFFF
    if value >= 0x80000000:
        value -= 0x100000000
    return value


def decode_float(data, start_bit, bit_len, factor, offset, byte_order, signed):
    return decode_int(data, start_bit, bit_len, byte_order, signed) * factor + offset


def encode_float(data: List[int], value: float, start_bit: int, bit_len: int,
                 factor: float, offset: float, byte_order: int) -> None:
    if bit_len == 0 or bit_len > 32:
        return
    raw = 0 if factor == 0.0 else int((value - offset) / factor)  # C cast: truncate
    raw &= 0xFFFFFFFF
    mask = (1 << bit_len) - 1
    v = raw & mask
    if byte_order == BYTEORDER_BE:
        byte_i, bit_i = start_bit // 8, start_bit % 8
        for i in range(bit_len):
            if (v >> (bit_len - 1 - i)) & 1:
                data[byte_i] |= 1 << bit_i
            else:
                data[byte_i] &= ~(1 << bit_i) & 0xFF
            bit_i -= 1
            if bit_i < 0:
                bit_i, byte_i = 7, byte_i + 1
    else:
        acc = 0
        for i in range(8):
            acc |= data[i] << (i * 8)
        acc &= ~(mask << start_bit) & 0xFFFFFFFFFFFFFFFF
        acc |= v << start_bit
        for i in range(8):
            data[i] = (acc >> (i * 8)) & 0xFF


# --------------------------------------------------------------------------
# functions/input.cpp -- Input::Check
# --------------------------------------------------------------------------
class InputLatch:
    """Momentary/latching edge helper. b_out/b_last are statically zero-init."""

    __slots__ = ("b_out", "b_last")

    def __init__(self) -> None:
        self.b_out = False
        self.b_last = False

    def check(self, mode: int, invert: bool, val: bool) -> bool:
        val = bool(val) ^ bool(invert)
        if val != self.b_last:
            if mode == MODE_MOMENTARY:
                self.b_out = val
            elif mode == MODE_LATCHING and val is True:
                self.b_out = not self.b_out
        self.b_last = val
        return self.b_out


# --------------------------------------------------------------------------
# Config loading
# --------------------------------------------------------------------------
GROUP_LIMITS = {
    "outputs": "num_outputs",
    "inputs": "num_dig_inputs",
    "canInputs": "num_can_inputs",
    "canOutputs": "num_can_outputs",
    "virtualInputs": "num_virt_inputs",
    "conditions": "num_conditions",
    "counters": "num_counters",
    "flashers": "num_flashers",
}

UNSUPPORTED_KEYS = ("wipers", "starterDisable", "keypads")


@dataclass
class DeviceConfig:
    board: Board
    name: str
    base_id: int
    groups: Dict[str, List[Dict[str, Any]]]
    raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @property
    def outputs(self):
        return self.groups["outputs"]


def _slots(raw_dev: Dict[str, Any], key: str, count: int,
           defaults: Dict[str, Dict[str, Any]],
           policy: str = "firmware") -> List[Dict[str, Any]]:
    """Expand a JSON array into `count` fully-defaulted slots.

    Array *position* selects the firmware instance, matching dingo-cli
    pdmcfg.go (`base := g.base + uint16(i)`). The `number` field is ignored by
    the CLI; if present and inconsistent it is recorded so the linter can shout.
    """
    arr = raw_dev.get(key) or []
    if not isinstance(arr, list):
        raise Unsupported(f"{key} is not an array")
    if len(arr) > count:
        raise Unsupported(f"{key}: {len(arr)} entries but board has {count}")
    out = []
    for i in range(count):
        slot = dict(defaults[key])
        slot["_slot"] = i + 1
        slot["_present"] = i < len(arr)
        slot["_explicit"] = set()
        if i < len(arr):
            item = arr[i] or {}
            if policy == "adversarial" and "enabled" not in item:
                # a slot the document mentions but does not explicitly enable:
                # the device may well still have it enabled from before
                slot["enabled"] = True
            for k, v in item.items():
                if k in ("name", "number"):
                    slot["_" + k] = v
                    continue
                if v is None:
                    continue
                slot[k] = v
                slot["_explicit"].add(k)
        out.append(slot)
    return out


def load_device(path_or_obj, board_name: Optional[str] = None,
                base_id: Optional[int] = None,
                default_policy: str = "firmware") -> DeviceConfig:
    if isinstance(path_or_obj, (str, bytes)):
        with open(path_or_obj) as fh:
            doc = json.load(fh)
    else:
        doc = path_or_obj

    devs = list(doc.get("PdmDevices") or [])
    devs += list(doc.get("PdmMaxDevices") or [])
    if not devs:
        raise Unsupported("no PdmDevices in document")
    if base_id is not None:
        match = [d for d in devs if d.get("baseId") == base_id]
        if not match:
            raise Unsupported(f"no PDM with baseId {base_id}")
        dev = match[0]
    elif len(devs) == 1:
        dev = devs[0]
    else:
        raise Unsupported("multiple PDM devices; pass base_id")

    if board_name:
        board = BOARDS[board_name]
    else:
        board = BY_PDM_TYPE.get(dev.get("pdmType", 0), BOARDS["dingopdm_v7"])

    for k in UNSUPPORTED_KEYS:
        v = dev.get(k)
        if isinstance(v, dict) and v.get("enabled"):
            raise Unsupported(f"{k} is enabled; not modelled")
        if isinstance(v, list) and any((x or {}).get("enabled") for x in v):
            raise Unsupported(f"{k} is enabled; not modelled")

    defaults = DEFAULT_POLICIES[default_policy]
    groups = {}
    for key, attr in GROUP_LIMITS.items():
        groups[key] = _slots(dev, key, getattr(board, attr), defaults,
                             default_policy)

    devdef = defaults["device"]
    return DeviceConfig(
        board=board,
        name=dev.get("name", "?"),
        base_id=dev.get("baseId", devdef["baseId"]),
        groups=groups,
        raw=dev,
    )


# --------------------------------------------------------------------------
# Runtime blocks
# --------------------------------------------------------------------------
class Sim:
    """One device. `step()` runs exactly one CyclicUpdate()."""

    def __init__(self, cfg: DeviceConfig):
        self.cfg = cfg
        self.b = cfg.board
        self.var = [0.0] * self.b.size
        self.var[self.b.index("AlwaysFalse")] = 0.0
        self.var[self.b.index("AlwaysTrue")] = 1.0
        self.var[self.b.index("State")] = 0.0  # DeviceState::Run
        self.time_ms = 0

        n = self.b
        self._din_latch = [InputLatch() for _ in range(n.num_dig_inputs)]
        self._din_last = [False] * n.num_dig_inputs
        self._din_check = [False] * n.num_dig_inputs
        self._din_trig = [0] * n.num_dig_inputs
        self._din_init = [False] * n.num_dig_inputs

        self._cin_latch = [InputLatch() for _ in range(n.num_can_inputs)]
        self._cin_last_rx = [0] * n.num_can_inputs

        self._vi_latch = [InputLatch() for _ in range(n.num_virt_inputs)]

        self._out_state = [0 for _ in range(n.num_outputs)]  # ProfetState

        self._fl_on = [0] * n.num_flashers
        self._fl_off = [0] * n.num_flashers

        self._ct_last_inc = [False] * n.num_counters
        self._ct_last_dec = [False] * n.num_counters
        self._ct_last_reset = [False] * n.num_counters

        self._canout_sample = [0.0] * n.num_can_outputs

        self._validate_refs()
        self._init_can_frames()
        self.tx: List[Tuple[int, int, List[int]]] = []  # (id, dlc, data) this cycle

    # -- reference validation -------------------------------------------
    def _validate_refs(self) -> None:
        size = self.b.size
        bad = []
        for key, fields in (
            ("outputs", ("input",)),
            ("canOutputs", ("input",)),
            ("virtualInputs", ("var0", "var1", "var2")),
            ("conditions", ("input",)),
            ("counters", ("incInput", "decInput", "resetInput")),
            ("flashers", ("input",)),
        ):
            for s in self.cfg.groups[key]:
                if not s["enabled"]:
                    continue
                for f in fields:
                    if not (0 <= int(s[f]) < size):
                        bad.append(f"{key}[{s['_slot']}].{f}={s[f]} out of var map (size {size})")
        if bad:
            raise Unsupported("; ".join(bad))

        # Refuse anything reading an analogue-derived var the model pins at 0.
        pinned = set()
        for i in range(1, self.b.num_outputs + 1):
            pinned |= {self.b.index(f"Out{i}Current"), self.b.index(f"Out{i}Overcurrent"),
                       self.b.index(f"Out{i}Fault")}
        for i in range(1, self.b.num_analog_inputs + 1):
            pinned |= {self.b.index(f"Analog{i}Val"), self.b.index(f"Analog{i}mV"),
                       self.b.index(f"Analog{i}Rotary"), self.b.index(f"Analog{i}Switch")}
        if self.b.sys_vars >= 5:
            pinned |= {self.b.index("BoardTemp"), self.b.index("BattVolt")}
        used = []
        for key, fields in (("outputs", ("input",)), ("canOutputs", ("input",)),
                            ("virtualInputs", ("var0", "var1", "var2")),
                            ("conditions", ("input",)),
                            ("counters", ("incInput", "decInput", "resetInput")),
                            ("flashers", ("input",))):
            for s in self.cfg.groups[key]:
                if not s["enabled"]:
                    continue
                for f in fields:
                    if int(s[f]) in pinned:
                        used.append(f"{key}[{s['_slot']}].{f} -> {self.b.label(int(s[f]))}")
        if used:
            raise Unsupported(
                "config reads analogue/unmodelled vars (pinned at 0 here): "
                + "; ".join(used))

    # -- CAN out frame assembly (can_outputs.cpp InitAllFrames) ----------
    def _init_can_frames(self) -> None:
        self._frames: List[Dict[str, Any]] = []
        self._assigned = [-1] * self.b.num_can_outputs
        for i, s in enumerate(self.cfg.groups["canOutputs"]):
            if not s["enabled"]:
                continue
            bl, iv = int(s["bitLength"]), int(s["interval"])
            if bl == 0 or bl > 64:
                continue
            if iv == 0:
                iv = 100
            dlc = (int(s["startBit"]) + bl - 1) // 8 + 1
            for j, fr in enumerate(self._frames):
                if fr["ide"] == int(s["ide"]) and fr["id"] == int(s["id"]):
                    self._assigned[i] = j
                    fr["dlc"] = max(fr["dlc"], dlc)
                    fr["interval"] = min(fr["interval"], iv)
                    break
            else:
                self._frames.append({"ide": int(s["ide"]), "id": int(s["id"]),
                                     "dlc": dlc, "interval": iv,
                                     "data": [0] * 8, "next_tx": 0})
                self._assigned[i] = len(self._frames) - 1

    # -- one cycle -------------------------------------------------------
    def step(self, pins: Optional[Dict[int, int]] = None,
             rx_frames: Optional[Sequence[Tuple[int, Sequence[int]]]] = None,
             ext_ide: int = 0) -> None:
        b, V = self.b, self.var
        self.tx = []
        pins = pins or {}

        # 1. drain RX
        for fid, data in (rx_frames or []):
            for i, s in enumerate(self.cfg.groups["canInputs"]):
                if not s["enabled"]:
                    continue
                if int(s["ide"]) != ext_ide or int(s["id"]) != fid:
                    continue
                if int(s["bitLength"]) == 0:
                    continue
                self._cin_last_rx[i] = self.time_ms
                val = decode_float(data, int(s["startBit"]), int(s["bitLength"]),
                                   float(s["factor"]), float(s["offset"]),
                                   int(s["byteOrder"]), bool(s["signed"]))
                V[b.base["canIn"] + 2 * i + 1] = val
                res = self._cmp(int(s["operator"]), val, float(s["operand"]),
                                can_input=True)
                V[b.base["canIn"] + 2 * i] = float(
                    self._cin_latch[i].check(int(s["mode"]), False, res))

        # 2. OUTPUTS -- run first, so they read last cycle's logic
        for i, s in enumerate(self.cfg.groups["outputs"]):
            self._profet(i, s)

        # 3. digital inputs
        for i, s in enumerate(self.cfg.groups["inputs"]):
            self._digin(i, s, bool(pins.get(i + 1, 0)))

        # 4. digital outputs / 5. analog inputs -- not modelled (canboard only)

        # 6. CAN input timeouts
        for i, s in enumerate(self.cfg.groups["canInputs"]):
            if not s["enabled"] or not s["timeoutEnabled"]:
                continue
            if self.time_ms - self._cin_last_rx[i] > int(s["timeout"]):
                V[b.base["canIn"] + 2 * i] = 0.0
                V[b.base["canIn"] + 2 * i + 1] = 0.0

        # 7. CAN outputs
        self._can_outputs()

        # 8. VIRTUAL INPUTS
        for i, s in enumerate(self.cfg.groups["virtualInputs"]):
            self._virtin(i, s)

        # 9/10. wiper, starter -- refused at load time

        # 11. FLASHERS
        for i, s in enumerate(self.cfg.groups["flashers"]):
            self._flasher(i, s)

        # 12. COUNTERS
        for i, s in enumerate(self.cfg.groups["counters"]):
            self._counter(i, s)

        # 13. CONDITIONS
        for i, s in enumerate(self.cfg.groups["conditions"]):
            self._condition(i, s)

        self.time_ms += CYCLE_MS

    # -- blocks ----------------------------------------------------------
    def _profet(self, i: int, s: Dict[str, Any]) -> None:
        """profet.cpp Profet::Update with fCurrent pinned at 0.

        With no current there is no path into Overcurrent/Fault, so the state
        machine degenerates to Off <-> On driven by the input var.
        """
        b, V = self.b, self.var
        base = b.base["output"] + 4 * i
        if not s["enabled"]:
            self._out_state[i] = 0
            V[base] = V[base + 1] = V[base + 2] = V[base + 3] = 0.0
            return
        req_on = bool(V[int(s["input"])])
        if self._out_state[i] == 0 and req_on:
            self._out_state[i] = 1
        elif self._out_state[i] == 1 and not req_on:
            self._out_state[i] = 0
        V[base] = 1.0 if self._out_state[i] == 1 else 0.0
        V[base + 1] = 0.0
        V[base + 2] = 0.0
        V[base + 3] = 0.0

    def _digin(self, i: int, s: Dict[str, Any], pin: bool) -> None:
        b, V = self.b, self.var
        idx = b.base["digIn"] + i
        if not s["enabled"]:
            V[idx] = 0.0
            return
        if pin != self._din_last[i]:
            self._din_trig[i] = self.time_ms
            self._din_check[i] = True
        self._din_last[i] = pin
        if (self._din_check[i]
                and (self.time_ms - self._din_trig[i]) > int(s["debounceTime"])) \
                or not self._din_init[i]:
            self._din_check[i] = False
            V[idx] = float(self._din_latch[i].check(
                int(s["mode"]), bool(s["invert"]), pin))
        self._din_init[i] = True

    def _cmp(self, op: int, lhs: float, rhs: float, can_input: bool) -> bool:
        """Operator semantics.

        can_input=True  -> can_input.cpp, where BitwiseNand is written correctly
                           as !((a & b) > 0).
        can_input=False -> condition.cpp, where BitwiseNand is `~(a & b)` on a
                           uint16 promoted to int -- NEVER zero, so the
                           condition is unconditionally true. That is the bug
                           a config generator must refuse to emit.
        """
        if op == OP_EQ:
            return lhs == rhs
        if op == OP_NE:
            return lhs != rhs
        if op == OP_GT:
            return lhs > rhs
        if op == OP_LT:
            return lhs < rhs
        if op == OP_GE:
            return lhs >= rhs
        if op == OP_LE:
            return lhs <= rhs
        if op == OP_BITAND:
            if can_input:
                return (int(lhs) & int(rhs)) > 0
            return bool(int(lhs) & int(rhs))
        if op == OP_BITNAND:
            if can_input:
                return not ((int(lhs) & int(rhs)) > 0)
            return True  # ~(uint16 & uint16) is never 0 -- always truthy
        return False

    def _condition(self, i: int, s: Dict[str, Any]) -> None:
        b, V = self.b, self.var
        idx = b.base["condition"] + i
        if not s["enabled"]:
            V[idx] = 0.0
            return
        op = int(s["operator"])
        lhs, rhs = V[int(s["input"])], float(s["arg"])
        if op == OP_BITAND:
            # firmware assigns the raw AND result, not a bool
            V[idx] = float(int(lhs) & int(rhs) & 0xFFFF)
        elif op == OP_BITNAND:
            V[idx] = float((~(int(lhs) & int(rhs) & 0xFFFF)) & 0xFFFFFFFF or 1)
        elif op > OP_BITNAND:
            V[idx] = 0.0
        else:
            V[idx] = 1.0 if self._cmp(op, lhs, rhs, can_input=False) else 0.0

    def _virtin(self, i: int, s: Dict[str, Any]) -> None:
        b, V = self.b, self.var
        idx = b.base["virtIn"] + i
        if not s["enabled"]:
            V[idx] = 0.0
            return
        # NOTE: firmware guards `if ((pVar0 == 0) || (pVar1 == 0)) return;` but
        # those are POINTERS from pVarMap[], and pVarMap[0] = &ALWAYS_FALSE is
        # non-null, so the guard is dead code. var0 == 0 therefore means
        # "always false", NOT "disabled". Modelled accordingly.
        r0 = bool(V[int(s["var0"])])
        if s["not0"]:
            r0 = not r0
        r1 = bool(V[int(s["var1"])])
        if s["not1"]:
            r1 = not r1
        c0 = int(s["cond0"])
        if c0 == BOOL_AND:
            sec0 = r0 and r1
        elif c0 == BOOL_OR:
            sec0 = r0 or r1
        else:                       # BoolOperator::Nor == NAND in firmware
            sec0 = (not r0) or (not r1)

        if int(s["var2"]) == 0:     # two-term sentinel; cond1/not2 ignored
            V[idx] = float(self._vi_latch[i].check(int(s["mode"]), False, sec0))
            return

        r2 = bool(V[int(s["var2"])])
        if s["not2"]:
            r2 = not r2
        c1 = int(s["cond1"])
        if c1 == BOOL_AND:
            sec1 = sec0 and r2
        elif c1 == BOOL_OR:
            sec1 = sec0 or r2
        else:
            sec1 = (not sec0) or (not r2)
        V[idx] = float(self._vi_latch[i].check(int(s["mode"]), False, sec1))

    def _flasher(self, i: int, s: Dict[str, Any]) -> None:
        b, V = self.b, self.var
        idx = b.base["flasher"] + i
        if not s["enabled"]:
            V[idx] = 0.0
            return
        if not V[int(s["input"])]:
            V[idx] = 0.0
            return
        now = self.time_ms
        if V[idx] == 0 and (now - self._fl_off[i]) > int(s["offTime"]):
            V[idx] = 1.0
            self._fl_on[i] = now
        if V[idx] == 1 and (now - self._fl_on[i]) > int(s["onTime"]):
            V[idx] = 0.0
            self._fl_off[i] = now
        # NOTE: `single` (bSingleCycle) is read from config but never used by
        # flasher.cpp. Deliberately ignored here so the model matches.

    @staticmethod
    def _edge(edge: int, prev: bool, curr: bool) -> bool:
        if edge == EDGE_RISING:
            return (not prev) and curr
        if edge == EDGE_FALLING:
            return prev and (not curr)
        if edge == EDGE_BOTH:
            return prev != curr
        return False

    def _counter(self, i: int, s: Dict[str, Any]) -> None:
        b, V = self.b, self.var
        idx = b.base["counter"] + i
        if not s["enabled"]:
            V[idx] = 0.0
            return
        inc = bool(V[int(s["incInput"])])
        dec = bool(V[int(s["decInput"])])
        rst = bool(V[int(s["resetInput"])])

        # counter.cpp: the reset branch `return`s BEFORE the bLast* update at the
        # bottom of Update(). bLastReset therefore never advances while a reset
        # is firing, which turns the edge test into a level test:
        #   Rising  -> reset is held for as long as the input is HIGH
        #   Falling -> reset latches ON at the first falling edge and is held
        #              for as long as the input stays LOW (i.e. a Falling reset
        #              pins the counter at 0 until the input goes high again)
        if self._edge(int(s["resetEdge"]), self._ct_last_reset[i], rst):
            V[idx] = 0.0
            return

        if s["holdToReset"]:
            if inc and (self.time_ms - self._ct_inc_t(i)) >= int(s["resetTime"]):
                V[idx] = 0.0
                return
            if dec and (self.time_ms - self._ct_dec_t(i)) >= int(s["resetTime"]):
                V[idx] = 0.0
                return

        if self._edge(int(s["incEdge"]), self._ct_last_inc[i], inc):
            V[idx] += 1
            if V[idx] > int(s["maxCount"]):
                V[idx] = 0.0 if s["wrapAround"] else float(int(s["maxCount"]))
            self._set_inc_t(i, self.time_ms)

        if self._edge(int(s["decEdge"]), self._ct_last_dec[i], dec):
            if V[idx] == 0:
                # NOTE: minCount is consulted ONLY here. Decrementing from any
                # value > 0 does a plain fVal-- with no minCount clamp, so a
                # counter with minCount > 0 can sit below minCount.
                V[idx] = float(int(s["maxCount"])) if s["wrapAround"] \
                    else float(int(s["minCount"]))
            else:
                V[idx] -= 1
            self._set_dec_t(i, self.time_ms)

        self._ct_last_inc[i] = inc
        self._ct_last_dec[i] = dec
        self._ct_last_reset[i] = rst

    def _ct_inc_t(self, i):
        return getattr(self, "_ct_inc_times", {}).get(i, 0)

    def _ct_dec_t(self, i):
        return getattr(self, "_ct_dec_times", {}).get(i, 0)

    def _set_inc_t(self, i, t):
        d = getattr(self, "_ct_inc_times", None)
        if d is None:
            d = self._ct_inc_times = {}
        d[i] = t

    def _set_dec_t(self, i, t):
        d = getattr(self, "_ct_dec_times", None)
        if d is None:
            d = self._ct_dec_times = {}
        d[i] = t

    def _can_outputs(self) -> None:
        V = self.var
        # Sample every enabled CAN output's source var at the point in the cycle
        # canOutputs.Update() runs. This is the observable: it is what the
        # firmware would put in the frame if this were a transmit cycle, and it
        # is independent of the tx interval. Frame packing and interval are
        # a structural property of the document, not a runtime one.
        for i, s in enumerate(self.cfg.groups["canOutputs"]):
            if s["enabled"]:
                self._canout_sample[i] = V[int(s["input"])]
        for j, fr in enumerate(self._frames):
            if self.time_ms < fr["next_tx"]:
                continue
            fr["next_tx"] = self.time_ms + fr["interval"]
            for i, s in enumerate(self.cfg.groups["canOutputs"]):
                if self._assigned[i] != j:
                    continue
                encode_float(fr["data"], V[int(s["input"])], int(s["startBit"]),
                             int(s["bitLength"]), float(s["factor"]),
                             float(s["offset"]), int(s["byteOrder"]))
            self.tx.append((fr["id"], fr["dlc"], list(fr["data"])))

    # -- observation -----------------------------------------------------
    def observe(self) -> Dict[str, float]:
        """The externally visible state, keyed by *physical* identity.

        Outputs are keyed by output number (a physical pin, not renumberable).
        CAN outputs are keyed by (id, startBit, bitLength) -- their placement on
        the bus -- not by slot, so slots are free to be reassigned.
        """
        b, V = self.b, self.var
        o: Dict[str, float] = {}
        for i in range(1, b.num_outputs + 1):
            o[f"out{i}"] = V[b.index(f"Out{i}Active")]
        for i, s in enumerate(self.cfg.groups["canOutputs"]):
            if not s["enabled"]:
                continue
            key = (f"can:{int(s['ide'])}:{int(s['id']):#x}"
                   f":{int(s['startBit'])}:{int(s['bitLength'])}")
            o[key] = self._canout_sample[i]
        return o

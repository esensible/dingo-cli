"""Board definitions and var-map layout.

Transcribed from dingoFW:
  - boards/<variant>/port.h            (the NUM_* / VAR_MAP_* counts)
  - core/device.cpp  InitVarMap()      (the *order* the slots are laid out in)

InitVarMap() order is the authority, NOT the VAR_MAP_SIZE macro (the macro is a
sum, so its term order is meaningless; pt-dpdm4_1 and dingopdmmax_v1 list canIn
before analogIn in the macro but InitVarMap always does analog first).

Order, per core/device.cpp:
    sys vars, digIn, digOut, analogIn(x4), canIn(x2), virtIn,
    outputs(x4), flashers, conditions, counters, wiper(6), keypads

Sys vars are conditional:
    [0] AlwaysFalse, [1] AlwaysTrue, [2] State,
    [3] BoardTemp   (only if HAS_EXT_TEMP_SENSOR),
    [4] BattVolt    (only if HAS_BATT_VOLT_SENSE)
so VAR_MAP_SYS_VARS is 5 on the PDMs and 3 on canboard_v2.
"""

from dataclasses import dataclass, field
from typing import Dict, List


@dataclass
class Board:
    name: str
    pdm_type: int          # PDM_TYPE, or -1 where the board has none (canboard)
    sys_vars: int
    num_dig_inputs: int
    num_dig_outputs: int
    num_analog_inputs: int
    num_can_inputs: int
    num_can_outputs: int
    num_virt_inputs: int
    num_outputs: int
    num_flashers: int
    num_conditions: int
    num_counters: int
    wiper_vars: int
    num_keypads: int
    keypad_buttons: int = 0
    keypad_dials: int = 0
    keypad_analogs: int = 0

    names: List[str] = field(default_factory=list, repr=False)
    by_name: Dict[str, int] = field(default_factory=dict, repr=False)
    base: Dict[str, int] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        n: List[str] = []
        base: Dict[str, int] = {}

        def block(key: str, items):
            base[key] = len(n)
            n.extend(items)

        sysnames = ["AlwaysFalse", "AlwaysTrue", "State", "BoardTemp", "BattVolt"]
        block("sys", sysnames[: self.sys_vars])
        block("digIn", [f"DigIn{i}" for i in range(1, self.num_dig_inputs + 1)])
        block("digOut", [f"DigOut{i}" for i in range(1, self.num_dig_outputs + 1)])
        block(
            "analogIn",
            [
                s
                for i in range(1, self.num_analog_inputs + 1)
                for s in (
                    f"Analog{i}Val",
                    f"Analog{i}mV",
                    f"Analog{i}Rotary",
                    f"Analog{i}Switch",
                )
            ],
        )
        block(
            "canIn",
            [
                s
                for i in range(1, self.num_can_inputs + 1)
                for s in (f"CanIn{i}Out", f"CanIn{i}Val")
            ],
        )
        block("virtIn", [f"VirtIn{i}" for i in range(1, self.num_virt_inputs + 1)])
        block(
            "output",
            [
                s
                for i in range(1, self.num_outputs + 1)
                for s in (
                    f"Out{i}Active",
                    f"Out{i}Current",
                    f"Out{i}Overcurrent",
                    f"Out{i}Fault",
                )
            ],
        )
        block("flasher", [f"Flasher{i}" for i in range(1, self.num_flashers + 1)])
        block("condition", [f"Cond{i}" for i in range(1, self.num_conditions + 1)])
        block("counter", [f"Counter{i}" for i in range(1, self.num_counters + 1)])
        block(
            "wiper",
            [
                "WiperSlowOut",
                "WiperFastOut",
                "WiperParkOut",
                "WiperInterOut",
                "WiperWashOut",
                "WiperSwipeOut",
            ][: self.wiper_vars],
        )
        kp = []
        for k in range(1, self.num_keypads + 1):
            kp += [f"Keypad{k}Button{b}" for b in range(1, self.keypad_buttons + 1)]
            kp += [f"Keypad{k}Dial{d}" for d in range(1, self.keypad_dials + 1)]
            kp += [f"Keypad{k}Analog{a}" for a in range(1, self.keypad_analogs + 1)]
        block("keypad", kp)

        self.names = n
        self.base = base
        self.by_name = {s.lower(): i for i, s in enumerate(n)}

    @property
    def size(self) -> int:
        return len(self.names)

    def index(self, name: str) -> int:
        return self.by_name[name.strip().lower()]

    def label(self, idx: int) -> str:
        if 0 <= idx < len(self.names):
            return self.names[idx]
        return f"<oob {idx}>"


_PDM_KEYPAD = dict(num_keypads=2, keypad_buttons=20, keypad_dials=2, keypad_analogs=4)

BOARDS: Dict[str, Board] = {}


def _reg(b: Board) -> Board:
    BOARDS[b.name] = b
    return b


# dingoFW/boards/dingopdm_v7/port.h   VAR_MAP_SIZE = 217
DINGOPDM_V7 = _reg(
    Board(
        name="dingopdm_v7",
        pdm_type=0,
        sys_vars=5,
        num_dig_inputs=2,
        num_dig_outputs=0,
        num_analog_inputs=0,
        num_can_inputs=32,
        num_can_outputs=32,
        num_virt_inputs=16,
        num_outputs=8,
        num_flashers=4,
        num_conditions=32,
        num_counters=4,
        wiper_vars=6,
        **_PDM_KEYPAD,
    )
)

# dingoFW/boards/dingopdmmax_v1/port.h   VAR_MAP_SIZE = 201
DINGOPDMMAX_V1 = _reg(
    Board(
        name="dingopdmmax_v1",
        pdm_type=1,
        sys_vars=5,
        num_dig_inputs=2,
        num_dig_outputs=0,
        num_analog_inputs=0,
        num_can_inputs=32,
        num_can_outputs=32,
        num_virt_inputs=16,
        num_outputs=4,
        num_flashers=4,
        num_conditions=32,
        num_counters=4,
        wiper_vars=6,
        **_PDM_KEYPAD,
    )
)

# dingoFW/boards/pt-dpdm4_1/port.h   VAR_MAP_SIZE = 209
PT_DPDM4_1 = _reg(
    Board(
        name="pt-dpdm4_1",
        pdm_type=2,
        sys_vars=5,
        num_dig_inputs=2,
        num_dig_outputs=0,
        num_analog_inputs=2,
        num_can_inputs=32,
        num_can_outputs=32,
        num_virt_inputs=16,
        num_outputs=4,
        num_flashers=4,
        num_conditions=32,
        num_counters=4,
        wiper_vars=6,
        **_PDM_KEYPAD,
    )
)

# dingoFW/boards/canboard_v2/port.h   VAR_MAP_SIZE = 75
CANBOARD_V2 = _reg(
    Board(
        name="canboard_v2",
        pdm_type=-1,
        sys_vars=3,
        num_dig_inputs=8,
        num_dig_outputs=4,
        num_analog_inputs=5,
        num_can_inputs=8,
        num_can_outputs=8,
        num_virt_inputs=8,
        num_outputs=0,
        num_flashers=4,
        num_conditions=8,
        num_counters=4,
        wiper_vars=0,
        num_keypads=0,
    )
)

BY_PDM_TYPE = {b.pdm_type: b for b in BOARDS.values() if b.pdm_type >= 0}

# Pins the firmware exposes as constants; these are *ground truth anchors* used by
# selftest.py. Each entry is (board, var name, expected index) and was read off
# port.h + InitVarMap by hand.
ANCHORS = [
    ("dingopdm_v7", "AlwaysFalse", 0),
    ("dingopdm_v7", "AlwaysTrue", 1),
    ("dingopdm_v7", "DigIn1", 5),
    ("dingopdm_v7", "CanIn1Out", 7),
    ("dingopdm_v7", "VirtIn1", 71),
    ("dingopdm_v7", "Out1Active", 87),
    ("dingopdm_v7", "Flasher1", 119),
    ("dingopdm_v7", "Cond1", 123),
    ("dingopdm_v7", "Counter1", 155),
    ("dingopdm_v7", "WiperSlowOut", 159),
    ("dingopdmmax_v1", "VirtIn1", 71),
    ("dingopdmmax_v1", "Cond1", 107),
    ("dingopdmmax_v1", "Counter1", 139),
    ("pt-dpdm4_1", "VirtIn1", 79),
    ("pt-dpdm4_1", "Cond1", 115),
    ("pt-dpdm4_1", "Counter1", 147),
    ("canboard_v2", "VirtIn1", 51),
    ("canboard_v2", "Cond1", 63),
    ("canboard_v2", "Counter1", 71),
]

SIZES = {
    "dingopdm_v7": 217,
    "dingopdmmax_v1": 201,
    "pt-dpdm4_1": 209,
    "canboard_v2": 75,
}

"""Input traces: config-independent stimulus.

A trace describes what happens at the *device boundary* -- digital input pin
levels and CAN frames on the wire. It never names a canInput slot or a var-map
index, so the same trace drives two configs that number their slots completely
differently. That is what makes it usable as an equivalence oracle.

Format (JSON):

{
  "name": "engine gesture: start then stop",
  "buses": {"0x642": {"dlc": 8}},        # optional; frames default to 8 bytes
  "steps": [
    {"ms": 200, "pins": {"1": 0, "2": 0}, "bits": {"0x642:32": 0}},
    {"ms": 100, "bits": {"0x642:0": 1}},
    ...
  ]
}

  ms     duration of the step (rounded up to whole 2 ms cycles); "cycles" also
         accepted for exact cycle counts
  pins   physical digital-input pin level, 1-based, BEFORE inversion. Sticky.
  bits   "<canid>:<startbit>" -> 0/1. Sticky. Every named CAN id is
         transmitted once per cycle with its current payload, which is the
         normal case for a CANBoard-style periodic broadcast.
  bytes  "<canid>" -> [b0..b7], for traces that need whole payloads. Sticky.
  quiet  list of CAN ids to STOP transmitting from this step on (for exercising
         canInput timeouts).
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

from dingosim import CYCLE_MS


def _parse_id(s: str) -> int:
    s = s.strip()
    return int(s, 16) if s.lower().startswith("0x") else int(s)


class Trace:
    def __init__(self, doc: Dict[str, Any]):
        self.name = doc.get("name", "trace")
        self.steps = doc["steps"]
        self.doc = doc

    @classmethod
    def load(cls, path: str) -> "Trace":
        with open(path) as fh:
            return cls(json.load(fh))

    def cycles(self) -> Iterator[Tuple[Dict[int, int],
                                       List[Tuple[int, List[int]]],
                                       str]]:
        """Yield (pins, rx_frames, label) once per 2 ms cycle."""
        pins: Dict[int, int] = {}
        payloads: Dict[int, List[int]] = {}
        silent: set = set()
        for step in self.steps:
            for k, v in (step.get("pins") or {}).items():
                pins[int(k)] = int(v)
            for k, v in (step.get("bits") or {}).items():
                sid, bit = k.split(":")
                cid, b = _parse_id(sid), int(bit)
                buf = payloads.setdefault(cid, [0] * 8)
                if int(v):
                    buf[b // 8] |= 1 << (b % 8)
                else:
                    buf[b // 8] &= ~(1 << (b % 8)) & 0xFF
            for k, v in (step.get("bytes") or {}).items():
                payloads[_parse_id(k)] = list(v) + [0] * (8 - len(v))
            for cid in step.get("quiet") or []:
                silent.add(_parse_id(cid))
            for cid in step.get("loud") or []:
                silent.discard(_parse_id(cid))

            if "cycles" in step:
                n = int(step["cycles"])
            else:
                ms = int(step.get("ms", CYCLE_MS))
                n = max(1, (ms + CYCLE_MS - 1) // CYCLE_MS)
            label = step.get("label", "")
            frames = [(cid, list(buf)) for cid, buf in payloads.items()
                      if cid not in silent]
            for _ in range(n):
                yield dict(pins), frames, label


def run(sim, trace: Trace, observe_every: int = 1) -> List[Dict[str, Any]]:
    """Run a trace and return the per-cycle observation log."""
    log = []
    for i, (pins, frames, label) in enumerate(trace.cycles()):
        sim.step(pins=pins, rx_frames=frames)
        if i % observe_every == 0:
            obs = sim.observe()
            obs["_cycle"] = i
            obs["_ms"] = sim.time_ms
            obs["_label"] = label
            log.append(obs)
    return log

#!/usr/bin/env python3
"""Print a config's observable transitions under a trace -- the readable form.

    ./show.py ../corpus/engine-repin.json ../corpus/traces/engine-gesture.json
    ./show.py cfg.json trace.json --vars VirtIn1 Cond1 Counter1
"""
from __future__ import annotations

import argparse
import sys

from dingosim import Sim, Unsupported, load_device
from trace import Trace


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("trace")
    ap.add_argument("--board", default=None)
    ap.add_argument("--base", type=lambda s: int(s, 0), default=None)
    ap.add_argument("--vars", nargs="*", default=[],
                    help="extra internal var-map names to show")
    ap.add_argument("--policy", default="firmware")
    args = ap.parse_args()

    try:
        sim = Sim(load_device(args.config, board_name=args.board,
                              base_id=args.base, default_policy=args.policy))
    except Unsupported as e:
        print(f"REFUSED: {e}")
        return 2
    tr = Trace.load(args.trace)
    extra = [(v, sim.b.index(v)) for v in args.vars]

    prev = None
    for i, (pins, frames, label) in enumerate(tr.cycles()):
        sim.step(pins=pins, rx_frames=frames)
        obs = sim.observe()
        for name, idx in extra:
            obs[name] = sim.var[idx]
        if obs != prev:
            cells = " ".join(f"{k}={v:g}" for k, v in sorted(obs.items()))
            print(f"{sim.time_ms:7d}ms c{i:<6d} {label[:40]:40s} {cells}")
            prev = obs
    return 0


if __name__ == "__main__":
    sys.exit(main())

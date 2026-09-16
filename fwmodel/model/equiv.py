#!/usr/bin/env python3
"""Semantic-equivalence checker for two dingoConfig documents.

    ./equiv.py a.json b.json --trace t1.json [t2.json ...]
    ./equiv.py a.json --self-contained --trace t1.json
    ./equiv.py a.json --dump --trace t1.json

Equivalence, precisely
----------------------
A and B are *observationally equivalent under trace set T* iff, for every trace
in T, running both from power-on reset produces the same observation vector on
every 2 ms cycle. The observation vector is:

  * out<n> for every physical output n  -- output number is a PIN, not a slot,
    so it is part of the contract and may not be renumbered.
  * can:<ide>:<id>:<startBit>:<bitLength> -- the value a CAN output places on
    the bus, keyed by its position in the frame rather than by its slot index.

Everything else is free: virtual input / condition / counter / flasher SLOT
numbers, the presence of redundant pass-through virtual inputs, names, and any
internal signal that does not reach a pin or the bus.

`--tolerance N` allows B to lag or lead A by up to N cycles on each signal
independently (report shows the alignment used). Default 0 -- use a non-zero
tolerance only when you have decided a pipeline-depth difference is acceptable,
and say so in the review; a one-cycle difference at 2 ms is invisible in a
vehicle but it is also the signature of a wrong slot ordering, so a clean 0 is
much better evidence than a tolerated 1.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List

from dingosim import Sim, Unsupported, load_device
from trace import Trace, run


def _load(path: str, board: str | None, base_id: int | None, policy: str) -> Sim:
    cfg = load_device(path, board_name=board, base_id=base_id,
                      default_policy=policy)
    return Sim(cfg)


def compare(log_a: List[Dict[str, Any]], log_b: List[Dict[str, Any]],
            tolerance: int = 0, limit: int = 20):
    keys = sorted((set(log_a[0]) | set(log_b[0])) - {"_cycle", "_ms", "_label"})
    only_a = sorted(set(log_a[0]) - set(log_b[0]) - {"_cycle", "_ms", "_label"})
    only_b = sorted(set(log_b[0]) - set(log_a[0]) - {"_cycle", "_ms", "_label"})
    diffs = []
    for k in keys:
        if k in only_a or k in only_b:
            diffs.append({"signal": k, "kind": "missing",
                          "detail": "present only in A" if k in only_a
                          else "present only in B"})
            continue
        a = [r[k] for r in log_a]
        b = [r[k] for r in log_b]
        n = min(len(a), len(b))
        best = None
        # try shift 0 first so a tie always resolves to "no lag"
        order = [0] + [x for x in range(-tolerance, tolerance + 1) if x]
        for shift in order:
            bad = []
            for i in range(n):
                j = i + shift
                if j < 0 or j >= n:
                    continue
                if a[i] != b[j]:
                    bad.append(i)
            if best is None or len(bad) < len(best[1]):
                best = (shift, bad)
            if not bad:
                break
        shift, bad = best
        if bad:
            diffs.append({
                "signal": k, "kind": "mismatch", "shift": shift,
                "count": len(bad),
                "first": [{"cycle": log_a[i]["_cycle"], "ms": log_a[i]["_ms"],
                           "label": log_a[i]["_label"], "a": a[i],
                           "b": b[i + shift] if 0 <= i + shift < n else None}
                          for i in bad[:limit]],
            })
        elif shift != 0:
            diffs.append({"signal": k, "kind": "lag", "shift": shift,
                          "count": 0})
    return diffs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("a")
    ap.add_argument("b", nargs="?")
    ap.add_argument("--trace", nargs="+", required=True)
    ap.add_argument("--board", default=None)
    ap.add_argument("--board-b", default=None)
    ap.add_argument("--base", type=lambda s: int(s, 0), default=None)
    ap.add_argument("--base-b", type=lambda s: int(s, 0), default=None)
    ap.add_argument("--tolerance", type=int, default=0)
    ap.add_argument("--self-contained", action="store_true",
                    help="compare A against itself under the adversarial "
                         "default policy: detects fields the document leaves "
                         "to whatever the device already had")
    ap.add_argument("--dump", action="store_true",
                    help="print A's observation log as JSON and exit")
    args = ap.parse_args()

    if args.dump:
        for t in args.trace:
            sim = _load(args.a, args.board, args.base, "firmware")
            log = run(sim, Trace.load(t))
            print(json.dumps({"trace": t, "log": log}, indent=1))
        return 0

    if args.self_contained:
        b_path, b_policy = args.a, "adversarial"
    elif args.b:
        b_path, b_policy = args.b, "firmware"
    else:
        ap.error("need a second config, or --self-contained, or --dump")

    failed = 0
    for t in args.trace:
        tr = Trace.load(t)
        try:
            sa = _load(args.a, args.board, args.base, "firmware")
            sb = _load(b_path, args.board_b or args.board,
                       args.base_b if args.base_b is not None else args.base,
                       b_policy)
        except Unsupported as e:
            print(f"REFUSED  {t}: {e}")
            failed += 1
            continue
        la, lb = run(sa, tr), run(sb, tr)
        diffs = compare(la, lb, args.tolerance)
        if not diffs:
            print(f"PASS     {t}  ({len(la)} cycles, "
                  f"{len(la[0]) - 3} observed signals)")
        else:
            failed += 1
            print(f"FAIL     {t}")
            for d in diffs:
                if d["kind"] == "mismatch":
                    print(f"  {d['signal']}: {d['count']} differing cycles"
                          + (f" (best shift {d['shift']})" if d["shift"] else ""))
                    for f in d["first"][:5]:
                        print(f"    cycle {f['cycle']:5d} @{f['ms']:6d}ms "
                              f"{f['label'][:34]:34s} A={f['a']} B={f['b']}")
                elif d["kind"] == "missing":
                    print(f"  {d['signal']}: {d['detail']}")
                    if args.self_contained:
                        print("    -> the document leaves this slot unwritten, "
                              "so dingo-cli sends nothing for it and the device "
                              "keeps its previous config. Emit every slot.")
                else:
                    print(f"  {d['signal']}: {d['kind']} {d.get('detail','')}"
                          f" {d.get('shift','')}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

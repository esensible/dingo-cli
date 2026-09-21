#!/usr/bin/env python3
"""Cross-check the host-compiled firmware against the Python model.

Runs fwmodel's Sim and build/fwhost over the same (config, trace) pairs and
reports every cycle where the observation vectors differ.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FWHOST = os.path.join(HERE, "build", "fwhost")
MODEL = os.environ.get("FWMODEL", os.path.join(HERE, os.pardir, "fwmodel", "model"))
CORPUS = os.path.abspath(os.path.join(MODEL, os.pardir, "corpus"))

sys.path.insert(0, MODEL)
import dingosim            # noqa: E402
import trace as tracemod   # noqa: E402


def py_run(cfg_path, trace_path, base_id=None):
    dev = dingosim.load_device(cfg_path, base_id=base_id)
    sim = dingosim.Sim(dev)
    tr = tracemod.Trace.load(trace_path)
    out = []
    for i, (pins, frames, label) in enumerate(tr.cycles()):
        sim.step(pins=pins, rx_frames=frames)
        obs = sim.observe()
        out.append((i, sim.time_ms - dingosim.CYCLE_MS, label, obs))
    return out


def cpp_run(cfg_path, trace_path, base_id=None):
    cmd = [FWHOST, cfg_path, trace_path]
    if base_id is not None:
        cmd += ["--base", str(base_id)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"fwhost failed: {p.stderr}")
    rows = []
    for line in p.stdout.splitlines():
        d = json.loads(line)
        if "_meta" in d:
            continue
        rows.append((d["cycle"], d["ms"], d["label"], d["obs"]))
    return rows, p.stderr


def compare(cfg_path, trace_path, base_id=None, limit=6, skip_cycle0_can=True):
    py = py_run(cfg_path, trace_path, base_id)
    cpp, stderr = cpp_run(cfg_path, trace_path, base_id)
    diffs = []
    n = min(len(py), len(cpp))
    if len(py) != len(cpp):
        diffs.append(("LENGTH", f"python {len(py)} cycles, fwhost {len(cpp)}"))
    for i in range(n):
        _, ms, label, pobs = py[i]
        _, _, _, cobs = cpp[i]
        keys = set(pobs) | set(cobs)
        for k in sorted(keys):
            pv = pobs.get(k)
            cv = cobs.get(k)
            if cv is None and k.startswith("can:") and i == 0 and skip_cycle0_can:
                continue          # firmware posts no frame on the very first cycle
            if pv is None or cv is None:
                diffs.append((i, f"{k}: python={pv} fwhost={cv} (ms={ms} {label})"))
            elif abs(float(pv) - float(cv)) > 1e-9:
                diffs.append((i, f"{k}: python={pv} fwhost={cv} (ms={ms} {label})"))
    return diffs, stderr, len(py)


CASES = [
    ("engine-repin.json", "engine-gesture.json", None),
    ("engine-repin.json", "engine-stop-hazard.json", None),
    ("engine-repin.json", "can-quiet.json", None),
    ("engine-repin-reference.json", "engine-gesture.json", None),
    ("engine-repin-reference.json", "engine-stop-hazard.json", None),
    ("engine-repin-reference.json", "can-quiet.json", None),
    ("engine-wipers-off.json", "engine-gesture.json", None),
    ("lights-repin.json", "lights-stalk.json", None),
    ("lights-repin.json", "can-quiet.json", None),
    ("adversarial/a1-nand-s0-right.json", "abc-truthtable.json", None),
    ("adversarial/a1-nand-s0-wrong.json", "abc-truthtable.json", None),
    ("adversarial/a1-nand-s0-reference.json", "abc-truthtable.json", None),
    ("adversarial/a3-slotorder-right.json", "abc-truthtable.json", None),
    ("adversarial/a3-slotorder-wrong.json", "abc-truthtable.json", None),
    ("adversarial/a4-latch-vi-mode.json", "abc-truthtable.json", None),
    ("adversarial/a4-latch-counter.json", "abc-truthtable.json", None),
    ("adversarial/a4-latch-wrap-toggle.json", "abc-truthtable.json", None),
    ("adversarial/a5-counter-bounds.json", "abc-truthtable.json", None),
]


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    total_bad = 0
    for cfg, tr, base in CASES:
        if only and only not in cfg and only not in tr:
            continue
        cfg_path = os.path.join(CORPUS, cfg)
        tr_path = os.path.join(CORPUS, "traces", tr)
        name = f"{cfg} x {tr}"
        try:
            diffs, stderr, ncyc = compare(cfg_path, tr_path, base)
        except Exception as e:
            print(f"ERROR {name}: {e}")
            total_bad += 1
            continue
        if not diffs:
            print(f"ok   {name}  ({ncyc} cycles)")
        else:
            total_bad += 1
            print(f"DIFF {name}  ({ncyc} cycles, {len(diffs)} differing observations)")
            seen = set()
            shown = 0
            for c, msg in diffs:
                sig = msg.split(":")[0]
                if sig in seen and shown > 12:
                    continue
                seen.add(sig)
                print(f"       cycle {c}: {msg}")
                shown += 1
                if shown > 24:
                    print("       ...")
                    break
        if stderr.strip():
            for l in stderr.strip().splitlines():
                print(f"       [fwhost] {l}")
    print()
    print("cases with differences:", total_bad, "of", len(CASES))
    return 1 if total_bad else 0


if __name__ == "__main__":
    sys.exit(main())

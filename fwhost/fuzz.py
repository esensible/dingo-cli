#!/usr/bin/env python3
"""Randomised differential test: host-compiled dingoFW vs the Python model.

Generates random dingopdm_v7 configs (restricted to the feature subset the
Python model claims to cover) and random boundary traces, runs both, and
reports the first divergence per case.
"""
import json
import os
import random
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FWHOST = os.path.join(HERE, "build", "fwhost")
sys.path.insert(0, os.environ.get(
    "FWMODEL", os.path.join(HERE, os.pardir, "fwmodel", "model")))
import dingosim          # noqa: E402
import trace as tracemod  # noqa: E402

N_CANIN, N_VI, N_COND, N_CTR, N_FL, N_OUT, N_CANOUT = 32, 16, 32, 4, 4, 8, 32
IDX_DIGIN = [5, 6]
IDX_CANIN_OUT = [7 + 2 * i for i in range(N_CANIN)]
IDX_CANIN_VAL = [8 + 2 * i for i in range(N_CANIN)]
IDX_VI = [71 + i for i in range(N_VI)]
IDX_OUT_ACTIVE = [87 + 4 * i for i in range(N_OUT)]
IDX_FL = [119 + i for i in range(N_FL)]
IDX_COND = [123 + i for i in range(N_COND)]
IDX_CTR = [155 + i for i in range(N_CTR)]

# Vars the Python model will accept as inputs (it refuses analogue-derived ones).
BOOLISH = [0, 1] + IDX_DIGIN + IDX_CANIN_OUT[:8] + IDX_VI[:8] + \
          IDX_OUT_ACTIVE + IDX_FL + IDX_COND[:8] + IDX_CTR
NUMERIC = IDX_CANIN_VAL[:8] + IDX_CTR + IDX_COND[:8]

IDS = [0x100, 0x101, 0x200]


def gen_config(rnd, name):
    canIn = []
    for i in range(N_CANIN):
        if i < 8:
            op = rnd.randrange(0, 8)
            sgn = rnd.random() < 0.2
            if op in (6, 7):
                sgn = False   # KNOWN DIVERGENCE #4: (uint32_t)negative-float is UB
            canIn.append(dict(
                enabled=True, timeoutEnabled=rnd.random() < 0.3,
                timeout=rnd.choice([100, 500, 1000]), ide=0,
                id=rnd.choice(IDS), startBit=rnd.randrange(0, 56),
                bitLength=rnd.choice([1, 1, 1, 4, 8, 16]),
                factor=rnd.choice([1.0, 1.0, 0.5, 2.0]), offset=0.0,
                byteOrder=rnd.choice([0, 0, 0, 1]), signed=sgn,
                operator=op, operand=float(rnd.choice([0, 1, 2, 15])),
                mode=rnd.choice([0, 0, 0, 1])))
        else:
            canIn.append(dict(enabled=False, timeoutEnabled=False, timeout=1000,
                              ide=0, id=0, startBit=0, bitLength=8, factor=1.0,
                              offset=0.0, byteOrder=0, signed=False, operator=0,
                              operand=0.0, mode=0))

    vis = []
    for i in range(N_VI):
        on = i < 8
        vis.append(dict(enabled=on, not0=rnd.random() < 0.3,
                        var0=rnd.choice(BOOLISH) if on else 0,
                        cond0=rnd.randrange(0, 3), not1=rnd.random() < 0.3,
                        var1=rnd.choice(BOOLISH) if on else 0,
                        cond1=rnd.randrange(0, 3), not2=rnd.random() < 0.3,
                        var2=(rnd.choice(BOOLISH) if rnd.random() < 0.5 else 0) if on else 0,
                        mode=rnd.choice([0, 0, 0, 1])))

    conds = []
    for i in range(N_COND):
        on = i < 8
        # operator 7 (BitwiseNand) is excluded here: it is a known, separately
        # reported divergence and would swamp everything else.
        conds.append(dict(enabled=on, input=rnd.choice(NUMERIC + BOOLISH) if on else 0,
                          operator=rnd.choice([0, 1, 2, 3, 4, 5, 6]) if on else 0,
                          arg=float(rnd.choice([0, 1, 2, 3, 15]))))

    ctrs = []
    for i in range(N_CTR):
        # KNOWN DIVERGENCE #3: a counter whose own output feeds one of its three
        # inputs.  Excluded so the fuzzer can look for anything else.
        own = IDX_CTR[i]
        pool = [v for v in BOOLISH if v != own]
        ctrs.append(dict(enabled=True, incInput=rnd.choice(pool),
                         decInput=rnd.choice(pool + [0, 0]),
                         resetInput=rnd.choice(pool + [0, 0]),
                         minCount=rnd.choice([0, 0, 1]),
                         maxCount=rnd.choice([1, 2, 3, 5, 10]),
                         incEdge=rnd.randrange(0, 3), decEdge=rnd.randrange(0, 3),
                         resetEdge=rnd.randrange(0, 3),
                         wrapAround=rnd.random() < 0.5,
                         holdToReset=rnd.random() < 0.3,
                         resetTime=rnd.choice([50, 200, 2000])))

    fls = [dict(enabled=True, input=rnd.choice(BOOLISH),
                onTime=rnd.choice([10, 50, 350]), offTime=rnd.choice([10, 50, 350]),
                single=rnd.random() < 0.5) for _ in range(N_FL)]

    outs = []
    for i in range(N_OUT):
        outs.append(dict(enabled=True, input=rnd.choice(BOOLISH),
                         currentLimit=20.0, inrushCurrentLimit=50.0,
                         inrushTime=1000, resetMode=0, resetTime=1000,
                         resetCountLimit=3, pwmEnabled=False,
                         softStartEnabled=False, variableDutyCycle=False,
                         dutyCycleInput=0, fixedDutyCycle=100, frequency=100,
                         softStartRampTime=0, dutyCycleDenominator=100,
                         minDutyCycle=0, primaryOutput=-1))

    cos = []
    for i in range(N_CANOUT):
        on = i < 6
        cos.append(dict(enabled=on, input=rnd.choice(BOOLISH) if on else 0, ide=0,
                        id=0x300 + rnd.randrange(0, 2),
                        startBit=i * 8 if on else 0, bitLength=8,
                        factor=1.0, offset=0.0, byteOrder=0, signed=True,
                        interval=100))

    digin = [dict(enabled=True, mode=rnd.choice([0, 0, 1]),
                  invert=rnd.random() < 0.5,
                  debounceTime=rnd.choice([0, 4, 20]), pull=0) for _ in range(2)]

    return {"PdmDevices": [dict(
        pdmType=0, name=name, baseId=512, sleepEnabled=False,
        filtersEnabled=False, connectUsbToCan=True, bitrate=1,
        inputs=digin, outputs=outs, canInputs=canIn, canOutputs=cos,
        virtualInputs=vis, conditions=conds, counters=ctrs, flashers=fls)]}


def gen_trace(rnd, nsteps=60):
    steps = []
    for _ in range(nsteps):
        st = {"ms": rnd.choice([2, 4, 10, 20, 60, 200])}
        if rnd.random() < 0.7:
            st["pins"] = {str(rnd.choice([1, 2])): rnd.randrange(0, 2)}
        if rnd.random() < 0.9:
            cid = rnd.choice(IDS)
            if rnd.random() < 0.4:
                st["bytes"] = {hex(cid): [rnd.randrange(0, 256) for _ in range(8)]}
            else:
                st["bits"] = {f"{hex(cid)}:{rnd.randrange(0, 56)}": rnd.randrange(0, 2)
                              for _ in range(rnd.randrange(1, 4))}
        if rnd.random() < 0.08:
            st["quiet"] = [hex(rnd.choice(IDS))]
        if rnd.random() < 0.08:
            st["loud"] = [hex(rnd.choice(IDS))]
        steps.append(st)
    return {"name": "fuzz", "steps": steps}


def run_case(seed, tmpdir):
    rnd = random.Random(seed)
    cfg = gen_config(rnd, f"fuzz{seed}")
    tr = gen_trace(rnd)
    cfg_p = os.path.join(tmpdir, f"cfg{seed}.json")
    tr_p = os.path.join(tmpdir, f"tr{seed}.json")
    json.dump(cfg, open(cfg_p, "w"))
    json.dump(tr, open(tr_p, "w"))

    try:
        dev = dingosim.load_device(cfg_p)
        sim = dingosim.Sim(dev)
    except dingosim.Unsupported as e:
        return ("skip", str(e), cfg_p, tr_p)
    t = tracemod.Trace.load(tr_p)
    py = []
    for pins, frames, label in t.cycles():
        sim.step(pins=pins, rx_frames=frames)
        py.append(sim.observe())

    p = subprocess.run([FWHOST, cfg_p, tr_p], capture_output=True, text=True)
    if p.returncode != 0:
        return ("error", p.stderr.strip()[:300], cfg_p, tr_p)
    cpp = []
    for line in p.stdout.splitlines():
        d = json.loads(line)
        if "_meta" not in d:
            cpp.append(d["obs"])

    for i in range(min(len(py), len(cpp))):
        for k in sorted(set(py[i]) | set(cpp[i])):
            pv, cv = py[i].get(k), cpp[i].get(k)
            if cv is None and k.startswith("can:") and i == 0:
                continue
            if pv is None or cv is None or abs(float(pv) - float(cv)) > 1e-9:
                if i == 0 and not k.startswith("can:"):
                    tag = "cycle0"
                else:
                    tag = "diff"
                return (tag, f"cycle {i} {k}: python={pv} fwhost={cv}", cfg_p, tr_p)
    return ("ok", "", cfg_p, tr_p)


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    keep = os.path.join(HERE, "fuzzfail")
    os.makedirs(keep, exist_ok=True)
    counts = {}
    firsts = {}
    tmpdir = tempfile.mkdtemp()
    for seed in range(n):
        tag, msg, cfg_p, tr_p = run_case(seed, tmpdir)
        counts[tag] = counts.get(tag, 0) + 1
        if tag in ("diff", "error") and tag not in firsts:
            firsts[tag] = (seed, msg)
        if tag == "diff":
            import shutil
            shutil.copy(cfg_p, os.path.join(keep, f"seed{seed}-cfg.json"))
            shutil.copy(tr_p, os.path.join(keep, f"seed{seed}-trace.json"))
            print(f"seed {seed}: {msg}")
        elif tag == "error":
            print(f"seed {seed}: ERROR {msg}")
    print()
    for k in sorted(counts):
        print(f"{k:8s} {counts[k]}")


if __name__ == "__main__":
    main()

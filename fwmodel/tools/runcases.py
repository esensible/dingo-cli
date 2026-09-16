#!/usr/bin/env python3
"""Run the model's regression suite and print a pass/fail table.

    ./runcases.py            # run everything
    ./runcases.py -v         # show output for passing cases too

Every case is an assertion about the MODEL, not about any particular config
tool: either "these two configs behave identically" or "these two configs do
NOT behave identically". The negative cases matter as much as the positive
ones -- an oracle that says everything is equivalent is useless, so the
adversarial pairs check that the model actually discriminates.

Cases are declared here, not discovered, so a missing file is a failure rather
than a silent skip.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                     ".."))
MODEL = os.path.join(ROOT, "model")
CORPUS = os.path.join(ROOT, "corpus")
ADV = os.path.join(CORPUS, "adversarial")
TR = os.path.join(CORPUS, "traces")


def sh(args, cwd=MODEL):
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def equiv(a, b, *traces, tolerance=0, self_contained=False):
    cmd = [sys.executable, os.path.join(MODEL, "equiv.py"), a]
    if not self_contained:
        cmd.append(b)
    else:
        cmd.append("--self-contained")
    cmd += ["--trace", *traces, "--tolerance", str(tolerance)]
    return sh(cmd)


ENGINE_TRACES = [os.path.join(TR, t) for t in
                 ("engine-gesture.json", "engine-stop-hazard.json",
                  "can-quiet.json")]
ABC = os.path.join(TR, "abc-truthtable.json")

RESULTS = []


def case(name, want, rc, out, note=""):
    ok = (rc == 0) if want == "pass" else (rc != 0)
    RESULTS.append((ok, name, want, note, out))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    rc, out = sh([sys.executable, os.path.join(MODEL, "selftest.py")])
    case("model self-test vs firmware source", "pass", rc, out)

    # --- a heavily-rewritten config is still the same program --------------
    rc, out = equiv(os.path.join(CORPUS, "engine-repin.json"),
                    os.path.join(CORPUS, "engine-repin-reference.json"),
                    *ENGINE_TRACES)
    case("engine-repin == engine-repin-reference (renumbered, "
         "Rising-reset rewrite)", "pass", rc, out)

    rc, out = equiv(os.path.join(CORPUS, "engine-repin-reference.json"), None,
                    *ENGINE_TRACES, self_contained=True)
    case("reference is self-contained (no reliance on prior device state)",
         "pass", rc, out)

    rc, out = equiv(os.path.join(CORPUS, "engine-repin.json"), None,
                    ENGINE_TRACES[0], self_contained=True)
    case("deployed engine-repin is NOT self-contained (28 unwritten "
         "canOutputs)", "fail", rc, out,
         "documents a known gap in the hand-written config, not a regression")

    # --- adversarial: logic lowering ---------------------------------------
    rc, out = equiv(os.path.join(ADV, "a1-nand-s0-right.json"),
                    os.path.join(ADV, "a1-nand-s0-reference.json"), ABC)
    case("A1 two-slot !(A&B)&C == De Morgan encoding", "pass", rc, out)

    rc, out = equiv(os.path.join(ADV, "a1-nand-s0-wrong.json"),
                    os.path.join(ADV, "a1-nand-s0-reference.json"), ABC)
    case("A1 single-slot NAND-at-level-2 is NOT !(A&B)&C", "fail", rc, out)

    rc, out = equiv(os.path.join(ADV, "a3-slotorder-wrong.json"),
                    os.path.join(ADV, "a3-slotorder-right.json"), ABC)
    case("A3 producer-after-consumer slot order is detected", "fail", rc, out)

    rc, out = equiv(os.path.join(ADV, "a3-slotorder-wrong.json"),
                    os.path.join(ADV, "a3-slotorder-right.json"), ABC,
                    tolerance=1)
    case("A3 is not merely a uniform one-cycle lag", "fail", rc, out,
         "still fails at tolerance 1")

    # --- adversarial: latch encodings --------------------------------------
    rc, out = equiv(os.path.join(ADV, "a4-latch-counter.json"),
                    os.path.join(ADV, "a4-latch-wrap-toggle.json"), ABC)
    case("A4 set/reset latch != wrapAround toggle", "fail", rc, out)

    rc, out = equiv(os.path.join(ADV, "a4-latch-wrap-toggle.json"),
                    os.path.join(ADV, "a4-latch-vi-mode.json"), ABC)
    case("A4 wrapAround toggle == virtual-input Latching mode "
         "(same cycle, zero counters)", "pass", rc, out)

    # --- deployed configs still behave as documented ------------------------
    for cfg, traces in [
        ("engine-repin.json", ENGINE_TRACES),
        ("lights-repin.json", [os.path.join(TR, "lights-stalk.json"),
                               os.path.join(TR, "can-quiet.json")]),
    ]:
        rc, out = equiv(os.path.join(CORPUS, cfg), os.path.join(CORPUS, cfg),
                        *traces)
        case(f"{cfg} is deterministic (self-comparison)", "pass", rc, out)

    width = max(len(n) for _, n, _, _, _ in RESULTS)
    bad = 0
    for ok, name, want, note, out in RESULTS:
        mark = "ok  " if ok else "FAIL"
        if not ok:
            bad += 1
        print(f"  {mark}  {name:<{width}}  (expect {want})"
              + (f"  -- {note}" if note else ""))
        if args.verbose or not ok:
            for line in out.strip().splitlines()[:12]:
                print(f"          {line}")
    print(f"\n{len(RESULTS) - bad}/{len(RESULTS)} cases as expected")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())

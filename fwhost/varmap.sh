#!/bin/sh
# Print each board's var-map layout, derived from the firmware's own
# InitVarMap() rather than transcribed.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
for B in dingopdm_v7 dingopdmmax_v1 pt-dpdm4_1 canboard_v2 canboard_v2_exp; do
    echo "===== $B"
    BOARD=$B MAIN="$HERE/src/probe_varmap.cpp" OUT="varmap_$B" sh "$HERE/build.sh" >/dev/null
    "$HERE/build/varmap_$B"
done

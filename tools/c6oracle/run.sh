#!/bin/sh
# Regenerate internal/params/testdata/c6body_v1.fw.json: the C6 body node's
# real dingoFW core, built for the host, answering for its parameter table,
# var map, and the apply/verify/read-back of each example config.
#
# Run inside the dingo-web dev container (g++, Go, Node). The C6 sources live
# in the hilux repo, which that container does not mount, so copy them in
# first, from the Mac:
#
#   podman exec dingo-web rm -rf /tmp/c6dingo
#   podman cp ~/src/hilux/wireless-can/dingo dingo-web:/tmp/c6dingo
#   podman exec dingo-web bash -lc 'cd /workspace && C6DINGO=/tmp/c6dingo tools/c6oracle/run.sh'
#
# C6DINGO is hilux's wireless-can/dingo (dingoFW/, c6body_v1/, glue/, shim/).
# The source list and include order are hilux wireless-can/build.rs's; only the
# target flags differ (host, not riscv32, and the host's C++ headers instead
# of dingo/shim/std).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
D=${C6DINGO:?set C6DINGO to a copy of hilux wireless-can/dingo}
D=$(cd "$D" && pwd)
OUT=${OUT:-$REPO/internal/params/testdata/c6body_v1.fw.json}
BUILD=${BUILD:-/tmp/c6oracle}
mkdir -p "$BUILD" "$(dirname "$OUT")"

FW="core/device.cpp core/config_handler.cpp core/param_protocol.cpp core/param_registry.cpp
 core/status.cpp comms/infomsg.cpp comms/request_msg.cpp functions/can_input.cpp
 functions/can_outputs.cpp functions/condition.cpp functions/counter.cpp
 functions/flasher.cpp functions/input.cpp functions/virtual_input.cpp utils/crc.cpp
 utils/dbc.cpp"
SRC=""
for s in $FW; do SRC="$SRC $D/dingoFW/$s"; done
SRC="$SRC $D/c6body_v1/hw_devices.cpp $D/c6body_v1/msg.cpp $D/glue/core.cpp"

INC="-I$D/shim -I$D/c6body_v1 -I$D/dingoFW/core -I$D/dingoFW/comms
 -I$D/dingoFW/functions -I$D/dingoFW/hardware -I$D/dingoFW/utils -I$D/dingoFW"

# dingoFW's USE_CPPOPT and the board's -Os -fno-strict-aliasing, as build.rs.
g++ -std=c++20 -fno-rtti -fno-exceptions -fno-threadsafe-statics -Os -fno-strict-aliasing \
    -w $INC $SRC "$HERE/oracle.cpp" -o "$BUILD/c6oracle"

# The params dingo-cli's apply would send for each example (the native
# encoder, web/test/golden), as "index sub value" lines.
cd "$REPO"
RUNS=""
for f in web/examples/c6-*.json; do
    n=$(basename "$f" .json)
    go run ./web/test/golden "$f" 0 |
        node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).params)console.log(p.index,p.sub,p.value)})' \
        > "$BUILD/$n.txt"
    RUNS="$RUNS $n=$BUILD/$n.txt"
done

"$BUILD/c6oracle" $RUNS > "$BUILD/raw.json"
PIN=$(sed -n 's/^commit //p' "$D/dingoFW/PINNED")
# Record the dingoFW pin, then pretty-print (one param per line keeps diffs
# of a regenerated table readable).
node -e '
const fs = require("fs");
const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const out = { generator: o.generator, dingoFW: process.argv[2], board: o.board, bootLoad: o.bootLoad, defaultsCrc: o.defaultsCrc, fatal: o.fatal,
  varMap: o.varMap, runs: o.runs, params: o.params };
fs.writeFileSync(process.argv[3], JSON.stringify({ ...out, params: undefined }, null, 1).replace(/\n}$/, "") +
  ",\n \"params\": [\n" + o.params.map((p) => "  " + JSON.stringify(p)).join(",\n") + "\n ]\n}\n");
' "$BUILD/raw.json" "$PIN" "$OUT"
echo "wrote $OUT (dingoFW $PIN, port.h DEFAULT_BASE_ID $(sed -n 's/^#define DEFAULT_BASE_ID //p' "$D/c6body_v1/port.h"))"

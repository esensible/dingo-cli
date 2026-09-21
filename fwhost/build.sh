#!/bin/sh
# Build the real dingoFW logic for the host.  No ChibiOS, no cross-compiler.
#
#   ./build.sh                       -> build/fwhost           (dingopdm_v7)
#   BOARD=dingopdmmax_v1 MAIN=src/probe_varmap.cpp OUT=varmap_max ./build.sh
#
# DINGOFW points at a dingoFW checkout (tested at tag v0.5.8).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
FW=${DINGOFW:-$HERE/../../dingoFW}
[ -d "$FW/functions" ] || { echo "set DINGOFW to a dingoFW checkout" >&2; exit 2; }
FW=$(cd "$FW" && pwd)

BOARD=${BOARD:-dingopdm_v7}
MAIN=${MAIN:-$HERE/src/main.cpp}
OUT=${OUT:-fwhost}
mkdir -p "$HERE/build"

INC="-I$HERE/shim -I$HERE/src \
 -I$FW/boards/$BOARD -I$FW/core -I$FW/functions -I$FW/functions/wiper \
 -I$FW/functions/keypad -I$FW/functions/keypad/blink -I$FW/functions/keypad/grayhill \
 -I$FW/utils -I$FW/comms -I$FW"

# Real firmware sources, compiled unmodified.  Everything here is logic; the
# translation units left out are the ones that only talk to hardware.
FWSRC="$FW/functions/virtual_input.cpp $FW/functions/condition.cpp \
 $FW/functions/counter.cpp $FW/functions/flasher.cpp \
 $FW/functions/digital_input.cpp $FW/functions/digital_output.cpp \
 $FW/functions/can_input.cpp $FW/functions/can_outputs.cpp \
 $FW/functions/input.cpp $FW/functions/starter.cpp \
 $FW/functions/profet.cpp $FW/functions/pwm.cpp \
 $FW/functions/wiper/wiper.cpp $FW/functions/wiper/wiper_digin.cpp \
 $FW/functions/wiper/wiper_intin.cpp $FW/functions/wiper/wiper_mixin.cpp \
 $FW/functions/keypad/keypad.cpp $FW/functions/keypad/keypad_button.cpp \
 $FW/functions/keypad/blink/blink_keypad.cpp $FW/functions/keypad/blink/blink_button.cpp \
 $FW/functions/keypad/blink/blink_dial.cpp $FW/functions/keypad/blink/blink_analog_input.cpp \
 $FW/functions/keypad/grayhill/grayhill_keypad.cpp $FW/functions/keypad/grayhill/grayhill_button.cpp \
 $FW/utils/dbc.cpp $FW/utils/crc.cpp \
 $FW/core/device.cpp $FW/core/config_handler.cpp \
 $FW/core/param_protocol.cpp $FW/core/param_registry.cpp $FW/core/status.cpp \
 $FW/boards/$BOARD/hw_devices.cpp"

case $BOARD in
  pt-dpdm4_1|canboard_v2) FWSRC="$FWSRC $FW/functions/analog_input.cpp";;
esac

HOSTSRC="$HERE/src/host_io.cpp $HERE/src/host_stubs.cpp \
 $HERE/src/host_stubs_extra.cpp $HERE/src/json.cpp $HERE/src/loader.cpp"

c++ -std=c++20 -O1 -g -w $INC $FWSRC $HOSTSRC "$MAIN" -o "$HERE/build/$OUT"
echo "built build/$OUT  (board $BOARD, firmware $FW)"

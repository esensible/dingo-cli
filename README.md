# dingo-cli

A small, dependency-light CLI for programming **dingoPDM / dingoFW** devices over
their USB CDC port — built so it can be cross-compiled for macOS from a Linux
container and run natively on the host (no toolchain on the Mac).

It speaks the device's **parameter (SDO-style) protocol** directly: every message
is a fixed 8-byte CAN frame (`cmd, index[2], subindex, value[4]`) carried over
SLCAN. Commands go to `BaseId+1`, responses come back on `BaseId+0`.

## Commands

```
# Name-based (recommended) — every UI-exposed feature, by name
dingo apply  -port <p> [-base 222] [-burn] config.json   # declarative config (see below)
dingo set    -port <p> [-base 222] [-burn] <name> <value> # write one parameter by name
dingo getn   -port <p> [-base 222] -name <name>           # read one parameter by name
dingo dump   -port <p> [-base 222] -named [-o config.json] # read all as a name->value object

# Raw index/subindex (low level)
dingo write  -port <p> [-base 222] [-burn] config.json   # write raw params + verify (count+CRC)
dingo get    -port <p> [-base 222] -index <i> -sub <s>   # read one raw param
dingo dump   -port <p> [-base 222] [-o config.json]      # read all raw params

# Device
dingo version | verify | burn | bootloader -port <p> [-base 222]

# Bus tools
dingo listen -port <p> -secs <n>                         # passive bus monitor
dingo tx     -port <p> -id <id> -data <hex> [-watch <id>] # send one frame
dingo pulse  -port <p> -id <id> -data <hex> -ms <on> -gap <off> -repeat <n|0=forever>
```

## Declarative config (`apply`)

`apply` is the source-of-truth workflow: keep the desired state in a JSON file
(in git), `apply` it, and the device ends up in exactly that state. The firmware
resets **all** parameters to their defaults and then applies your file, so the
file only needs to list what differs from default. The device returns a parameter
count and CRC-32 that the CLI checks — a successful `apply` means the device holds
exactly what you sent.

Values are typed automatically from the firmware parameter table:

```json
{
  "device.baseId": 222,
  "device.canSpeed": "500K",

  "output[4].enabled": true,
  "output[4].input": "AlwaysTrue",
  "output[4].currentLimit": 20.0,
  "output[4].resetMode": "Endless",

  "virtualInput[1].enabled": true,
  "virtualInput[1].var0": "DigIn1",
  "virtualInput[1].cond0": "And",
  "virtualInput[1].var1": "DigIn2",

  "condition[1].enabled": true,
  "condition[1].input": "BattVolt",
  "condition[1].operator": "GreaterThan",
  "condition[1].arg": 13.5,

  "flasher[1].enabled": true,
  "flasher[1].input": "VirtIn1",
  "flasher[1].flashOnTime": 250,
  "flasher[1].flashOffTime": 750
}
```

### Naming

- `<block>[<n>].<field>` — every `[n]` is **1-based**, matching the UI/silkscreen
  (`output[4]` is the 4th output, protocol index `0x1003`).
- Singletons have no index: `device.*`, `starter.*`, `wiper.*`.
- Blocks: `device`, `output`, `digInput`, `canInput`, `canOutput`,
  `virtualInput`, `condition`, `counter`, `flasher`, `starter`, `wiper`,
  `keypad[k].button[b]`, `keypad[k].dial[d]`. Nested fields use dots, e.g.
  `output[1].pwm.enabled`, `wiper.speedMap[1]`, `starter.disableOut[3]`.

### Value types

- **bool** → `true`/`false` (or `0`/`1`)
- **int** (`uint8/16/32`, `int8`) → number; hex strings like `"0x7FF"` accepted
- **float** (current/inrush limits, factor/offset, condition arg, …) → number,
  encoded as IEEE-754
- **enum** → the enumerator name (case-insensitive) or its number, e.g.
  `canSpeed: "500K"`, `resetMode: "Endless"`, `operator: "GreaterThan"`,
  `mode: "Latching"`, `byteOrder: "BigEndian"`
- **var-map reference** (any `*.input`, `var0..2`, `incInput`, …) → a variable
  name or its index, e.g. `"AlwaysTrue"`, `"DigIn1"`, `"VirtIn1"`, `"Out4Active"`,
  `"Cond1"`, `"BattVolt"`

The registry is generated from the firmware table (`core/param_defs.h` +
`boards/dingopdm_v7/params.h`, 2269 parameters) and the var map
(`device.cpp InitVarMap`, 217 variables); see `internal/params/`. Run
`go test ./internal/params/` to validate it against the firmware facts.

## Build (cross-compile for macOS in a container)

```
podman run --rm -v "$PWD":/src -w /src \
  -e CGO_ENABLED=0 -e GOOS=darwin -e GOARCH=arm64 \
  docker.io/library/golang:latest go build -o bin/dingo .
```

Pure Go (`go.bug.st/serial`, no cgo), so the cross-build produces an ad-hoc
linker-signed macOS arm64 binary that runs on Apple Silicon directly.

## Notes

- `apply`/`set` change the **live** config; add `-burn` (or run `dingo burn`) to
  persist to flash.
- `burn` uses the magic payload `[30,1,3,8]` and verifies the device's
  `WriteConfig` ack; `bootloader` uses `[33,'B','O','O','T','L']`.
- This build targets the **dingopdm_v7** board (8 outputs, 2 keypads, etc.). Other
  boards have different instance counts; the registry constants in
  `internal/params/registry.go` would need to match.
- `dump` of the full table can drop frames on the large keypad burst; for
  authoring, prefer hand-written sparse `apply` files over round-tripping `dump`.
```

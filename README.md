# dingo-cli

A small, dependency-light CLI for programming **dingoPDM / dingoFW** devices over
their USB CDC port — built so it can be cross-compiled for macOS from a Linux
container and run natively on the host (no toolchain on the Mac).

It speaks the device's **parameter (SDO-style) protocol** directly: every message
is a fixed 8-byte CAN frame (`cmd, index[2], subindex, value[4]`) carried over
SLCAN. Commands go to `BaseId+1`, responses come back on `BaseId+0`.

## Commands

```
dingo dump       -port <p> [-base 2000] [-o config.json]   # read all params
dingo write      -port <p> [-base 2000] [-burn] config.json # write + verify (count+CRC)
dingo verify     -port <p> [-base 2000]                     # print device config CRC
dingo burn       -port <p> [-base 2000]                     # persist to flash
dingo bootloader -port <p> [-base 2000]                     # reset into DFU
```

`config.json` is an array of params:

```json
[
  { "index": 8192, "subIndex": 0, "value": 1 },
  { "index": 8192, "subIndex": 3, "value": 1538 }
]
```

The simplest authoring workflow is `dump` → edit → `write`.

## Why it's robust

The device **self-verifies**: `write` sends a bulk `WriteAll` sequence and the
firmware returns a parameter count and a CRC-32, which the CLI checks against its
own. `dump` is verified the same way. So a successful `write` means the device
holds exactly what you sent — no golden-vector oracle needed.

## Build (cross-compile for macOS in a container)

```
podman run --rm -v "$PWD":/src -w /src \
  -e CGO_ENABLED=0 -e GOOS=darwin -e GOARCH=arm64 \
  docker.io/library/golang:latest sh -c 'go mod tidy && go build -o bin/dingo .'
```

Pure Go (`go.bug.st/serial`, no cgo), so the cross-build produces an ad-hoc
linker-signed macOS arm64 binary that runs on Apple Silicon directly.

## Status / caveats

- **Transport, `dump`, `write`, `verify`** map directly to the firmware
  (`param_protocol.cpp`) and configurator (`SlcanAdapter.cs`) and are
  high-confidence.
- **`burn` and `bootloader`** use the confirmed command envelope (cmd 30 / 33)
  but their firmware dispatch wasn't fully traced — **verify on hardware** before
  relying on them.
- A human-readable name→`index/subindex` map (so configs can use names instead of
  raw indices) is a planned layer on top; the index scheme is computed per
  function type in the firmware's `param_registry`.

# dingo-cli

A small, dependency-light CLI for programming **dingoPDM** devices over their USB
CDC port. It reads the **dingoConfig** JSON file format directly and writes it to
a device, so the same config file flows between the GUI and the command line — no
separate format, no converter.

## Upstream projects

dingo-cli is a companion to corygrant's dingoPDM ecosystem and is built around its
file format and protocol:

- **dingoPDM** (hardware + firmware) — <https://github.com/corygrant/DingoPDM_FW>
- **dingoConfig** (the official .NET/Blazor configuration GUI, and the canonical
  config **file format**) — <https://github.com/corygrant/dingoConfig>

The dingoConfig `.json` file is the single source of truth. dingo-cli is a
headless way to push one of those files to a device (and to do live, low-level
pokes), intended for scripting, CI, and agentic/automated workflows.

## Workflow

```
configure in dingoConfig (GUI)  ──save──▶  device.json
                                              │
                       edit in git / by an agent (it's just JSON)
                                              │
                          dingo apply device.json ──▶ PDM
                                              │
                  re-open device.json in dingoConfig ──▶ write from the GUI
```

The CLI only **consumes** the dingoConfig file (it never rewrites it), so there
are no round-trip/fidelity concerns — the GUI remains the file's author/editor.

## Commands

```
dingo apply <config.json> -port <p> [-base 222] [-burn]
        # parse a dingoConfig file, map the PDM (selected by -base) to wire
        # params, and WriteAll (verifying count + CRC). -burn persists to flash.

# Live single-parameter access (by human name; addressing convenience, not a file format)
dingo set  -port <p> [-base 222] [-burn] <name> <value>   # e.g. set "output[4].currentLimit" 15
dingo getn -port <p> [-base 222] -name <name>

# Device / diagnostics
dingo verify     -port <p> [-base 222]     # device config CRC
dingo version    -port <p> [-base 222]
dingo burn       -port <p> [-base 222]
dingo bootloader -port <p> [-base 222]     # software jump to DFU (current firmware)
dingo get        -port <p> [-base 222] -index <i> -sub <s>

# Raw bus tools
dingo listen -port <p> -secs <n>
dingo tx     -port <p> -id <id> -data <hex> [-watch <id>]
dingo pulse  -port <p> -id <id> -data <hex> -ms <on> -gap <off> -repeat <n|0=forever>
dingo raw    -port <p> -data <hex>          # raw CDC bytes, no SLCAN framing
```

Each subcommand owns its own flags; run `dingo <command> -h` for the exact set,
and an unknown/misplaced flag is rejected rather than silently ignored.

### `apply` details

- Selects the PDM device in the file whose `baseId` matches `-base` (a
  single-PDM file is used regardless). Multi-device files (e.g. with CANBoard /
  DBC / keypad entries) are fine — non-PDM and other-PDM entries are ignored.
- Maps every PDM field to the firmware parameter (SDO-style) protocol —
  `{index, subindex, value}` frames — using the firmware param table; enums,
  var-map references, and floats (IEEE-754) are encoded as the firmware expects.
- Variable-output variants (e.g. dingoPDM-Max with 4 outputs) work because the
  projection follows the file's actual array lengths.
- The device self-verifies: `WriteAll` returns a parameter count and CRC-32 that
  the CLI checks, so a successful `apply` means the device holds exactly the
  config you sent.

## Build (cross-compile for macOS in a container)

```
podman run --rm -v "$PWD":/src -w /src \
  -e CGO_ENABLED=0 -e GOOS=darwin -e GOARCH=arm64 \
  docker.io/library/golang:latest go build -o bin/dingo .
```

Pure Go (`go.bug.st/serial`, no cgo), so the cross-build produces an ad-hoc
linker-signed macOS arm64 binary that runs on Apple Silicon directly. Run the
tests with `go test ./...`.

## Layout

- `internal/pdmcfg` — parses a dingoConfig file and projects the chosen PDM to
  wire params (the dingoConfig-field → firmware-`(index,sub)` bridge).
- `internal/params` — the firmware parameter table (index/sub/type/range) and
  value encode/decode; the source of truth for the wire mapping.
- `internal/dingo` — the parameter protocol over SLCAN (`WriteAll`/`SetParam`/
  `Burn`/`Version`/…), behind a `Transport` interface for hardware-free tests.
- `internal/slcan` — the SLCAN transport over USB CDC.

## Notes

- `apply`/`set` change the **live** config; add `-burn` (or run `dingo burn`) to
  persist to flash.
- The board targeted here is **dingopdm_v7** (8 outputs, 2 keypads, …); the param
  table in `internal/params` is board-specific.
- Older firmware (pre-SLCAN-RX) uses a raw-byte USB protocol and a different
  bootloader command; `dingo raw` exists to drive that recovery path. Current
  firmware uses `dingo bootloader`.

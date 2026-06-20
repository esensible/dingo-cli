---
name: dingopdm-hardware
description: >-
  Physical wiring reference for the dingo ecosystem hardware: dingoPDM /
  dingoPDM-Max power-distribution modules (the main DT/Deutsch connector pinout,
  connector and socket part numbers, power/ground lugs, USB cabling caveats, CAN
  termination, output current ratings, MCU test points, and how physical
  Output/Input pins map to the config's numbering and var-map) and the CANBoard
  CAN I/O expander (digital/analog inputs, low-side outputs, CAN base-ID and
  termination jumpers, and the CAN frame layout the PDM uses to read/command it).
  Use whenever the task involves wiring a dingoPDM or CANBoard, picking
  connectors/contacts, or relating a physical pin to a configured output/input.
---

# dingo hardware / wiring (dingoPDM + CANBoard)

Physical wiring reference for the **dingoPDM** / **dingoPDM-Max** PDMs and the
**CANBoard** CAN I/O expander. For the *configuration* side (the dingoConfig JSON,
var-map, applying with `dingo-cli`) see the companion **`dingopdm-config`** skill —
this skill is the hardware/pin layer.

Source of truth: the official hardware docs at
https://github.com/corygrant/dingoPDM/blob/master/docs/hardware/connections.md and
https://github.com/corygrant/CANBoard (pulled 2026-06-20). The signal/I-O logic
lives in firmware: https://github.com/corygrant/dingoFW . Reference copies of the
source diagrams/schematics are vendored under `assets/` next to this file. Verify
pin numbers against the molded numbers on the connector and the pin-number
diagram before crimping — current ratings below are connector **estimates**, not
firmware limits.

## Connectors (the three external interfaces)

| ID | Connector | Part | Notes |
|---|---|---|---|
| 1 | Main signal/output | **DT 12-position, `DT06-12SA`** (+ `W12S` wedgelock) | all outputs, inputs, and CAN |
| 2 | 12V DC power | `M6` / `1/4"` ring lug | **4–10 AWG** (large-gauge battery feed) |
| 3 | Ground | `M6` / `1/4"` ring lug | 18–20 AWG ok |
| 4 | USB Type-C | — | firmware config/flash; see USB caveat |

dingoPDM outputs are **high-side** (they switch +12 V to the load); each load
returns to chassis ground **directly, not through the PDM**, so the ground lug only
carries the module's own reference current — hence the modest gauge.

**Contacts for the DT12** (solid, size-16 Deutsch):
- `0462-209-16141` — 14–16 AWG — **×2** (use for the two 13 A outputs)
- `0462-201-16141` — 16–20 AWG — **×10** (everything else)

## dingoPDM pinout — DT06-12SA (12 pin)

| Pin | Function | Rated current |
|---|---|---|
| 1 | CAN L | — |
| 2 | CAN H | — |
| 3 | Output 8 | 8 A |
| 4 | Output 7 | 8 A |
| 5 | Output 6 | 8 A |
| 6 | Output 5 | 8 A |
| 7 | **Output 1** | **13 A** |
| 8 | Input 1 | — |
| 9 | Output 4 | 8 A |
| 10 | Output 3 | 8 A |
| 11 | Input 2 | — |
| 12 | **Output 2** | **13 A** |

- **Outputs 1 and 2 are the high-current (13 A) channels** (pins 7 and 12) — use
  the 14–16 AWG contacts here and put your heaviest loads (motors, pumps) on them.
  Outputs 3–8 are 8 A.
- Main 12 V feed and ground are on the **separate lugs**, not the DT connector.
- **Inputs** (pins 8, 11) are typically wired **switch-to-GND**; pick `pull` /
  `invert` in the config to match (see `dingopdm-config` → inputs). Only Input 1
  (pin 8) can wake the device from sleep.

## dingoPDM-Max pinout — DT06-12SA (12 pin)

The Max has 4 outputs, each on a **doubled pair of pins** (~26 A/output). Different
pin order from the standard PDM — do not assume they match.

| Pin | Function | Rated current |
|---|---|---|
| 1 | Output 4 | 26 A |
| 2 | Output 4 | 26 A |
| 3 | CAN L | — |
| 4 | CAN H | — |
| 5 | Output 3 | 26 A |
| 6 | Output 3 | 26 A |
| 7 | Output 1 | 26 A |
| 8 | Output 1 | 26 A |
| 9 | Input 1 | — |
| 10 | Input 2 | — |
| 11 | Output 2 | 26 A |
| 12 | Output 2 | 26 A |

(Both pins of an output pair are the same channel — land both for full current.)

## CAN

- **No internal termination.** There is no 120 Ω terminating resistor on the PDM's
  CAN — add one externally (the PDM should sit at a bus end with a terminator, or
  the bus must already be terminated at both ends).
- CAN L / CAN H are pins 1 / 2 on dingoPDM (pins 3 / 4 on the Max).

## USB

USB-C is for configuration/flashing (this is the port `dingo-cli` talks to).

| Hardware | USB C–C cable | USB A–C cable |
|---|---|---|
| **v7.2** | ❌ not supported | ✅ |
| v7.3 and up | ✅ | ✅ |

If a v7.2 board won't enumerate, suspect a C-to-C cable — use an A-to-C cable.

## Physical pin ↔ config mapping

The config (dingoConfig JSON / var-map, see `dingopdm-config`) addresses outputs
and inputs by **number**, 1-based; arrays are 0-based so `outputs[i]` = Output
`i+1`. Map number → physical pin with the table above. For the standard dingoPDM:

| Config | Array idx | DT pin | var-map (Active) |
|---|---|---|---|
| Output 1 | `outputs[0]` | 7 (13 A) | 87 |
| Output 2 | `outputs[1]` | 12 (13 A) | 91 |
| Output 3 | `outputs[2]` | 10 | 95 |
| Output 4 | `outputs[3]` | 9 | 99 |
| Output 5 | `outputs[4]` | 6 | 103 |
| Output 6 | `outputs[5]` | 5 | 107 |
| Output 7 | `outputs[6]` | 4 | 111 |
| Output 8 | `outputs[7]` | 3 | 115 |
| Input 1 | `inputs[0]` | 8 | DigIn1 = 5 |
| Input 2 | `inputs[1]` | 11 | DigIn2 = 6 |

(Out{n}Active = 87 + 4·(n-1); Current/Overcurrent/Fault are +1/+2/+3.) So "drive
the motor from OUT1" = land it on **DT pin 7**, and only DigIn1 (pin 8) can wake the
device from sleep.

## Test points (debug / extra I/O headers)

| Label | Function | MCU pin |
|---|---|---|
| I2C | I2C1 clock | PB6 |
| I2D | I2C1 data | PB7 |
| CR | CAN receive | PB8 |
| CT | CAN transmit | PB9 |
| E1 | Extra 1 | PC10 |
| E2 | Extra 2 | PC11 |
| E3 | Extra 3 | PC13 |
| GND | Ground | — |
| TagConnect | Debugger | — |

## Wipers

Driving a wiper motor directly needs a separate **WiperModule** (3 relays for
slow / fast / brake; slow input also supplies motor power, ground and park pass
through). See https://github.com/corygrant/WiperModule . The PDM's wiper *logic*
and output vars are documented in `dingopdm-config`.

## CANBoard (CAN I/O expander)

A separate CAN node — a small I/O board (steering wheels, switch panels, button
boxes) the PDM reads and commands over CAN. Hardware repo:
https://github.com/corygrant/CANBoard ; firmware: https://github.com/corygrant/dingoFW .
The PDM-side config recipe is in `dingopdm-config` → "Driving a CANBoard from a
PDM"; this is the hardware/electrical layer. MCU: STM32F303K8T6.

**I/O capability:**
- **8 digital inputs (DI1–8)** — *ground-switching*: each idles **high** (internal
  pull-up) and is asserted by connecting it to **GND**. Wire a switch between the
  DI pin and a GND pin — no external voltage. 10 kΩ series protection per input.
- **5 analog inputs (AI1–5)** — **0–5 V max**, RC-filtered and internally scaled to
  the 3.3 V ADC (4.7 kΩ series + 10 kΩ to GND). For pots / 2–3-wire sensors; the
  5 V and GND header rails are there to power them.
- **4 digital outputs (DO1–4, silk `DIGOUT1–4`)** — **low-side open-drain N-FET
  (DMN2004WK), 0.5 A max each.** The pin sinks to GND when on; wire the load
  between **+12 V and the DIGOUT pin**. **0.5 A will not drive a motor or lamp
  directly — switch a relay (or a PDM output).** Add an external **flyback diode**
  across any inductive load (relay coil); the board has none on the outputs. For a
  standard automotive relay: coil terminal **86 → +12 V**, terminal **85 → the
  DIGOUT pin**, flyback diode across 85–86 with its **cathode to +12 V**. (A horn or
  lamp draws several amps — well over 0.5 A — so always relay it, never direct.)

**Power:** 12 V in → onboard 5 V (TPS56339 buck) and 3.3 V (LD1117S33). The 5 V rail
is exposed on the headers for sensors / switch LEDs.

**CAN:**
- Transceiver MCP2562 with ESD protection. **Optional 120 Ω termination** via the
  **CAN Term** solder jumper (JP3 / `TERM_SB`) — solder only if the board is at a
  bus end.
- **Base CAN ID is set by two solder jumpers** (silk `JP1` / `JP2`; *Closed* =
  soldered bridge, *Open* = not soldered) so several CANBoards can share a bus:

  | Jumper 1 | Jumper 2 | Base ID |
  |---|---|---|
  | Open | Open | 0x640 |
  | Closed | Open | 0x650 |
  | Open | Closed | 0x660 |
  | Closed | Closed | 0x670 |

**CAN frame layout (ids are relative to the base; default base 0x640):**
- **Broadcast — base+2 (`0x642`):** byte 4 = digital-input bitfield (bit0 = DI1 …
  bit7 = DI8, 1 = asserted/closed-to-ground); byte 6 = output-state bitfield
  (bit0 = DO1 … bit3 = DO4); byte 7 = heartbeat. (Analog values are also broadcast
  — see firmware/DBC for exact bytes.)
- **Command — base+3 (`0x643`), DLC ≥ 4:** byte0 bit0 = DO1, byte1 bit0 = DO2,
  byte2 bit0 = DO3, byte3 bit0 = DO4 (0x01 = on). The PDM must send this
  continuously; pad to DLC 4.
- Non-default base shifts everything (base 0x650 → broadcast 0x652, command 0x653).
- In a PDM config these are decimal: read DIs from `id` 1602 (0x642), command DOs to
  `id` 1603 (0x643). See `dingopdm-config`.

**Connectors:** four 8-pin single-row headers (`Conn_01x08`, J1–J4), grouped by
function:
- **Digital inputs** — DI1…DI8 in pin order (one full header).
- **Digital outputs** — DIGOUT1…DIGOUT4 (+ 5 V / GND).
- **Analog inputs** — AI1…AI5 (+ 5 V / GND sensor supply).
- **CAN + power** — CAN H, CAN L, +12 V, GND.

The digital-input header is straight DI1→DI8; for the exact pin order of the
power/CAN/analog/output headers, check the vendored connections diagram
(`assets/canboard-connections.png`) and schematic (`assets/canboard-schematic-v2.pdf`)
against the board silkscreen before crimping.

**Programming:** TC2030 Tag-Connect (J5: SWDIO / SWCLK / NRST / 3V3 / GND);
firmware = dingoFW.

## Provenance

- dingoPDM pinout, connector/contact part numbers, USB table, test points:
  `corygrant/dingoPDM` `docs/hardware/connections.md` (master, 2026-06-20).
- CANBoard electrical spec, jumper tables, programming: `corygrant/CANBoard`
  `README.md` + `Export/V2/CANBoard_HW_V2.pdf` (main, 2026-06-20). CAN frame map
  cross-checked against `dingopdm-config` / dingoFW.
- Vendored source docs live in `assets/` beside this skill (CANBoard connections
  diagram + schematic; dingoPDM connection/pinout diagrams + hardware PDF).
- Current ratings are connector estimates; actual capacity depends on wire gauge,
  install, and config. Firmware enforces the per-output current limits you set in
  the config, not these connector numbers. CANBoard outputs are a hard 0.5 A.

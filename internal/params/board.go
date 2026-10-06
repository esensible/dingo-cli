package params

import "strings"

// Board is the shape of one dingo firmware target: how many of each function
// block it has, and which optional subsystems it compiles in.
//
// Every count here is transcribed from that board's dingoFW boards/<x>/port.h.
// They drive BOTH the parameter registry (which index/subindex pairs exist) and
// the var map (which runtime variable lives at which index), because in the
// firmware those two tables are generated from the same NUM_* macros. Getting a
// count wrong therefore silently shifts every var-map index above it — which is
// exactly why a script must name its board rather than inherit a default:
// VirtIn1 is index 71 on dingopdm_v7, 79 on pt-dpdm4_1 and 51 on canboard_v2,
// so a config compiled for the wrong variant wires the wrong signals together
// and still passes every range check.
type Board struct {
	// Name is the canonical name used in device({board: ...}) and is the
	// dingoConfig GUI's typeName where one exists.
	Name string
	// Aliases are additional accepted spellings (case-insensitive).
	Aliases []string
	// Firmware is the dingoFW boards/<dir> this was transcribed from.
	Firmware string
	// PdmType is the dingoConfig "pdmType" discriminator, and the board type
	// the firmware broadcasts in the high nibble of status byte 1 (base+2,
	// msg.cpp `GetDeviceState() + (PDM_TYPE << 4)`). CANBoard is not a
	// PdmDevice at all and broadcasts no type, so it carries -1 and
	// IsCanboard.
	PdmType    int
	IsCanboard bool

	// DefaultBaseID is the board's DEFAULT_BASE_ID: the device.baseId
	// parameter's firmware default, which a config that omits baseId gets.
	DefaultBaseID int

	Outputs      int
	DigInputs    int
	DigOutputs   int
	AnalogInputs int
	CanInputs    int
	CanOutputs   int
	VirtInputs   int
	Conditions   int
	Counters     int
	Flashers     int

	Keypads       int
	KeypadButtons int
	KeypadDials   int
	KeypadAnalogs int

	// SysVars is VAR_MAP_SYS_VARS: AlwaysFalse, AlwaysTrue, State, and then
	// BoardTemp/BattVolt only where HAS_EXT_TEMP_SENSOR/HAS_BATT_VOLT_SENSE.
	SysVars int

	HasWipers  bool
	HasStarter bool

	WiperSpeedMap    int
	WiperInterDelays int
}

// boards is the board table. Order is the order Boards() reports them in.
var boards = []Board{
	{
		Name: "dingoPDM", Firmware: "dingopdm_v7", PdmType: 0, DefaultBaseID: 0x0DE,
		Outputs: 8, DigInputs: 2, DigOutputs: 0, AnalogInputs: 0,
		CanInputs: 32, CanOutputs: 32, VirtInputs: 16, Conditions: 32,
		Counters: 4, Flashers: 4,
		Keypads: 2, KeypadButtons: 20, KeypadDials: 2, KeypadAnalogs: 4,
		SysVars: 5, HasWipers: true, HasStarter: true,
		WiperSpeedMap: 8, WiperInterDelays: 6,
	},
	{
		Name: "dingoPDM-Max", Aliases: []string{"dingoPDMMax", "dingopdm-max"},
		Firmware: "dingopdmmax_v1", PdmType: 1, DefaultBaseID: 0x0DE,
		Outputs: 4, DigInputs: 2, DigOutputs: 0, AnalogInputs: 0,
		CanInputs: 32, CanOutputs: 32, VirtInputs: 16, Conditions: 32,
		Counters: 4, Flashers: 4,
		Keypads: 2, KeypadButtons: 20, KeypadDials: 2, KeypadAnalogs: 4,
		SysVars: 5, HasWipers: true, HasStarter: true,
		WiperSpeedMap: 8, WiperInterDelays: 6,
	},
	{
		Name: "PT-DPDM", Aliases: []string{"PTDPDM", "pt-dpdm4"},
		Firmware: "pt-dpdm4_1", PdmType: 2, DefaultBaseID: 0x0DE,
		Outputs: 4, DigInputs: 2, DigOutputs: 0, AnalogInputs: 2,
		CanInputs: 32, CanOutputs: 32, VirtInputs: 16, Conditions: 32,
		Counters: 4, Flashers: 4,
		Keypads: 2, KeypadButtons: 20, KeypadDials: 2, KeypadAnalogs: 4,
		SysVars: 5, HasWipers: true, HasStarter: true,
		WiperSpeedMap: 8, WiperInterDelays: 6,
	},
	{
		// CANBoard has no Profet outputs at all: its "outputs" are four
		// low-side digital outputs (0x2100), and it gains eight digital and
		// five analog inputs. It also drops the temp sensor and battery sense,
		// so its system var block is 3 entries, not 5.
		Name: "CANBoard", Aliases: []string{"canboard_v2"},
		Firmware: "canboard_v2", PdmType: -1, IsCanboard: true, DefaultBaseID: 0x640,
		Outputs: 0, DigInputs: 8, DigOutputs: 4, AnalogInputs: 5,
		CanInputs: 8, CanOutputs: 8, VirtInputs: 8, Conditions: 8,
		Counters: 4, Flashers: 4,
		Keypads: 0, KeypadButtons: 0, KeypadDials: 0, KeypadAnalogs: 0,
		SysVars: 3, HasWipers: false, HasStarter: false,
		WiperSpeedMap: 0, WiperInterDelays: 0,
	},
	{
		// The hilux XIAO ESP32-C6 body node (hilux wireless-can/NODE.md): the
		// dingoFW core (vendored at wireless-can/dingo/dingoFW, v0.5.8) built
		// with the board directory wireless-can/dingo/c6body_v1, not a dingoFW
		// boards/ entry. CANBoard-sized logic and, so far, no local IO at all
		// (milestone 3 adds digital inputs and outputs, milestone 4 keypads;
		// each changes the param table AND shifts the var map, so this row
		// must change with that port.h). It broadcasts its type like a PDM
		// (PDM_TYPE 0xC), so its config is a PdmDevices entry with pdmType 12.
		//
		// Checked against the firmware itself, not just transcribed:
		// testdata/c6body_v1.fw.json is the real core built for the host by
		// tools/c6oracle (param table, var map, and apply/verify/read-back of
		// web/examples/c6-*.json), and TestC6AgainstFirmware compares.
		Name: "c6body_v1", Aliases: []string{"C6", "c6body"},
		Firmware: "hilux wireless-can/dingo/c6body_v1", PdmType: 12, DefaultBaseID: 0x500,
		Outputs: 0, DigInputs: 0, DigOutputs: 0, AnalogInputs: 0,
		CanInputs: 8, CanOutputs: 8, VirtInputs: 8, Conditions: 8,
		Counters: 4, Flashers: 4,
		Keypads: 0, KeypadButtons: 0, KeypadDials: 0, KeypadAnalogs: 0,
		SysVars: 3, HasWipers: false, HasStarter: false,
		WiperSpeedMap: 0, WiperInterDelays: 0,
	},
}

// Boards returns every known board, in table order.
func Boards() []Board { return append([]Board(nil), boards...) }

// BoardNames returns the canonical board names, for error messages.
func BoardNames() []string {
	out := make([]string, len(boards))
	for i, b := range boards {
		out[i] = b.Name
	}
	return out
}

// LookupBoard resolves a board by canonical name or alias, case-insensitively.
func LookupBoard(name string) (Board, bool) {
	want := strings.ToLower(strings.TrimSpace(name))
	for _, b := range boards {
		if strings.ToLower(b.Name) == want {
			return b, true
		}
		for _, a := range b.Aliases {
			if strings.ToLower(a) == want {
				return b, true
			}
		}
	}
	return Board{}, false
}

// DefaultBoard is dingopdm_v7, the variant the CLI has always assumed and the
// one every package-level helper in this package resolves against.
func DefaultBoard() Board { return boards[0] }

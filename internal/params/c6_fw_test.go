package params

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

// FwRecord is testdata/c6body_v1.fw.json: what the C6 body node's real
// dingoFW core, built for the host by tools/c6oracle, reports about itself
// and answers for web/examples/c6-*.json.
type FwRecord struct {
	DingoFW string `json:"dingoFW"`
	Board   struct {
		BaseID     int `json:"baseId"`
		NumParams  int `json:"numParams"`
		VarMapSize int `json:"varMapSize"`
		PdmType    int `json:"pdmType"`
	} `json:"board"`
	DefaultsCrc string   `json:"defaultsCrc"`
	Fatal       int      `json:"fatal"`
	VarMap      []string `json:"varMap"`
	Params      []struct {
		Index   uint16 `json:"index"`
		Sub     uint8  `json:"sub"`
		Type    string `json:"type"`
		Default uint32 `json:"default"`
		Min     uint32 `json:"min"`
		Max     uint32 `json:"max"`
	} `json:"params"`
}

func loadC6Record(t *testing.T) FwRecord {
	t.Helper()
	data, err := os.ReadFile("testdata/c6body_v1.fw.json")
	if err != nil {
		t.Fatal(err)
	}
	var r FwRecord
	if err := json.Unmarshal(data, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

// fwType is the firmware ParamType a registry type is stored as. A var-map
// reference is a plain UInt16 in the firmware, bounded by VAR_MAP_SIZE-1.
func fwType(t Type) string {
	switch t {
	case TBool:
		return "bool"
	case TU8:
		return "uint8"
	case TU16, TVarMap:
		return "uint16"
	case TU32:
		return "uint32"
	case TI8:
		return "int8"
	case TFloat:
		return "float"
	case TEnum:
		return "enum"
	}
	return "?"
}

// wire is a natural-units registry value as the firmware's uint32 column
// holds it (float bit pattern, sign-extended int8, else the integer).
func wire(t Type, v float64) uint32 {
	switch t {
	case TFloat:
		return math.Float32bits(float32(v))
	case TI8:
		return uint32(int32(v))
	}
	return uint32(v)
}

// TestC6AgainstFirmware checks the c6body_v1 board row against the firmware
// itself: the same parameters in the same order (the order is the CRC
// order), each with the firmware's type, default and range, and the same
// var map, name for name.
func TestC6AgainstFirmware(t *testing.T) {
	fw := loadC6Record(t)
	b, ok := LookupBoard("c6body_v1")
	if !ok {
		t.Fatal("no c6body_v1 board")
	}
	if fw.Fatal != -1 {
		t.Fatalf("the firmware core raised a fatal error (%d) while recording", fw.Fatal)
	}
	if b.PdmType != fw.Board.PdmType {
		t.Errorf("PdmType %d, firmware PDM_TYPE %d", b.PdmType, fw.Board.PdmType)
	}
	if b.DefaultBaseID != fw.Board.BaseID {
		t.Errorf("DefaultBaseID 0x%03X, firmware DEFAULT_BASE_ID 0x%03X", b.DefaultBaseID, fw.Board.BaseID)
	}
	r := NewRegistry(b)
	defs := r.All()
	if len(defs) != fw.Board.NumParams || len(fw.Params) != fw.Board.NumParams {
		t.Fatalf("registry has %d params, firmware NUM_PARAMS %d (table %d)", len(defs), fw.Board.NumParams, len(fw.Params))
	}
	for i, d := range defs {
		p := fw.Params[i]
		if d.Index != p.Index || d.Sub != p.Sub {
			t.Fatalf("param %d: registry %s is 0x%04X.%d, firmware has 0x%04X.%d", i, d.Name, d.Index, d.Sub, p.Index, p.Sub)
		}
		if got := fwType(d.Type); got != p.Type {
			t.Errorf("%s: type %s (%s), firmware %s", d.Name, d.Type, got, p.Type)
		}
		min, max, def := wire(d.Type, d.Min), wire(d.Type, d.Max), wire(d.Type, d.Default)
		if d.Type == TVarMap {
			min, max, def = 0, uint32(r.VarMapSize()-1), 0
		}
		if def != p.Default || min != p.Min || max != p.Max {
			t.Errorf("%s: default/min/max %d/%d/%d (wire), firmware %d/%d/%d", d.Name, def, min, max, p.Default, p.Min, p.Max)
		}
	}
	if r.VarMapSize() != fw.Board.VarMapSize || len(fw.VarMap) != fw.Board.VarMapSize {
		t.Fatalf("var map size %d, firmware VAR_MAP_SIZE %d (named %d)", r.VarMapSize(), fw.Board.VarMapSize, len(fw.VarMap))
	}
	for i, name := range fw.VarMap {
		if got := r.VarName(uint16(i)); got != name {
			t.Errorf("var %d: registry %q, firmware %q", i, got, name)
		}
	}
}

// TestBoardDefaultBaseIDs pins device.baseId's default to each board's
// DEFAULT_BASE_ID (port.h), which a config that omits baseId is written with.
func TestBoardDefaultBaseIDs(t *testing.T) {
	want := map[string]float64{"dingoPDM": 0x0DE, "dingoPDM-Max": 0x0DE, "PT-DPDM": 0x0DE, "CANBoard": 0x640, "c6body_v1": 0x500}
	for _, b := range Boards() {
		d, ok := NewRegistry(b).Lookup("device.baseId")
		if !ok {
			t.Fatalf("%s: no device.baseId", b.Name)
		}
		if d.Default != want[b.Name] {
			t.Errorf("%s: device.baseId default 0x%X, want 0x%X", b.Name, int(d.Default), int(want[b.Name]))
		}
	}
}

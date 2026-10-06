// Command golden prints, as JSON, what the native dingo CLI writes for a
// dingoConfig file: `go run ./web/test/golden <file.json> <base>`. The Node
// tests (web/test/wasm.test.mjs) compare dingo.encode() in the wasm build
// against it, so the browser and the CLI provably encode identically.
//
// It calls pdmcfg directly (what `dingo apply` encodes through) rather than
// the shared ops layer, so it is an independent oracle for the wasm path.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	"dingo-cli/internal/dingo"
	"dingo-cli/internal/pdmcfg"
)

type param struct {
	Index int `json:"index"`
	Sub   int `json:"sub"`
	Value int `json:"value"`
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: golden <dingoConfig.json> <base>")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	base, err := strconv.ParseUint(os.Args[2], 0, 16)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	ps, err := pdmcfg.DeviceParams(data, uint16(base))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	out := struct {
		Count  int     `json:"count"`
		CRC    string  `json:"crc"`
		Params []param `json:"params"`
	}{Count: len(ps), CRC: fmt.Sprintf("%08X", dingo.CRC(ps))}
	for _, p := range ps {
		out.Params = append(out.Params, param{int(p.Index), int(p.SubIndex), int(p.Value)})
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

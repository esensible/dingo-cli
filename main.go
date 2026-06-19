// Command dingo is a CLI for programming dingoPDM / dingoFW devices over their
// USB CDC port using the parameter (SDO-style) protocol.
//
//	dingo dump   -port <p> [-base 2000] [-o config.json]
//	dingo write  -port <p> [-base 2000] [-burn] config.json
//	dingo verify -port <p> [-base 2000]
//	dingo burn   -port <p> [-base 2000]
//	dingo bootloader -port <p> [-base 2000]
package main

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"time"

	"dingo-cli/internal/config"
	"dingo-cli/internal/dingo"
	"dingo-cli/internal/params"
	"dingo-cli/internal/slcan"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd := os.Args[1]

	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	port := fs.String("port", "", "serial port (e.g. /dev/cu.usbmodem8001)")
	base := fs.Uint("base", 222, "device base CAN id (firmware default 0x0DE)")
	bitrate := fs.Int("bitrate", 500000, "CAN bitrate")
	outFile := fs.String("o", "", "output file for dump (default stdout)")
	burn := fs.Bool("burn", false, "burn to flash after a successful write")
	secs := fs.Int("secs", 6, "listen duration in seconds")
	idx := fs.Uint("index", 0, "param index (get)")
	sub := fs.Uint("sub", 0, "param subindex (get)")
	txID := fs.Uint("id", 0, "raw CAN id to transmit (pulse)")
	txData := fs.String("data", "", "hex on-state payload (pulse)")
	ms := fs.Int("ms", 1000, "pulse duration in ms")
	watch := fs.Uint("watch", 0, "status CAN id to read back (pulse, 0=none)")
	repeat := fs.Int("repeat", 1, "number of pulse cycles")
	gap := fs.Int("gap", 1000, "off time between pulse cycles in ms")
	name := fs.String("name", "", "parameter name (get/set)")
	named := fs.Bool("named", false, "dump as a name->value config object")
	_ = fs.Parse(os.Args[2:])

	switch cmd {
	case "dump":
		cl := connect(*port, uint16(*base), *bitrate)
		defer cl.Close()
		ps, err := cl.ReadAll()
		check(err)
		if *named {
			dumpNamed(*outFile, ps)
		} else {
			dumpJSON(*outFile, ps)
		}
		fmt.Fprintf(os.Stderr, "read %d params\n", len(ps))

	case "defaults":
		// Emit the full registry as a name->default config (every parameter).
		m := make(map[string]interface{}, len(params.All()))
		for i := range params.All() {
			d := params.All()[i]
			m[d.Name] = d.Default
		}
		b, err := json.MarshalIndent(m, "", "  ")
		check(err)
		b = append(b, '\n')
		if *outFile == "" {
			os.Stdout.Write(b)
		} else {
			check(os.WriteFile(*outFile, b, 0o644))
		}
		fmt.Fprintf(os.Stderr, "wrote %d default params\n", len(m))

	case "apply":
		args := fs.Args()
		if len(args) != 1 {
			fatal("apply requires exactly one config file argument")
		}
		cfg := loadNamedConfig(args[0])
		cl := connect(*port, uint16(*base), *bitrate)
		defer cl.Close()
		check(cl.WriteAll(cfg))
		fmt.Printf("applied %d params (count + CRC verified)\n", len(cfg))
		if *burn {
			check(cl.Burn())
			fmt.Println("burned to flash")
		}

	case "set":
		args := fs.Args()
		if len(args) != 2 {
			fatal("set requires <name> <value>")
		}
		d, ok := params.Lookup(args[0])
		if !ok {
			fatal("unknown param: " + args[0])
		}
		val, err := params.Encode(d, args[1])
		check(err)
		cl := connect(*port, uint16(*base), *bitrate)
		defer cl.Close()
		check(cl.SetParam(d.Index, d.Sub, val))
		fmt.Printf("set %s = %v (index=0x%04X sub=%d value=0x%X)\n", d.Name, params.Decode(d, val), d.Index, d.Sub, val)
		if *burn {
			check(cl.Burn())
			fmt.Println("burned to flash")
		}

	case "getn":
		if *name == "" {
			fatal("getn requires -name")
		}
		d, ok := params.Lookup(*name)
		if !ok {
			fatal("unknown param: " + *name)
		}
		cl := connect(*port, uint16(*base), *bitrate)
		defer cl.Close()
		v, err := cl.ReadParam(d.Index, d.Sub)
		check(err)
		fmt.Printf("%s = %v (index=0x%04X sub=%d raw=0x%X)\n", d.Name, params.Decode(d, v), d.Index, d.Sub, v)

	case "write":
		args := fs.Args()
		if len(args) != 1 {
			fatal("write requires exactly one config file argument")
		}
		params := loadJSON(args[0])
		cl := connect(*port, uint16(*base), *bitrate)
		defer cl.Close()
		check(cl.WriteAll(params))
		fmt.Printf("wrote %d params (count + CRC verified)\n", len(params))
		if *burn {
			check(cl.Burn())
			fmt.Println("burned to flash")
		}

	case "verify":
		cl := connect(*port, uint16(*base), *bitrate)
		defer cl.Close()
		crc, err := cl.CheckCrc()
		check(err)
		fmt.Printf("device config CRC = %08X\n", crc)

	case "version":
		cl := connect(*port, uint16(*base), *bitrate)
		defer cl.Close()
		maj, min, bld, err := cl.Version()
		check(err)
		fmt.Printf("firmware v%d.%d.%d\n", maj, min, bld)

	case "tx":
		if *port == "" {
			fatal("missing -port")
		}
		d, err := hex.DecodeString(*txData)
		check(err)
		if len(d) == 0 || len(d) > 8 {
			fatal("-data must be 1-8 hex bytes")
		}
		// Send exactly the bytes given (DLC = len), not padded to 8 — some
		// firmware checks DLC exactly (e.g. the old bootloader command is DLC 6).
		p, err := slcan.Open(*port, *bitrate)
		check(err)
		defer p.Close()
		id := uint16(*txID)
		check(p.Send(slcan.Frame{ID: id, Data: d}))
		fmt.Printf("sent 0x%03X <- %X (DLC %d)\n", id, d, len(d))
		if w := uint16(*watch); w != 0 {
			fmt.Printf("  status 0x%03X = %X (live)\n", w, readFrame(p, w, 600*time.Millisecond))
		}

	case "pulse":
		if *port == "" {
			fatal("missing -port")
		}
		on, err := hex.DecodeString(*txData)
		check(err)
		if len(on) == 0 || len(on) > 8 {
			fatal("-data must be 1-8 hex bytes")
		}
		onFrame := make([]byte, 8)
		copy(onFrame, on)
		p, err := slcan.Open(*port, *bitrate)
		check(err)
		defer p.Close()
		id := uint16(*txID)
		w := uint16(*watch)
		off := make([]byte, 8)
		inf := *repeat <= 0 // repeat <= 0 means pulse forever
		for r := 1; inf || r <= *repeat; r++ {
			check(p.Send(slcan.Frame{ID: id, Data: onFrame}))
			fmt.Printf("[%d] sent 0x%03X <- %X (on)\n", r, id, onFrame)
			if w != 0 {
				fmt.Printf("    status 0x%03X = %X\n", w, readFrame(p, w, 600*time.Millisecond))
			}
			time.Sleep(time.Duration(*ms) * time.Millisecond)
			check(p.Send(slcan.Frame{ID: id, Data: off}))
			fmt.Printf("[%d] sent 0x%03X <- %X (off) after %dms\n", r, id, off, *ms)
			if w != 0 {
				fmt.Printf("    status 0x%03X = %X\n", w, readFrame(p, w, 600*time.Millisecond))
			}
			if inf || r < *repeat {
				time.Sleep(time.Duration(*gap) * time.Millisecond)
			}
		}

	case "raw":
		if *port == "" {
			fatal("missing -port")
		}
		d, err := hex.DecodeString(*txData)
		check(err)
		if len(d) == 0 || len(d) > 8 {
			fatal("-data must be 1-8 hex bytes")
		}
		check(slcan.WriteRaw(*port, d))
		fmt.Printf("wrote %d raw bytes to %s: %X\n", len(d), *port, d)

	case "get":
		cl := connect(*port, uint16(*base), *bitrate)
		defer cl.Close()
		v, err := cl.ReadParam(uint16(*idx), uint8(*sub))
		check(err)
		fmt.Printf("index=0x%04X sub=%d value=%d (0x%X)\n", *idx, *sub, v, v)

	case "burn":
		cl := connect(*port, uint16(*base), *bitrate)
		defer cl.Close()
		check(cl.Burn())
		fmt.Println("burned to flash (verified)")

	case "bootloader":
		cl := connect(*port, uint16(*base), *bitrate)
		check(cl.Bootloader())
		fmt.Println("bootloader requested — device resetting to DFU")

	case "listen":
		if *port == "" {
			fatal("missing -port")
		}
		p, err := slcan.Open(*port, *bitrate)
		check(err)
		defer p.Close()
		// Passive bus monitor: capture every frame and summarize by ID.
		type stat struct {
			count int
			last  []byte
		}
		seen := map[uint16]*stat{}
		deadline := time.Now().Add(time.Duration(*secs) * time.Second)
		total := 0
		for time.Now().Before(deadline) {
			f, err := p.Recv(500 * time.Millisecond)
			if err != nil {
				continue
			}
			total++
			s := seen[f.ID]
			if s == nil {
				s = &stat{}
				seen[f.ID] = s
			}
			s.count++
			s.last = f.Data
		}
		ids := make([]int, 0, len(seen))
		for id := range seen {
			ids = append(ids, int(id))
		}
		sort.Ints(ids)
		fmt.Printf("captured %d frames over %ds, %d distinct IDs:\n", total, *secs, len(ids))
		for _, id := range ids {
			s := seen[uint16(id)]
			fmt.Printf("  id=0x%03X (%d)  count=%-5d last=%X\n", id, id, s.count, s.last)
		}

	default:
		usage()
		os.Exit(2)
	}
}

func connect(port string, base uint16, bitrate int) *dingo.Client {
	if port == "" {
		fatal("missing -port")
	}
	p, err := slcan.Open(port, bitrate)
	check(err)
	return dingo.New(p, base)
}

func loadJSON(path string) []dingo.Param {
	b, err := os.ReadFile(path)
	check(err)
	var params []dingo.Param
	check(json.Unmarshal(b, &params))
	return params
}

// loadNamedConfig reads a name->value config object and resolves it to wire
// params. WriteAll resets the device to firmware defaults before applying these,
// so the file is the full desired non-default state (declarative).
func loadNamedConfig(path string) []dingo.Param {
	b, err := os.ReadFile(path)
	check(err)
	var raw map[string]interface{}
	check(json.Unmarshal(b, &raw))
	cfg, err := config.Resolve(raw)
	check(err)
	return cfg
}

// dumpNamed writes a name->value config object, decoding each param to its
// human-friendly form (bool/number/enum name/var name).
func dumpNamed(path string, ps []dingo.Param) {
	b, err := json.MarshalIndent(config.Named(ps), "", "  ")
	check(err)
	b = append(b, '\n')
	if path == "" {
		os.Stdout.Write(b)
		return
	}
	check(os.WriteFile(path, b, 0o644))
}

func dumpJSON(path string, params []dingo.Param) {
	b, err := json.MarshalIndent(params, "", "  ")
	check(err)
	b = append(b, '\n')
	if path == "" {
		os.Stdout.Write(b)
		return
	}
	check(os.WriteFile(path, b, 0o644))
}

func readFrame(p *slcan.Port, id uint16, timeout time.Duration) []byte {
	time.Sleep(150 * time.Millisecond) // let the command take effect on the device
	p.Flush()                          // discard backlog so we read the live state
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		f, err := p.Recv(time.Until(deadline))
		if err != nil {
			return nil
		}
		if f.ID == id {
			return f.Data
		}
	}
	return nil
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: dingo <command> -port <p> [-base 222] [flags] [args]")
	fmt.Fprintln(os.Stderr, "commands:")
	fmt.Fprintln(os.Stderr, "  apply <config.json> [-burn]   declarative name-based config (resets to defaults, then applies)")
	fmt.Fprintln(os.Stderr, "  set <name> <value> [-burn]    write one parameter by name")
	fmt.Fprintln(os.Stderr, "  getn -name <name>             read one parameter by name")
	fmt.Fprintln(os.Stderr, "  dump [-named] [-o file]       read all parameters (raw or name->value)")
	fmt.Fprintln(os.Stderr, "  write <config.json> [-burn]   write raw index/sub/value params")
	fmt.Fprintln(os.Stderr, "  get -index <i> -sub <s>       read one raw parameter")
	fmt.Fprintln(os.Stderr, "  verify | burn | version | bootloader | listen | tx | pulse")
}

func check(err error) {
	if err != nil {
		fatal(err.Error())
	}
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, "error:", msg)
	os.Exit(1)
}

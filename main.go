// Command dingo is a CLI for programming dingoPDM devices over their USB CDC
// port. It applies dingoConfig .json config files to a device by mapping them to
// the firmware parameter (SDO-style) protocol — the same file format the
// dingoConfig GUI reads and writes.
//
// Each subcommand owns its own flag set; run "dingo <command> -h" for details.
// The common device flags are -port, -base (default 222 = 0x0DE) and -bitrate.
package main

import (
	"bytes"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"time"

	"dingo-cli/internal/dingo"
	"dingo-cli/internal/ops"
	"dingo-cli/internal/slcan"
)

// command is one CLI subcommand. run parses its own flags and executes,
// returning an error instead of exiting so main is the single exit point.
type command struct {
	name    string
	summary string
	run     func(args []string) error
}

var commands = []command{
	{"apply", "apply a dingoConfig .json file to the device [-burn] [-partial]", runApply},
	{"set", "write one parameter by name: set <name> <value> [-burn]", runSet},
	{"getn", "read one parameter by name (-name)", runGetn},
	{"get", "read one raw parameter (-index -sub)", runGet},
	{"verify", "print the device config CRC", runVerify},
	{"version", "read the firmware version", runVersion},
	{"burn", "persist the live config to flash", runBurn},
	{"bootloader", "reset the device into the DFU bootloader", runBootloader},
	{"listen", "passive bus monitor (-secs)", runListen},
	{"tx", "send one CAN frame (-id -data [-watch])", runTx},
	{"pulse", "toggle a frame on/off (-id -data -ms -gap -repeat [-watch])", runPulse},
	{"raw", "write raw CDC bytes, no SLCAN framing (-port -data)", runRaw},
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	name := os.Args[1]
	for _, c := range commands {
		if c.name == name {
			if err := c.run(os.Args[2:]); err != nil {
				fmt.Fprintln(os.Stderr, "error:", err)
				os.Exit(1)
			}
			return
		}
	}
	fmt.Fprintf(os.Stderr, "unknown command %q\n\n", name)
	usage()
	os.Exit(2)
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: dingo <command> [flags] [args]")
	fmt.Fprintln(os.Stderr, "\ncommands:")
	for _, c := range commands {
		fmt.Fprintf(os.Stderr, "  %-11s %s\n", c.name, c.summary)
	}
	fmt.Fprintln(os.Stderr, "\nrun 'dingo <command> -h' for command-specific flags")
}

// conn holds the shared device-connection flags and owns the port lifecycle so
// the port is always closed, including on error paths.
type conn struct {
	port    *string
	base    *uint
	bitrate *int
}

func addConn(fs *flag.FlagSet) *conn {
	return &conn{
		port:    fs.String("port", "", "serial port (e.g. /dev/cu.usbmodem8001)"),
		base:    fs.Uint("base", 222, "device base CAN id (firmware default 0x0DE)"),
		bitrate: fs.Int("bitrate", 500000, "CAN bitrate"),
	}
}

func (c *conn) open() (*slcan.Port, error) {
	if *c.port == "" {
		return nil, errors.New("missing -port")
	}
	p, err := slcan.Open(*c.port, *c.bitrate)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", *c.port, err)
	}
	return p, nil
}

// client runs fn with a protocol client, guaranteeing the port is closed.
func (c *conn) client(fn func(*dingo.Client) error) error {
	p, err := c.open()
	if err != nil {
		return err
	}
	defer p.Close()
	return fn(dingo.New(p, uint16(*c.base)))
}

// withPort runs fn with the raw SLCAN port, guaranteeing it is closed.
func (c *conn) withPort(fn func(*slcan.Port) error) error {
	p, err := c.open()
	if err != nil {
		return err
	}
	defer p.Close()
	return fn(p)
}

// parseArgs parses fs but, unlike a bare fs.Parse, tolerates positional
// arguments appearing before, after, or between flags (Go's flag package
// otherwise stops at the first non-flag token). It returns the positionals in
// order. This lets "apply file.json -port X" and "apply -port X file.json" both
// work, matching how the docs and `-h` present the command.
func parseArgs(fs *flag.FlagSet, args []string) []string {
	var positionals []string
	for {
		fs.Parse(args)
		args = fs.Args()
		if len(args) == 0 {
			return positionals
		}
		positionals = append(positionals, args[0])
		args = args[1:]
	}
}

// addType adds -type: the board (pdmType) whose parameter table and var map
// set/getn resolve names against.
func addType(fs *flag.FlagSet) *int {
	return fs.Int("type", 0, "board type (pdmType): 0 dingoPDM, 1 dingoPDM-Max, 2 PT-DPDM, 12 c6body_v1")
}

// typeListen is how long apply waits for the node's status frame (sent every
// 100 ms, CAN_TX_CYCLIC_MSG_DELAY) to read its board type.
const typeListen = 350 * time.Millisecond

// maybeBurn persists to flash when -burn was given.
func maybeBurn(cl *dingo.Client, burn bool) error {
	if !burn {
		return nil
	}
	if err := ops.Burn(cl); err != nil {
		return err
	}
	fmt.Println("burned to flash")
	return nil
}

func runApply(args []string) error {
	fs := flag.NewFlagSet("apply", flag.ExitOnError)
	c := addConn(fs)
	burn := fs.Bool("burn", false, "burn to flash after a successful apply")
	partial := fs.Bool("partial", false,
		"write only the fields the file mentions, leaving the device's previous value for the rest "+
			"(the default is to write every parameter, defaulting anything absent)")
	noTypeCheck := fs.Bool("no-type-check", false,
		"skip comparing the board type the node broadcasts (status frame base+2) with the config's pdmType")
	rest := parseArgs(fs, args)
	if len(rest) != 1 {
		return errors.New("apply requires exactly one dingoConfig .json file argument")
	}
	data, err := os.ReadFile(rest[0])
	if err != nil {
		return err
	}
	cfg, err := ops.EncodeConfig(data, uint16(*c.base), *partial)
	if err != nil {
		return err
	}
	board, err := ops.ConfigBoard(data, uint16(*c.base))
	if err != nil {
		return err
	}
	return c.withPort(func(p *slcan.Port) error {
		base := uint16(*c.base)
		if !*noTypeCheck && !board.IsCanboard {
			typ, seen := ops.BroadcastType(p, base, typeListen)
			if !seen {
				fmt.Printf("note: no status frame on 0x%03X within %v; board type not checked\n", base+2, typeListen)
			} else if err := ops.CheckType(board, base, typ); err != nil {
				return fmt.Errorf("refusing to apply: %w (-no-type-check overrides)", err)
			}
		}
		cl := dingo.New(p, base)
		res, err := ops.Apply(cl, cfg, ops.ApplyOptions{Burn: *burn, AfterWrite: func(n int) {
			how := "every parameter on the board"
			if *partial {
				how = "only the fields the file sets"
			}
			fmt.Printf("applied %d params from %s — %s (count + CRC verified)\n", n, rest[0], how)
		}})
		if err != nil {
			return err
		}
		if res.Burned {
			fmt.Println("burned to flash")
		}
		return nil
	})
}

func runSet(args []string) error {
	fs := flag.NewFlagSet("set", flag.ExitOnError)
	c := addConn(fs)
	burn := fs.Bool("burn", false, "burn to flash after a successful set")
	typ := addType(fs)
	rest := parseArgs(fs, args)
	if len(rest) != 2 {
		return errors.New("set requires <name> <value>")
	}
	b, err := ops.Board(*typ)
	if err != nil {
		return err
	}
	d, val, err := ops.EncodeParamFor(b, rest[0], rest[1])
	if err != nil {
		return err
	}
	return c.client(func(cl *dingo.Client) error {
		pv, err := ops.SetFor(cl, b, d, val)
		if err != nil {
			return err
		}
		fmt.Printf("set %s = %v (index=0x%04X sub=%d value=0x%X)\n", d.Name, pv.Value, d.Index, d.Sub, pv.Raw)
		return maybeBurn(cl, *burn)
	})
}

func runGetn(args []string) error {
	fs := flag.NewFlagSet("getn", flag.ExitOnError)
	c := addConn(fs)
	name := fs.String("name", "", "parameter name")
	typ := addType(fs)
	fs.Parse(args)
	if *name == "" {
		return errors.New("getn requires -name")
	}
	b, err := ops.Board(*typ)
	if err != nil {
		return err
	}
	d, err := ops.ResolveParamFor(b, *name)
	if err != nil {
		return err
	}
	return c.client(func(cl *dingo.Client) error {
		pv, err := ops.GetFor(cl, b, d)
		if err != nil {
			return err
		}
		fmt.Printf("%s = %v (index=0x%04X sub=%d raw=0x%X)\n", d.Name, pv.Value, d.Index, d.Sub, pv.Raw)
		return nil
	})
}

func runGet(args []string) error {
	fs := flag.NewFlagSet("get", flag.ExitOnError)
	c := addConn(fs)
	idx := fs.Uint("index", 0, "param index")
	sub := fs.Uint("sub", 0, "param subindex")
	fs.Parse(args)
	return c.client(func(cl *dingo.Client) error {
		v, err := ops.GetRaw(cl, uint16(*idx), uint8(*sub))
		if err != nil {
			return err
		}
		fmt.Printf("index=0x%04X sub=%d value=%d (0x%X)\n", *idx, *sub, v, v)
		return nil
	})
}

func runVerify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	c := addConn(fs)
	fs.Parse(args)
	return c.client(func(cl *dingo.Client) error {
		crc, err := ops.Verify(cl)
		if err != nil {
			return err
		}
		fmt.Printf("device config CRC = %08X\n", crc)
		return nil
	})
}

func runVersion(args []string) error {
	fs := flag.NewFlagSet("version", flag.ExitOnError)
	c := addConn(fs)
	fs.Parse(args)
	return c.client(func(cl *dingo.Client) error {
		v, err := ops.ReadVersion(cl)
		if err != nil {
			return err
		}
		fmt.Printf("firmware v%d.%d.%d\n", v.Major, v.Minor, v.Build)
		return nil
	})
}

func runBurn(args []string) error {
	fs := flag.NewFlagSet("burn", flag.ExitOnError)
	c := addConn(fs)
	fs.Parse(args)
	return c.client(func(cl *dingo.Client) error {
		if err := ops.Burn(cl); err != nil {
			return err
		}
		fmt.Println("burned to flash (verified)")
		return nil
	})
}

func runBootloader(args []string) error {
	fs := flag.NewFlagSet("bootloader", flag.ExitOnError)
	c := addConn(fs)
	fs.Parse(args)
	p, err := c.open()
	if err != nil {
		return err
	}
	// Intentionally do NOT close the port. The device resets into the DFU
	// bootloader immediately, so the SLCAN close sequence ("C\r") would be
	// written to a vanishing port and could error or hang. The process exits
	// right after this, which releases the fd.
	if err := dingo.New(p, uint16(*c.base)).Bootloader(); err != nil {
		return err
	}
	fmt.Println("bootloader requested — device resetting to DFU")
	return nil
}

func runListen(args []string) error {
	fs := flag.NewFlagSet("listen", flag.ExitOnError)
	c := addConn(fs)
	secs := fs.Int("secs", 6, "listen duration in seconds")
	changes := fs.Bool("changes", false, "also print each frame whose data differs from that ID's previous frame, timestamped")
	fs.Parse(args)
	return c.withPort(func(p *slcan.Port) error {
		type stat struct {
			count int
			last  []byte
		}
		seen := map[uint16]*stat{}
		start := time.Now()
		deadline := start.Add(time.Duration(*secs) * time.Second)
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
			if *changes && (s.count == 0 || !bytes.Equal(s.last, f.Data)) {
				fmt.Printf("%8.3fs  id=0x%03X  %X\n", time.Since(start).Seconds(), f.ID, f.Data)
			}
			s.count++
			s.last = append(s.last[:0], f.Data...)
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
		return nil
	})
}

func runTx(args []string) error {
	fs := flag.NewFlagSet("tx", flag.ExitOnError)
	c := addConn(fs)
	id := fs.Uint("id", 0, "raw CAN id to transmit")
	data := fs.String("data", "", "hex payload (1-8 bytes)")
	watch := fs.Uint("watch", 0, "status CAN id to read back (0=none)")
	fs.Parse(args)
	d, err := txData(*data, *id)
	if err != nil {
		return err
	}
	return c.withPort(func(p *slcan.Port) error {
		fid := uint16(*id)
		// Send exactly the bytes given (DLC = len), not padded to 8 — some
		// firmware checks DLC exactly (e.g. the old bootloader command is DLC 6).
		if err := p.Send(slcan.Frame{ID: fid, Data: d}); err != nil {
			return err
		}
		fmt.Printf("sent 0x%03X <- %X (DLC %d)\n", fid, d, len(d))
		if w := uint16(*watch); w != 0 {
			fmt.Printf("  status 0x%03X = %X (live)\n", w, readFrame(p, w, 600*time.Millisecond))
		}
		return nil
	})
}

func runPulse(args []string) error {
	fs := flag.NewFlagSet("pulse", flag.ExitOnError)
	c := addConn(fs)
	id := fs.Uint("id", 0, "raw CAN id")
	data := fs.String("data", "", "hex on-state payload")
	ms := fs.Int("ms", 1000, "on duration in ms")
	gap := fs.Int("gap", 1000, "off duration between cycles in ms")
	repeat := fs.Int("repeat", 1, "number of cycles (0 = forever)")
	watch := fs.Uint("watch", 0, "status CAN id to read back (0=none)")
	fs.Parse(args)
	on, err := txData(*data, *id)
	if err != nil {
		return err
	}
	return c.withPort(func(p *slcan.Port) error {
		onFrame := make([]byte, 8) // pad to 8: CANBoard output frames need DLC>=4
		copy(onFrame, on)
		off := make([]byte, 8)
		fid := uint16(*id)
		w := uint16(*watch)
		inf := *repeat <= 0 // repeat <= 0 means pulse forever
		for r := 1; inf || r <= *repeat; r++ {
			if err := p.Send(slcan.Frame{ID: fid, Data: onFrame}); err != nil {
				return err
			}
			fmt.Printf("[%d] sent 0x%03X <- %X (on)\n", r, fid, onFrame)
			if w != 0 {
				fmt.Printf("    status 0x%03X = %X\n", w, readFrame(p, w, 600*time.Millisecond))
			}
			time.Sleep(time.Duration(*ms) * time.Millisecond)
			if err := p.Send(slcan.Frame{ID: fid, Data: off}); err != nil {
				return err
			}
			fmt.Printf("[%d] sent 0x%03X <- %X (off) after %dms\n", r, fid, off, *ms)
			if w != 0 {
				fmt.Printf("    status 0x%03X = %X\n", w, readFrame(p, w, 600*time.Millisecond))
			}
			if inf || r < *repeat {
				time.Sleep(time.Duration(*gap) * time.Millisecond)
			}
		}
		return nil
	})
}

func runRaw(args []string) error {
	fs := flag.NewFlagSet("raw", flag.ExitOnError)
	port := fs.String("port", "", "serial port (e.g. /dev/cu.usbmodem8001)")
	data := fs.String("data", "", "hex bytes (1-8)")
	fs.Parse(args)
	if *port == "" {
		return errors.New("missing -port")
	}
	d, err := hex.DecodeString(*data)
	if err != nil {
		return err
	}
	if len(d) == 0 || len(d) > 8 {
		return errors.New("-data must be 1-8 hex bytes")
	}
	if err := slcan.WriteRaw(*port, d); err != nil {
		return err
	}
	fmt.Printf("wrote %d raw bytes to %s: %X\n", len(d), *port, d)
	return nil
}

// txData decodes and validates a hex payload and the 11-bit id for tx/pulse.
func txData(data string, id uint) ([]byte, error) {
	d, err := hex.DecodeString(data)
	if err != nil {
		return nil, err
	}
	if len(d) == 0 || len(d) > 8 {
		return nil, errors.New("-data must be 1-8 hex bytes")
	}
	if id > 0x7FF {
		return nil, fmt.Errorf("-id 0x%X exceeds the 11-bit range (max 0x7FF); extended IDs are not supported", id)
	}
	return d, nil
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

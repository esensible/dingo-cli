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
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"dingo-cli/internal/dingo"
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
	base := fs.Uint("base", 2000, "device base CAN id")
	bitrate := fs.Int("bitrate", 500000, "CAN bitrate")
	outFile := fs.String("o", "", "output file for dump (default stdout)")
	burn := fs.Bool("burn", false, "burn to flash after a successful write")
	secs := fs.Int("secs", 6, "listen duration in seconds")
	_ = fs.Parse(os.Args[2:])

	switch cmd {
	case "dump":
		cl := connect(*port, uint16(*base), *bitrate)
		defer cl.Close()
		params, err := cl.ReadAll()
		check(err)
		dumpJSON(*outFile, params)
		fmt.Fprintf(os.Stderr, "read %d params\n", len(params))

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
		cl := dingo.New(p, uint16(*base))
		_ = cl.SendReadAll()
		deadline := time.Now().Add(time.Duration(*secs) * time.Second)
		n := 0
		for time.Now().Before(deadline) {
			f, err := p.Recv(500 * time.Millisecond)
			if err != nil {
				continue
			}
			n++
			if n <= 50 {
				fmt.Printf("id=%03X data=%X\n", f.ID, f.Data)
			}
		}
		fmt.Printf("received %d frames\n", n)

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

func usage() {
	fmt.Fprintln(os.Stderr, "usage: dingo <dump|write|verify|burn|bootloader> -port <p> [-base 2000] [flags] [config.json]")
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

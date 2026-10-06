// canflood: bench CAN stress generator, written for the hilux C6 CAN overrun
// investigation (2026-10-06) and kept as the receive-path stress test. It
// talks SLCAN to a dingoPDM's USB port (the PDM bridges it onto the bus).
//
// The PDM's SLCAN-to-CAN path drops whole USB writes when pushed hard:
// at ~3000 frames/s use -batch 4 (or lower the rate) or sequence gaps measure
// the PDM, not the device under test. Not part of the dingo CLI build.
//
//	canflood -port P -secs N flood
//	    back-to-back frames on -id (0x7F0), payload = u32 LE seq + ^seq
//	canflood -port P -n K readall
//	    K read-only ReadAll requests (cmd 10) to -base+1 (0x701), counting
//	    the responses on -base the SLCAN host sees; waits for 1.5 s quiet.
//	canflood -port P -secs N -every S mixed
//	    flood S seconds, one ReadAll, repeat for N seconds.
package main

import (
	"encoding/binary"
	"flag"
	"fmt"
	"os"
	"strconv"
	"time"

	"go.bug.st/serial"
)

type frame struct {
	id   uint16
	data []byte
}

func line(id uint16, d []byte) []byte {
	s := fmt.Sprintf("t%03X%X", id&0x7FF, len(d))
	for _, b := range d {
		s += fmt.Sprintf("%02X", b)
	}
	return []byte(s + "\r")
}

func main() {
	portName := flag.String("port", "/dev/cu.usbmodem8001", "")
	secs := flag.Int("secs", 10, "")
	id := flag.Uint("id", 0x7F0, "")
	batch := flag.Int("batch", 32, "")
	base := flag.Uint("base", 0x700, "")
	n := flag.Int("n", 1, "")
	every := flag.Int("every", 15, "")
	rate := flag.Int("rate", 0, "frames/s cap (0 = as fast as the port takes them)")
	// The C6 node only (base 0x500, hardcoded so the bench PDM is never
	// burned): one burn request this many seconds into each flood, 0 = none.
	c6burn := flag.Int("c6burn", 0, "seconds into each flood to send one burn request to the C6 (0x501); 0 = never")
	alt := flag.Bool("alt", false, "mixed: alternate ReadAll between -base and the C6 (0x500)")
	flag.Parse()
	mode := flag.Arg(0)

	p, err := serial.Open(*portName, &serial.Mode{BaudRate: 115200})
	if err != nil {
		fmt.Println("open:", err)
		os.Exit(1)
	}
	defer p.Close()
	p.SetReadTimeout(50 * time.Millisecond)
	for _, c := range []string{"C\r", "S6\r", "O\r"} {
		p.Write([]byte(c))
	}
	frames := make(chan frame, 65536)
	go func() {
		tmp := make([]byte, 4096)
		var l []byte
		for {
			k, err := p.Read(tmp)
			if err != nil {
				return
			}
			for _, b := range tmp[:k] {
				if b != '\r' {
					l = append(l, b)
					continue
				}
				if len(l) >= 5 && l[0] == 't' {
					fid, _ := strconv.ParseUint(string(l[1:4]), 16, 16)
					dlc, _ := strconv.ParseUint(string(l[4:5]), 16, 8)
					if len(l) >= 5+int(dlc)*2 {
						d := make([]byte, dlc)
						for i := range d {
							v, _ := strconv.ParseUint(string(l[5+2*i:7+2*i]), 16, 8)
							d[i] = byte(v)
						}
						select {
						case frames <- frame{uint16(fid), d}:
						default:
						}
					}
				}
				l = l[:0]
			}
		}
	}()
	time.Sleep(1500 * time.Millisecond)
	drain := func() {
		for {
			select {
			case f := <-frames:
				if f.id == 0x500 && len(f.data) >= 1 && f.data[0] == 30 {
					fmt.Printf("%s c6 burn ack: % X\n", time.Now().Format("15:04:05.000"), f.data)
				}
			default:
				return
			}
		}
	}

	var seq uint32
	flood := func(d time.Duration) {
		end := time.Now().Add(d)
		start := time.Now()
		first := seq
		burnDue := time.Time{}
		if *c6burn > 0 {
			burnDue = start.Add(time.Duration(*c6burn) * time.Second)
		}
		for time.Now().Before(end) {
			if !burnDue.IsZero() && time.Now().After(burnDue) {
				burnDue = time.Time{}
				fmt.Printf("%s c6 burn request sent (seq %d)\n", time.Now().Format("15:04:05.000"), seq)
				p.Write(line(0x501, []byte{30, 1, 3, 8, 0, 0, 0, 0}))
			}
			buf := make([]byte, 0, *batch*22)
			for i := 0; i < *batch; i++ {
				data := make([]byte, 8)
				binary.LittleEndian.PutUint32(data[0:4], seq)
				binary.LittleEndian.PutUint32(data[4:8], ^seq)
				buf = append(buf, line(uint16(*id), data)...)
				seq++
			}
			if _, err := p.Write(buf); err != nil {
				fmt.Println("write:", err)
				return
			}
			drain()
			if *rate > 0 {
				due := start.Add(time.Duration(float64(seq-first) / float64(*rate) * float64(time.Second)))
				time.Sleep(time.Until(due))
			}
		}
		el := time.Since(start).Seconds()
		fmt.Printf("%s flood:", time.Now().Format("15:04:05.000"))
		fmt.Printf(" seq %d..%d, %d frames written in %.1f s (%.0f/s)\n", first, seq-1, seq-first, el, float64(seq-first)/el)
	}
	readAll := func(i int) {
		drain()
		b := *base
		if *alt && i%2 == 0 {
			b = 0x500
		}
		req := make([]byte, 8)
		req[0] = 10
		p.Write(line(uint16(b+1), req))
		rsp, complete := 0, -1
		last := time.Now().Add(1500 * time.Millisecond)
		for time.Since(last) < 1500*time.Millisecond {
			select {
			case f := <-frames:
				if f.id == uint16(b) && len(f.data) == 8 {
					last = time.Now()
					switch f.data[0] {
					case 11:
						rsp++
					case 12:
						complete = int(binary.LittleEndian.Uint16(f.data[1:3]))
					}
				}
			case <-time.After(100 * time.Millisecond):
			}
		}
		fmt.Printf("%s readall %d (base %#x): host saw %d responses, device complete count %d\n", time.Now().Format("15:04:05.000"), i, b, rsp, complete)
	}

	switch mode {
	case "flood":
		flood(time.Duration(*secs) * time.Second)
	case "readall":
		for i := 1; i <= *n; i++ {
			readAll(i)
		}
	case "mixed":
		end := time.Now().Add(time.Duration(*secs) * time.Second)
		for i := 1; time.Now().Before(end); i++ {
			flood(time.Duration(*every) * time.Second)
			readAll(i)
		}
	default:
		fmt.Println("mode: flood | readall | mixed")
		os.Exit(2)
	}
	p.Write([]byte("C\r"))
}

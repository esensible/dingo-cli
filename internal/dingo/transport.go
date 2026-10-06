package dingo

import (
	"time"

	"dingo-cli/internal/canframe"
)

// Transport is the frame-level interface the Client needs. *slcan.Port satisfies
// it as-is (slcan.Frame is an alias of canframe.Frame); an in-memory fake
// satisfies it in tests, and a JavaScript-supplied transport satisfies it in the
// js/wasm build, so the protocol layer never depends on the serial port package.
type Transport interface {
	Send(f canframe.Frame) error
	Recv(timeout time.Duration) (canframe.Frame, error)
	Close() error
}

// Clock abstracts time so retry/timeout logic is deterministically testable.
type Clock interface {
	Now() time.Time
	Since(t time.Time) time.Duration
	Sleep(d time.Duration)
}

type realClock struct{}

func (realClock) Now() time.Time                  { return time.Now() }
func (realClock) Since(t time.Time) time.Duration { return time.Since(t) }
func (realClock) Sleep(d time.Duration)           { time.Sleep(d) }

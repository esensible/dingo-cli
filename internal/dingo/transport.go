package dingo

import (
	"time"

	"dingo-cli/internal/slcan"
)

// Transport is the frame-level interface the Client needs. *slcan.Port satisfies
// it as-is; an in-memory fake satisfies it in tests, so the entire protocol layer
// is testable without hardware.
type Transport interface {
	Send(f slcan.Frame) error
	Recv(timeout time.Duration) (slcan.Frame, error)
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

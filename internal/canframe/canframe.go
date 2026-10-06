// Package canframe defines the classic 11-bit CAN frame shared by every
// transport (SLCAN over USB, and the browser's JavaScript-supplied transport in
// the js/wasm build).
//
// It exists so the protocol layer (internal/dingo) can name a frame without
// importing internal/slcan, whose serial-port dependency does not compile for
// js/wasm. slcan.Frame is an alias of this type, so native code is unchanged.
package canframe

// Frame is a classic 11-bit CAN frame.
type Frame struct {
	ID   uint16
	Data []byte // 0..8 bytes
}

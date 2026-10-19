// ota-client.js — a firmware update for the ESP32-C6, the browser's side,
// whatever protocol carries it (plain ES module, no dependencies; Web Crypto
// for SHA-256):
//
//   checkImage(bytes, maxLen)   the image checked before anything is sent:
//                               ESP-IDF's app image (c6_ota::image, what
//                               c6-image writes): the magic, the ESP32-C6's
//                               chip id, whole 16-byte lines, room on the
//                               box, and the appended digest (the image's
//                               last 32 bytes, the SHA-256 of the rest: the
//                               firmware's identity). The box checks all of
//                               it again, and the segments, at its commit;
//                               this catches "the ELF instead of the .bin"
//                               first.
//   sendImage(bytes, transport) the upload (c6_ota::upload): begin → { offset,
//                               chunk, window } → the bytes from offset as
//                               `data` values ([offset u32 LE][bytes]), in
//                               order, `chunk` per value, at most `window`
//                               past the last Ack → the final Ack (→ commit).
//                               A gap (Sequence) rewinds to where the box
//                               asks; no Ack for stallMs with the window full
//                               resends from the last Ack; a dropped link
//                               waits for the reconnect and begins again (the
//                               box resumes at what it has).
//
// The constants mirror c6_ota::image (projects/c6-ota/src/image.rs).

export const IMAGE_MAGIC = 0xe9;
export const CHIP_ID_C6 = 13;
export const AT_CHIP_ID = 12;
export const DIGEST_LEN = 32;
/** The header (24 B), a segment's header (8 B), and the checksum's line: the least an image can be. */
const MIN_LEN = 24 + 8 + 16 + DIGEST_LEN;

// c6_ota::image::reason: why the box refused an image at its commit (the
// reason, and its own detail above it)
export const IMAGE_REASONS = {
  1: 'a flash read failed (at the offset given)',
  2: 'the first byte is not 0xe9 (not an image)',
  3: "not the ESP32-C6's chip id",
  4: 'the header does not say a digest is appended',
  5: 'no segments, or more than 16',
  6: 'a segment runs past the image or is not a multiple of 4 long',
  7: "the checksum byte is not the segments'",
  8: 'the image does not end with its digest',
};

export async function sha256(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** What checkImage's refusals tell a person to do, unless the caller says otherwise. */
export const IMAGE_HINTS = {
  make: 'make it from the ELF with c6-image (projects/c6-ota): `c6-image <elf> --partitions <partitions.csv>`',
  chip: 'build the firmware for the ESP32-C6',
  room: 'the firmware has outgrown its app slot (its partition table)',
};

function refused(message, hint) {
  const e = new Error(message);
  e.code = 'IMAGE';
  e.hint = hint;
  return e;
}

/**
 * checkImage(bytes, maxLen, hints) → { len, sha256 (hex: the appended digest) },
 * or throws an Error (.code 'IMAGE', .hint) saying what is wrong. maxLen: the
 * box's room (null: not checked). hints: { make, chip, room } in place of
 * IMAGE_HINTS'.
 */
export async function checkImage(bytes, maxLen = null, hints = {}) {
  const h = { ...IMAGE_HINTS, ...hints };
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < MIN_LEN) throw refused(`${b.length} bytes is not a firmware image`, h.make);
  if (b[0] !== IMAGE_MAGIC) {
    const elf = b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
    throw refused(elf ? 'this is the ELF, not the firmware image' : `not a firmware image (its first byte is 0x${b[0].toString(16)}, not 0xe9)`, h.make);
  }
  const chip = b[AT_CHIP_ID] | (b[AT_CHIP_ID + 1] << 8);
  if (chip !== CHIP_ID_C6) throw refused(`an image for chip id ${chip}, not the ESP32-C6's (${CHIP_ID_C6})`, h.chip);
  if (b.length % 16 !== 0) throw refused(`${b.length} bytes is not whole 16-byte lines: the image is cut short or has bytes after it`, h.make);
  if (maxLen !== null && b.length > maxLen) throw refused(`the image is ${b.length} bytes; the box has room for ${maxLen}`, h.room);
  const n = b.length - DIGEST_LEN;
  const digest = hex(b.subarray(n));
  const got = hex(await sha256(b.subarray(0, n)));
  if (got !== digest) throw refused(`the image does not end with its digest (the SHA-256 of the rest is ${got}, its last 32 bytes ${digest}): cut short or changed`, h.make);
  return { len: b.length, sha256: digest };
}

function linkError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * sendImage(bytes, transport, opts) → { chunk, window, resumedFrom, resumes,
 * rewinds, resends, written, ms, committed? }.
 *
 * transport, the protocol's side:
 *   begin()            → Promise<{ offset, chunk, window }>: the begin
 *                        request answered (a refusal rejects); asked again
 *                        after a dropped link, to resume
 *   writeData(value)   → Promise: one `data` value, [offset u32 LE][bytes]
 *   onResponse(fn)     → unsubscribe: fn gets every answer while the bytes
 *                        go, as { tag: 'Ack', offset } (every byte before
 *                        offset is in), { tag: 'Sequence', expected } (a gap:
 *                        send from expected), { tag: 'Error', error } (the
 *                        box refused the bytes: rejects with error),
 *                        { tag: 'Disconnected' }, or { tag: 'Other' } (any
 *                        other answer; it wakes the wait like any)
 *   isConnected()      → whether the link is up
 *   waitConnected(ms)  → Promise<bool>: the link back within ms
 *   commit()           (optional) → Promise: after the final Ack; its result
 *                        is .committed
 *   dropped(what), stalled(message), lost()  (optional) → the Error to throw
 *                        for a link that dropped (its .code must be
 *                        'DROPPED': that is what resumes), no Ack for too
 *                        long, a link that did not come back
 *
 * opts: onProgress({ phase: begin|upload|reconnect, sent, total, kbps }),
 * log(level, message), now() (ms), stallMs (4000: no Ack for this long with
 * the window full: send again from the last Ack), maxStalls (3: then give
 * up), resumeTries (3: drops mid-upload survived), reconnectWaitMs (30000:
 * how long to wait for each reconnect). A refusal of the first begin rejects
 * with .beforeReady true (the box took nothing).
 */
export async function sendImage(bytes, transport, {
  onProgress = () => {},
  log = () => {},
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  stallMs = 4000,
  maxStalls = 3,
  resumeTries = 3,
  reconnectWaitMs = 30000,
} = {}) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const L = (level, msg) => { try { log(level, msg); } catch { /* ignore */ } };
  const dropped = transport.dropped ?? ((what) => linkError(`${what}: the link dropped`, 'DROPPED'));
  const stalled = transport.stalled ?? ((message) => linkError(message, 'STALLED'));
  const lost = transport.lost ?? (() => linkError('the link dropped mid-upload and did not come back', 'DROPPED'));
  const len = bytes.length;
  const out = { chunk: null, window: null, resumedFrom: null, resumes: 0, rewinds: 0, resends: 0, written: 0, ms: 0 };
  const start = now();
  let first = true;
  const kbps = (n) => Math.round((n / Math.max(1, now() - start)) * 10) / 10; // bytes per ms = kB/s
  for (;;) {
    onProgress({ phase: 'begin', sent: 0, total: len, kbps: 0 });
    let ready;
    try {
      ready = await transport.begin();
    } catch (e) {
      // the first begin refused: the box took nothing (a firmware update
      // has not wiped anything); a later one (after a drop) may not be
      if (first && e && typeof e === 'object') e.beforeReady = true;
      throw e;
    }
    const { offset, chunk, window } = ready;
    out.chunk = chunk; out.window = window;
    if (first) out.resumedFrom = offset || null;
    L('info', `ready at ${offset}${offset ? ' (resumed)' : ''}: chunks of ${chunk}, window ${window}`);
    first = false;
    try {
      await pump(bytes, transport, { offset, chunk, window, len, out, stallMs, maxStalls, L, dropped, stalled, onProgress: (acked) => onProgress({ phase: 'upload', sent: acked, total: len, kbps: kbps(acked - (out.resumedFrom ?? 0)) }) });
      break;
    } catch (e) {
      if (e?.code !== 'DROPPED' || out.resumes >= resumeTries) throw e;
      out.resumes++;
      L('warn', `the link dropped mid-upload; waiting for the reconnect to resume (${out.resumes} of ${resumeTries})`);
      onProgress({ phase: 'reconnect', sent: 0, total: len, kbps: 0 });
      if (!(await transport.waitConnected(reconnectWaitMs))) throw lost();
    }
  }
  out.ms = Math.round(now() - start);
  L('info', `${len - (out.resumedFrom ?? 0)} B in ${out.ms} ms (${kbps(len - (out.resumedFrom ?? 0))} kB/s), ${out.written} B written${out.rewinds ? `, ${out.rewinds} rewinds` : ''}${out.resends ? `, ${out.resends} resends` : ''}${out.resumes ? `, ${out.resumes} resumes` : ''}`);
  if (transport.commit) out.committed = await transport.commit();
  return out;
}

async function pump(bytes, transport, { offset, chunk, window, len, out, stallMs, maxStalls, L, dropped, stalled, onProgress }) {
  let sent = offset;
  let acked = offset;
  let failure = null;
  let wake = null;
  let rewound = false;
  const unsubscribe = transport.onResponse((r) => {
    if (r.tag === 'Ack') { if (r.offset > acked) { acked = r.offset; onProgress(acked); } } else if (r.tag === 'Disconnected') failure = dropped('the upload');
    else if (r.tag === 'Sequence') {
      L('warn', `gap: the box has ${r.expected} B; going back there`);
      out.rewinds++;
      sent = r.expected;
      acked = Math.min(acked, sent);
      rewound = true;
    } else if (r.tag === 'Error') failure = r.error;
    if (wake) wake();
  });
  let stalls = 0;
  try {
    while (acked < len) {
      if (failure) throw failure;
      const n = Math.min(chunk, len - sent);
      if (sent < len && sent + n - acked <= window) {
        const at = sent;
        const value = new Uint8Array(4 + n);
        new DataView(value.buffer).setUint32(0, at, true);
        value.set(bytes.subarray(at, at + n), 4);
        try {
          await transport.writeData(value);
        } catch (e) {
          if (failure) throw failure;
          if (!transport.isConnected()) throw dropped('the upload');
          throw e;
        }
        out.written += n;
        if (sent === at) sent = at + n; // unless a gap rewound it meanwhile
        continue;
      }
      // the window is full (or everything is out): wait for an Ack, a gap or the stall timer
      const before = acked;
      rewound = false;
      let timer;
      await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, stallMs); });
      clearTimeout(timer);
      wake = null;
      if (failure) throw failure;
      if (acked > before || rewound) { stalls = 0; continue; }
      if (++stalls > maxStalls) throw stalled(`no Ack for ${(stallMs * stalls) / 1000} s at ${acked} of ${len} B`);
      L('warn', `no Ack for ${stallMs} ms at ${acked}: sending again from there`);
      out.resends++;
      sent = acked;
    }
  } finally {
    unsubscribe();
  }
}

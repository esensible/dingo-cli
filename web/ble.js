// ble.js — the CAN-bridge transport: Web Bluetooth <-> the hilux ESP32-C6 <-> CAN.
//
// Contract: hilux/wireless-can/BRIDGE.md. One GATT service with four
// characteristics (tx / rx / filter / stats). Frames on tx and rx are
//     [id: u16 LE][dlc: u8][data: dlc bytes]
// concatenated; standard 11-bit ids only (id <= 0x7FF), dlc 0..8, at most 10
// frames per tx write. The filter is 0..8 entries of [id u16 LE][mask u16 LE];
// it is empty (forwards nothing) after every (re)connect, so this module
// re-writes the last filter it set whenever it reconnects.
//
// Access: the C6 serves the bridge only to a paired device with the CAN bridge
// role (granted on the Kindle page). See ROLE_REFUSED below for how a refusal
// reaches us, and STALE_PAIRING for the other way a connect fails for good.
//
// The bridge is a consumer of the page's one link to the C6 (link.js): it
// never connects, picks or watches for advertisements itself; it attaches to
// the link (its service and characteristics, fetched afresh on every link)
// and re-attaches when the link comes back.
//
// No DOM access: everything comes in through createBridge({ link | bluetooth, log }).

import {
  createLink, DEVICE_NAME, BRIDGE_SERVICE, KEYLESS_SERVICE, FIRMWARE_SERVICE, requestOptions, withTimeout, errText, STALE_PAIRING,
} from './link.js';

export { DEVICE_NAME, BRIDGE_SERVICE, KEYLESS_SERVICE, FIRMWARE_SERVICE, requestOptions, withTimeout, errText, STALE_PAIRING };
export const BRIDGE_TX = 'd9e5a0c1-f7a1-4b6e-9c3d-2a8e1f0b5c4d';
export const BRIDGE_RX = 'd9e5a0c2-f7a1-4b6e-9c3d-2a8e1f0b5c4d';
export const BRIDGE_FILTER = 'd9e5a0c3-f7a1-4b6e-9c3d-2a8e1f0b5c4d';
export const BRIDGE_STATS = 'd9e5a0c4-f7a1-4b6e-9c3d-2a8e1f0b5c4d';

export const MAX_ID = 0x7ff;
export const MAX_DLC = 8;
export const MAX_TX_FRAMES = 10;
export const MAX_FILTER_ENTRIES = 8;

// ---------------------------------------------------------------- codec ----

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) {
    const bad = v.find((b) => !Number.isInteger(b) || b < 0 || b > 255);
    if (bad !== undefined) throw new RangeError(`byte ${JSON.stringify(bad)} out of range (0..255)`);
    return Uint8Array.from(v);
  }
  throw new TypeError('expected bytes (Uint8Array, ArrayBuffer, DataView or number[])');
}

/** Validate one frame; returns { id, data: Uint8Array } or throws a descriptive Error. */
export function checkFrame(id, data) {
  if (!Number.isInteger(id) || id < 0 || id > MAX_ID) {
    throw new RangeError(`CAN id ${id} is not a standard 11-bit id (0..0x7FF)`);
  }
  let d;
  try { d = toBytes(data ?? []); } catch (e) { throw new TypeError(`frame 0x${hex3(id)}: ${e.message}`); }
  if (d.length > MAX_DLC) throw new RangeError(`frame 0x${hex3(id)}: ${d.length} data bytes (max 8)`);
  for (const b of d) if (!Number.isInteger(b) || b < 0 || b > 255) throw new RangeError(`frame 0x${hex3(id)}: byte ${b} out of range`);
  return { id, data: d };
}

/** Encode frames [{id, data}] as one tx write (throws on invalid input or > 10 frames). */
export function encodeFrames(frames) {
  if (!Array.isArray(frames) || frames.length === 0) throw new RangeError('encodeFrames: need at least one frame');
  if (frames.length > MAX_TX_FRAMES) throw new RangeError(`encodeFrames: ${frames.length} frames (max ${MAX_TX_FRAMES} per write)`);
  const checked = frames.map((f) => checkFrame(f.id, f.data));
  const out = new Uint8Array(checked.reduce((n, f) => n + 3 + f.data.length, 0));
  let o = 0;
  for (const f of checked) {
    out[o++] = f.id & 0xff;
    out[o++] = f.id >> 8;
    out[o++] = f.data.length;
    out.set(f.data, o);
    o += f.data.length;
  }
  return out;
}

/**
 * Decode a buffer of concatenated frames (an rx notification). Malformed input
 * (truncated frame, id > 0x7FF, dlc > 8, empty buffer) throws — the bridge
 * rejects malformed buffers as a whole, so we do too.
 */
export function decodeFrames(buf) {
  const b = toBytes(buf);
  if (b.length === 0) throw new RangeError('empty frame buffer');
  const frames = [];
  let o = 0;
  while (o < b.length) {
    if (b.length - o < 3) throw new RangeError(`truncated frame header at byte ${o} of ${b.length}`);
    const id = b[o] | (b[o + 1] << 8);
    const dlc = b[o + 2];
    if (id > MAX_ID) throw new RangeError(`id 0x${id.toString(16)} > 0x7FF at byte ${o}`);
    if (dlc > MAX_DLC) throw new RangeError(`dlc ${dlc} > 8 at byte ${o}`);
    if (o + 3 + dlc > b.length) throw new RangeError(`truncated frame data at byte ${o}: dlc ${dlc}, ${b.length - o - 3} bytes left`);
    frames.push({ id, data: b.slice(o + 3, o + 3 + dlc) });
    o += 3 + dlc;
  }
  return frames;
}

/** Normalise filter entries: accepts [[id, mask]] or [{id, mask}]; returns [{id, mask}] or throws. */
export function normaliseFilter(entries) {
  if (!Array.isArray(entries)) throw new TypeError('filter entries must be an array of [id, mask] or {id, mask}');
  if (entries.length > MAX_FILTER_ENTRIES) throw new RangeError(`filter has ${entries.length} entries (max ${MAX_FILTER_ENTRIES})`);
  return entries.map((e, i) => {
    const id = Array.isArray(e) ? e[0] : e?.id;
    const mask = Array.isArray(e) ? e[1] : e?.mask;
    for (const [k, v] of [['id', id], ['mask', mask]]) {
      if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`filter entry ${i}: ${k} ${v} must be an integer 0..0xFFFF`);
    }
    return { id, mask };
  });
}

export function encodeFilter(entries) {
  const n = normaliseFilter(entries);
  const out = new Uint8Array(n.length * 4);
  n.forEach((e, i) => {
    out[i * 4] = e.id & 0xff; out[i * 4 + 1] = e.id >> 8;
    out[i * 4 + 2] = e.mask & 0xff; out[i * 4 + 3] = e.mask >> 8;
  });
  return out;
}

export function decodeFilter(buf) {
  const b = toBytes(buf);
  if (b.length % 4 !== 0) throw new RangeError(`filter value is ${b.length} bytes (must be a multiple of 4)`);
  const out = [];
  for (let o = 0; o < b.length; o += 4) out.push({ id: b[o] | (b[o + 1] << 8), mask: b[o + 2] | (b[o + 3] << 8) });
  return out;
}

export function parseStats(buf) {
  const b = toBytes(buf);
  if (b.length < 16) throw new RangeError(`stats value is ${b.length} bytes (expected 16)`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { tx_ok: dv.getUint32(0, true), tx_err: dv.getUint32(4, true), rx_forwarded: dv.getUint32(8, true), rx_dropped: dv.getUint32(12, true) };
}

/** Does a frame id pass a filter (BRIDGE.md semantics)? */
export function filterMatches(entries, id) {
  return entries.some((e) => (id & e.mask) === (e.id & e.mask));
}

export function hex3(n) { return n.toString(16).toUpperCase().padStart(3, '0'); }
export function toHex(bytes) { return Array.from(toBytes(bytes), (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(''); }

// --------------------------------------------------------------- bridge ----

// ------------------------------------------------------------ refusals ----
//
// The C6 refuses bridge access from a device without the CAN bridge role with
// ATT Insufficient Authorization (0x08); on a link that is not yet encrypted
// it answers Insufficient Authentication (0x05) first, which makes the OS
// encrypt or pair and retry. What reaches the page (Chromium source, 2026-10):
//  - macOS: Chrome does not translate CoreBluetooth's ATT errors
//    (device/bluetooth/bluetooth_device_mac.mm GetGattErrorCodeFromNSError
//    returns kFailed for every CBATTErrorDomain code), so any refused GATT
//    operation is NotSupportedError "GATT operation failed for unknown reason."
//    (blink bluetooth_error.cc, GATT_UNKNOWN_FAILURE).
//  - platforms that do translate 0x08 (kNotAuthorized): SecurityError
//    "GATT operation not authorized." (GATT_NOT_AUTHORIZED).
// On macOS the error itself therefore does not say why, so a refusal is
// inferred from the operation: subscribing to rx, writing/reading the filter
// or reading stats on a link that is still up. This client never sends a
// value the C6 could reject for another reason there (frames and filters are
// validated first), so on those operations the inference holds. A tx write
// without response gets no ATT reply at all: a refused one is dropped
// silently on the C6 (and logged there).
export const ROLE_REFUSED = "This computer isn't allowed to use the CAN bridge — grant it the CAN bridge role on the Kindle";
const ROLE_HOW = "(Settings → Bluetooth: tap this computer's name, turn on CAN bridge and tap again to confirm; if it is not listed, Pair new device with CAN bridge and connect from here while the window is open)";

/** Is e how Chrome reports the C6's ATT Insufficient Authorization (see above)? */
export function isRefusal(e) {
  const t = errText(e);
  if (e?.name === 'SecurityError') return /not authori[sz]ed/i.test(t);
  return e?.name === 'NotSupportedError' && /failed for unknown reason|not permitted|GATT Error Unknown/i.test(t);
}

function refused(op, e) {
  const err = new Error(`${ROLE_REFUSED} ${ROLE_HOW} [${op}: ${errText(e)}]`);
  err.code = 'NOT_AUTHORISED';
  return err;
}

/**
 * createBridge({ link | bluetooth, log, ...options }) → bridge.
 *
 * `link`: the page's one link (link.js), shared with firmware.js; without one
 * the bridge makes its own from `bluetooth` (and the link options below).
 *
 *   connect({ allowChooser, forceChooser })  the link's (link.js connect), then the bridge on it
 *   disconnect()       the person's Disconnect: the link goes (for every consumer)
 *   isConnected(), info(), onState(cb), state, link, gattOp
 *   setFilter / readFilter / getFilter / send / onFrame / stats
 *
 * States: disconnected | connecting | connected | reconnecting | failed —
 * the link's, while the bridge wants it; `failed` also when the bridge was
 * refused on a reconnect (the role taken away meanwhile).
 *
 * Options (all optional, mostly for tests):
 *   connectTimeoutMs (15000), advertTimeoutMs (12000), reconnectTries (3),
 *   reconnectDelayMs (1000)   for the link it makes when none is given
 *   maxFramesPerWrite (10)    frames coalesced into one tx write (1..10, the BRIDGE.md limit;
 *                             needs ATT MTU >= 113, falls back to smaller writes on error)
 *   earlyAck (true)           resolve send() as soon as the frame is queued while the backlog
 *                             fits `pipelineWrites` writes, so awaited sends still coalesce and
 *                             the next write is ready before the current one completes; a later
 *                             write failure then rejects the next send()
 *   pipelineWrites (2)        how many writes' worth of frames may be early-acked
 *   writeWithoutResponse (true)  write-without-response on tx: no ATT round trip per write
 *                             (measured 2026-10-03: with-response cost ~60-150 ms per write,
 *                             i.e. 30-75 s for a 2269-param apply)
 */
export function createBridge({
  bluetooth = globalThis.navigator?.bluetooth,
  link = null,
  log = () => {},
  connectTimeoutMs = 15000,
  advertTimeoutMs = 12000,
  reconnectTries = 3,
  reconnectDelayMs = 1000,
  maxFramesPerWrite = 10,
  writeWithoutResponse = true,
  earlyAck = true,
  pipelineWrites = 2,
} = {}) {
  const L = (level, msg) => { try { log(level, 'ble: ' + msg); } catch { /* logging must never break transport */ } };
  maxFramesPerWrite = Math.max(1, Math.min(MAX_TX_FRAMES, maxFramesPerWrite | 0));
  link = link || createLink({ bluetooth, log, connectTimeoutMs, advertTimeoutMs, reconnectTries, reconnectDelayMs });
  const USER = 'bridge';

  let chars = null; // { tx, rx, filter, stats } on the current link
  let state = 'disconnected'; // disconnected | connecting | connected | reconnecting | failed
  let lastError = null;
  let filter = []; // last filter we wrote (desired state, re-applied on every attach)
  let wanted = false; // the bridge is wanted on the link (connect() until disconnect or refusal)
  let reconnectCount = 0;
  const counters = { framesSent: 0, writes: 0, framesReceived: 0, notifications: 0, rxMalformed: 0, txErrors: 0 };
  const frameListeners = new Set();
  const stateListeners = new Set();

  function setState(s, err) {
    if (err !== undefined) lastError = err;
    if (s === state) return;
    state = s;
    L('info', `state → ${s}${err ? ' (' + err + ')' : ''}`);
    for (const cb of stateListeners) { try { cb(s, lastError); } catch { /* listener bug must not break us */ } }
  }

  const gattOp = link.gattOp;

  // ---- the link's events, while the bridge is wanted
  link.onDown((reason) => {
    chars = null;
    // frames queued for a link that is gone can never be sent
    txQueue.splice(0).forEach((f) => f.reject(new Error('link dropped before the frame was written')));
    if (!wanted) return;
    if (reason === 'dropped') { L('warn', 'unexpected disconnect'); setState('reconnecting', 'link dropped'); } else { wanted = false; setState('disconnected'); }
  });
  link.onState((s, err) => {
    if (!wanted) return;
    if (s === 'failed') setState('failed', err);
    else if (s === 'reconnecting' && state !== 'reconnecting') setState('reconnecting');
  });
  link.onUp(() => {
    // A link that came back (a reconnect, or another consumer's connect): attach again.
    if (!wanted || attaching || state === 'connecting') return;
    reattach();
  });

  let attaching = null;
  async function reattach() {
    try {
      attaching = attach();
      await attaching;
      reconnectCount++;
      L('info', `bridge back on the link (generation ${link.generation})`);
      setState('connected', null);
    } catch (e) {
      lastError = errText(e);
      L('warn', `bridge did not come back: ${lastError}`);
      if (e.code === 'NOT_AUTHORISED') { wanted = false; link.release(USER); }
      setState('failed', lastError);
    } finally { attaching = null; }
  }

  /** The bridge's characteristics on the current link (Service Changed: never kept across links). */
  async function attach() {
    let service;
    try { service = await link.service(BRIDGE_SERVICE, 'CAN bridge'); } catch (e) {
      if (e.code === 'NO_SERVICE') throw new Error(`${e.message}; is the C6 running bridge firmware?`);
      throw e;
    }
    const got = [];
    for (const u of [BRIDGE_TX, BRIDGE_RX, BRIDGE_FILTER, BRIDGE_STATS]) {
      try { got.push(await gattOp(() => service.getCharacteristic(u))); } catch (e) {
        throw new Error(`bridge service found but characteristic ${u} is missing (${errText(e)}); C6 firmware does not match BRIDGE.md`);
      }
    }
    const [tx, rx, flt, stats] = got;
    const c = { tx, rx, filter: flt, stats };
    c.rx.removeEventListener?.('characteristicvaluechanged', onNotify);
    c.rx.addEventListener('characteristicvaluechanged', onNotify);
    await gattOp(() => c.rx.startNotifications()).catch((e) => {
      throw isRefusal(e) ? refused('rx subscribe', e) : e;
    });
    chars = c;
    if (filter.length) {
      await bridgeOp('filter write', () => c.filter.writeValue(encodeFilter(filter)));
      L('info', `filter re-applied after connect: ${fmtFilter(filter)}`);
    }
  }

  // ---- tx queue with coalescing (up to maxFramesPerWrite frames per write, order kept)
  const txQueue = []; // { id, data, resolve, reject, acked }
  let txPumping = false;
  let inFlight = 0; // frames in the write being performed
  let txFailure = null; // a write failed after its frames were early-acked
  async function pumpTx() {
    if (txPumping) return;
    txPumping = true;
    try {
      while (txQueue.length) {
        const batch = txQueue.splice(0, maxFramesPerWrite);
        if (!chars || state !== 'connected') {
          const err = new Error(`not connected (state: ${state})`);
          batch.forEach((f) => f.reject(err));
          continue;
        }
        const buf = encodeFrames(batch);
        inFlight = batch.length;
        try {
          const c = chars.tx;
          await gattOp(() => (writeWithoutResponse && c.writeValueWithoutResponse ? c.writeValueWithoutResponse(buf)
            : c.writeValueWithResponse ? c.writeValueWithResponse(buf) : c.writeValue(buf)));
          counters.writes++;
          counters.framesSent += batch.length;
          batch.forEach((f) => { if (!f.acked) f.resolve(); });
        } catch (e) {
          counters.txErrors++;
          // A multi-frame write can exceed a small ATT MTU (10 frames need MTU >= 113).
          // The C6 rejects a write as a whole, so retrying the same frames in smaller
          // writes cannot duplicate any of them.
          if (batch.length > 1 && chars && state === 'connected') {
            maxFramesPerWrite = Math.max(1, batch.length >> 1);
            L('warn', `tx write of ${batch.length} frames failed (${errText(e)}); retrying with ≤${maxFramesPerWrite} frames per write`);
            txQueue.unshift(...batch);
            continue;
          }
          const err = new Error(`tx write failed: ${errText(e)}`);
          L('error', err.message);
          // Early-acked frames were already reported as sent: fail the next send instead.
          if (batch.some((f) => f.acked)) txFailure = err;
          batch.forEach((f) => { if (!f.acked) f.reject(err); });
        } finally {
          inFlight = 0;
        }
      }
    } finally {
      txPumping = false;
    }
  }

  function onNotify(ev) {
    const v = ev.target.value;
    counters.notifications++;
    let frames;
    try {
      frames = decodeFrames(v);
    } catch (e) {
      counters.rxMalformed++;
      L('warn', `malformed rx notification dropped (${e.message}): ${toHex(v)}`);
      return;
    }
    counters.framesReceived += frames.length;
    for (const f of frames) {
      for (const cb of frameListeners) { try { cb(f.id, f.data); } catch (e) { L('error', 'frame listener threw: ' + errText(e)); } }
    }
  }

  /** A GATT op on the bridge service, with a refusal turned into ROLE_REFUSED. */
  function bridgeOp(op, fn) {
    return gattOp(fn).catch((e) => {
      if (!isRefusal(e)) throw e;
      const err = refused(op, e);
      L('error', err.message);
      throw err;
    });
  }

  /**
   * connect({ allowChooser, forceChooser }): the link (link.js connect: the
   * remembered device; the chooser only from a click), then the bridge on it.
   * Chrome opens the chooser only during a click's user activation (~5 s), so
   * the SERVICE_NOT_GRANTED fallback can fail after a slow connect; the error
   * then says to click Connect (which then opens the chooser at once).
   */
  async function connect({ allowChooser = false, forceChooser = false } = {}) {
    if (attaching) await attaching.catch(() => {});
    if (!forceChooser && isConnected()) return { deviceName: link.device.name, deviceId: link.device.id, already: true };
    if (!link.info().bluetoothAvailable) throw new Error('Web Bluetooth is not available here (needs Chrome/Edge on a secure origin such as http://localhost:5173)');
    wanted = true;
    link.use(USER);
    setState('connecting');
    try {
      const r = await link.connect({ allowChooser, forceChooser });
      // "Use another hilux…" picked the device already connected: the bridge stays as it is
      if (r.already && chars) { setState('connected', null); return { deviceName: r.deviceName, deviceId: r.deviceId, already: true }; }
      try {
        attaching = attach();
        await attaching;
      } catch (e) {
        if (e.code !== 'SERVICE_NOT_GRANTED' || !allowChooser || forceChooser) throw e;
        L('warn', `${errText(e)}; re-picking in the chooser`);
        try { await link.connect({ forceChooser: true }); } catch (e2) { throw new Error(`${e.message} [the chooser did not open: ${errText(e2)}]`); }
        attaching = attach();
        await attaching;
      } finally { attaching = null; }
      setState('connected', null);
      return { deviceName: link.device.name, deviceId: link.device.id, already: !!r.already };
    } catch (e) {
      wanted = false;
      chars = null;
      // Do not sit on one of the C6's connections for nothing: the iPhone needs one to unlock.
      if (e.code === 'NOT_AUTHORISED' || e.code === 'SERVICE_NOT_GRANTED') link.release(USER); else link.unuse(USER);
      setState('disconnected', errText(e));
      throw e;
    }
  }

  /** The person's Disconnect: the link goes, for every consumer. */
  async function disconnect() {
    wanted = false;
    chars = null;
    link.unuse(USER);
    await link.disconnect();
    setState('disconnected');
    txQueue.splice(0).forEach((f) => f.reject(new Error('disconnected')));
  }

  function isConnected() { return state === 'connected' && !!chars && link.isConnected(); }

  async function setFilter(entries) {
    const n = normaliseFilter(entries);
    if (!isConnected()) throw new Error(`cannot set filter: not connected (state: ${state})`);
    const c = chars;
    await bridgeOp('filter write', () => c.filter.writeValue(encodeFilter(n)));
    filter = n;
    return n.map((e) => ({ ...e }));
  }

  async function readFilter() {
    if (!isConnected()) throw new Error(`not connected (state: ${state})`);
    const c = chars;
    const v = await bridgeOp('filter read', () => c.filter.readValue());
    return decodeFilter(v);
  }

  function getFilter() { return filter.map((e) => ({ ...e })); }

  function send(id, data) {
    let f;
    try { f = checkFrame(id, data); } catch (e) { return Promise.reject(e); }
    if (!isConnected()) return Promise.reject(new Error(`cannot send: not connected (state: ${state})`));
    if (txFailure) { const e = txFailure; txFailure = null; return Promise.reject(e); }
    return new Promise((resolve, reject) => {
      const entry = { id: f.id, data: f.data.slice(), resolve, reject, acked: false };
      txQueue.push(entry);
      // Early ack: while the backlog fits in one write, report the frame as sent at
      // once so a caller that awaits each send (the WASM does) still lets frames
      // coalesce into multi-frame writes. Past that, the caller waits (back-pressure).
      if (earlyAck && txQueue.length + inFlight <= maxFramesPerWrite * pipelineWrites) { entry.acked = true; resolve(); }
      pumpTx();
    });
  }

  function onFrame(cb) { frameListeners.add(cb); return () => frameListeners.delete(cb); }
  function onState(cb) { stateListeners.add(cb); return () => stateListeners.delete(cb); }

  async function stats() {
    if (!isConnected()) throw new Error(`not connected (state: ${state})`);
    const c = chars;
    const v = await bridgeOp('stats read', () => c.stats.readValue());
    return parseStats(v);
  }

  function info() {
    return {
      state,
      deviceName: link.device?.name ?? null,
      deviceId: link.device?.id ?? null,
      bluetoothAvailable: link.info().bluetoothAvailable,
      lastError,
      link: link.state,
      reconnects: reconnectCount,
      filter: getFilter(),
      txQueued: txQueue.length,
      framesPerWrite: maxFramesPerWrite,
      counters: { ...counters },
    };
  }

  // gattOp: the link's one GATT queue, shared with firmware.js.
  return { connect, disconnect, isConnected, setFilter, getFilter, readFilter, send, onFrame, onState, stats, info, gattOp, link, get state() { return state; } };
}

export function fmtFilter(entries) {
  if (!entries.length) return '[] (forwards nothing)';
  return entries.map((e) => `[0x${hex3(e.id)}/0x${hex3(e.mask)}]`).join(' ');
}

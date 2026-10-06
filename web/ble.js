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
// No DOM access: everything comes in through createBridge({ bluetooth, log }).

export const DEVICE_NAME = 'hilux';
export const BRIDGE_SERVICE = 'd9e5a0c0-f7a1-4b6e-9c3d-2a8e1f0b5c4d';
export const BRIDGE_TX = 'd9e5a0c1-f7a1-4b6e-9c3d-2a8e1f0b5c4d';
export const BRIDGE_RX = 'd9e5a0c2-f7a1-4b6e-9c3d-2a8e1f0b5c4d';
export const BRIDGE_FILTER = 'd9e5a0c3-f7a1-4b6e-9c3d-2a8e1f0b5c4d';
export const BRIDGE_STATS = 'd9e5a0c4-f7a1-4b6e-9c3d-2a8e1f0b5c4d';
export const KEYLESS_SERVICE = 'd9e5a0b0-f7a1-4b6e-9c3d-2a8e1f0b5c4d';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]);
}

function errText(e) {
  if (!e) return 'unknown error';
  return (e.name && e.name !== 'Error' ? e.name + ': ' : '') + (e.message || String(e));
}

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

// A stale pairing: this computer still holds a pairing the C6 no longer has
// (forgotten on the Kindle, or lost on the C6). macOS tries to encrypt with
// the old key as it connects, the C6 rejects it, and macOS drops the link
// itself; it never re-pairs on its own. Chrome reports no reason for that
// (the CoreBluetooth error is not passed on, crbug 585897), so the symptom is
// what we map: the link drops while connecting, or gatt.connect() fails with
// "Connection failed for unknown reason." or, as Chrome on macOS reported it
// on the hardware (2026-10-03), NetworkError "Connection Error: Connection
// attempt failed." -- with no gattserverdisconnected event. That last one
// counts only if the C6 was seen advertising first (see openBridge).
export const STALE_PAIRING = "if this keeps happening, this computer probably holds an old pairing with 'hilux': forget 'hilux' in macOS System Settings → Bluetooth, then PAIR on the Kindle (with the CAN bridge role) and connect again";

function isRefusal(e) {
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
 * createBridge({ bluetooth, log, ...options }) → bridge.
 *
 * Options (all optional, mostly for tests):
 *   connectTimeoutMs (15000)  gatt.connect() + service discovery ceiling
 *   advertTimeoutMs (12000)   how long to wait for an advertisement before connecting a remembered device
 *   reconnectTries (3)        auto-reconnect attempts after an unexpected disconnect
 *   reconnectDelayMs (1000)   base backoff between attempts (x attempt number)
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

  let device = null;
  let chars = null; // { tx, rx, filter, stats }
  let state = 'disconnected'; // disconnected | connecting | connected | reconnecting | failed
  let lastError = null;
  let filter = []; // last filter we wrote (desired state, re-applied on reconnect)
  let userDisconnect = false;
  let connecting = null; // in-flight connect promise
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

  // ---- serialised GATT queue: Web Bluetooth rejects concurrent operations.
  let gattChain = Promise.resolve();
  function gattOp(fn) {
    const p = gattChain.then(fn, fn);
    gattChain = p.then(() => {}, () => {});
    return p;
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

  let droppedWhileConnecting = false; // see STALE_PAIRING
  function onDisconnected(ev) {
    if (ev?.target && device && ev.target !== device) return; // a device we have since replaced
    const wasConnected = state === 'connected';
    chars = null;
    if (userDisconnect) { setState('disconnected'); return; }
    if (!wasConnected) { droppedWhileConnecting = true; return; } // a failed connect attempt; the connect path handles it
    L('warn', 'unexpected disconnect');
    // frames queued for a link that is gone can never be sent
    txQueue.splice(0).forEach((f) => f.reject(new Error('link dropped before the frame was written')));
    reconnecting = autoReconnect().finally(() => { reconnecting = null; });
  }

  let reconnecting = null;
  async function autoReconnect() {
    setState('reconnecting', 'link dropped');
    for (let attempt = 1; attempt <= reconnectTries; attempt++) {
      if (userDisconnect) return;
      await sleep(reconnectDelayMs * attempt);
      if (userDisconnect) return;
      try {
        L('info', `reconnect attempt ${attempt}/${reconnectTries}`);
        await openDevice(device, { fromReconnect: true });
        reconnectCount++;
        L('info', `reconnected (attempt ${attempt})`);
        return;
      } catch (e) {
        L('warn', `reconnect attempt ${attempt} failed: ${errText(e)}`);
        lastError = errText(e);
        // Retrying cannot fix a refusal; only the Kindle can.
        if (e.code === 'NOT_AUTHORISED') { setState('failed', lastError); return; }
        setState('reconnecting');
      }
    }
    setState('failed', `auto-reconnect gave up after ${reconnectTries} attempts: ${lastError}`);
  }

  async function waitForAdvertisement(dev) {
    if (typeof dev.watchAdvertisements !== 'function') throw new Error('this browser has no device.watchAdvertisements() (enable chrome://flags/#enable-web-bluetooth-new-permissions-backend)');
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    let handler;
    const seen = new Promise((resolve) => { handler = resolve; dev.addEventListener('advertisementreceived', handler, { once: true }); });
    try {
      await dev.watchAdvertisements(ac ? { signal: ac.signal } : undefined);
      await withTimeout(seen, advertTimeoutMs, `waiting for an advertisement from ${dev.name || dev.id} (is the C6 powered and in range?)`);
    } finally {
      dev.removeEventListener('advertisementreceived', handler);
      try { ac?.abort(); } catch { /* ignore */ }
    }
  }

  async function gattConnect(dev) {
    const server = await withTimeout(dev.gatt.connect(), connectTimeoutMs, 'gatt.connect()');
    const service = await withTimeout(server.getPrimaryService(BRIDGE_SERVICE), connectTimeoutMs,
      'getPrimaryService(bridge)').catch((e) => {
      if (/disconnected/i.test(errText(e))) throw e; // the link dropped (see STALE_PAIRING), not a missing service
      if (/SecurityError|not allowed to access/.test(errText(e))) {
        const err = new Error(`Chrome has not granted this page the CAN bridge service on ${dev.name || dev.id} (it was picked before the service existed): a person must click the page's "Choose device…" button and pick it again`);
        err.code = 'SERVICE_NOT_GRANTED';
        throw err;
      }
      throw new Error(`connected to ${dev.name || dev.id} but the CAN bridge service ${BRIDGE_SERVICE} was not found (${errText(e)}); is the C6 running bridge firmware?`);
    });
    const got = [];
    for (const u of [BRIDGE_TX, BRIDGE_RX, BRIDGE_FILTER, BRIDGE_STATS]) {
      try { got.push(await service.getCharacteristic(u)); } catch (e) {
        throw new Error(`bridge service found but characteristic ${u} is missing (${errText(e)}); C6 firmware does not match BRIDGE.md`);
      }
    }
    const [tx, rx, flt, stats] = got;
    return { tx, rx, filter: flt, stats };
  }

  async function openDevice(dev, { fromReconnect = false } = {}) {
    if (!dev.__bridgeListening) {
      dev.addEventListener('gattserverdisconnected', onDisconnected);
      dev.__bridgeListening = true;
    }
    droppedWhileConnecting = false;
    try {
      await openBridge(dev, fromReconnect);
    } catch (e) {
      if (e.code === 'SERVICE_NOT_GRANTED') throw e; // we released the link ourselves; not a dropped one
      if (e.code === 'NOT_AUTHORISED') {
        // Do not sit on the C6's only connection: the iPhone needs it to unlock.
        try { dev.gatt.disconnect(); } catch { /* ignore */ }
        throw e;
      }
      if (droppedWhileConnecting || e.afterAdvert || /failed for unknown reason/i.test(errText(e))) {
        const err = new Error(`${errText(e)} (the link dropped while connecting; ${STALE_PAIRING})`);
        err.code = 'STALE_PAIRING_SUSPECTED';
        throw err;
      }
      throw e;
    }
  }

  async function openBridge(dev, fromReconnect) {
    let c;
    try {
      c = await gattConnect(dev);
    } catch (e) {
      const msg = errText(e);
      try { dev.gatt.disconnect(); } catch { /* ignore */ }
      if (e.code === 'SERVICE_NOT_GRANTED') throw e; // only a re-pick in the chooser fixes it
      // "Connection attempt failed" is what Chrome on macOS said for a stale
      // pairing on the hardware, but nothing shows it is not also what an
      // unpowered C6 gives. An advertisement tells them apart: a C6 that is
      // advertising and still refuses the link points at the pairing.
      if (/no longer in range|not in range|out of range|Connection attempt failed/i.test(msg) || fromReconnect) {
        L('info', `direct connect failed (${msg}); waiting for an advertisement`);
        await waitForAdvertisement(dev);
        L('info', 'advertisement seen; connecting');
        try {
          c = await gattConnect(dev);
        } catch (e2) {
          if (/Connection attempt failed/i.test(errText(e2))) e2.afterAdvert = true;
          throw e2;
        }
      } else {
        throw e;
      }
    }
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
    setState('connected', null);
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

  function requestDevice() {
    L('info', 'opening the Bluetooth chooser');
    return bluetooth.requestDevice({ filters: [{ name: DEVICE_NAME }], optionalServices: [BRIDGE_SERVICE, KEYLESS_SERVICE] });
  }

  /**
   * connect({ allowChooser, forceChooser }):
   *   default        the remembered device only (getDevices); never a chooser (script calls)
   *   allowChooser   a real click: the remembered device first; the chooser only
   *                  when there is none, or Chrome has not granted it the bridge
   *                  service (SERVICE_NOT_GRANTED: picked before the service existed)
   *   forceChooser   a real click on "Choose device…": always the chooser
   * Chrome opens the chooser only during a click's user activation (~5 s), so
   * the SERVICE_NOT_GRANTED fallback can fail after a slow connect; the error
   * then says to click "Choose device…".
   */
  async function connect({ allowChooser = false, forceChooser = false } = {}) {
    if (reconnecting) {
      L('info', 'connect(): auto-reconnect in progress; waiting for it');
      await reconnecting;
    }
    let picked = null;
    if (state === 'connected' && device?.gatt?.connected && chars) {
      if (!forceChooser) return { deviceName: device.name, deviceId: device.id, already: true };
      // Re-pick while connected (e.g. to grant services): the chooser first, while
      // the click's activation lasts; the link stays up if the same device is picked.
      picked = await requestDevice();
      if (picked === device || picked.id === device.id) return { deviceName: device.name, deviceId: device.id, already: true };
      await disconnect();
    }
    if (connecting) return connecting;
    connecting = (async () => {
      userDisconnect = false;
      if (!bluetooth) throw new Error('Web Bluetooth is not available here (needs Chrome/Edge on a secure origin such as http://localhost:5173)');
      setState('connecting');
      try {
        let dev = forceChooser ? picked : device;
        if (!dev && !forceChooser && typeof bluetooth.getDevices === 'function') {
          const devs = await bluetooth.getDevices();
          dev = devs.find((d) => d.name === DEVICE_NAME) || null;
          L('info', `getDevices(): ${devs.length ? devs.map((d) => d.name || d.id).join(', ') : 'none permitted'}`);
        }
        if (!dev && (allowChooser || forceChooser)) dev = await requestDevice();
        if (!dev) {
          const err = new Error(`no remembered '${DEVICE_NAME}' device: a person must click the page's Connect button once (Chrome only opens the Bluetooth chooser from a real click)`);
          err.code = 'NEEDS_USER_GESTURE';
          throw err;
        }
        device = dev;
        L('info', `connecting to ${dev.name || dev.id}`);
        try {
          await openDevice(dev);
        } catch (e) {
          if (e.code !== 'SERVICE_NOT_GRANTED' || !allowChooser || forceChooser) throw e;
          L('warn', `${errText(e)}; re-picking in the chooser`);
          try {
            dev = await requestDevice();
          } catch (e2) {
            throw new Error(`${e.message} [the chooser did not open: ${errText(e2)}]`);
          }
          device = dev;
          L('info', `connecting to ${dev.name || dev.id}`);
          await openDevice(dev);
        }
        return { deviceName: dev.name, deviceId: dev.id, already: false };
      } catch (e) {
        setState('disconnected', errText(e));
        throw e;
      }
    })();
    try { return await connecting; } finally { connecting = null; }
  }

  async function disconnect() {
    userDisconnect = true;
    const d = device;
    chars = null;
    if (d?.gatt?.connected) d.gatt.disconnect();
    setState('disconnected');
    // reject anything still queued
    txQueue.splice(0).forEach((f) => f.reject(new Error('disconnected')));
  }

  function isConnected() { return state === 'connected' && !!chars && !!device?.gatt?.connected; }

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
      deviceName: device?.name ?? null,
      deviceId: device?.id ?? null,
      bluetoothAvailable: !!bluetooth,
      lastError,
      reconnects: reconnectCount,
      filter: getFilter(),
      txQueued: txQueue.length,
      framesPerWrite: maxFramesPerWrite,
      counters: { ...counters },
    };
  }

  return { connect, disconnect, isConnected, setFilter, getFilter, readFilter, send, onFrame, onState, stats, info, get state() { return state; } };
}

export function fmtFilter(entries) {
  if (!entries.length) return '[] (forwards nothing)';
  return entries.map((e) => `[0x${hex3(e.id)}/0x${hex3(e.mask)}]`).join(' ');
}

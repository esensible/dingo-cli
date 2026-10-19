// firmware.js — the hilux C6's firmware update over Web Bluetooth.
//
// Contract: hilux/wireless-can/FIRMWARE.md (esensible monorepo). One GATT
// service with three characteristics, every value a fixed little-endian
// layout whose first byte says which:
//
//   control (write with response)    Info [01] · Begin [02][len u32][sha256 32]
//                                    · Commit [03] · Abort [04]
//   data    (write without response) [offset u32][bytes]
//   status  (notify)                 Info [01][sha256 32][slot u8][pending u8][max_len u32]
//                                    · Ready [02][offset u32][chunk u16][window u16]
//                                    · Ack [03][offset u32] · Rebooting [04]
//                                    · Error [05][request u8][code u8][detail u32]
//
// Every request gets exactly one status answer. The upload itself (window,
// Acks, a gap's rewind, a stall's resend, resume after a dropped link) is the
// monorepo's shared c6-ota's ota-client.js, vendored in vendor/c6-ota/ (see
// its vendor.sh); this module is its transport for hilux, plus what comes
// after the commit: the reset, the reconnect, and waiting until the update
// is running and confirmed (20 s after its boot, FIRMWARE.md "Trial and
// rollback").
//
// Access: the C6 serves the service only to a paired device with the
// Firmware role (granted on the Kindle). A refusal reaches the page as the
// bridge's does (ble.js "refusals"): on macOS any refused GATT operation is
// NotSupportedError "GATT operation failed for unknown reason.", so a refusal
// is inferred from the operation: the status subscribe or a control write.
//
// The link itself (picking, connecting, advertisements, reconnecting after
// the reset) is the page's one link, link.js, shared with the CAN bridge.
//
// No DOM access: everything comes in through createFirmware({ link | bluetooth, log }).

import { checkImage as checkC6Image, sendImage, IMAGE_REASONS, hex, DIGEST_LEN } from './vendor/c6-ota/ota-client.js';
import { createLink, FIRMWARE_SERVICE, errText, linkError } from './link.js';
import { isRefusal } from './ble.js';

export { FIRMWARE_SERVICE, IMAGE_REASONS };
export const FIRMWARE_CONTROL = 'd9e5a0d1-f7a1-4b6e-9c3d-2a8e1f0b5c4d';
export const FIRMWARE_DATA = 'd9e5a0d2-f7a1-4b6e-9c3d-2a8e1f0b5c4d';
export const FIRMWARE_STATUS = 'd9e5a0d3-f7a1-4b6e-9c3d-2a8e1f0b5c4d';

/** control request codes (and 0x05: data, as an Error's `request`). */
export const REQUEST = { INFO: 0x01, BEGIN: 0x02, COMMIT: 0x03, ABORT: 0x04, DATA: 0x05 };
export const REQUEST_NAMES = { 1: 'Info', 2: 'Begin', 3: 'Commit', 4: 'Abort', 5: 'data' };
/** status tags. */
export const STATUS = { INFO: 0x01, READY: 0x02, ACK: 0x03, REBOOTING: 0x04, ERROR: 0x05 };
const STATUS_LEN = { 1: 39, 2: 9, 3: 5, 4: 1, 5: 7 };
/** Error codes (FIRMWARE.md "Error codes"). */
export const ERROR_CODES = { 1: 'BUSY', 2: 'NO_UPLOAD', 3: 'TIMEOUT', 4: 'SEQUENCE', 5: 'LENGTH', 6: 'NO_SPACE', 7: 'HASH', 8: 'FLASH', 9: 'IMAGE', 10: 'ON_TRIAL', 11: 'UNAVAILABLE', 12: 'MALFORMED', 13: 'SWITCH' };
export const ERROR = Object.fromEntries(Object.entries(ERROR_CODES).map(([k, v]) => [v, Number(k)]));
/** Info's slot when the C6 does not know it. */
export const SLOT_UNKNOWN = 0xff;

// ---------------------------------------------------------------- codec ----

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v);
  throw new TypeError('expected bytes (Uint8Array, ArrayBuffer, DataView or number[])');
}

/** A 32-byte digest from bytes or 64 hex digits. */
function digestBytes(sha) {
  if (typeof sha === 'string') {
    if (!/^[0-9a-f]{64}$/i.test(sha)) throw new RangeError(`sha256 "${sha}" is not 64 hex digits`);
    return Uint8Array.from(sha.match(/../g), (h) => parseInt(h, 16));
  }
  const b = toBytes(sha);
  if (b.length !== 32) throw new RangeError(`sha256 is ${b.length} bytes (must be 32)`);
  return b;
}

function u32(v, what) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`${what} ${v} is not a u32`);
  return v;
}

export const encodeInfo = () => Uint8Array.of(REQUEST.INFO);
export const encodeCommit = () => Uint8Array.of(REQUEST.COMMIT);
export const encodeAbort = () => Uint8Array.of(REQUEST.ABORT);

/** Begin: [0x02][len u32][sha256 32] (37 bytes): the image's length and its appended digest. */
export function encodeBegin(len, sha256) {
  const out = new Uint8Array(37);
  out[0] = REQUEST.BEGIN;
  new DataView(out.buffer).setUint32(1, u32(len, 'len'), true);
  out.set(digestBytes(sha256), 5);
  return out;
}

/** A data value: [offset u32][bytes]. (ota-client.js builds its own; this is for the fake C6 and tests.) */
export function encodeData(offset, bytes) {
  const b = toBytes(bytes);
  const out = new Uint8Array(4 + b.length);
  new DataView(out.buffer).setUint32(0, u32(offset, 'offset'), true);
  out.set(b, 4);
  return out;
}

export function decodeData(buf) {
  const b = toBytes(buf);
  if (b.length < 5) throw new RangeError(`data value is ${b.length} bytes (at least 5: an offset and a byte)`);
  return { offset: new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true), bytes: b.subarray(4) };
}

/** A control value → { tag, len?, sha256? (hex) }; throws on a value FIRMWARE.md does not define. */
export function decodeRequest(buf) {
  const b = toBytes(buf);
  const t = b[0];
  if (b.length === 1 && t === REQUEST.INFO) return { tag: 'Info' };
  if (b.length === 1 && t === REQUEST.COMMIT) return { tag: 'Commit' };
  if (b.length === 1 && t === REQUEST.ABORT) return { tag: 'Abort' };
  if (b.length === 37 && t === REQUEST.BEGIN) return { tag: 'Begin', len: new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(1, true), sha256: hex(b.subarray(5, 37)) };
  throw new RangeError(`not a request: ${b.length} bytes${b.length ? `, first 0x${t.toString(16)}` : ''}`);
}

/**
 * A status notification → one of
 *   { tag: 'Info', sha256 (hex), slot, pending (bool), maxLen }
 *   { tag: 'Ready', offset, chunk, window }
 *   { tag: 'Ack', offset }
 *   { tag: 'Rebooting' }
 *   { tag: 'Error', request, requestName, code, name, detail }
 * Throws on anything else (an unknown tag, a length the tag does not have).
 */
export function decodeStatus(buf) {
  const b = toBytes(buf);
  if (!b.length) throw new RangeError('empty status value');
  const t = b[0];
  const want = STATUS_LEN[t];
  if (want === undefined) throw new RangeError(`unknown status tag 0x${t.toString(16)} (${b.length} bytes)`);
  if (b.length !== want) throw new RangeError(`status tag 0x${t.toString(16)} is ${want} bytes, got ${b.length}`);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (t) {
    case STATUS.INFO: return { tag: 'Info', sha256: hex(b.subarray(1, 33)), slot: b[33], pending: b[34] !== 0, maxLen: dv.getUint32(35, true) };
    case STATUS.READY: return { tag: 'Ready', offset: dv.getUint32(1, true), chunk: dv.getUint16(5, true), window: dv.getUint16(7, true) };
    case STATUS.ACK: return { tag: 'Ack', offset: dv.getUint32(1, true) };
    case STATUS.REBOOTING: return { tag: 'Rebooting' };
    default: return { tag: 'Error', request: b[1], requestName: REQUEST_NAMES[b[1]] ?? `request 0x${b[1].toString(16)}`, code: b[2], name: ERROR_CODES[b[2]] ?? `code ${b[2]}`, detail: dv.getUint32(3, true) };
  }
}

/** The C6's side of decodeStatus (for the fake C6 and tests). */
export function encodeStatus(m) {
  const out = new Uint8Array(STATUS_LEN[STATUS[m.tag.toUpperCase()]]);
  const dv = new DataView(out.buffer);
  switch (m.tag) {
    case 'Info': out[0] = STATUS.INFO; out.set(digestBytes(m.sha256), 1); out[33] = m.slot; out[34] = m.pending ? 1 : 0; dv.setUint32(35, m.maxLen, true); break;
    case 'Ready': out[0] = STATUS.READY; dv.setUint32(1, m.offset, true); dv.setUint16(5, m.chunk, true); dv.setUint16(7, m.window, true); break;
    case 'Ack': out[0] = STATUS.ACK; dv.setUint32(1, m.offset, true); break;
    case 'Rebooting': out[0] = STATUS.REBOOTING; break;
    case 'Error': out[0] = STATUS.ERROR; out[1] = m.request; out[2] = typeof m.code === 'string' ? ERROR[m.code] : m.code; dv.setUint32(3, m.detail ?? 0, true); break;
    default: throw new RangeError(`unknown status ${m.tag}`);
  }
  return out;
}

export function slotName(slot) { return slot === SLOT_UNKNOWN || !Number.isInteger(slot) ? 'unknown' : `ota_${slot}`; }

// --------------------------------------------------------------- errors ----

/** How the C6's image is made (FIRMWARE.md "The image"), from projects/hilux in the monorepo. */
export const MAKE_IMAGE = 'cargo run --manifest-path ../c6-ota/Cargo.toml -p c6-image -- wireless-can/target/riscv32imac-unknown-none-elf/release/wireless-can --partitions wireless-can/partitions.csv -o wireless-can/target/wireless-can.bin';
const IMAGE_HINTS = {
  make: `choose wireless-can.bin, made from the ELF with c6-image (in projects/hilux: \`${MAKE_IMAGE}\`)`,
  chip: 'build wireless-can for the ESP32-C6',
  room: "the firmware has outgrown hilux's app slot (wireless-can/partitions.csv)",
};

/** checkImage(bytes, maxLen) → { len, sha256 }, or an Error (.code 'IMAGE', .hint): c6-ota's check with hilux's hints. */
export function checkImage(bytes, maxLen = null) {
  return checkC6Image(bytes, maxLen, IMAGE_HINTS);
}

/** What an Error from the C6 means, and what to do: { message, hint }. */
export function describeError({ request, code, detail }) {
  const name = ERROR_CODES[code] ?? `code ${code}`;
  const req = REQUEST_NAMES[request] ?? `request 0x${request?.toString(16)}`;
  const say = (message, hint) => ({ message: `${req}: ${name}: ${message}`, hint });
  switch (name) {
    case 'BUSY': return say("another connection's firmware upload is in progress on hilux", 'let it finish (or stop it: it is dropped 60 s after its last bytes), then update again');
    case 'NO_UPLOAD': return say('hilux has no upload in progress', 'start the update again');
    case 'TIMEOUT': return say('hilux dropped this upload after 60 s without bytes', 'start the update again (it begins afresh)');
    case 'SEQUENCE': return say(`a gap: hilux has the bytes up to ${detail}`, 'the upload rewinds there by itself');
    case 'LENGTH': return request === REQUEST.COMMIT
      ? say(`the commit came before every byte was in (hilux has ${detail})`, 'update again: hilux resumes from what it has')
      : say(`a length that does not fit (${detail})`, 'check the image (it must be c6-image output), and that the link negotiated an ATT MTU of at least 11');
    case 'NO_SPACE': return say(`the image does not fit: hilux's other app slot holds ${detail} bytes`, IMAGE_HINTS.room);
    case 'HASH': return say('the bytes hilux received are not the digest Begin named', 'update again; if it repeats, the file is damaged: make it again with c6-image');
    case 'FLASH': return say(`a flash read, write or erase failed on hilux (detail ${detail})`, 'update again; if it repeats, the C6 needs the probe');
    case 'IMAGE': {
      const reason = detail & 0xff;
      return say(`hilux checked the image in flash and refused it: ${IMAGE_REASONS[reason] ?? `reason ${reason}`} (detail ${detail >>> 8})`, IMAGE_HINTS.make);
    }
    case 'ON_TRIAL': return say('the running firmware is an update still on trial (not yet confirmed)', 'wait until it confirms itself, 20 s after its boot, then update again');
    case 'UNAVAILABLE': return say("this C6 takes no updates: it has no second app slot or otadata, or doesn't know its own image", "the one-time move to the OTA partition table hasn't been done: it needs the probe (wireless-can README, \"The one-time move to the OTA partition table\")");
    case 'MALFORMED': return say(`hilux did not understand the request (a ${detail}-byte value)`, 'this page and the C6 firmware disagree about FIRMWARE.md: update dingo-web');
    case 'SWITCH': return say('the image checked out, but hilux could not record the update or switch otadata: nothing changed, no reset', "update again; if it repeats, see the C6's log (otadata)");
    default: return say(`detail ${detail}`, undefined);
  }
}

/** An Error answer from the C6. .code is its name (BUSY, ON_TRIAL, IMAGE, ...). */
export class FirmwareError extends Error {
  constructor(m) {
    const d = describeError(m);
    super(d.message);
    this.name = 'FirmwareError';
    this.code = ERROR_CODES[m.code] ?? `CODE_${m.code}`;
    this.request = m.request;
    this.detail = m.detail;
    this.hint = d.hint;
  }
}


// The role: Kindle Settings → Bluetooth → this computer → Firmware, confirmed
// by a second tap (FIRMWARE.md "Access", KEYLESS.md "Device roles").
export const FIRMWARE_ROLE_REFUSED = "This computer isn't allowed to update hilux's firmware — grant it the Firmware role on the Kindle";
const ROLE_HOW = "(Settings → Bluetooth: tap this computer's name, turn on Firmware and tap again to confirm; if it is not listed, Pair new device with Firmware and connect from here while the window is open)";
export const FIRMWARE_STALE_PAIRING = "if this keeps happening, this computer probably holds an old pairing with 'hilux': forget 'hilux' in macOS System Settings → Bluetooth, then PAIR on the Kindle (with the Firmware role) and connect again";

function refused(op, e) {
  return linkError(`${FIRMWARE_ROLE_REFUSED} ${ROLE_HOW} [${op}: ${errText(e)}]`, 'NOT_AUTHORISED',
    "a person must grant this computer the Firmware role on the Kindle page (Settings → Bluetooth); retrying from here will not help");
}

// ------------------------------------------------------------- client ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * createFirmware({ link | bluetooth, log, ...options }) → firmware.
 *
 * A consumer of the page's one link to the C6 (link.js), shared with the CAN
 * bridge: it never connects, picks or watches for advertisements itself.
 * Without a `link` it makes its own from `bluetooth`.
 *
 *   connect({ allowChooser, forceChooser })  the link's connect, then the
 *                     firmware service on it (the chooser only from a click)
 *   disconnect()      lets go of the link (it stays up while another consumer uses it)
 *   info()            → { sha256, slot, pending, maxLen }
 *   update(bytes, { onProgress, allowSame })  the whole update (below)
 *   abort()           drops hilux's upload in progress → Info
 *   isConnected(), state, onState(cb), lastInfo()
 *
 * Options (mostly for tests):
 *   connectTimeoutMs (15000), advertTimeoutMs (12000), reconnectDelayMs (1000)
 *                     for the link it makes when none is given
 *   requestTimeoutMs (10000),
 *   commitTimeoutMs (30000: the C6 hashes and walks the image in flash),
 *   stallMs (4000), maxStalls (3), resumeTries (3), reconnectWaitMs (30000)
 *                     ota-client.js's, per dropped link
 *   resetWaitMs (30000)      after Rebooting: how long for the link to drop
 *   bootWaitMs (60000)       then: how long for the link to come back
 *   confirmWaitMs (90000)    then: how long for it to confirm the update (20 s on the C6)
 *   pollMs (2000)            Info every pollMs meanwhile
 */
export function createFirmware({
  bluetooth = globalThis.navigator?.bluetooth,
  link = null,
  log = () => {},
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  connectTimeoutMs = 15000,
  advertTimeoutMs = 12000,
  requestTimeoutMs = 10000,
  commitTimeoutMs = 30000,
  stallMs = 4000,
  maxStalls = 3,
  resumeTries = 3,
  reconnectWaitMs = 30000,
  reconnectDelayMs = 1000,
  resetWaitMs = 30000,
  bootWaitMs = 60000,
  confirmWaitMs = 90000,
  pollMs = 2000,
} = {}) {
  const L = (level, msg) => { try { log(level, 'firmware: ' + msg); } catch { /* logging must never break transport */ } };
  link = link || createLink({ bluetooth, log, connectTimeoutMs, advertTimeoutMs, reconnectDelayMs });
  const USER = 'firmware';
  const gattOp = link.gattOp;

  let chars = null; // { control, data, status } on the current link
  let charsGen = -1; // the link generation they belong to
  let state = 'disconnected'; // disconnected | connecting | connected
  let wanted = false;
  let last = null; // the last Info
  const listeners = new Set(); // status messages, and { tag: 'Disconnected' }
  const stateListeners = new Set();

  function setState(s) {
    if (s === state) return;
    state = s;
    L('info', `state → ${s}`);
    for (const cb of stateListeners) { try { cb(s); } catch { /* ignore */ } }
  }

  function emit(m) { for (const l of [...listeners]) { try { l(m); } catch (e) { L('error', 'listener threw: ' + errText(e)); } } }

  function onStatus(ev) {
    let m;
    try { m = decodeStatus(ev.target.value); } catch (e) {
      L('warn', `undecodable status notification dropped (${e.message})`);
      return;
    }
    if (m.tag !== 'Ack') L('debug', `← ${m.tag}${m.tag === 'Error' ? ` ${m.requestName} ${m.name} ${m.detail}` : ''}`);
    if (m.tag === 'Info') last = m;
    emit(m);
  }

  link.onDown((reason) => {
    const was = !!chars;
    chars = null;
    if (!was && state !== 'connected') return;
    L(reason === 'dropped' ? 'warn' : 'info', reason === 'dropped' ? 'the link dropped' : 'disconnected');
    setState('disconnected');
    emit({ tag: 'Disconnected' });
  });

  // Every link fetches the service and its characteristics again, never
  // reusing objects from an earlier one: after an update that changes the
  // GATT table the C6 indicates Service Changed (hilux b3de8e3) and Chrome
  // invalidates every object it handed out before.
  async function attach() {
    const gen = link.generation;
    let service;
    try { service = await link.service(FIRMWARE_SERVICE, 'firmware'); } catch (e) {
      if (e.code === 'SERVICE_NOT_GRANTED') {
        throw linkError(`Chrome has not granted this page hilux's firmware service on ${link.device?.name || 'hilux'} (it was picked before this page asked for it): a person must click Connect and pick hilux in Chrome's chooser`, 'SERVICE_NOT_GRANTED', e.hint);
      }
      if (e.code === 'NO_SERVICE') {
        throw linkError(`${e.message}: its firmware predates updates over BLE (it needs the probe once: wireless-can README "The one-time move to the OTA partition table"), or this Mac keeps hilux's GATT table from before (a pairing made before hilux's GATT caching is never told it changed: forget 'hilux' in macOS System Settings → Bluetooth and PAIR again on the Kindle)`, 'NO_FIRMWARE_SERVICE',
          "flash a firmware with the firmware service by probe once; or, if it has one, forget 'hilux' on the Mac and PAIR again on the Kindle (the Mac then reads the table afresh)");
      }
      throw e;
    }
    const got = [];
    for (const u of [FIRMWARE_CONTROL, FIRMWARE_DATA, FIRMWARE_STATUS]) {
      try { got.push(await gattOp(() => service.getCharacteristic(u))); } catch (e) {
        throw new Error(`firmware service found but characteristic ${u} is missing (${errText(e)}); the C6 firmware does not match FIRMWARE.md`);
      }
    }
    const [control, data, status] = got;
    status.removeEventListener?.('characteristicvaluechanged', onStatus);
    status.addEventListener('characteristicvaluechanged', onStatus);
    // Subscribe before any request: answers come only as notifications.
    await gattOp(() => status.startNotifications()).catch((e) => { throw isRefusal(e) ? refused('status subscribe', e) : e; });
    chars = { control, data, status };
    charsGen = gen;
    setState('connected');
  }

  let updating = false; // the post-commit wait: never let go of the link on an inferred refusal
  function attachFailed(e) {
    chars = null;
    setState('disconnected');
    if (!updating && ['NOT_AUTHORISED', 'SERVICE_NOT_GRANTED'].includes(e.code)) { wanted = false; link.release(USER); }
  }

  async function connect({ allowChooser = false, forceChooser = false } = {}) {
    if (!forceChooser && isConnected()) return { deviceName: link.device.name, deviceId: link.device.id, already: true };
    wanted = true;
    link.use(USER);
    setState('connecting');
    try {
      await link.connect({ allowChooser, forceChooser });
      try {
        await attach();
      } catch (e) {
        if (e.code !== 'SERVICE_NOT_GRANTED' || !allowChooser || forceChooser) throw e;
        L('warn', `${errText(e)}; re-picking in the chooser`);
        try { await link.connect({ forceChooser: true }); } catch (e2) { throw linkError(`${e.message} [the chooser did not open: ${errText(e2)}]`, 'SERVICE_NOT_GRANTED', e.hint); }
        await attach();
      }
      return { deviceName: link.device.name, deviceId: link.device.id, already: false };
    } catch (e) {
      attachFailed(e);
      if (!['NOT_AUTHORISED', 'SERVICE_NOT_GRANTED'].includes(e.code)) { wanted = false; link.unuse(USER); }
      throw e;
    }
  }

  /** The link back (after a drop or a reset) within ms, and the service on it → bool; a refusal throws. */
  async function reconnect(ms) {
    const until = now() + ms;
    for (;;) {
      if (isConnected()) return true;
      if (!wanted) return false;
      setState('connecting');
      if (!(await link.waitConnected(Math.max(0, until - now())))) { setState('disconnected'); return false; }
      try {
        await attach();
        return true;
      } catch (e) {
        attachFailed(e);
        if (['NOT_AUTHORISED', 'SERVICE_NOT_GRANTED', 'NO_FIRMWARE_SERVICE'].includes(e.code)) throw e;
        L('warn', `firmware service after the link came back: ${errText(e)}`);
      }
      if (now() + reconnectDelayMs > until) return false;
      await sleep(reconnectDelayMs);
    }
  }

  async function disconnect() {
    wanted = false;
    chars = null;
    setState('disconnected');
    link.release(USER);
  }

  function isConnected() { return state === 'connected' && !!chars && charsGen === link.generation && link.isConnected(); }

  const dropped = (what) => linkError(`${what}: the link to hilux dropped`, 'DROPPED', 'connect again and update again within 60 s: hilux resumes from what it has');

  /**
   * One request: register for the answer, write control (with response),
   * resolve on done(answer); an Error for this request rejects with a
   * FirmwareError, a dropped link with DROPPED, silence with TIMEOUT.
   */
  function request(bytes, code, done, ms = requestTimeoutMs) {
    if (!isConnected()) return Promise.reject(linkError(`${REQUEST_NAMES[code]}: not connected to hilux's firmware service (state: ${state})`, 'NOT_CONNECTED', 'connect first'));
    const c = chars;
    let listener; let timer;
    const answered = new Promise((resolve, reject) => {
      listener = (m) => {
        if (m.tag === 'Disconnected') return reject(dropped(REQUEST_NAMES[code]));
        if (m.tag === 'Error' && m.request === code) return reject(new FirmwareError(m));
        if (m.tag !== 'Error' && done(m)) resolve(m);
      };
      listeners.add(listener);
      timer = setTimeout(() => reject(linkError(`${REQUEST_NAMES[code]}: no answer from hilux in ${ms} ms`, 'TIMEOUT', 'disconnect and connect again; hilux may be busy or resetting')), ms);
    });
    answered.catch(() => {});
    const sent = gattOp(() => c.control.writeValueWithResponse(bytes)).catch((e) => {
      if (isRefusal(e) && isConnected()) throw refused(`${REQUEST_NAMES[code]} write`, e);
      if (!isConnected()) throw dropped(REQUEST_NAMES[code]);
      throw e;
    });
    return Promise.all([sent, answered]).then(([, m]) => m).finally(() => { listeners.delete(listener); clearTimeout(timer); });
  }

  async function info() {
    const m = await request(encodeInfo(), REQUEST.INFO, (x) => x.tag === 'Info');
    return { sha256: m.sha256, slot: m.slot, pending: m.pending, maxLen: m.maxLen };
  }

  async function abort() {
    const m = await request(encodeAbort(), REQUEST.ABORT, (x) => x.tag === 'Info');
    return { sha256: m.sha256, slot: m.slot, pending: m.pending, maxLen: m.maxLen };
  }

  /** ota-client.js's transport over this service, for the image `len`/`digest`. */
  function transport(len, digest) {
    return {
      begin: async () => {
        const m = await request(encodeBegin(len, digest), REQUEST.BEGIN, (x) => x.tag === 'Ready');
        return { offset: m.offset, chunk: m.chunk, window: m.window };
      },
      writeData: (value) => {
        const c = chars;
        if (!c || !isConnected()) return Promise.reject(dropped('the upload'));
        return gattOp(() => (c.data.writeValueWithoutResponse ? c.data.writeValueWithoutResponse(value) : c.data.writeValue(value)));
      },
      onResponse(fn) {
        const l = (m) => {
          if (m.tag === 'Ack') fn({ tag: 'Ack', offset: m.offset });
          else if (m.tag === 'Disconnected') fn({ tag: 'Disconnected' });
          else if (m.tag === 'Error' && m.request === REQUEST.DATA) fn(m.code === ERROR.SEQUENCE ? { tag: 'Sequence', expected: m.detail } : { tag: 'Error', error: new FirmwareError(m) });
          else fn({ tag: 'Other' });
        };
        listeners.add(l);
        return () => listeners.delete(l);
      },
      isConnected,
      waitConnected: (ms) => reconnect(ms),
      // The C6 answers Rebooting and resets 0.5 s later; a link that drops
      // first leaves the answer unknown: what boots tells.
      commit: async () => {
        try { await request(encodeCommit(), REQUEST.COMMIT, (x) => x.tag === 'Rebooting', commitTimeoutMs); return 'rebooting'; } catch (e) {
          if (e.code === 'DROPPED') { L('warn', 'the link dropped before Rebooting arrived: checking what hilux boots'); return 'dropped'; }
          throw e;
        }
      },
      dropped,
      stalled: (message) => linkError(message, 'STALLED', 'disconnect, connect and update again within 60 s: hilux resumes from what it has'),
      lost: () => linkError('the link dropped mid-upload and did not come back', 'DROPPED', 'connect again and update again within 60 s: hilux resumes from what it has'),
    };
  }

  function waitForDrop(ms) {
    if (!isConnected()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let t;
      const l = (m) => { if (m.tag === 'Disconnected') { clearTimeout(t); listeners.delete(l); resolve(true); } };
      listeners.add(l);
      t = setTimeout(() => { listeners.delete(l); resolve(false); }, ms);
    });
  }

  /**
   * The whole update:
   *   1. Info (the running digest, whether it is on trial, the room);
   *   2. checkImage (c6-ota's, with that room); an image that is already
   *      running is refused (SAME) unless allowSame;
   *   3. sendImage (ota-client.js) over this service, resuming after drops;
   *   4. Commit → Rebooting; the link drops as the C6 resets;
   *   5. reconnect, then Info every pollMs until the update runs and is
   *      confirmed (pending 0). Running the old image again, unconfirmed,
   *      means the update was rolled back (or its image refused by the
   *      bootloader): ROLLED_BACK.
   * onProgress({ phase, sent, total, kbps, ... }): phase begin | upload |
   * reconnect (ota-client.js's), then commit | rebooting | booting | trial.
   * → { len, sha256, previous: { sha256, slot }, slot, chunk, window,
   *     resumedFrom, resumes, rewinds, resends, written, uploadMs, kbps,
   *     committed ('rebooting' | 'dropped'), confirmMs, ms }
   */
  async function update(bytes, { onProgress = () => {}, allowSame = false } = {}) {
    const t0 = now();
    const P = (p) => { try { onProgress(p); } catch { /* ignore */ } };
    const b = toBytes(bytes);
    const before = await info();
    L('info', `running ${before.sha256} in ${slotName(before.slot)}${before.pending ? ' (on trial)' : ''}, room ${before.maxLen} B`);
    const img = await checkImage(b, before.maxLen > 0 ? before.maxLen : null);
    if (img.sha256 === before.sha256 && !allowSame) {
      throw linkError(`hilux is already running this image (${img.sha256})`, 'SAME', 'choose another image; nothing was sent');
    }
    L('info', `update: ${img.len} B, sha256 ${img.sha256}`);
    const out = await sendImage(b, transport(img.len, img.sha256), {
      onProgress: (p) => P(p), log: (level, msg) => L(level, msg), now, stallMs, maxStalls, resumeTries, reconnectWaitMs,
    });
    const uploadMs = out.ms;
    const kbps = Math.round(((img.len - (out.resumedFrom ?? 0)) / Math.max(1, uploadMs)) * 10) / 10;
    P({ phase: 'rebooting', sent: img.len, total: img.len, kbps });
    if (!(await waitForDrop(resetWaitMs))) {
      throw linkError(`hilux answered the commit but did not reset within ${resetWaitMs} ms`, 'NO_RESET', "see the C6's log; Read firmware info shows what runs");
    }
    P({ phase: 'booting', sent: img.len, total: img.len, kbps });
    updating = true;
    try { return await afterReset(img, before, out, uploadMs, kbps, t0, P); } finally { updating = false; }
  }

  /** After the commit's reset: the link back, then Info until the update runs confirmed (or is rolled back). */
  async function afterReset(img, before, out, uploadMs, kbps, t0, P) {
    const tBoot = now();
    let refusal = null;
    let back = false;
    try { back = await reconnect(bootWaitMs); } catch (e) {
      if (e.code !== 'NOT_AUTHORISED') throw e;
      refusal = e; back = true; // a link came back; see the loop below
      L('warn', `after the reset: ${errText(e)}`);
    }
    if (!back) {
      throw linkError(`hilux did not come back within ${bootWaitMs / 1000} s of its reset`, 'NOT_BACK', 'check it has power; then Read firmware info: it says what runs (the update rolls back by itself if it fails)');
    }
    let seen = null;
    for (;;) {
      // While the update is on trial a failure that looks like a refusal is
      // not one to act on: macOS reports every failed GATT operation alike
      // (ble.js "refusals"), and an update that hangs or resets fails them
      // too (seen on the hardware 2026-10-19 with ota-hang-test: an Info
      // write failed while the C6's executor hung, and the page stopped
      // watching before the rollback). This computer had the role a minute
      // ago and an update keeps the bonds; the C6 confirms or rolls back by
      // itself, so keep watching, and say what was seen if it never settles.
      try {
        if (!isConnected() && !(await reconnect(Math.max(0, tBoot + bootWaitMs + confirmWaitMs - now())))) break;
        seen = await info();
      } catch (e) {
        if (e.code === 'NOT_AUTHORISED') refusal = e;
        L('warn', `Info after the reset: ${errText(e)}`);
      }
      if (seen) {
        if (seen.sha256 === img.sha256 && !seen.pending) break;
        if (seen.sha256 !== img.sha256 && !seen.pending) {
          throw linkError(`hilux is running ${seen.sha256} (${slotName(seen.slot)}) again, not the update: it was rolled back (its third boot without confirming) or the bootloader refused its image`, 'ROLLED_BACK',
            "see the C6's log (firmware: on trial … rolling back); the old firmware runs, nothing else changed");
        }
        P({ phase: 'trial', sent: img.len, total: img.len, kbps, slot: seen.slot });
      }
      if (now() - tBoot > bootWaitMs + confirmWaitMs) break;
      await sleep(pollMs);
    }
    if (!seen || seen.sha256 !== img.sha256 || seen.pending) {
      throw linkError(`the update is not confirmed after ${Math.round((now() - tBoot) / 1000)} s${seen ? ` (running ${seen.sha256}${seen.pending ? ', on trial' : ''})` : ''}${refusal ? ` (meanwhile: ${refusal.message})` : ''}`, 'NOT_CONFIRMED', 'Read firmware info again in a minute: an update confirms itself 20 s after it boots, or rolls back');
    }
    const ms = Math.round(now() - t0);
    L('info', `update running and confirmed in ${slotName(seen.slot)} (${Math.round(now() - tBoot)} ms after the reset)`);
    return {
      len: img.len, sha256: img.sha256, previous: { sha256: before.sha256, slot: before.slot }, slot: seen.slot,
      chunk: out.chunk, window: out.window, resumedFrom: out.resumedFrom, resumes: out.resumes, rewinds: out.rewinds, resends: out.resends, written: out.written,
      uploadMs, kbps, committed: out.committed, confirmMs: Math.round(now() - tBoot), ms,
    };
  }

  return {
    connect, disconnect, isConnected, info, abort, update,
    onState: (cb) => { stateListeners.add(cb); return () => stateListeners.delete(cb); },
    lastInfo: () => (last ? { sha256: last.sha256, slot: last.slot, pending: last.pending, maxLen: last.maxLen } : null),
    get state() { return state; },
  };
}

export { DIGEST_LEN, hex };

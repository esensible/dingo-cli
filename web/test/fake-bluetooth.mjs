// fake-bluetooth.mjs — a fake Web Bluetooth stack wired to a fake hilux C6 CAN
// bridge (per hilux/wireless-can/BRIDGE.md) and fake dingoPDMs on a fake CAN bus.
//
// Behaviours modelled (the ones the real Chrome/C6 showed):
//  - getDevices() returns remembered devices; requestDevice() needs `chooserResult`
//    (and fails without a user gesture when bluetooth.noUserActivation is set).
//  - device.serviceNotGranted: picked before the bridge service existed, so
//    getPrimaryService() fails with SecurityError until it is picked again.
//  - after a "page reload" (device.inRangeKnown=false) gatt.connect() rejects with
//    "Bluetooth Device is no longer in range." until an advertisement was received
//    via watchAdvertisements().
//  - concurrent GATT operations reject with "GATT operation already in progress."
//  - unexpected disconnects (dropLink()), after which the bridge filter is empty.
//  - tx: concatenated frames, max 10 per write, malformed → whole write rejected.
//  - rx: frames matching the filter, up to 20 per notification, concatenated.
//  - roles: with c6.refuse set (this computer lacks the CAN bridge role), rx
//    subscribe, filter read/write and stats read fail the way Chrome reports
//    the C6's ATT 0x08 — 'mac': NotSupportedError "GATT operation failed for
//    unknown reason." (CoreBluetooth errors are not translated), 'other':
//    SecurityError "GATT operation not authorized."; a tx write without
//    response is dropped silently (no ATT reply).
//  - stale pairing: with device.stalePairing set, the link comes up and drops
//    at once (macOS encrypting with a key the C6 no longer has, then
//    disconnecting itself); with 'connect', gatt.connect() itself fails with
//    "Connection Error: Connection attempt failed." while the C6 keeps
//    advertising -- what Chrome on macOS actually reported (2026-10-03).

import { BRIDGE_SERVICE, BRIDGE_TX, BRIDGE_RX, BRIDGE_FILTER, BRIDGE_STATS, decodeFrames, encodeFrames, decodeFilter, filterMatches } from '../ble.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function domErr(name, message) { const e = new Error(message); e.name = name; return e; }
function refusal(c6) {
  return c6.refuse === 'other' ? domErr('SecurityError', 'GATT operation not authorized.') : domErr('NotSupportedError', 'GATT operation failed for unknown reason.');
}

// ------------------------------------------------------------------ CAN bus ----

export class FakeBus {
  constructor() { this.nodes = new Set(); this.log = []; }
  attach(node) { this.nodes.add(node); node.bus = this; return node; }
  detach(node) { this.nodes.delete(node); }
  /** A frame transmitted by `from` reaches every other node. */
  transmit(from, id, data) {
    this.log.push({ id, data: Uint8Array.from(data) });
    if (this.log.length > 5000) this.log.splice(0, 1000);
    for (const n of this.nodes) if (n !== from) n.receive(id, Uint8Array.from(data));
  }
}

// ------------------------------------------------------------------ fake PDM ----

const CMD = { read: 1, write: 2, readAll: 10, readAllRsp: 11, readAllComplete: 12, writeAll: 20, writeAllVal: 21, writeAllComplete: 22, burn: 30, version: 31, bootloader: 33, checkCrc: 34, checkCrcRsp: 35 };
export { CMD };

let CRC_TABLE;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function crcOfParams(params) {
  const buf = new Uint8Array(params.length * 4);
  const dv = new DataView(buf.buffer);
  params.forEach((p, i) => dv.setUint32(i * 4, p.value >>> 0, true));
  return crc32(buf);
}
export function frameBytes(cmd, index, sub, value) {
  const d = new Uint8Array(8); const dv = new DataView(d.buffer);
  d[0] = cmd; dv.setUint16(1, index, true); d[3] = sub; dv.setUint32(4, value >>> 0, true);
  return d;
}
export function decodeMsg(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return { cmd: d[0], index: dv.getUint16(1, true), sub: d[3], value: dv.getUint32(4, true) };
}

/** An in-memory dingoPDM: the firmware's param protocol + cyclic status frames. */
export class FakePdm {
  constructor({ base = 222, version = [0, 4, 12], statusIds = 27, statusPeriodMs = 0, initial = [], pdmType = 0 } = {}) {
    this.base = base;
    this.pdmType = pdmType; // broadcast in the high nibble of byte 1 of base+2 (state Run = 0 in the low nibble)
    this.version = version;
    this.statusIds = statusIds;
    this.order = initial.map((p) => ({ ...p }));
    this.store = new Map(this.order.map((p) => [key(p.index, p.sub), p.value]));
    this.staged = [];
    this.burned = 0;
    this.commands = [];
    this.silent = false; // stop answering (powered off)
    this.timer = statusPeriodMs ? setInterval(() => this.emitStatus(), statusPeriodMs) : null;
    this.timer?.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); }
  emitStatus() {
    if (this.silent || !this.bus) return;
    for (let i = 0; i < this.statusIds; i++) this.bus.transmit(this, this.base + 2 + i, Uint8Array.of(i, i === 0 ? this.pdmType << 4 : 0, 0, 0, 0, 0, 0, 0));
  }
  reply(cmd, idx, sub, val) { this.bus.transmit(this, this.base, frameBytes(cmd, idx, sub, val)); }
  receive(id, data) {
    if (this.silent || id !== this.base + 1 || data.length < 8) return;
    const m = decodeMsg(data);
    this.commands.push(m.cmd);
    // Reply asynchronously, like real hardware.
    queueMicrotask(() => this.handle(m));
  }
  /** ReadAll dump paced like dingoFW SendAllParams: batches of 51 frames, 10 ms apart. */
  async dump() {
    const order = this.order.slice();
    this.reply(CMD.readAll, 0, 0, 0);
    await new Promise((r) => setTimeout(r, 1));
    let n = 0;
    for (const p of order) {
      if (n > 50) { await new Promise((r) => setTimeout(r, 10)); n = 0; }
      n++;
      this.reply(CMD.readAllRsp, p.index, p.sub, p.value);
    }
    this.reply(CMD.readAllComplete, order.length, 0, crcOfParams(order));
  }
  handle(m) {
    switch (m.cmd) {
      case CMD.writeAll: this.staged = []; this.reply(CMD.writeAll, 0, 0, 0); break;
      case CMD.writeAllVal: this.staged.push({ index: m.index, sub: m.sub, value: m.value }); break;
      case CMD.writeAllComplete: {
        this.order = this.staged.map((p) => ({ ...p }));
        for (const p of this.order) this.store.set(key(p.index, p.sub), p.value);
        this.reply(CMD.writeAllComplete, this.staged.length, 0, crcOfParams(this.staged));
        break;
      }
      case CMD.write: this.store.set(key(m.index, m.sub), m.value); {
        const p = this.order.find((x) => x.index === m.index && x.sub === m.sub);
        if (p) p.value = m.value; else this.order.push({ index: m.index, sub: m.sub, value: m.value });
      }
        this.reply(CMD.write, m.index, m.sub, m.value); break;
      case CMD.read: this.reply(CMD.read, m.index, m.sub, this.store.get(key(m.index, m.sub)) ?? 0); break;
      case CMD.readAll: this.dump(); break;
      case CMD.checkCrc: this.reply(CMD.checkCrcRsp, 0, 0, crcOfParams(this.order)); break;
      case CMD.burn: this.burned++; this.reply(CMD.burn, 0, 0, 1); break;
      case CMD.version: {
        const [maj, min, bld] = this.version;
        this.reply(CMD.version, 0, 0, (maj & 0xff) | ((min & 0xff) << 8) | (((bld >> 8) & 0xff) << 16) | ((bld & 0xff) << 24));
        break;
      }
      default: break;
    }
  }
}
function key(i, s) { return i * 256 + s; }

/** A node that just puts frames on the bus (other traffic, e.g. the C6's own 0x300/0x400 ids). */
export class FakeNode { receive() {} send(id, data) { this.bus.transmit(this, id, data); } }

// ------------------------------------------------------------ fake C6 bridge ----

class FakeCharacteristic extends EventTarget {
  constructor(server, uuid, impl) { super(); this.server = server; this.uuid = uuid; this.impl = impl; this.value = null; }
  async _op(name, fn) {
    const s = this.server;
    if (!s.connected) throw domErr('NetworkError', 'GATT Server is disconnected. Cannot perform GATT operations.');
    if (s.inFlight) throw domErr('NetworkError', 'GATT operation already in progress.');
    s.inFlight = name;
    s.opCount++;
    try {
      await tick(s.c6.latencyMs);
      if (!s.connected) throw domErr('NetworkError', 'GATT Server is disconnected. Cannot perform GATT operations.');
      return await fn();
    } finally { s.inFlight = null; }
  }
  writeValue(v) { return this._op('write', () => this.impl.write?.(bytes(v))); }
  writeValueWithResponse(v) { return this.writeValue(v); }
  writeValueWithoutResponse(v) { return this.writeValue(v); }
  readValue() { return this._op('read', () => { const b = this.impl.read(); return new DataView(b.buffer, b.byteOffset, b.byteLength); }); }
  startNotifications() { return this._op('notify', () => { this.impl.subscribe?.(); this.notifying = true; return this; }); }
  stopNotifications() { return this._op('notify', () => { this.notifying = false; return this; }); }
  _notify(buf) {
    if (!this.notifying || !this.server.connected) return;
    this.value = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}
function bytes(v) { return v instanceof Uint8Array ? Uint8Array.from(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) : new Uint8Array(v); }

/** The C6: a CAN node + a GATT server with the bridge service. */
export class FakeC6 {
  constructor({ latencyMs = 1, mtu = 247 } = {}) {
    this.latencyMs = latencyMs;
    this.mtu = mtu;
    this.filter = [];
    this.stats = { tx_ok: 0, tx_err: 0, rx_forwarded: 0, rx_dropped: 0 };
    this.rxQueue = [];
    this.txWrites = [];
    this.malformedWrites = 0;
    this.flushScheduled = false;
    this.server = null;
    this.refuse = null; // 'mac' | 'other': this computer has no CAN bridge role
    this.refusedTx = 0;
  }
  receive(id, data) {
    if (!this.server?.connected || !filterMatches(this.filter, id)) return;
    if (!this.chars?.rx.notifying) { this.stats.rx_dropped++; return; } // not subscribed: discarded (BRIDGE.md)
    if (this.rxQueue.length >= 64) { this.stats.rx_dropped++; return; }
    this.rxQueue.push({ id, data });
    this.stats.rx_forwarded++;
    if (!this.flushScheduled) { this.flushScheduled = true; setTimeout(() => this.flush(), 0); }
  }
  flush() {
    this.flushScheduled = false;
    while (this.rxQueue.length) {
      const batch = this.rxQueue.splice(0, 20);
      const total = batch.reduce((n, f) => n + 3 + f.data.length, 0);
      const out = new Uint8Array(total); let o = 0;
      for (const f of batch) { out[o++] = f.id & 0xff; out[o++] = f.id >> 8; out[o++] = f.data.length; out.set(f.data, o); o += f.data.length; }
      this.chars?.rx._notify(out);
    }
  }
  /** Inject a raw notification (e.g. malformed) straight to the client. */
  rawNotify(buf) { this.chars?.rx._notify(Uint8Array.from(buf)); }
  makeService(server) {
    const c6 = this;
    const tx = new FakeCharacteristic(server, BRIDGE_TX, {
      write(buf) {
        if (c6.refuse) { c6.refusedTx++; return; } // write without response: no reply, dropped on the C6
        if (buf.length > c6.mtu - 3) throw domErr('NetworkError', `GATT Error: write of ${buf.length} bytes exceeds ATT MTU ${c6.mtu}`);
        let frames;
        try { frames = decodeFrames(buf); } catch (e) { c6.malformedWrites++; throw domErr('NotSupportedError', 'GATT Error 0x13: Value Not Allowed (malformed frame buffer: ' + e.message + ')'); }
        if (frames.length > 10) { c6.malformedWrites++; throw domErr('NotSupportedError', 'GATT Error: more than 10 frames'); }
        c6.txWrites.push(frames.length);
        for (const f of frames) { c6.stats.tx_ok++; c6.bus.transmit(c6, f.id, f.data); }
      },
    });
    const rx = new FakeCharacteristic(server, BRIDGE_RX, { subscribe() { if (c6.refuse) throw refusal(c6); } });
    const filter = new FakeCharacteristic(server, BRIDGE_FILTER, {
      write(buf) { if (c6.refuse) throw refusal(c6); if (buf.length % 4 || buf.length > 32) throw domErr('NotSupportedError', 'bad filter length'); c6.filter = decodeFilter(buf); c6.rxQueue = []; },
      read() { if (c6.refuse) throw refusal(c6); const out = new Uint8Array(c6.filter.length * 4); c6.filter.forEach((e, i) => { out[i * 4] = e.id & 0xff; out[i * 4 + 1] = e.id >> 8; out[i * 4 + 2] = e.mask & 0xff; out[i * 4 + 3] = e.mask >> 8; }); return out; },
    });
    const stats = new FakeCharacteristic(server, BRIDGE_STATS, {
      read() { if (c6.refuse) throw refusal(c6); const b = new Uint8Array(16); const dv = new DataView(b.buffer); ['tx_ok', 'tx_err', 'rx_forwarded', 'rx_dropped'].forEach((k, i) => dv.setUint32(i * 4, c6.stats[k], true)); return b; },
    });
    this.chars = { tx, rx, filter, stats };
    const map = new Map([[BRIDGE_TX, tx], [BRIDGE_RX, rx], [BRIDGE_FILTER, filter], [BRIDGE_STATS, stats]]);
    return {
      uuid: BRIDGE_SERVICE,
      async getCharacteristic(u) { await tick(0); const c = map.get(u); if (!c) throw domErr('NotFoundError', 'No Characteristics matching UUID ' + u); return c; },
    };
  }
}

// --------------------------------------------------------- fake BT device ----

class FakeGattServer {
  constructor(device) { this.device = device; this.connected = false; this.inFlight = null; this.opCount = 0; this.c6 = device.c6; }
  async connect() {
    const d = this.device;
    d.connectCalls++;
    await tick(d.connectDelayMs);
    if (d.failConnects > 0) { d.failConnects--; throw domErr('NetworkError', 'Connection attempt failed.'); }
    if (!d.inRangeKnown) throw domErr('NetworkError', 'Bluetooth Device is no longer in range.');
    if (!d.powered) throw domErr('NetworkError', 'Connection attempt failed.');
    // As Chrome on macOS reported it on the hardware: connect() itself fails
    // while the C6 keeps advertising.
    if (d.stalePairing === 'connect') throw domErr('NetworkError', 'Connection Error: Connection attempt failed.');
    this.connected = true;
    this.c6.server = this;
    this.c6.filter = []; // empty after every connect (BRIDGE.md)
    if (d.stalePairing) this.disconnect(); // the C6 rejected macOS's old key; macOS drops the link
    return this;
  }
  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.c6.filter = [];
    queueMicrotask(() => this.device.dispatchEvent(new Event('gattserverdisconnected')));
  }
  async getPrimaryService(uuid) {
    await tick(0);
    if (!this.connected) throw domErr('NetworkError', 'GATT Server is disconnected.');
    if (uuid !== BRIDGE_SERVICE || this.device.noBridgeService) throw domErr('NotFoundError', 'No Services matching UUID ' + uuid + ' found in Device.');
    // Picked before the bridge service existed: Chrome never granted it to this origin.
    if (this.device.serviceNotGranted) throw domErr('SecurityError', "Origin is not allowed to access the service. Tip: Add the service UUID to 'optionalServices' in requestDevice() options. https://goo.gl/HxfxSQ");
    return this.c6.makeService(this);
  }
}

export class FakeDevice extends EventTarget {
  constructor({ name = 'hilux', id = 'fake-hilux-id', c6, inRangeKnown = true } = {}) {
    super();
    this.name = name; this.id = id; this.c6 = c6;
    this.inRangeKnown = inRangeKnown; // false = "after page reload": needs an advertisement first
    this.powered = true;
    this.advertising = true;
    this.connectDelayMs = 1;
    this.advertDelayMs = 5;
    this.failConnects = 0;
    this.connectCalls = 0;
    this.watchCalls = 0;
    this.noBridgeService = false;
    this.stalePairing = false;
    this.gatt = new FakeGattServer(this);
  }
  async watchAdvertisements(opts = {}) {
    this.watchCalls++;
    this.watchingAdvertisements = true;
    const t = setTimeout(() => {
      if (!this.watchingAdvertisements || !this.advertising || !this.powered) return;
      this.inRangeKnown = true;
      this.dispatchEvent(new Event('advertisementreceived'));
    }, this.advertDelayMs);
    opts.signal?.addEventListener('abort', () => { this.watchingAdvertisements = false; clearTimeout(t); });
  }
  /** Simulate the link dropping (C6 reset, out of range...). */
  dropLink() {
    if (!this.gatt.connected) return;
    this.gatt.connected = false;
    this.c6.filter = [];
    this.dispatchEvent(new Event('gattserverdisconnected'));
  }
}

export function makeFakeBluetooth({ remembered = true, inRangeKnown = true, latencyMs = 1, mtu = 247 } = {}) {
  const bus = new FakeBus();
  const c6 = bus.attach(new FakeC6({ latencyMs, mtu }));
  const device = new FakeDevice({ c6, inRangeKnown });
  const bluetooth = {
    remembered: remembered ? [device] : [],
    chooserResult: null,
    requestDeviceCalls: [],
    async getDevices() { return [...this.remembered]; },
    async requestDevice(opts) {
      this.requestDeviceCalls.push(opts);
      if (this.noUserActivation) throw domErr('SecurityError', 'Must be handling a user gesture to show a permission request.');
      if (!this.chooserResult) throw domErr('NotFoundError', 'User cancelled the requestDevice() chooser.');
      this.chooserResult.serviceNotGranted = false; // a pick grants the optionalServices asked for
      this.remembered = [this.chooserResult];
      return this.chooserResult;
    },
  };
  return { bus, c6, device, bluetooth };
}

export { encodeFrames };

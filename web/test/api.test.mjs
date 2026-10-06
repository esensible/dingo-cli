// api.test.mjs — unit tests for web/ble.js and web/api.js against a fake Web
// Bluetooth stack + fake C6 bridge + fake PDM (fake-bluetooth.mjs), with a fake
// dingo module (fake-dingo.mjs), plus an end-to-end test with the REAL
// web/dingo.wasm. Node 20, no packages:
//
//   podman exec dingo-web bash -lc 'cd /workspace && node web/test/api.test.mjs'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createBridge, encodeFrames, decodeFrames, checkFrame, encodeFilter, decodeFilter, normaliseFilter,
  filterMatches, parseStats, BRIDGE_SERVICE, KEYLESS_SERVICE, ROLE_REFUSED,
} from '../ble.js';
import { createApi, createLogger, withUnknownGuard, toPlain } from '../api.js';
import { makeFakeBluetooth, FakePdm, FakeNode, crcOfParams } from './fake-bluetooth.mjs';
import { createFakeDingo } from './fake-dingo.mjs';
import { EXAMPLES, loadExample, configGuard, parseBaseInput, baseAfterLoad, explainError } from '../ui.js';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = join(webDir, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchText = async (url) => {
  const p = join(webDir, url.replace(/^\.\//, ''));
  if (!existsSync(p)) throw new Error(`HTTP 404 for ${url}`);
  return readFileSync(p, 'utf8');
};
const roundTrips = (r) => assert.deepEqual(JSON.parse(JSON.stringify(r)), r, 'result must be JSON-serialisable');
const fail = (r, re) => {
  assert.equal(r.ok, false, `expected failure, got ${JSON.stringify(r)}`);
  assert.equal(typeof r.error, 'string');
  if (re) assert.match(r.error, re);
  roundTrips(r);
};
const okr = (r) => { assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`); roundTrips(r); return r; };

const cfgFor = (baseId, extra = {}) => ({
  PdmDevices: [{ pdmType: 0, name: 'test', baseId, outputs: [{ enabled: true, currentLimit: 10, input: 5 }], ...extra }],
  CanboardDevices: [], DbcDevices: [], BlinkMarineKeypads: [], GrayhillKeypads: [],
});

/** Fake world: bluetooth + C6 + optional PDM, bridge, logger, api over a fake (or given) dingo. */
function world({ pdm = { base: 222 }, dingo, bridgeOpts = {}, fake = {} } = {}) {
  const fb = makeFakeBluetooth(fake);
  const pdms = [];
  if (pdm) pdms.push(fb.bus.attach(new FakePdm(pdm)));
  const logger = createLogger();
  const bridge = createBridge({ bluetooth: fb.bluetooth, log: logger.log, reconnectDelayMs: 5, advertTimeoutMs: 500, ...bridgeOpts });
  const d = dingo === undefined ? createFakeDingo() : dingo;
  const api = createApi({ bridge, dingo: d, fetchText, log: logger });
  return { ...fb, pdms, pdm: pdms[0], logger, bridge, api, dingo: d, stop: () => pdms.forEach((p) => p.stop()) };
}

// ======================================================================= codec

test('codec: frames encode/decode round trip, concatenated', () => {
  const frames = [{ id: 0x0de, data: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) }, { id: 0x7ff, data: new Uint8Array(0) }, { id: 0, data: Uint8Array.of(0xaa) }];
  const buf = encodeFrames(frames);
  assert.deepEqual([...buf], [0xde, 0x00, 8, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0x07, 0, 0x00, 0x00, 1, 0xaa]);
  const back = decodeFrames(buf);
  assert.deepEqual(back.map((f) => [f.id, [...f.data]]), [[0x0de, [1, 2, 3, 4, 5, 6, 7, 8]], [0x7ff, []], [0, [0xaa]]]);
  // DataView input (what a notification carries)
  assert.equal(decodeFrames(new DataView(buf.buffer)).length, 3);
});

test('codec: malformed buffers are rejected as a whole', () => {
  assert.throws(() => decodeFrames(new Uint8Array(0)), /empty/);
  assert.throws(() => decodeFrames(Uint8Array.of(0xde, 0x00)), /truncated frame header/);
  assert.throws(() => decodeFrames(Uint8Array.of(0xde, 0x00, 4, 1, 2)), /truncated frame data/);
  assert.throws(() => decodeFrames(Uint8Array.of(0x00, 0x08, 0)), /id 0x800 > 0x7FF/);
  assert.throws(() => decodeFrames(Uint8Array.of(0x01, 0x00, 9, 1, 2, 3, 4, 5, 6, 7, 8, 9)), /dlc 9 > 8/);
  // a good frame followed by a truncated one: whole buffer rejected
  assert.throws(() => decodeFrames(Uint8Array.of(1, 0, 0, 2, 0)), /truncated/);
  assert.throws(() => encodeFrames([]), /at least one/);
  assert.throws(() => encodeFrames(Array.from({ length: 11 }, () => ({ id: 1, data: [] }))), /max 10/);
  assert.throws(() => checkFrame(0x800, []), /11-bit/);
  assert.throws(() => checkFrame(-1, []), /11-bit/);
  assert.throws(() => checkFrame(1.5, []), /11-bit/);
  assert.throws(() => checkFrame(1, new Uint8Array(9)), /max 8/);
  assert.throws(() => checkFrame(1, [256]), /out of range/);
});

test('codec: filter + stats', () => {
  const f = encodeFilter([[0x0de, 0x7ff], { id: 0, mask: 0 }]);
  assert.deepEqual([...f], [0xde, 0, 0xff, 0x07, 0, 0, 0, 0]);
  assert.deepEqual(decodeFilter(f), [{ id: 0x0de, mask: 0x7ff }, { id: 0, mask: 0 }]);
  assert.deepEqual(encodeFilter([]).length, 0);
  assert.throws(() => normaliseFilter(Array(9).fill([0, 0])), /max 8/);
  assert.throws(() => normaliseFilter([[0x10000, 0]]), /0..0xFFFF/);
  assert.throws(() => normaliseFilter('x'), /array/);
  assert.throws(() => decodeFilter(Uint8Array.of(1, 2, 3)), /multiple of 4/);
  assert.equal(filterMatches([{ id: 0xde, mask: 0x7ff }], 0xde), true);
  assert.equal(filterMatches([{ id: 0xde, mask: 0x7ff }], 0xe0), false);
  assert.equal(filterMatches([{ id: 0, mask: 0 }], 0x123), true);
  assert.equal(filterMatches([], 0x123), false);
  const s = new Uint8Array(16); const dv = new DataView(s.buffer);
  [1, 2, 3, 0xffffffff].forEach((v, i) => dv.setUint32(i * 4, v, true));
  assert.deepEqual(parseStats(s), { tx_ok: 1, tx_err: 2, rx_forwarded: 3, rx_dropped: 0xffffffff });
  assert.throws(() => parseStats(new Uint8Array(4)), /expected 16/);
});

// ====================================================================== bridge

test('bridge: connects to the remembered device, never opens the chooser from script', async () => {
  const w = world({ pdm: null });
  const r = await w.bridge.connect();
  assert.equal(r.deviceName, 'hilux');
  assert.equal(w.bridge.isConnected(), true);
  assert.equal(w.bluetooth.requestDeviceCalls.length, 0);
  assert.equal((await w.bridge.connect()).already, true);

  const w2 = world({ pdm: null, fake: { remembered: false } });
  await assert.rejects(w2.bridge.connect({ allowChooser: false }), (e) => e.code === 'NEEDS_USER_GESTURE' && /click the page's Connect button/.test(e.message));
  assert.equal(w2.bluetooth.requestDeviceCalls.length, 0);
  assert.equal(w2.bridge.info().state, 'disconnected');
  assert.match(w2.bridge.info().lastError, /Connect button/);

  // with a gesture: requestDevice with the name filter + both services
  w2.bluetooth.chooserResult = w2.device;
  await w2.bridge.connect({ allowChooser: true });
  assert.deepEqual(w2.bluetooth.requestDeviceCalls[0], { filters: [{ name: 'hilux' }], optionalServices: [BRIDGE_SERVICE, KEYLESS_SERVICE] });
  assert.equal(w2.bridge.isConnected(), true);
});

test('bridge: "no longer in range" after reload → waits for an advertisement, then connects', async () => {
  const w = world({ pdm: null, fake: { inRangeKnown: false } });
  await w.bridge.connect();
  assert.equal(w.device.connectCalls, 2);
  assert.equal(w.device.watchCalls, 1);
  assert.equal(w.bridge.isConnected(), true);
  assert.ok(w.logger.lines(50).some((l) => /waiting for an advertisement/.test(l)));

  const w2 = world({ pdm: null, fake: { inRangeKnown: false } });
  w2.device.advertising = false; // C6 off
  await assert.rejects(w2.bridge.connect(), /advertisement .* timed out/);
  assert.equal(w2.bridge.info().state, 'disconnected');
});

test('bridge: Web Bluetooth unavailable → clear error', async () => {
  const b = createBridge({ bluetooth: null });
  await assert.rejects(b.connect(), /Web Bluetooth is not available/);
  await assert.rejects(b.send(0x100, []), /not connected/);
  await assert.rejects(b.setFilter([]), /not connected/);
});

test('bridge: concurrent sends/filter/stats are serialised (no "GATT operation already in progress")', async () => {
  const w = world({ pdm: null, fake: { latencyMs: 3 } });
  await w.bridge.connect();
  const seen = [];
  const node = w.bus.attach(new FakeNode());
  node.receive = (id, data) => seen.push([id, data[0]]);
  const ops = [];
  for (let i = 0; i < 30; i++) ops.push(w.bridge.send(0x100 + i, Uint8Array.of(i)));
  ops.push(w.bridge.setFilter([[0x123, 0x7ff]]), w.bridge.stats(), w.bridge.readFilter());
  for (let i = 30; i < 40; i++) ops.push(w.bridge.send(0x100 + i, Uint8Array.of(i)));
  await Promise.all(ops);
  await sleep(20);
  assert.deepEqual(seen.map((s) => s[0]), Array.from({ length: 40 }, (_, i) => 0x100 + i), 'frames on the bus in order');
  assert.ok(w.c6.txWrites.every((n) => n >= 1 && n <= 10), `writes coalesce ≤10 frames: ${w.c6.txWrites}`);
  assert.ok(w.c6.txWrites.length < 40, 'some frames were coalesced');
  assert.equal(w.bridge.info().counters.txErrors, 0);
  assert.deepEqual(w.c6.filter, [{ id: 0x123, mask: 0x7ff }]);

  // the fake really does reject overlapping GATT ops (proves the queue matters)
  const raw = w.c6.chars.stats;
  const both = await Promise.allSettled([raw.readValue(), raw.readValue()]);
  assert.match(both[1].reason?.message ?? '', /already in progress/);
});

test('bridge: one frame per write when earlyAck is off; awaited sends', async () => {
  const w = world({ pdm: null, bridgeOpts: { earlyAck: false, maxFramesPerWrite: 1 } });
  await w.bridge.connect();
  for (let i = 0; i < 5; i++) await w.bridge.send(0x200, Uint8Array.of(i));
  assert.deepEqual(w.c6.txWrites, [1, 1, 1, 1, 1]);
});

test('bridge: small ATT MTU → multi-frame write rejected, retried in smaller writes, order kept', async () => {
  const w = world({ pdm: null, fake: { mtu: 40 } }); // 37 bytes: three 8-byte frames (33 B) fit, four do not
  await w.bridge.connect();
  const seen = [];
  const node = w.bus.attach(new FakeNode()); node.receive = (id) => seen.push(id);
  await Promise.all(Array.from({ length: 16 }, (_, i) => w.bridge.send(0x300 + i, new Uint8Array(8))));
  await sleep(30);
  assert.deepEqual(seen, Array.from({ length: 16 }, (_, i) => 0x300 + i));
  assert.ok(w.bridge.info().framesPerWrite <= 3, `adapted framesPerWrite ${w.bridge.info().framesPerWrite}`);
  assert.ok(w.logger.lines(100).some((l) => /retrying with/.test(l)));
});

test('bridge: rx notifications decoded (concatenated), filtered; malformed notification dropped and counted', async () => {
  const w = world({ pdm: null });
  await w.bridge.connect();
  const got = [];
  w.bridge.onFrame((id, data) => got.push([id, [...data]]));
  const node = w.bus.attach(new FakeNode());
  node.send(0x55, [1]); // filter empty → nothing
  await sleep(5);
  assert.equal(got.length, 0);
  await w.bridge.setFilter([[0x50, 0x7f0]]);
  node.send(0x55, [1]); node.send(0x56, [2, 3]); node.send(0x60, [9]); node.send(0x5f, []);
  await sleep(5);
  assert.deepEqual(got, [[0x55, [1]], [0x56, [2, 3]], [0x5f, []]]);
  assert.equal(w.bridge.info().counters.notifications, 1, 'three frames arrived in one concatenated notification');
  w.c6.rawNotify([0x55, 0x00, 5, 1]);
  await sleep(1);
  assert.equal(got.length, 3);
  assert.equal(w.bridge.info().counters.rxMalformed, 1);
  assert.ok(w.logger.lines(20).some((l) => /malformed rx notification/.test(l)));
});

test('bridge: unexpected disconnect → auto-reconnect, filter re-applied; gives up after bounded tries', async () => {
  const w = world({ pdm: null });
  const states = [];
  w.bridge.onState((s) => states.push(s));
  await w.bridge.connect();
  await w.bridge.setFilter([[0x0de, 0x7ff]]);
  w.device.dropLink();
  assert.deepEqual(w.c6.filter, []);
  await assert.rejects(w.bridge.send(1, []), /not connected/);
  for (let i = 0; i < 100 && !w.bridge.isConnected(); i++) await sleep(5);
  assert.equal(w.bridge.isConnected(), true);
  assert.deepEqual(w.c6.filter, [{ id: 0x0de, mask: 0x7ff }], 'filter re-applied after reconnect');
  assert.equal(w.bridge.info().reconnects, 1);
  assert.deepEqual(states, ['connecting', 'connected', 'reconnecting', 'connected']);

  // reconnect while the C6 is gone
  w.device.powered = false;
  w.device.dropLink();
  for (let i = 0; i < 200 && w.bridge.info().state !== 'failed'; i++) await sleep(10);
  assert.equal(w.bridge.info().state, 'failed');
  assert.match(w.bridge.info().lastError, /gave up after 3 attempts/);
  // a manual connect afterwards works once the C6 is back
  w.device.powered = true;
  await w.bridge.connect();
  assert.equal(w.bridge.isConnected(), true);

  // user disconnect does not reconnect
  await w.bridge.disconnect();
  await sleep(30);
  assert.equal(w.bridge.info().state, 'disconnected');
});

test('bridge: no CAN bridge role → clear refusal (both Chrome surfaces), link released, not retried', async () => {
  for (const style of ['mac', 'other']) {
    const w = world({ pdm: null });
    w.c6.refuse = style;
    await assert.rejects(w.bridge.connect(), (e) => e.code === 'NOT_AUTHORISED' && e.message.startsWith(ROLE_REFUSED) && /rx subscribe/.test(e.message) && /Kindle/.test(e.message), style);
    assert.equal(w.device.gatt.connected, false, `${style}: the C6's only connection is released`);
    assert.equal(w.bridge.info().state, 'disconnected');
    assert.ok(w.bridge.info().lastError.startsWith(ROLE_REFUSED));
  }

  // role taken away mid-session: filter and stats are refused with the same message
  const w = world({ pdm: null });
  await w.bridge.connect();
  w.c6.refuse = 'mac';
  await assert.rejects(w.bridge.setFilter([[0x0de, 0x7ff]]), (e) => e.code === 'NOT_AUTHORISED' && /filter write/.test(e.message));
  await assert.rejects(w.bridge.readFilter(), (e) => e.code === 'NOT_AUTHORISED' && /filter read/.test(e.message));
  await assert.rejects(w.bridge.stats(), (e) => e.code === 'NOT_AUTHORISED' && /stats read/.test(e.message));
  assert.ok(w.logger.lines(20).some((l) => /ERROR ble: This computer isn't allowed/.test(l)));

  // a reconnect that is refused fails at once instead of retrying
  const states = [];
  w.bridge.onState((st) => states.push(st));
  w.device.dropLink();
  for (let i = 0; i < 100 && w.bridge.info().state !== 'failed'; i++) await sleep(5);
  assert.equal(w.bridge.info().state, 'failed');
  assert.ok(w.bridge.info().lastError.startsWith(ROLE_REFUSED));
  assert.equal(w.device.connectCalls, 2, 'one reconnect attempt, not three');
});

test('bridge: stale pairing (link drops while connecting) → error says to forget hilux and pair again', async () => {
  const w = world({ pdm: null });
  w.device.stalePairing = true;
  await assert.rejects(w.bridge.connect(), (e) => e.code === 'STALE_PAIRING_SUSPECTED' && /old pairing with 'hilux'/.test(e.message) && /forget 'hilux' in macOS System Settings/.test(e.message) && /PAIR on the Kindle/.test(e.message));
  assert.match(w.bridge.info().lastError, /old pairing/);

  // as Chrome on macOS reported it on the hardware: connect() fails while the
  // C6 keeps advertising
  const w3 = world({ pdm: null });
  w3.device.stalePairing = 'connect';
  await assert.rejects(w3.bridge.connect(), (e) => e.code === 'STALE_PAIRING_SUSPECTED' && /Connection attempt failed/.test(e.message) && /forget 'hilux' in macOS System Settings/.test(e.message));

  // a C6 that is simply off is not reported as a stale pairing: no advertisement
  const w2 = world({ pdm: null });
  w2.device.powered = false;
  await assert.rejects(w2.bridge.connect(), (e) => !/old pairing/.test(e.message));
});

test('api: refusal and stale pairing come back as plain errors with a hint for the person', async () => {
  const w = world();
  w.c6.refuse = 'mac';
  const c = await w.api.connect();
  fail(c, /^This computer isn't allowed to use the CAN bridge — grant it the CAN bridge role on the Kindle/);
  assert.match(c.hint, /Kindle page .*retrying from here will not help/);
  const v = await w.api.version(222);
  fail(v, /not connected: This computer isn't allowed to use the CAN bridge/);
  assert.match(v.hint, /CAN bridge role on the Kindle/);

  const w2 = world();
  w2.device.stalePairing = true;
  const c2 = await w2.api.connect();
  fail(c2, /old pairing/);
  assert.match(c2.hint, /forget 'hilux' in macOS/);

  // What the page shows for these real results (ui.js explainError): connection
  // problems, in the banner, with the steps only a person can do.
  const xc = explainError(c, { op: 'connect' });
  assert.equal(xc.where, 'connection'); assert.equal(xc.headline, "This computer isn't allowed to use the CAN bridge");
  assert.ok(xc.steps.some((s) => /Kindle/.test(s))); assert.equal(xc.detail.split('\n')[0], c.error);
  const xv = explainError(v, { op: 'version', node: 'dingoPDM · 0x0DE' });
  assert.equal(xv.where, 'connection', 'a device op that could not connect is a connection problem');
  assert.equal(xv.headline, xc.headline);
  const xs = explainError(c2, { op: 'connect' });
  assert.equal(xs.where, 'connection'); assert.match(xs.headline, /seems to have refused this Mac's pairing/, 'inferred, so worded as such');
  assert.ok(xs.steps.some((s) => /Forget This Device/.test(s)));

  const d = okr(await w.api.describe());
  assert.ok(d.notes.some((n) => /CAN bridge role/.test(n) && /Kindle/.test(n)), 'describe() explains the role');
  assert.match(d.functions.find((f) => f.name === 'connect').summary, /isn't allowed to use the CAN bridge/);
});

// ========================================================================= api

test('api: describe() lists exactly the functions that exist, from the registry', async () => {
  const w = world();
  const d = okr(await w.api.describe());
  const names = d.functions.map((f) => f.name);
  assert.deepEqual(names.slice().sort(), Object.keys(w.api).sort());
  for (const f of d.functions) {
    assert.equal(typeof f.summary, 'string'); assert.ok(f.summary.length > 10, f.name);
    assert.equal(typeof f.returns, 'string'); assert.match(f.returns, /ok/);
    assert.match(f.example, new RegExp(`api\\.${f.name}\\(`));
    for (const a of f.args) assert.deepEqual(Object.keys(a).sort(), ['description', 'name', 'required', 'type']);
  }
  for (const want of ['describe', 'status', 'connect', 'disconnect', 'listen', 'discover', 'version', 'verify', 'readParams', 'apply', 'burn', 'setParam', 'getParam', 'encode', 'devices', 'sendFrame', 'filter', 'skills', 'skill', 'log']) {
    assert.ok(names.includes(want), want);
  }
  assert.deepEqual(d.skills.map((s) => s.name).sort(), ['dingo-web-api', 'dingopdm-config', 'dingopdm-hardware']);
  assert.ok(d.workflow.some((s) => /web-api/.test(s) && /dingopdm-config/.test(s)));
  assert.ok(d.workflow.findIndex((s) => /encode/.test(s)) < d.workflow.findIndex((s) => /api\.apply/.test(s)));
  assert.equal(d.name, 'dingo-web');
});

test('api: page survives a missing WASM and missing Bluetooth (describe/status/log still work)', async () => {
  const api = createApi({ bridge: createBridge({ bluetooth: null }), dingo: async () => { throw new Error('HTTP 404 for ./dingo.wasm'); }, fetchText });
  okr(await api.describe());
  const s = okr(await api.status());
  assert.equal(s.connection.state, 'disconnected');
  assert.equal(s.connection.bluetoothAvailable, false);
  const e = await api.encode(cfgFor(222));
  fail(e, /WASM not available: HTTP 404/);
  assert.match(e.hint, /dingo\.wasm/);
  const s2 = okr(await api.status());
  assert.match(s2.wasm.error, /404/);
  assert.match(s2.lastError, /encode/);
  const v = await api.version(222);
  fail(v, /WASM not available/);
  const c = await api.connect();
  fail(c, /Web Bluetooth is not available/);
  assert.match(c.hint, /Chrome/);
  assert.ok(okr(await api.log()).lines.some((l) => /wasm load failed/.test(l)));
});

test('api: status/connect/disconnect', async () => {
  const w = world();
  okr(await w.api.connect());
  const s = okr(await w.api.status());
  assert.equal(s.connection.state, 'connected');
  assert.equal(s.connection.deviceName, 'hilux');
  assert.deepEqual(Object.keys(s.stats).sort(), ['rx_dropped', 'rx_forwarded', 'tx_err', 'tx_ok']);
  assert.equal(s.busy, null);
  assert.equal(s.wasm.loaded, true);
  const d = okr(await w.api.disconnect());
  assert.equal(d.state, 'disconnected');

  const w2 = world({ fake: { remembered: false } });
  const c = await w2.api.connect();
  fail(c, /no remembered 'hilux' device/);
  assert.match(c.hint, /click the page's Connect button/);
  // a device op auto-connects, and reports the same clear error
  const v = await w2.api.version(222);
  fail(v, /not connected: no remembered/);
  assert.match(v.hint, /Connect button/);
  assert.equal(typeof v.elapsedMs, 'number');
});

test('api: version + verify + encode + devices + apply + readParams + burn + set/getParam (fake dingo)', async () => {
  const w = world();
  const cfg = cfgFor(222);
  const v = okr(await w.api.version('0x0DE'));
  assert.deepEqual([v.base, v.baseHex, v.text], [222, '0x0DE', 'v0.4.12']);
  assert.equal(w.bridge.getFilter()[0].id, 222);
  assert.deepEqual(w.c6.filter, [{ id: 222, mask: 0x7ff }], 'device op sets exactly [B, 0x7FF]');

  const e = okr(await w.api.encode(cfg, 222));
  assert.equal(e.baseId, 222); assert.match(e.crcHex, /^0x[0-9A-F]{8}$/);
  assert.equal(e.params, undefined, 'params only on request');
  const ep = okr(await w.api.encode(JSON.stringify(cfg), 222, { params: true, limit: 2 }));
  assert.equal(ep.params.length, 2); assert.equal(ep.nextOffset, 2);

  const dv = okr(await w.api.devices(cfg));
  assert.deepEqual(dv.devices, [{ kind: 'pdm', name: 'test', baseId: 222, pdmType: 0, baseHex: '0x0DE' }]);

  const before = okr(await w.api.verify(222, cfg));
  assert.equal(before.matches, false); assert.ok(before.hint);

  const a = okr(await w.api.apply(222, cfg));
  assert.equal(a.applied, e.count); assert.equal(a.crcHex, e.crcHex); assert.equal(a.burned, false);
  assert.equal(w.pdm.burned, 0);
  const after = okr(await w.api.verify(222, cfg));
  assert.equal(after.matches, true); assert.equal(after.crcHex, e.crcHex);
  assert.equal(typeof after.elapsedMs, 'number');

  const r0 = okr(await w.api.readParams(222, { limit: 3 }));
  assert.equal(r0.count, e.count); assert.equal(r0.params.length, 3); assert.equal(r0.fromCache, false);
  assert.equal(r0.nextOffset, 3);
  assert.equal(r0.crc, crcOfParams(w.pdm.order));
  const r1 = okr(await w.api.readParams(222, { offset: 3, limit: 1000 }));
  assert.equal(r1.fromCache, true); assert.equal(r1.nextOffset, null);
  assert.equal(r1.returned, e.count - 3);
  assert.match(r1.params[0].indexHex, /^0x[0-9A-F]{4}$/);

  okr(await w.api.burn(222)); assert.equal(w.pdm.burned, 1);
  const s = okr(await w.api.setParam(222, 'output[0].currentLimit', 12));
  assert.equal(s.value, 12);
  const g = okr(await w.api.getParam({ base: 222, name: 'output[0].currentLimit' }));
  assert.equal(g.value, 12);
  fail(await w.api.setParam(222, 'nope', 1), /unknown param/);
  fail(await w.api.setParam(222), /name must be/);
  const pn = okr(await w.api.paramNames({ filter: 'output' }));
  assert.ok(pn.names.every((n) => n.includes('output')));

  okr(await w.api.apply(222, cfg, { burn: true }));
  assert.equal(w.pdm.burned, 2);
});

test('api: input validation errors are clear and never throw', async () => {
  const w = world();
  fail(await w.api.version(), /base is required/);
  fail(await w.api.version(0x7ff), /out of range/);
  fail(await w.api.version('zz'), /must be an integer/);
  fail(await w.api.encode('{"PdmDevices": [}'), /not valid JSON/);
  fail(await w.api.encode(), /config is required/);
  fail(await w.api.encode(42), /object or JSON text/);
  fail(await w.api.apply(222), /config is required/);
  fail(await w.api.sendFrame(0x800, '00'), /11-bit/);
  fail(await w.api.sendFrame(0x100, 'abc'), /even-length hex/);
  fail(await w.api.sendFrame(0x100, '000000000000000000'), /max 8/);
  fail(await w.api.listen({ ms: 10 }), /out of range/);
  fail(await w.api.listen({ ids: Array(9).fill(1) }), /1..8/);
  fail(await w.api.filter([[0x10000, 0]]), /0..0xFFFF/);
  fail(await w.api.readParams(222, { limit: 0 }), /out of range/);
  fail(await w.api.log({ last: 0 }), /out of range/);
  const g = withUnknownGuard(w.api);
  const u = await g.applyConfig(1);
  fail(u, /api\.applyConfig does not exist/);
  assert.match(u.hint, /describe/);
  assert.equal(g.then, undefined, 'the api object is not thenable');
});

test('api: writes refuse an unconfirmed base, and a config whose baseId differs', async () => {
  const w = world({ dingo: createFakeDingo({ requestTimeoutMs: 40, tries: 2 }) });
  const r = await w.api.apply(300, cfgFor(300));
  fail(r, /refusing to write: no dingoPDM answered a version request at base 0x12C/);
  assert.match(r.hint, /discover/);
  fail(await w.api.burn(300), /refusing to write/);
  fail(await w.api.setParam(300, 'output[0].currentLimit', 1), /refusing to write/);
  assert.equal(w.pdm.commands.length, 0, 'the PDM at 222 saw nothing');

  const m = await w.api.apply(222, cfgFor(300));
  fail(m, /baseId 300 \(0x12C\) but you targeted 222/);
  assert.match(m.hint, /allowBaseChange/);
  okr(await w.api.version(222));
  const before = w.pdm.commands.length;
  fail(await w.api.apply(222, cfgFor(300)), /refusing to apply/);
  assert.equal(w.pdm.commands.length, before, 'refused before any frame');

  // a silent device: version times out with a hint
  const t = await w.api.version(400);
  fail(t, /no response/);
  assert.match(t.hint, /powered/);
});

test('api: apply checks the board type the node broadcasts (base+2 byte 1) against the config pdmType', async () => {
  const w = world({ pdm: { base: 0x500, statusPeriodMs: 40, statusIds: 1, pdmType: 0 } });
  const c6cfg = { PdmDevices: [{ pdmType: 12, name: 'c6', baseId: 0x500 }] };
  try {
    okr(await w.api.version(0x500));
    const before = w.pdm.commands.length;
    const r = await w.api.apply(0x500, c6cfg);
    fail(r, /^refusing to apply: the node at base 0x500 broadcasts board type 0 \(dingoPDM\) but the config is for another board \(pdmType 12\)$/);
    assert.match(r.hint, /allowTypeMismatch/);
    assert.equal(w.pdm.commands.length, before, 'refused before any frame');
    assert.deepEqual(w.c6.filter, [{ id: 0x500, mask: 0x7ff }], 'filter restored');

    const forced = okr(await w.api.apply(0x500, c6cfg, { allowTypeMismatch: true }));
    assert.deepEqual(forced.typeCheck, { seen: true, configType: 12, configBoard: null, deviceType: 0, deviceBoard: 'dingoPDM', matches: false });

    w.pdm.pdmType = 12;
    const same = okr(await w.api.apply(0x500, c6cfg));
    assert.equal(same.typeCheck.matches, true);
    assert.equal(same.typeCheck.deviceType, 12);

    // A node that sends no status frame is not checked (logged), and applied.
    w.stop();
    const silent = okr(await w.api.apply(0x500, c6cfg));
    assert.deepEqual(silent.typeCheck, { seen: false, configType: 12, configBoard: null });
    assert.ok(w.logger.lines(50).some((l) => /WARN .*no status frame on 0x502 .* board type not checked/.test(l)));
  } finally { w.stop(); }
});

test('api: busy — a second device op while one runs', async () => {
  const w = world({ dingo: createFakeDingo({ requestTimeoutMs: 100, tries: 2 }) });
  okr(await w.api.connect());
  const slow = w.api.version(500); // nobody there: ~200 ms
  await sleep(10);
  const busy = await w.api.version(222);
  fail(busy, /^busy: version running$/);
  assert.ok(busy.hint);
  const st = okr(await w.api.status());
  assert.equal(st.busy.op, 'version');
  // the page's Apply panel reads the same without status()'s stats read
  assert.equal(w.api._busy().op, 'version');
  assert.ok(Object.keys(w.api).every((k) => !k.startsWith('_')), 'page extras stay off the agent surface');
  okr(await w.api.encode(cfgFor(222))); // pure ops are not blocked
  okr(await w.api.log());
  fail(await slow, /no response/);
  assert.equal(w.api._busy(), null);
  okr(await w.api.version(222));
});

test('api: listen reports ids/rates/payloads and restores the previous filter', async () => {
  const w = world({ pdm: { base: 222, statusPeriodMs: 100, statusIds: 5 } });
  okr(await w.api.version(222));
  const l = okr(await w.api.listen({ ms: 350 }));
  assert.deepEqual(l.ids.map((x) => x.idHex), ['0x0E0', '0x0E1', '0x0E2', '0x0E3', '0x0E4']);
  const e0 = l.ids[0];
  assert.ok(e0.count >= 2 && e0.hz > 3 && e0.hz < 15, JSON.stringify(e0));
  assert.equal(e0.lastHex, '0000000000000000'); assert.equal(e0.dlc, 8);
  assert.deepEqual(w.c6.filter, [{ id: 222, mask: 0x7ff }], 'filter restored');
  const l2 = okr(await w.api.listen({ ms: 250, ids: [0xe2], max: 1 }));
  assert.deepEqual(l2.ids.map((x) => x.id), [0xe2]);
  assert.equal(l2.bridgeRxDropped, 0);
  w.stop();
});

test('api: discover finds the PDM from its status frame (board type in base+2 byte 1) and confirms it; skips other traffic', async () => {
  const w = world({ pdm: { base: 0x123, statusPeriodMs: 100 } });
  const other = w.bus.attach(new FakeNode());
  const t = setInterval(() => { for (const id of [0x400, 0x401, 0x402]) other.send(id, [1]); }, 100);
  try {
    const d = okr(await w.api.discover({ ms: 300 }));
    const pdm = { base: 0x123, baseHex: '0x123', version: 'v0.4.12', type: 0, board: 'dingoPDM' };
    assert.deepEqual(d.nodes, [pdm]);
    assert.deepEqual(d.pdms, d.nodes, 'pdms: the older name, same list');
    assert.equal(d.candidates.length, 1, 'only base+2 of the PDM; not its other status ids, not the 1-byte 0x400..0x402');
    assert.deepEqual([d.candidates[0].statusId, d.candidates[0].runLength], [0x125, 27]);
    assert.ok(d.idsSeen >= 30);
    const s = okr(await w.api.status());
    assert.deepEqual(s.confirmedBases.map((b) => b.base), [0x123]);
    // explicit bases, one absent; the board type is read from the status frame
    const w2 = world({ dingo: createFakeDingo({ requestTimeoutMs: 40, tries: 2 }), pdm: { base: 222, statusPeriodMs: 50, statusIds: 1 } });
    try {
      const d2 = okr(await w2.api.discover({ bases: [222, '0x300'] }));
      assert.deepEqual(d2.nodes, [{ base: 222, baseHex: '0x0DE', version: 'v0.4.12', type: 0, board: 'dingoPDM' }]);
      assert.equal(d2.unconfirmed[0].baseHex, '0x300');
    } finally { w2.stop(); }
    // silent bus
    const w3 = world({ pdm: null });
    const d3 = await w3.api.discover({ ms: 150 });
    fail(d3, /no CAN frames/);
    assert.match(d3.hint, /bus is silent/);
  } finally { clearInterval(t); w.stop(); }
});

test('api: discover finds every node by board type: the bench dingoPDM (0x700) and the C6 body node (0x500, 1 status id)', async () => {
  const w = world({ pdm: { base: 0x700, version: [0, 5, 3], statusPeriodMs: 100, statusIds: 27, pdmType: 0 }, dingo: createFakeDingo({ requestTimeoutMs: 40, tries: 2 }) });
  const c6 = w.bus.attach(new FakePdm({ base: 0x500, version: [0, 5, 8], statusPeriodMs: 100, statusIds: 1, pdmType: 12 }));
  const other = w.bus.attach(new FakeNode());
  const t = setInterval(() => {
    other.send(0x5f0, [1, 0]); // the C6 test config's CAN output: 2 bytes, not a status frame
    other.send(0x300, [0, 0xf0, 0, 0, 0, 0, 0, 0]); // 8 bytes, but type 15 names no board
    other.send(0x402, [0, 0x00, 0, 0, 0, 0, 0, 0]); // looks like a status frame; nobody answers at 0x400
  }, 100);
  try {
    const d = okr(await w.api.discover({ ms: 400 }));
    assert.deepEqual(d.nodes, [
      { base: 0x500, baseHex: '0x500', version: 'v0.5.8', type: 12, board: 'c6body_v1' },
      { base: 0x700, baseHex: '0x700', version: 'v0.5.3', type: 0, board: 'dingoPDM' },
    ]);
    assert.deepEqual(d.candidates.map((c) => c.baseHex).sort(), ['0x400', '0x500', '0x700']);
    assert.equal(d.candidates[0].baseHex, '0x700', 'the longest status run is probed first');
    assert.deepEqual(d.unconfirmed.map((u) => [u.baseHex, u.type, u.board]), [['0x400', 0, 'dingoPDM']]);
    assert.match(d.unconfirmed[0].reason, /no response/);
    assert.equal(w.pdm.commands.length, 1, 'the PDM got exactly one version request');
    assert.equal(c6.commands.length, 1, 'the C6 got exactly one version request');
  } finally { clearInterval(t); w.stop(); c6.stop(); }
});

test('api: discover never probes a status-shaped frame that is not 10 Hz (the C6 presence heartbeat 0x401 `C6 00 …` at 1 Hz → nothing to 0x400)', async () => {
  const w = world({ pdm: { base: 0x700, version: [0, 5, 3], statusPeriodMs: 100, statusIds: 27, pdmType: 0 }, dingo: createFakeDingo({ requestTimeoutMs: 40, tries: 2 }) });
  const c6 = w.bus.attach(new FakePdm({ base: 0x500, version: [0, 5, 8], statusPeriodMs: 100, statusIds: 1, pdmType: 12 }));
  const other = w.bus.attach(new FakeNode());
  const heartbeat = () => other.send(0x401, [0xc6, 0, 0, 0, 0, 0, 0, 0]); // exactly what the bench bus carries
  heartbeat();
  const t = setInterval(heartbeat, 1000);
  try {
    const d = okr(await w.api.discover()); // the default 1500 ms window
    assert.deepEqual(d.nodes.map((n) => n.baseHex), ['0x500', '0x700']);
    assert.deepEqual(d.candidates.map((c) => c.baseHex).sort(), ['0x500', '0x700']);
    assert.deepEqual(d.unconfirmed, []);
    assert.equal(d.ignored.length, 1);
    assert.deepEqual([d.ignored[0].baseHex, d.ignored[0].statusId, d.ignored[0].type], ['0x3FF', 0x401, 0]);
    assert.match(d.ignored[0].reason, /^not a dingo status frame: [\d.]+ Hz \(status is 10 Hz\), constant; not probed$/);
    assert.ok(d.ignored[0].hz < 2, `hz ${d.ignored[0].hz}`);
    assert.equal(w.bus.log.filter((f) => f.id === 0x400).length, 0, 'no frame was sent to 0x400 (base 0x3FF + 1)');
    // a user-given base is still probed, as asked
    okr(await w.api.discover({ bases: [0x500] }));
  } finally { clearInterval(t); w.stop(); c6.stop(); }
});

test('bridge: Connect click uses the remembered device without the chooser; chooser only when needed or forced', async () => {
  // remembered (getDevices) → no chooser at all
  const w = world({ pdm: null });
  okr(await w.api._connectWithChooser());
  assert.equal(w.bluetooth.requestDeviceCalls.length, 0, 'remembered device: no chooser');
  assert.equal(w.bridge.isConnected(), true);
  // "Choose device…" always opens it; the same device keeps the link up
  w.bluetooth.chooserResult = w.device;
  const c = okr(await w.api._chooseDevice());
  assert.equal(w.bluetooth.requestDeviceCalls.length, 1);
  assert.equal(c.already, true);
  assert.equal(w.bridge.isConnected(), true);

  // remembered but picked before the bridge service existed → the chooser re-picks it
  const w2 = world({ pdm: null });
  w2.device.serviceNotGranted = true;
  w2.bluetooth.chooserResult = w2.device;
  okr(await w2.api._connectWithChooser());
  assert.equal(w2.bluetooth.requestDeviceCalls.length, 1, 'chooser opened once, for the missing grant');
  assert.equal(w2.bridge.isConnected(), true);

  // from script the same case never opens the chooser and says what to click
  const w3 = world({ pdm: null });
  w3.device.serviceNotGranted = true;
  const r3 = await w3.api.connect();
  fail(r3, /not granted this page the CAN bridge service/);
  assert.match(r3.error, /Choose device/);
  assert.match(r3.hint, /Choose device/);
  assert.equal(w3.bluetooth.requestDeviceCalls.length, 0);
  assert.doesNotMatch(r3.error, /old pairing/, 'our own disconnect is not a dropped link');
  // a click whose activation expired: the error still says to click "Choose device…"
  w3.bluetooth.noUserActivation = true;
  const r4 = await w3.api._connectWithChooser();
  fail(r4, /Choose device.*the chooser did not open: SecurityError: Must be handling a user gesture/);

  // nothing remembered → the chooser (as before)
  const w5 = world({ pdm: null, fake: { remembered: false } });
  w5.bluetooth.chooserResult = w5.device;
  okr(await w5.api._connectWithChooser());
  assert.equal(w5.bluetooth.requestDeviceCalls.length, 1);
});

test('api: verify with a config for another base warns (the page blocks it; this is the backstop)', async () => {
  const w = world();
  const v = okr(await w.api.verify(222, cfgFor(300)));
  assert.match(v.warning, /baseId 300 \(0x12C\), not 222 \(0x0DE\)/);
  assert.equal(v.expected.baseId, undefined);
  assert.equal(okr(await w.api.verify(222, cfgFor(222))).warning, undefined);
});

test('api: sendFrame + filter get/set', async () => {
  const w = world({ pdm: null });
  const seen = [];
  const node = w.bus.attach(new FakeNode()); node.receive = (id, d) => seen.push([id, [...d]]);
  const s = okr(await w.api.sendFrame('0x643', '01 00 00 00'));
  assert.deepEqual([s.idHex, s.dlc, s.dataHex], ['0x643', 4, '01000000']);
  await sleep(5);
  assert.deepEqual(seen, [[0x643, [1, 0, 0, 0]]]);
  okr(await w.api.sendFrame(0x10, []));
  const f = okr(await w.api.filter([[0x642, 0x7ff], { id: 0, mask: 0x700 }]));
  assert.deepEqual(f.filter, [{ id: 0x642, idHex: '0x642', mask: 0x7ff, maskHex: '0x7FF' }, { id: 0, idHex: '0x000', mask: 0x700, maskHex: '0x700' }]);
  assert.deepEqual(f.device, f.filter, 'what the C6 reports');
  const g = okr(await w.api.filter());
  assert.deepEqual(g.filter, f.filter);
  okr(await w.api.filter([]));
  assert.deepEqual(w.c6.filter, []);
});

test('api: skills listing and paged skill reading', async () => {
  const w = world({ pdm: null });
  const s = okr(await w.api.skills());
  assert.deepEqual(s.skills.map((x) => x.name).sort(), ['dingo-web-api', 'dingopdm-config', 'dingopdm-hardware']);
  assert.ok(s.skills.find((x) => x.name === 'dingopdm-hardware').assets.length > 0);
  const full = readFileSync(join(webDir, 'skills/dingopdm-config/SKILL.md'), 'utf8');
  let md = ''; let offset = 0; let pages = 0;
  for (;;) {
    const p = okr(await w.api.skill('dingopdm-config', { offset, maxChars: 5000 }));
    assert.equal(p.totalChars, full.length);
    md += p.markdown; pages++;
    if (p.nextOffset === null) break;
    offset = p.nextOffset;
  }
  assert.equal(md, full); assert.ok(pages >= 6);
  const byDir = okr(await w.api.skill('web-api'));
  assert.equal(byDir.name, 'dingo-web-api');
  assert.match(byDir.markdown, /CLI → api mapping/);
  const missing = await w.api.skill('nope');
  fail(missing, /no skill named 'nope'/);
  assert.match(missing.hint, /dingopdm-config/);
  const nofetch = createApi({ bridge: w.bridge, dingo: createFakeDingo(), fetchText: async () => { throw new Error('HTTP 404'); } });
  const ns = await nofetch.skills();
  fail(ns, /skills\/index.json/);
  assert.match(ns.hint, /sync-skills/);
  okr(await nofetch.describe()); // describe still works without skills
});

test('api: log ring buffer + every result JSON-serialisable', async () => {
  const w = world();
  okr(await w.api.version(222));
  fail(await w.api.version());
  const l = okr(await w.api.log({ last: 500 }));
  assert.ok(l.lines.some((x) => /version\(222\) …/.test(x)));
  assert.ok(l.lines.some((x) => /version ok in \d+ ms/.test(x)));
  assert.ok(l.lines.some((x) => /ERROR version failed .* base is required/.test(x)));
  assert.ok(l.lines.some((x) => /ble: state → connected/.test(x)));
  assert.ok(l.lines.every((x) => /^\d\d:\d\d:\d\d\.\d{3} /.test(x)));
  assert.equal(okr(await w.api.log({ last: 2 })).lines.length, 2);
  assert.deepEqual(toPlain({ a: Uint8Array.of(1, 255), b: 1n }), { a: '01FF', b: 1 });
});

// ======================================================= real WASM, end to end

const wasmPath = join(webDir, 'dingo.wasm');
const haveWasm = existsSync(wasmPath) && existsSync(join(webDir, 'wasm_exec.js'));

test('integration: REAL dingo.wasm over fake bluetooth/C6/PDM: encode → apply → verify → readParams → burn', { skip: !haveWasm && 'web/dingo.wasm not built' }, async () => {
  const { loadDingo } = await import('../dingo-loader.js');
  const dingo = await loadDingo(readFileSync(wasmPath));
  assert.equal(typeof dingo.encode, 'function');
  const w = world({ dingo, pdm: { base: 222, version: [5, 3, 258] } });
  const example = readFileSync(join(repoDir, 'internal/pdmcfg/testdata/example.json'), 'utf8');
  const exampleBase = JSON.parse(example).PdmDevices[0].baseId;
  const cfg = JSON.parse(example);
  cfg.PdmDevices[0].baseId = 222;

  const s0 = okr(await w.api.status());
  const v = okr(await w.api.version(222));
  assert.equal(v.text, '5.3.258');
  const e = okr(await w.api.encode(cfg, 222));
  assert.ok(e.count > 100, `count ${e.count}`); assert.match(e.crcHex, /^0x[0-9A-F]{8}$/);
  assert.equal(typeof e.crc, 'number');

  const t0 = Date.now();
  // The page's Apply panel polls api._busy() for the WASM's onProgress({ done, total }).
  const seen = [];
  const poll = setInterval(() => { const b = w.api._busy(); if (b?.op === 'apply' && b.progress) seen.push(b.progress); }, 20);
  let a;
  try { a = okr(await w.api.apply(222, cfg)); } finally { clearInterval(poll); }
  const applyMs = Date.now() - t0;
  assert.ok(seen.length > 0, 'apply progress visible while it runs');
  assert.ok(seen.every((p) => p.total === e.count && p.done >= 0 && p.done <= e.count), JSON.stringify(seen.slice(0, 3)));
  assert.equal(a.applied, e.count); assert.equal(a.crcHex, e.crcHex); assert.equal(a.burned, false);
  assert.equal(w.pdm.order.length, e.count);
  assert.equal(crcOfParams(w.pdm.order), e.crc, 'fake PDM holds exactly the encoded params');
  const vf = okr(await w.api.verify(222, cfg));
  assert.equal(vf.matches, true); assert.equal(vf.crcHex, e.crcHex);

  const rp = okr(await w.api.readParams(222, { limit: 5 }));
  assert.equal(rp.count, e.count); assert.equal(rp.crcHex, e.crcHex);
  okr(await w.api.burn(222)); assert.equal(w.pdm.burned, 1);

  // named params through the real table
  const names = okr(await w.api.paramNames({ filter: 'currentLimit', limit: 3 }));
  assert.ok(names.names.length > 0);
  const nm = names.names[0];
  okr(await w.api.setParam(222, nm, 7));
  const g = okr(await w.api.getParam(222, nm));
  assert.equal(Number(g.value), 7);

  // the base-change guard sees the real encode result
  if (exampleBase !== 222) fail(await w.api.apply(222, example), /refusing to apply/);

  const writes = w.c6.txWrites;
  console.log(`# real wasm: ${e.count} params, apply ${applyMs} ms, ${writes.length} tx writes total (max ${Math.max(...writes)} frames/write), wasm ${JSON.stringify(s0.wasm.info ?? dingo.info)}`);

  // absent base with the real wasm (timeouts scaled down for the test)
  dingo._setTimeoutScale?.(0.02);
  try {
    const nr = await w.api.version(0x300);
    fail(nr, /no response/);
    assert.match(nr.hint, /powered/);
  } finally { dingo._setTimeoutScale?.(1); }
});

test('integration: REAL dingo.wasm, C6 body node (c6body_v1): encode → apply (type checked) → verify → readParams; refused on a dingoPDM', { skip: !haveWasm && 'web/dingo.wasm not built' }, async () => {
  const { loadDingo } = await import('../dingo-loader.js');
  const dingo = await loadDingo(readFileSync(wasmPath));
  const fw = JSON.parse(readFileSync(join(repoDir, 'internal/params/testdata/c6body_v1.fw.json'), 'utf8'));
  const run = Object.fromEntries(fw.runs.map((r) => [r.name, r]));
  const cfg = JSON.parse(readFileSync(join(webDir, 'examples/c6-test.json'), 'utf8'));
  // The C6 broadcasts type 0xC on 0x502 and status on 0x503..0x504.
  const w = world({ dingo, pdm: { base: 0x500, version: [0, 5, 8], statusPeriodMs: 50, statusIds: 3, pdmType: 12 } });
  try {
    const dv = okr(await w.api.devices(cfg));
    assert.deepEqual(dv.devices, [{ kind: 'PdmDevices', name: 'c6-body-test', baseId: 1280, pdmType: 12, baseHex: '0x500' }]);
    const e = okr(await w.api.encode(cfg));
    assert.deepEqual([e.board, e.pdmType, e.baseHex, e.count, e.crcHex], ['c6body_v1', 12, '0x500', 385, '0x' + run['c6-test'].writeCrc]);
    okr(await w.api.version(0x500));
    const a = okr(await w.api.apply(0x500, cfg));
    assert.equal(a.board, 'c6body_v1'); assert.equal(a.applied, 385); assert.equal(a.crcHex, e.crcHex);
    assert.deepEqual(a.typeCheck, { seen: true, configType: 12, configBoard: 'c6body_v1', deviceType: 12, deviceBoard: 'c6body_v1', matches: true });
    const vf = okr(await w.api.verify(0x500, cfg));
    assert.equal(vf.matches, true);
    const rp = okr(await w.api.readParams(0x500, { limit: 1 }));
    assert.equal(rp.count, 385); assert.equal(rp.crcHex, e.crcHex);
    const s = okr(await w.api.setParam(0x500, 'canOutput[1].input', 'CanIn1Out', { pdmType: 12 }));
    assert.deepEqual([s.board, s.raw], ['c6body_v1', 3]);
    const pn = okr(await w.api.paramNames({ pdmType: 12, filter: 'flasher[4]' }));
    assert.equal(pn.total, 5);

    // The same config aimed at a dingoPDM is refused before any write.
    w.pdm.pdmType = 0;
    const before = w.pdm.commands.length;
    const r = await w.api.apply(0x500, cfg);
    fail(r, /broadcasts board type 0 \(dingoPDM\) but the config is for c6body_v1 \(pdmType 12\)/);
    assert.equal(w.pdm.commands.length, before);
  } finally { w.stop(); }
});

test('integration: REAL dingo.wasm: every example loads (what the page shows) and the Base id guard blocks a mismatch', { skip: !haveWasm && 'web/dingo.wasm not built' }, async () => {
  const { loadDingo } = await import('../dingo-loader.js');
  const dingo = await loadDingo(readFileSync(wasmPath));
  const w = world({ dingo, pdm: null });
  const want = {
    // count + CRC: what the page's config summary shows (and Check compares); the C6 ones are API.md's.
    'bench-toggle': [{ name: 'bench-toggle', baseId: 0x700, baseHex: '0x700', pdmType: 0, board: 'dingoPDM', count: 2269, crc: 0x4B021705, crcHex: '0x4B021705' }],
    'c6-empty': [{ name: 'c6-body', baseId: 0x500, baseHex: '0x500', pdmType: 12, board: 'c6body_v1', count: 385, crc: 0x19879C6B, crcHex: '0x19879C6B' }],
    'c6-test': [{ name: 'c6-body-test', baseId: 0x500, baseHex: '0x500', pdmType: 12, board: 'c6body_v1', count: 385, crc: 0xC1E4D8D1, crcHex: '0xC1E4D8D1' }],
  };
  assert.deepEqual(EXAMPLES.map((e) => e.name), Object.keys(want));
  for (const ex of EXAMPLES) {
    const { text } = await loadExample(ex.name, fetchText);
    const info = okr(await w.api._inspectConfig(text));
    assert.deepEqual(info.pdms, want[ex.name], ex.name);
    // loading sets Base id from the config
    assert.equal(baseAfterLoad(info, 0x0de), want[ex.name][0].baseId);
  }
  const c6 = await w.api._inspectConfig((await loadExample('c6-test', fetchText)).text);
  const nodes = new Map([[0x700, { base: 0x700, baseHex: '0x700', version: '0.5.3', type: 0, board: 'dingoPDM' }]]);
  const g = configGuard(parseBaseInput('1792'), c6, nodes);
  assert.deepEqual(g, { ok: false, message: 'Config is for 0x500 (c6-body-test); Base id is 0x700 (dingoPDM 0.5.3)', fixes: [0x500] });
  assert.deepEqual(configGuard(parseBaseInput('0x500'), c6, nodes), { ok: true, base: 0x500 });
  fail(await w.api._inspectConfig('{"PdmDevices": ['), /not valid JSON/);
});

// firmware.test.mjs — web/firmware.js (the hilux firmware service's codec and
// its transport for c6-ota's ota-client.js), the firmware api calls and the
// Firmware panel's logic, against fake-firmware.mjs (a fake C6 firmware
// service on fake-bluetooth.mjs). Node 20, no packages:
//
//   podman exec dingo-web bash -lc 'cd /workspace && node --test web/test/firmware.test.mjs'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createFirmware, encodeBegin, encodeInfo, encodeCommit, encodeAbort, encodeData, decodeData, decodeStatus, encodeStatus, decodeRequest,
  describeError, FirmwareError, ERROR, REQUEST, FIRMWARE_ROLE_REFUSED, checkImage, slotName,
} from '../firmware.js';
import { createBridge, FIRMWARE_SERVICE } from '../ble.js';
import { createApi, createLogger } from '../api.js';
import { explainError, firmwareHtml, firmwareProgress, activityEvent } from '../ui.js';
import { makeFakeBluetooth } from './fake-bluetooth.mjs';
import { FakeFirmwareBox, image } from './fake-firmware.mjs';
import { createFakeDingo } from './fake-dingo.mjs';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const hexOf = (b) => Buffer.from(b).toString('hex');
const sha = (b) => createHash('sha256').update(b).digest('hex');

const FAST = { connectTimeoutMs: 500, advertTimeoutMs: 30, requestTimeoutMs: 500, commitTimeoutMs: 500, stallMs: 50, reconnectWaitMs: 1500, reconnectDelayMs: 5, resetWaitMs: 500, bootWaitMs: 2000, confirmWaitMs: 2000, pollMs: 5 };

function world({ box = {}, fw = {}, fake = {} } = {}) {
  const fb = makeFakeBluetooth(fake);
  const logger = createLogger();
  const b = new FakeFirmwareBox({ c6: fb.c6, device: fb.device, ...box });
  const firmware = createFirmware({ bluetooth: fb.bluetooth, log: logger.log, ...FAST, ...fw });
  return { ...fb, box: b, firmware, logger };
}

// ======================================================================= codec

test('codec: FIRMWARE.md test vectors', () => {
  const digest = new Uint8Array(32).map((_, i) => i);
  const begin = encodeBegin(1327104, digest);
  assert.equal(begin.length, 37);
  assert.equal(hexOf(begin.subarray(0, 5)), '0200401400');
  assert.deepEqual([...begin.subarray(5)], [...digest]);
  assert.deepEqual(encodeBegin(1327104, hexOf(digest)), begin, 'the digest as hex');
  assert.deepEqual(decodeRequest(begin), { tag: 'Begin', len: 1327104, sha256: hexOf(digest) });

  assert.deepEqual(decodeStatus(Buffer.from('02402301 00f400a007'.replace(/ /g, ''), 'hex')), { tag: 'Ready', offset: 0x12340, chunk: 244, window: 1952 });
  assert.deepEqual(decodeStatus(Buffer.from('0300040000', 'hex')), { tag: 'Ack', offset: 1024 });
  assert.deepEqual(decodeStatus(Buffer.from('050504801e0000', 'hex')), { tag: 'Error', request: 5, requestName: 'data', code: 4, name: 'SEQUENCE', detail: 0x1e80 });
  assert.equal(hexOf(encodeStatus({ tag: 'Ready', offset: 0x12340, chunk: 244, window: 1952 })), '0240230100f400a007');
  assert.equal(hexOf(encodeStatus({ tag: 'Error', request: 5, code: 'SEQUENCE', detail: 0x1e80 })), '050504801e0000');
  assert.deepEqual(decodeStatus(Uint8Array.of(4)), { tag: 'Rebooting' });

  const info = { tag: 'Info', sha256: 'ab'.repeat(32), slot: 1, pending: true, maxLen: 0x1e0000 };
  const ib = encodeStatus(info);
  assert.equal(ib.length, 39);
  assert.equal(hexOf(ib.subarray(33)), '0101' + '00001e00');
  assert.deepEqual(decodeStatus(ib), info);
  assert.deepEqual(decodeStatus(new DataView(ib.buffer)), info, 'a notification carries a DataView');

  assert.deepEqual([...encodeInfo()], [1]); assert.deepEqual([...encodeCommit()], [3]); assert.deepEqual([...encodeAbort()], [4]);
  const d = encodeData(0x01020304, [9, 8]);
  assert.equal(hexOf(d), '040302010908');
  assert.deepEqual({ ...decodeData(d), bytes: [...decodeData(d).bytes] }, { offset: 0x01020304, bytes: [9, 8] });
});

test('codec: malformed values are refused', () => {
  assert.throws(() => decodeStatus(new Uint8Array(0)), /empty/);
  assert.throws(() => decodeStatus(Uint8Array.of(9)), /unknown status tag 0x9/);
  assert.throws(() => decodeStatus(Uint8Array.of(3, 0, 0)), /is 5 bytes, got 3/);
  assert.throws(() => decodeStatus(new Uint8Array(38).fill(1)), /is 39 bytes, got 38/);
  assert.throws(() => decodeRequest(Uint8Array.of(2, 0)), /not a request: 2 bytes/);
  assert.throws(() => decodeRequest(Uint8Array.of(7)), /not a request/);
  assert.throws(() => encodeBegin(-1, new Uint8Array(32)), /not a u32/);
  assert.throws(() => encodeBegin(10, new Uint8Array(31)), /31 bytes/);
  assert.throws(() => encodeBegin(10, 'zz'), /64 hex digits/);
  assert.throws(() => decodeData(Uint8Array.of(0, 0, 0, 0)), /at least 5/);
});

test('errors: every code by name, with what to do; IMAGE carries c6-ota\'s reason', () => {
  for (const [code, name] of Object.entries({ 1: 'BUSY', 2: 'NO_UPLOAD', 3: 'TIMEOUT', 4: 'SEQUENCE', 5: 'LENGTH', 6: 'NO_SPACE', 7: 'HASH', 8: 'FLASH', 9: 'IMAGE', 10: 'ON_TRIAL', 11: 'UNAVAILABLE', 12: 'MALFORMED', 13: 'SWITCH' })) {
    const e = new FirmwareError({ request: REQUEST.BEGIN, code: Number(code), detail: 0 });
    assert.equal(e.code, name);
    assert.match(e.message, new RegExp(`^Begin: ${name}: `));
    assert.equal(typeof e.hint, 'string', name);
  }
  const img = describeError({ request: REQUEST.COMMIT, code: ERROR.IMAGE, detail: (0x40 << 8) | 7 });
  assert.match(img.message, /^Commit: IMAGE: .*checksum byte is not the segments'.*detail 64/);
  assert.match(describeError({ request: REQUEST.COMMIT, code: ERROR.LENGTH, detail: 500 }).message, /before every byte was in \(hilux has 500\)/);
  assert.match(describeError({ request: REQUEST.BEGIN, code: ERROR.ON_TRIAL, detail: 0 }).hint, /20 s after its boot/);
  assert.match(describeError({ request: REQUEST.BEGIN, code: ERROR.UNAVAILABLE, detail: 0 }).hint, /one-time move/);
  assert.equal(slotName(1), 'ota_1'); assert.equal(slotName(0xff), 'unknown');
});

test('vendor: ota-client.js is the file SOURCE.json records (and the monorepo\'s, when it is visible)', () => {
  const meta = JSON.parse(readFileSync(join(webDir, 'vendor/c6-ota/SOURCE.json'), 'utf8'));
  const here = readFileSync(join(webDir, 'vendor/c6-ota/ota-client.js'));
  assert.equal(sha(here), meta.sha256, 'web/vendor/c6-ota/ota-client.js was edited here: change it in the monorepo and run web/vendor/c6-ota/vendor.sh');
  assert.match(meta.commit, /^[0-9a-f]{40}$/);
  const src = join(process.env.C6_OTA_DIR || join(webDir, '../../esensible/projects/c6-ota'), 'js/ota-client.js');
  // the dingo-web container mounts only this repo: there vendor.sh --check covers the monorepo side
  if (existsSync(src)) assert.equal(sha(readFileSync(src)), meta.sha256, `the monorepo's ${src} changed: run web/vendor/c6-ota/vendor.sh`);
});

test('checkImage: hilux\'s hints (the ELF, the room)', async () => {
  const elf = new Uint8Array(200); elf.set([0x7f, 0x45, 0x4c, 0x46]);
  await assert.rejects(checkImage(elf), (e) => e.code === 'IMAGE' && /ELF/.test(e.message) && /wireless-can\.bin/.test(e.hint) && /c6-image/.test(e.hint));
  const img = image(3000);
  await assert.rejects(checkImage(img, 1000), (e) => /room for 1000/.test(e.message) && /partitions\.csv/.test(e.hint));
  assert.equal((await checkImage(img)).len, img.length);
});

// ====================================================================== client

test('client: Info, then a whole update: upload, commit, reset, reconnect, trial, confirmed', async () => {
  const w = world();
  await w.firmware.connect();
  const before = await w.firmware.info();
  assert.equal(before.slot, 0); assert.equal(before.pending, false); assert.equal(before.maxLen, 0x1e0000);
  const img = image(20000);
  const phases = [];
  const r = await w.firmware.update(img, { onProgress: (p) => { if (phases.at(-1) !== p.phase) phases.push(p.phase); } });
  assert.equal(r.sha256, hexOf(img.subarray(img.length - 32)));
  assert.equal(r.len, img.length);
  assert.deepEqual(r.previous, { sha256: before.sha256, slot: 0 });
  assert.equal(r.slot, 1);
  assert.equal(r.committed, 'rebooting');
  assert.equal(r.written, img.length);
  assert.deepEqual([r.chunk, r.window, r.resumes], [240, 1920, 0]);
  assert.ok(r.kbps > 0);
  assert.deepEqual(w.box.running, { sha: r.sha256, slot: 1, pending: false });
  assert.equal(w.box.boots, 1);
  for (const p of ['begin', 'upload', 'rebooting', 'booting']) assert.ok(phases.includes(p), `phase ${p} in ${phases}`);
  assert.ok(phases.includes('trial'), 'it polled Info while the update was on trial');
  assert.equal(w.firmware.isConnected(), true, 'connected again after the reset');
  assert.equal((await w.firmware.info()).sha256, r.sha256);
});

test('client: a dropped link mid-upload resumes where the C6 is (one upload, two Begins)', async () => {
  const w = world();
  w.box.dropAt = 7200;
  await w.firmware.connect();
  const img = image(20000);
  const phases = new Set();
  const r = await w.firmware.update(img, { onProgress: (p) => phases.add(p.phase) });
  assert.equal(r.resumes, 1);
  assert.equal(w.box.begins, 2);
  assert.ok(phases.has('reconnect'));
  assert.ok(r.written < img.length + 2000, `only what was not acknowledged is sent again (${r.written} of ${img.length})`);
  assert.equal(w.box.running.sha, r.sha256);
});

test('client: a gap rewinds to where the C6 asks', async () => {
  const w = world();
  await w.firmware.connect();
  const img = image(12000);
  // lose one data value on its first write
  const orig = w.box.data.bind(w.box);
  let lost = false;
  w.box.data = (s, buf) => { if (!lost && new DataView(buf.buffer, buf.byteOffset).getUint32(0, true) === 2400) { lost = true; return; } orig(s, buf); };
  const r = await w.firmware.update(img);
  assert.equal(r.rewinds, 1);
  assert.equal(w.box.running.sha, r.sha256);
});

test('client: refusals by name, before anything is written (BUSY, ON_TRIAL, UNAVAILABLE, NO_SPACE, SAME, the ELF)', async () => {
  const w = world();
  await w.firmware.connect();
  const img = image(8000);
  w.box.busyOther = true;
  await assert.rejects(w.firmware.update(img), (e) => e instanceof FirmwareError && e.code === 'BUSY' && e.beforeReady === true && /another connection/.test(e.message));
  w.box.busyOther = false;
  w.box.running.pending = true;
  await assert.rejects(w.firmware.update(img), (e) => e.code === 'ON_TRIAL' && /20 s/.test(e.hint));
  w.box.running.pending = false;
  w.box.maxLen = 4000;
  await assert.rejects(w.firmware.update(img), (e) => e.code === 'IMAGE' && /room for 4000/.test(e.message), 'checked against Info\'s room first: nothing sent');
  assert.equal(w.box.begins, 2);
  w.box.maxLen = 0x1e0000;
  w.box.unavailable = true;
  await assert.rejects(w.firmware.update(img), (e) => e.code === 'UNAVAILABLE');
  w.box.unavailable = false;
  const running = image(4000, 3);
  await assert.rejects(w.firmware.update(running), (e) => e.code === 'SAME');
  const elf = new Uint8Array(4000); elf.set([0x7f, 0x45, 0x4c, 0x46]);
  const begins = w.box.begins;
  await assert.rejects(w.firmware.update(elf), (e) => e.code === 'IMAGE' && /ELF/.test(e.message));
  assert.equal(w.box.begins, begins, 'the ELF never reached Begin');
  assert.deepEqual(w.box.running, { sha: hexOf(running.subarray(running.length - 32)), slot: 0, pending: false });
});

test('client: the C6 refusing the image at its commit (IMAGE reason), and a rollback', async () => {
  const w = world();
  await w.firmware.connect();
  w.box.commitError = { code: 'IMAGE', detail: 7 };
  await assert.rejects(w.firmware.update(image(8000)), (e) => e.code === 'IMAGE' && /^Commit: IMAGE: .*checksum byte/.test(e.message));
  assert.equal(w.box.boots, 0, 'no reset');
  w.box.commitError = null;
  w.box.rollback = true;
  const old = w.box.running.sha;
  await assert.rejects(w.firmware.update(image(8000, 5)), (e) => e.code === 'ROLLED_BACK' && e.message.includes(old));
  assert.equal(w.box.running.sha, old);
});

test('client: an update that hangs on trial (its writes fail like refusals) is watched to its rollback, not reported as a missing role', async () => {
  const w = world({ box: { confirmMs: 150 } });
  await w.firmware.connect();
  const old = w.box.running.sha;
  w.box.hangOnTrial = true;
  w.box.rollback = true;
  await assert.rejects(w.firmware.update(image(8000, 13)), (e) => e.code === 'ROLLED_BACK' && e.message.includes(old), 'ROLLED_BACK, not NOT_AUTHORISED');
  assert.equal(w.box.running.sha, old);
  assert.equal(w.firmware.isConnected(), true, 'the link kept: no release over an inferred refusal');
  assert.equal((await w.firmware.info()).sha256, old);
});

test('client: no Firmware role → the refusal says so; the link is released unless the bridge uses it', async () => {
  for (const style of ['mac', 'other']) {
    const w = world();
    w.box.refuse = style;
    await assert.rejects(w.firmware.connect(), (e) => e.code === 'NOT_AUTHORISED' && e.message.startsWith(FIRMWARE_ROLE_REFUSED) && /status subscribe/.test(e.message) && /Kindle/.test(e.hint), style);
    assert.equal(w.device.gatt.connected, false, 'released');
  }
  const fb = makeFakeBluetooth();
  const box = new FakeFirmwareBox({ c6: fb.c6, device: fb.device });
  const bridge = createBridge({ bluetooth: fb.bluetooth, reconnectDelayMs: 5, advertTimeoutMs: 50 });
  await bridge.connect();
  const firmware = createFirmware({ link: bridge.link, ...FAST });
  box.refuse = 'mac';
  await assert.rejects(firmware.connect(), (e) => e.code === 'NOT_AUTHORISED');
  assert.equal(fb.device.gatt.connected, true, 'the bridge keeps its link');
  assert.equal(bridge.isConnected(), true);
});

test('client: a device picked before the firmware service existed → SERVICE_NOT_GRANTED; a click re-picks', async () => {
  const w = world();
  w.device.firmwareNotGranted = true;
  await assert.rejects(w.firmware.connect(), (e) => e.code === 'SERVICE_NOT_GRANTED' && /click Connect/.test(e.message));
  w.bluetooth.chooserResult = w.device;
  await w.firmware.connect({ allowChooser: true });
  assert.equal(w.firmware.isConnected(), true);
  assert.deepEqual(w.bluetooth.requestDeviceCalls[0].optionalServices.includes(FIRMWARE_SERVICE), true);

  const w2 = world({ fake: { remembered: false } });
  await assert.rejects(w2.firmware.connect(), (e) => e.code === 'NEEDS_USER_GESTURE');
  assert.equal(w2.bluetooth.requestDeviceCalls.length, 0, 'never the chooser from script');
});

test('client: next to a connected CAN bridge, on one GATT queue', async () => {
  const fb = makeFakeBluetooth();
  const box = new FakeFirmwareBox({ c6: fb.c6, device: fb.device });
  const bridge = createBridge({ bluetooth: fb.bluetooth, reconnectDelayMs: 5, advertTimeoutMs: 50 });
  await bridge.connect();
  const firmware = createFirmware({ link: bridge.link, ...FAST });
  await firmware.connect();
  // bridge traffic during the upload: serialised with the data writes (the fake rejects overlap)
  const stats = (async () => { for (let i = 0; i < 5; i++) { await bridge.stats(); await new Promise((r) => setTimeout(r, 3)); } })();
  const oldFirmwareStatus = box.chars.status;
  const oldBridgeStats = fb.c6.chars.stats;
  const gen = fb.device.gattGeneration;
  const r = await firmware.update(image(10000));
  await stats;
  assert.equal(box.running.sha, r.sha256);
  // The update's boot indicated GATT Service Changed: Chrome's old objects are dead...
  assert.equal(fb.device.gattGeneration, gen + 1);
  await assert.rejects(oldFirmwareStatus.startNotifications(), (e) => e.name === 'InvalidStateError');
  await assert.rejects(oldBridgeStats.readValue(), (e) => e.name === 'InvalidStateError');
  // ...and both clients fetched the services and characteristics again on their reconnect
  assert.notEqual(box.chars.status, oldFirmwareStatus);
  assert.equal((await firmware.info()).sha256, r.sha256, 'firmware: Info on fresh objects after the reset');
  for (let i = 0; i < 200 && !bridge.isConnected(); i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal(bridge.isConnected(), true, `bridge reconnected by itself (state ${bridge.info().state}, ${bridge.info().lastError})`);
  assert.notEqual(fb.c6.chars.stats, oldBridgeStats);
  assert.deepEqual(Object.keys(await bridge.stats()).sort(), ['rx_dropped', 'rx_forwarded', 'tx_err', 'tx_ok'], 'bridge: stats on fresh objects');
  await bridge.setFilter([[0x0de, 0x7ff]]);
  await firmware.disconnect();
  assert.equal(bridge.isConnected(), true, 'the firmware client letting go keeps the bridge\'s link');
  assert.equal(fb.device.overlaps ?? 0, 0, 'never two connects/watches at once: one connection owner');
  assert.equal(fb.device.maxLinkOps, 1);
});

test('link: one connection owner — the C6 resets after an update with the bridge attached: one reconnect brings both back, nothing hangs', async () => {
  // What happened on the hardware (2026-10-19): the bridge and the firmware
  // client each reconnected the same device after the reset; their
  // advertisement watches collided and the page's Web Bluetooth stopped
  // answering. Now the link reconnects once and both attach to it.
  const fb = makeFakeBluetooth();
  const box = new FakeFirmwareBox({ c6: fb.c6, device: fb.device, bootMs: 60 });
  const bridge = createBridge({ bluetooth: fb.bluetooth, reconnectDelayMs: 5, advertTimeoutMs: 200, connectTimeoutMs: 500 });
  const firmware = createFirmware({ link: bridge.link, ...FAST });
  await bridge.connect();
  await bridge.setFilter([[0x300, 0x7ff]]);
  await firmware.connect();
  const connects = fb.device.connectCalls;
  const r = await firmware.update(image(9000));
  assert.equal(box.running.sha, r.sha256);
  for (let i = 0; i < 200 && !bridge.isConnected(); i++) await new Promise((res) => setTimeout(res, 5));
  assert.equal(bridge.isConnected(), true, `bridge back (${bridge.info().state}, ${bridge.info().lastError})`);
  assert.deepEqual(fb.c6.filter, [{ id: 0x300, mask: 0x7ff }], 'the bridge re-applied its filter on the shared link');
  assert.equal(firmware.isConnected(), true);
  assert.equal(fb.device.overlaps ?? 0, 0, 'never two connects/watches at once');
  assert.ok(fb.device.connectCalls - connects <= 3, `one reconnect path (${fb.device.connectCalls - connects} gatt.connect calls after the reset)`);

  // A reset while idle: the link comes back by itself; the firmware client
  // finds it again for its next request.
  box.reset({ ...box.running }, box.running);
  for (let i = 0; i < 300 && !(bridge.isConnected() && fb.device.gatt.connected); i++) await new Promise((res) => setTimeout(res, 5));
  assert.equal(bridge.isConnected(), true);
  await firmware.connect();
  assert.equal((await firmware.info()).sha256, r.sha256);
  assert.equal(fb.device.overlaps ?? 0, 0);
});

test('link: Connect (a click) opens the chooser by itself when the remembered grant predates the page\'s services; never again after a pick', async () => {
  const { createLink, GRANT_VERSION } = await import('../link.js');
  const fb = makeFakeBluetooth();
  let stored = null;
  const grantStore = { get: () => stored, set: (v) => { stored = v; } };
  const link = createLink({ bluetooth: fb.bluetooth, grantStore, reconnectDelayMs: 5, advertTimeoutMs: 50 });
  fb.bluetooth.chooserResult = fb.device;
  await link.connect({ allowChooser: true });
  assert.equal(fb.bluetooth.requestDeviceCalls.length, 1, 'a grant of unknown age: the chooser, at the click');
  assert.equal(stored, GRANT_VERSION);
  await link.disconnect();
  await link.connect({ allowChooser: true });
  assert.equal(fb.bluetooth.requestDeviceCalls.length, 1, 'the remembered device after that: no chooser');
  await link.disconnect();
  await link.connect();
  assert.equal(fb.bluetooth.requestDeviceCalls.length, 1, 'never from script');
  // a service Chrome refuses afterwards (an older grant): the next click re-picks
  fb.device.firmwareNotGranted = true;
  new FakeFirmwareBox({ c6: fb.c6, device: fb.device });
  await assert.rejects(link.service(FIRMWARE_SERVICE, 'firmware'), (e) => e.code === 'SERVICE_NOT_GRANTED' && /click Connect/.test(e.message));
  await link.disconnect();
  await link.connect({ allowChooser: true });
  assert.equal(fb.bluetooth.requestDeviceCalls.length, 2);
  assert.ok(await link.service(FIRMWARE_SERVICE, 'firmware'));
});

test('link: only link.js connects, picks or watches for advertisements', () => {
  for (const f of ['ble.js', 'firmware.js', 'api.js', 'app.js', 'ui.js']) {
    // the code only: comments and string literals (error-message matching) out
    const src = readFileSync(join(webDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
    for (const call of ['gatt.connect(', 'watchAdvertisements(', 'requestDevice(', 'getDevices(']) {
      assert.ok(!src.includes(call), `${f} calls ${call}: the page's one connection owner is link.js`);
    }
  }
});

test('client: Service Changed at every reconnect — never an old characteristic (firmware and bridge)', async () => {
  // a dropped link and a table change while the C6 is away, twice: each reconnect must fetch anew
  const fb = makeFakeBluetooth();
  const box = new FakeFirmwareBox({ c6: fb.c6, device: fb.device });
  const bridge = createBridge({ bluetooth: fb.bluetooth, reconnectDelayMs: 5, advertTimeoutMs: 50 });
  const firmware = createFirmware({ link: bridge.link, ...FAST });
  await bridge.connect();
  await firmware.connect();
  for (let round = 0; round < 2; round++) {
    fb.device.serviceChanged();
    fb.device.dropLink();
    assert.ok(await new Promise((res) => { (async () => { for (let i = 0; i < 200; i++) { if (bridge.isConnected()) return res(true); await new Promise((t) => setTimeout(t, 10)); } res(false); })(); }), `bridge back (round ${round})`);
    await firmware.connect();
    assert.equal(typeof (await firmware.info()).sha256, 'string', `firmware Info (round ${round})`);
    await bridge.stats();
  }
  // the image upload too: a drop with Service Changed mid-upload resumes on fresh objects
  box.dropAt = 4800;
  const orig = fb.device.dropLink.bind(fb.device);
  fb.device.dropLink = () => { fb.device.serviceChanged(); orig(); };
  const r = await firmware.update(image(12000));
  assert.equal(r.resumes, 1);
  assert.equal(box.running.sha, r.sha256);
});

// ========================================================================= api

test('api: firmwareInfo / firmwareCheck / firmwareUpdate: plain results, errors with code and hint', async () => {
  const w = world();
  const bridge = createBridge({ bluetooth: w.bluetooth });
  const api = createApi({ bridge, dingo: createFakeDingo(), firmware: w.firmware, fetchBytes: async () => image(6000, 9) });
  const i = await api.firmwareInfo();
  assert.equal(i.ok, true, JSON.stringify(i));
  assert.deepEqual(Object.keys(i).sort(), ['elapsedMs', 'maxLen', 'ok', 'pending', 'sha256', 'slot', 'slotName', 'updatable']);
  assert.equal(i.slotName, 'ota_0'); assert.equal(i.updatable, true);

  const img = image(8000);
  const c = await api.firmwareCheck(Array.from(img));
  assert.equal(c.ok, true);
  assert.deepEqual([c.len, c.fits, c.sameAsRunning, c.running], [img.length, true, false, i.sha256]);
  const bad = await api.firmwareCheck(Array.from(new Uint8Array(100)));
  assert.equal(bad.ok, false); assert.equal(bad.code, 'IMAGE'); assert.match(bad.hint, /c6-image/);
  const viaUrl = await api.firmwareCheck('./wireless-can.bin');
  assert.equal(viaUrl.ok, true); assert.equal(viaUrl.len, image(6000, 9).length);

  const u = await api.firmwareUpdate(img);
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.deepEqual(JSON.parse(JSON.stringify(u)), u, 'JSON-serialisable');
  assert.equal(u.slotName, 'ota_1');
  const ev = activityEvent('firmwareUpdate', ['<8048 bytes>'], u);
  assert.match(ev.title, /^Updated hilux's firmware to [0-9a-f]{12}$/); assert.match(ev.sub, /ota_0 → ota_1/);

  w.box.running.pending = true;
  const t = await api.firmwareUpdate(image(8000, 11));
  assert.equal(t.ok, false); assert.equal(t.code, 'ON_TRIAL'); assert.match(t.hint, /20 s/);
  const x = explainError(t, { op: 'firmwareUpdate' });
  assert.equal(x.where, 'firmware'); assert.equal(x.code, 'ON_TRIAL'); assert.equal(x.headline, 'hilux is still trying out its last update');

  const s = await api.status();
  assert.equal(s.firmware.state, 'connected'); assert.equal(s.firmware.lastInfo.pending, true);
  const d = await api.describe();
  for (const n of ['firmwareInfo', 'firmwareCheck', 'firmwareUpdate']) assert.ok(d.functions.some((f) => f.name === n), n);
  assert.ok(d.notes.some((n) => /Firmware role/.test(n) && /update when parked/.test(n)));
});

test('api: no Firmware role → error, hint and code; the page explains it with the Kindle steps', async () => {
  const w = world();
  w.box.refuse = 'mac';
  const api = createApi({ bridge: createBridge({ bluetooth: w.bluetooth }), dingo: createFakeDingo(), firmware: w.firmware });
  const r = await api.firmwareInfo();
  assert.equal(r.ok, false); assert.equal(r.code, 'NOT_AUTHORISED');
  assert.ok(r.error.startsWith(FIRMWARE_ROLE_REFUSED));
  assert.match(r.hint, /Firmware role on the Kindle/);
  const x = explainError(r, { op: 'firmwareInfo' });
  assert.equal(x.headline, "This computer isn't allowed to update hilux's firmware");
  assert.ok(x.steps.some((s) => /Turn on Firmware/.test(s)));
  const n = await createApi({ bridge: createBridge({ bluetooth: null }) }).firmwareInfo();
  assert.equal(n.ok, false); assert.match(n.error, /no firmware client/);
});

// ==================================================================== the panel

test('panel: progress line, and the panel through its states', () => {
  assert.deepEqual(firmwareProgress({ phase: 'upload', sent: 524288, total: 1048576, kbps: 10 }), { label: 'Sending the image', pct: 50, sentText: '512 KiB of 1.00 MiB', rateText: '10 kB/s', etaText: 'about 52 s left' });
  assert.equal(firmwareProgress({ phase: 'reconnect', sent: 0, total: 1000, kbps: 0 }, 400).pct, 40, 'keeps what was sent across a drop');
  assert.equal(firmwareProgress({ phase: 'trial', sent: 1000, total: 1000, kbps: 9 }).pct, 100);

  const info = { sha256: 'a1'.repeat(32), slot: 0, slotName: 'ota_0', pending: false, maxLen: 0x1e0000, updatable: true };
  let h = firmwareHtml({ info: null, file: null });
  assert.match(h, /Not read yet/); assert.match(h, /data-act="fw-confirm" disabled/);
  h = firmwareHtml({ info, infoAt: 0, file: { name: 'wireless-can.bin', check: { ok: true, len: 1400000, sha256: 'b2'.repeat(32), fits: true, sameAsRunning: false, running: info.sha256 } } }, 1000);
  assert.match(h, /a1a1a1a1a1a1/); assert.match(h, /ota_0/); assert.match(h, /Confirmed/); assert.match(h, /1\.88 MiB/);
  assert.match(h, /differs from what hilux runs/); assert.doesNotMatch(h, /data-act="fw-confirm" disabled/);
  h = firmwareHtml({ info, file: { name: 'x.bin', check: { ok: true, len: 1400000, sha256: 'b2'.repeat(32) } }, confirming: true });
  assert.match(h, /Update hilux to b2b2b2b2b2b2\?/); assert.match(h, /data-act="fw-go"/); assert.match(h, /parked/);
  h = firmwareHtml({ info, file: { name: 'x.bin', check: { ok: false, error: 'this is the ELF, not the firmware image' } } });
  assert.match(h, /Not usable: this is the ELF/);
  h = firmwareHtml({ info, running: true, started: 0, progress: { phase: 'upload', sent: 700000, total: 1400000, kbps: 9.5 } }, 60000);
  assert.match(h, /Sending the image/); assert.match(h, /9\.5 kB\/s/); assert.match(h, /aria-valuenow="50"/);
  h = firmwareHtml({ info, result: { ok: true, len: 1400000, kbps: 9.5, ms: 180000, uploadMs: 150000, confirmMs: 25000, sha256: 'b2'.repeat(32), slotName: 'ota_1', previous: { slot: 0 }, resumes: 1 } });
  assert.match(h, /hilux runs b2b2b2b2b2b2/); assert.match(h, /From ota_0 to ota_1/); assert.match(h, /resumed 1 time/);
});

test('panel: every firmware error code gets its own headline', () => {
  const seen = new Set();
  for (const [code, error] of [
    ['NOT_AUTHORISED', FIRMWARE_ROLE_REFUSED], ['STALE_PAIRING_SUSPECTED', 'x (old pairing)'], ['SERVICE_NOT_GRANTED', 'Chrome has not granted this page'],
    ['NO_FIRMWARE_SERVICE', 'no firmware service'], ['UNAVAILABLE', 'Begin: UNAVAILABLE: this C6 takes no updates'], ['BUSY', 'Begin: BUSY: another'],
    ['ON_TRIAL', 'Begin: ON_TRIAL: on trial'], ['SAME', 'already running'], ['IMAGE', 'Commit: IMAGE: hilux checked the image'], ['NO_SPACE', 'Begin: NO_SPACE: too big'],
    ['HASH', 'Commit: HASH: not the digest'], ['FLASH', 'data: FLASH: failed'], ['SWITCH', 'Commit: SWITCH: x'], ['DROPPED', 'the upload: the link to hilux dropped'],
    ['ROLLED_BACK', 'hilux is running x again'], ['NOT_CONFIRMED', 'not confirmed'],
  ]) {
    const x = explainError({ ok: false, error, code }, { op: 'firmwareUpdate' });
    assert.equal(x.where, 'firmware', code); assert.equal(x.code, code);
    assert.ok(!seen.has(x.headline), `${code}: ${x.headline}`); seen.add(x.headline);
  }
  const local = explainError({ ok: false, error: 'this is the ELF, not the firmware image', code: 'IMAGE', hint: 'make it with c6-image' }, { op: 'firmwareCheck' });
  assert.equal(local.headline, "This file isn't a hilux firmware image");
  const generic = explainError({ ok: false, error: 'busy: apply running' }, { op: 'firmwareUpdate' });
  assert.equal(generic.headline, 'Another operation is still running'); assert.equal(generic.where, 'firmware');
});

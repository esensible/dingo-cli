// End-to-end tests for web/dingo.wasm under Node (run inside the dev container):
//
//   web/build.sh && node web/test/wasm.test.mjs
//
// Loads the real wasm through web/dingo-loader.js (served over HTTP with a
// non-wasm MIME type, exercising the instantiateStreaming fallback), compares
// dingo.encode() with the native Go encoder (web/test/golden), and drives every
// device operation against a JS fake PDM that implements the device side of the
// param protocol (after internal/dingo/fake_test.go and protocol.go).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, "..");
const repo = join(webDir, "..");
const BASE = 222; // 0x0DE

// ---------------------------------------------------------------------------
// Native golden: what the Go CLI encodes for a file.

function golden(file, base) {
  const env = { ...process.env };
  delete env.GOOS;
  delete env.GOARCH;
  const out = execFileSync("go", ["run", "./web/test/golden", file, String(base)], { cwd: repo, env });
  return JSON.parse(out.toString());
}

// ---------------------------------------------------------------------------
// Fake PDM: the device side of the protocol. Responses arrive asynchronously
// (as BLE notifications would) via dingo.pushFrame on base+0, interleaved with
// cyclic status noise on other ids and a short frame on base+0 that the client
// must ignore.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// CRC-32/IEEE over each value as 4 little-endian bytes, in order (firmware rule).
function crcOf(params) {
  let c = 0xffffffff;
  for (const p of params) {
    for (let i = 0; i < 4; i++) {
      const b = (p.value >>> (8 * i)) & 0xff;
      c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    }
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

function frame(cmd, index, sub, value) {
  const d = new Uint8Array(8);
  const v = new DataView(d.buffer);
  d[0] = cmd;
  v.setUint16(1, index, true);
  d[3] = sub;
  v.setUint32(4, value >>> 0, true);
  return d;
}

class FakePDM {
  constructor(dingo, base) {
    Object.assign(this, {
      dingo, base, store: new Map(), order: [], staged: [], burned: false, burnResult: 1,
      version: 0x02010305, // 5.3, build (0x01<<8)|0x02 = 258
      silent: false, rejectSend: null, sendDelayMs: 0, sent: 0, noise: true,
    });
  }
  transport() {
    return { send: (id, data) => this.send(id, data) };
  }
  key(i, s) { return i * 256 + s; }
  async send(id, data) {
    if (this.sendDelayMs) await new Promise((r) => setTimeout(r, this.sendDelayMs));
    if (this.rejectSend) throw new Error(this.rejectSend);
    if (!(data instanceof Uint8Array)) throw new TypeError("send: data is not a Uint8Array");
    this.sent++;
    if (id !== this.base + 1 || this.silent) return;
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const cmd = data[0], index = v.getUint16(1, true), sub = data[3], value = v.getUint32(4, true);
    const out = [];
    const reply = (c, i, s, val) => out.push(frame(c, i, s, val));
    switch (cmd) {
      case 20: this.staged = []; reply(20, 0, 0, 0); break; // WriteAll start
      case 21: this.staged.push({ index, sub, value }); break; // value, no reply
      case 22: // complete: commit, report count + CRC
        this.order = this.staged.slice();
        for (const p of this.order) this.store.set(this.key(p.index, p.sub), p.value);
        reply(22, this.order.length, 0, parseInt(crcOf(this.order), 16));
        break;
      case 2: this.store.set(this.key(index, sub), value); reply(2, index, sub, value); break;
      case 1: reply(1, index, sub, this.store.get(this.key(index, sub)) ?? 0); break;
      case 10:
        reply(10, 0, 0, 0);
        for (const p of this.order) reply(11, p.index, p.sub, p.value);
        reply(12, this.order.length, 0, parseInt(crcOf(this.order), 16));
        break;
      case 34: reply(35, 0, 0, parseInt(crcOf(this.order), 16)); break;
      case 30: {
        const magic = data[1] === 1 && data[2] === 3 && data[3] === 8;
        const result = magic ? this.burnResult : 0;
        if (result === 1) this.burned = true;
        reply(30, 0, 0, result);
        break;
      }
      case 31: reply(31, 0, 0, this.version); break;
    }
    if (out.length === 0) return;
    setTimeout(() => {
      for (const f of out) {
        if (this.noise) this.dingo.pushFrame(this.base + 3, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
        const r = this.dingo.pushFrame(this.base, f);
        if (r?.ok !== true) throw new Error("pushFrame refused a valid frame: " + JSON.stringify(r));
      }
      if (this.noise) this.dingo.pushFrame(this.base, new Uint8Array([22, 0])); // short: ignored
    }, 0);
  }
}

// ---------------------------------------------------------------------------
// Harness.

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// call asserts the Promise contract: resolves (never rejects) to an object with
// a boolean ok, and an error string iff !ok.
async function call(p) {
  assert.ok(p instanceof Promise, "operation did not return a Promise");
  let r;
  try {
    r = await p;
  } catch (e) {
    assert.fail("Promise rejected (contract: always resolves): " + e);
  }
  assert.equal(typeof r, "object");
  assert.equal(typeof r.ok, "boolean", "result has no boolean ok: " + JSON.stringify(r));
  if (!r.ok) assert.ok(typeof r.error === "string" && r.error.length > 0, "failure without error: " + JSON.stringify(r));
  return r;
}
const ok = async (p) => {
  const r = await call(p);
  assert.ok(r.ok, "expected ok, got error: " + r.error);
  return r;
};
const err = async (p, ...parts) => {
  const r = await call(p);
  assert.equal(r.ok, false, "expected failure, got " + JSON.stringify(r).slice(0, 200));
  for (const s of parts) assert.ok(r.error.includes(s), `error ${JSON.stringify(r.error)} lacks ${JSON.stringify(s)}`);
  return r;
};

// ---------------------------------------------------------------------------
// Fixtures.

const examplePath = join(repo, "internal/pdmcfg/testdata/example.json");
const exampleText = readFileSync(examplePath, "utf8");
const twoText = (() => {
  const doc = JSON.parse(exampleText);
  const rear = structuredClone(doc.PdmDevices[0]);
  rear.name = "rear";
  rear.baseId = 300;
  doc.PdmDevices.push(rear);
  return JSON.stringify(doc, null, 2);
})();
const tmp = mkdtempSync(join(tmpdir(), "dingo-wasm-"));
const twoPath = join(tmp, "two.json");
writeFileSync(twoPath, twoText);

const gold = golden(examplePath, BASE);
const goldRear = golden(twoPath, 300);

// Serve web/ with the wrong MIME type for .wasm, so the loader must fall back.
const server = createServer((req, res) => {
  try {
    const body = readFileSync(join(webDir, new URL(req.url, "http://x").pathname));
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { loadDingo } = await import(join(webDir, "dingo-loader.js"));
const dingo = await loadDingo(`http://127.0.0.1:${server.address().port}/dingo.wasm`);
server.close();

const fake = new FakePDM(dingo, BASE);

// ---------------------------------------------------------------------------
// Tests (in order: the first ones run before any transport is set).

test("loader: info, ready, idempotent", async () => {
  assert.equal(dingo, globalThis.dingo);
  assert.equal(await dingo.ready, true);
  assert.equal(dingo.info.module, "dingo-cli");
  assert.match(dingo.info.go, /^go1\.22/);
  assert.ok(dingo.info.build && dingo.info.build !== "unknown", "build: " + dingo.info.build);
  assert.equal(await loadDingo(), dingo);
});

test("no transport set", async () => {
  await err(dingo.deviceVersion(BASE), "no transport", "setTransport");
  await err(dingo.apply(BASE, exampleText), "no transport");
});

test("encode(example) equals native Go encode (count, CRC, every param)", async () => {
  for (const r of [await ok(dingo.encode(exampleText, BASE)), await ok(dingo.encode(exampleText))]) {
    assert.equal(r.count, gold.count);
    assert.equal(r.count, 2269);
    assert.equal(r.crc, gold.crc);
    assert.equal(r.crc, crcOf(r.params)); // independent JS CRC agrees
    assert.deepEqual(r.params, gold.params);
    assert.equal(r.name, "test1");
    assert.equal(r.baseId, 222);
    assert.equal(r.pdmType, 0);
    assert.equal(r.board, "dingoPDM");
  }
  const rear = await ok(dingo.encode(twoText, 300));
  assert.equal(rear.name, "rear");
  assert.equal(rear.crc, goldRear.crc);
  assert.deepEqual(rear.params, goldRear.params);
});

test("devices / paramNames", async () => {
  const d = await ok(dingo.devices(twoText));
  assert.deepEqual(d.devices, [
    { kind: "PdmDevices", name: "test1", baseId: 222, pdmType: 0 },
    { kind: "PdmDevices", name: "rear", baseId: 300, pdmType: 0 },
  ]);
  const n = await ok(dingo.paramNames());
  assert.equal(n.board, "dingoPDM");
  assert.ok(n.names.includes("output[4].currentLimit"));
  assert.ok(n.names.includes("output[8].enabled"));
  const max = await ok(dingo.paramNames(1));
  assert.equal(max.board, "dingoPDM-Max");
  assert.ok(!max.names.includes("output[5].enabled"));
  await err(dingo.paramNames(9), "unknown pdmType 9", "0 (dingoPDM)");
});

test("encode: malformed JSON, no PDMs, ambiguous file", async () => {
  await err(dingo.encode('{\n  "PdmDevices": [\n    {,}\n  ]\n}'), "malformed JSON at line 3, column 6");
  await err(dingo.encode(""), "malformed JSON");
  await err(dingo.encode('{"PdmDevices": [], "CanboardDevices": [{"name":"cb"}]}'), "no PdmDevices in file", "CanboardDevices");
  await err(dingo.encode(twoText), "2 PdmDevices entries", '222 (0x0DE) "test1"', '300 (0x12C) "rear"');
  await err(dingo.encode(exampleText, "222"), "base must be a number");
  await err(dingo.encode(42), "jsonText must be");
});

test("pushFrame validation and overflow", async () => {
  assert.deepEqual(dingo.pushFrame(0x123, new Uint8Array([1, 2])), { ok: true });
  assert.equal(dingo.pushFrame(0x800, new Uint8Array(8)).ok, false);
  assert.equal(dingo.pushFrame(1, new Uint8Array(9)).ok, false);
  assert.equal(dingo.pushFrame(1, "nope").ok, false);
  assert.equal(dingo.pushFrame(1, [1, 2, 3]).ok, true); // plain array accepted
  const t0 = Date.now();
  for (let i = 0; i < 20000; i++) dingo.pushFrame(0x100, new Uint8Array(8)); // > 16384 queue: drops oldest
  assert.ok(Date.now() - t0 < 5000, "pushFrame is slow");
});

test("setTransport validation", async () => {
  assert.equal(dingo.setTransport({}).ok, false);
  assert.equal(dingo.setTransport(fake.transport()).ok, true);
});

test("apply end to end, verified by the fake's committed state", async () => {
  const progress = [];
  const r = await ok(dingo.apply(BASE, exampleText, { onProgress: (p) => progress.push(p) }));
  assert.equal(r.applied, gold.count);
  assert.equal(r.crc, gold.crc);
  assert.equal(r.burned, false);
  assert.equal(r.partial, false);
  assert.equal(fake.burned, false);
  assert.deepEqual(fake.order, gold.params);
  assert.ok(progress.length > 1);
  assert.deepEqual(progress.at(-1), { done: gold.count, total: gold.count });
});

test("checkCrc / readAll / deviceVersion", async () => {
  assert.equal((await ok(dingo.checkCrc(BASE))).crc, gold.crc);
  const progress = [];
  const ra = await ok(dingo.readAll(BASE, { onProgress: (p) => progress.push(p) }));
  assert.equal(ra.count, gold.count);
  assert.equal(ra.crc, gold.crc);
  assert.deepEqual(ra.params, gold.params);
  assert.deepEqual(progress.at(-1), { done: gold.count, total: gold.count });
  const v = await ok(dingo.deviceVersion(BASE));
  assert.deepEqual({ ...v }, { ok: true, major: 5, minor: 3, build: 258, text: "5.3.258" });
});

test("setParam / getParam", async () => {
  const s = await ok(dingo.setParam(BASE, "output[4].currentLimit", 15));
  assert.equal(s.name, "output[4].currentLimit");
  assert.equal(s.value, 15);
  assert.equal(s.index, 0x1003);
  assert.equal(s.sub, 2);
  assert.equal(s.raw, 0x41700000); // float32 15.0
  assert.equal(s.burned, false);
  assert.equal(fake.store.get(0x1003 * 256 + 2), 0x41700000);
  const g = await ok(dingo.getParam(BASE, "output[4].currentLimit"));
  assert.equal(g.value, 15);
  assert.equal(g.raw, 0x41700000);
  assert.equal((await ok(dingo.setParam(BASE, "output[1].enabled", true))).value, true);
  assert.equal((await ok(dingo.setParam(BASE, "output[2].input", "Flasher1"))).value, "Flasher1");
  assert.equal((await ok(dingo.setParam(BASE, "device.canSpeed", "250K", { burn: true }))).burned, true);
  await err(dingo.setParam(BASE, "output[99].currentLimit", 1), "unknown param: output[99].currentLimit");
  await err(dingo.setParam(BASE, "output[4].currentLimit", 500), "out of firmware range");
  await err(dingo.getParam(BASE, "nope"), "unknown param: nope");
  await err(dingo.setParam(BASE, "output[4].currentLimit"), "missing value");
});

test("burn ok, burn rejected, apply+burn rejected", async () => {
  fake.burned = false;
  await ok(dingo.burn(BASE));
  assert.equal(fake.burned, true);
  fake.burnResult = 0;
  await err(dingo.burn(BASE), "burn: PDM at base 0x0DE", "burn rejected: device WriteConfig returned 0");
  const r = await err(dingo.apply(BASE, exampleText, { burn: true }), "burn failed", "WriteConfig returned 0");
  assert.equal(r.applied, gold.count);
  assert.equal(r.crc, gold.crc);
  assert.equal(r.burned, false);
  fake.burnResult = 1;
  const b = await ok(dingo.apply(BASE, exampleText, { burn: true }));
  assert.equal(b.burned, true);
});

test("apply: wrong baseId, malformed JSON, bad options", async () => {
  await err(dingo.apply(0x123, twoText), "no PdmDevices entry with baseId 291 (0x123)", '222 (0x0DE) "test1"', '300 (0x12C) "rear"');
  await err(dingo.apply(BASE, "{oops"), "malformed JSON at line 1, column 2");
  await err(dingo.apply(BASE, exampleText, { burn: "yes" }), "opts.burn must be a boolean");
  await err(dingo.apply(0x800, exampleText), "not an integer CAN id");
  // A single-PDM file is used regardless of base, exactly like `dingo apply`.
  const single = await ok(dingo.encode(exampleText, 0x123));
  assert.match(single.warning, /only PDM has baseId 222/);
});

test("busy: one device operation at a time", async () => {
  fake.sendDelayMs = 1;
  const first = dingo.apply(BASE, exampleText, { partial: true });
  await err(dingo.deviceVersion(BASE), "busy: apply in progress");
  await err(dingo.burn(BASE), "busy: apply in progress");
  await ok(dingo.encode(exampleText)); // pure functions are not blocked
  const r = await ok(first);
  assert.equal(r.partial, true);
  fake.sendDelayMs = 0;
  await ok(dingo.deviceVersion(BASE)); // slot released
});

test("progress callback that throws is reported, not fatal", async () => {
  const r = await ok(dingo.readAll(BASE, { onProgress: () => { throw new Error("boom"); } }));
  assert.equal(r.count, gold.count);
  assert.match(r.progressError, /onProgress threw: boom/);
});

test("transport send rejected", async () => {
  fake.rejectSend = "GATT operation failed";
  await err(dingo.deviceVersion(BASE), "transport.send(0x0DF) rejected: GATT operation failed");
  fake.rejectSend = null;
});

test("silent device: timeouts (scaled for the test) name the missing response", async () => {
  assert.equal(dingo._setTimeoutScale(0.02).ok, true);
  fake.silent = true;
  const t0 = Date.now();
  await err(dingo.deviceVersion(BASE), "deviceVersion: PDM at base 0x0DE (commands to 0x0DF, responses on 0x0DE)", "no response (want cmd 31) after 6 tries");
  await err(dingo.checkCrc(BASE), "no response (want cmd 35) after 6 tries");
  await err(dingo.burn(BASE), "no response (want cmd 30) within");
  await err(dingo.readAll(BASE), "device not responding");
  await err(dingo.apply(BASE, exampleText), "WriteAll start: no response (want cmd 20)");
  await err(dingo.getParam(BASE, "device.baseId"), "no response (want cmd 1)");
  await err(dingo.setParam(BASE, "device.baseId", 222), "set: no ack (unknown param or out of range)");
  assert.ok(Date.now() - t0 < 10000, `silent-device tests took ${Date.now() - t0}ms`);
  fake.silent = false;
  dingo._setTimeoutScale(1);
  await ok(dingo.deviceVersion(BASE));
});

test("silent transport send (never settles) times out", async () => {
  dingo._setTimeoutScale(0.02);
  dingo.setTransport({ send: () => new Promise(() => {}) });
  await err(dingo.deviceVersion(BASE), "transport.send(0x0DF) did not settle within");
  dingo.setTransport({ send: () => { throw new Error("sync throw"); } });
  await err(dingo.deviceVersion(BASE), "transport.send(0x0DF) threw: sync throw");
  dingo.setTransport(fake.transport());
  dingo._setTimeoutScale(1);
  await ok(dingo.deviceVersion(BASE));
});

// ---------------------------------------------------------------------------
// The C6 body node (board c6body_v1). FakeTableNode answers the protocol from
// the C6 firmware's own parameter table, recorded by tools/c6oracle from the
// real core (internal/params/testdata/c6body_v1.fw.json), with dingoFW's
// semantics (core/param_protocol.cpp): WriteAll resets the staged copy to the
// defaults, an unknown param answers 25 and an out-of-range one 26 (neither
// counted), WriteAllComplete applies only if the count matches, and CheckCrc /
// ReadAll run over the whole table in table order.

const fw = JSON.parse(readFileSync(join(repo, "internal/params/testdata/c6body_v1.fw.json"), "utf8"));
const C6_BASE = fw.board.baseId; // DEFAULT_BASE_ID
const c6Run = Object.fromEntries(fw.runs.map((r) => [r.name, r]));
const c6Path = (n) => join(webDir, "examples", n + ".json");
const c6Text = (n) => readFileSync(c6Path(n), "utf8");

class FakeTableNode {
  constructor(dingo, table) {
    this.dingo = dingo;
    this.table = table;
    this.live = table.map((p) => p.default);
    this.staged = this.live.slice();
    this.rejected = [];
    this.at = new Map(table.map((p, i) => [p.index * 256 + p.sub, i]));
  }
  get base() { return this.live[0]; } // device.baseId is the first param
  inRange(p, v) {
    const f32 = (u) => new Float32Array(new Uint32Array([u]).buffer)[0];
    const i32 = (u) => u | 0;
    if (p.type === "float") return f32(v) >= f32(p.min) && f32(v) <= f32(p.max);
    if (p.type.startsWith("int")) return i32(v) >= i32(p.min) && i32(v) <= i32(p.max);
    return v >= p.min && v <= p.max;
  }
  crc(vals) { return parseInt(crcOf(vals.map((value) => ({ value }))), 16); }
  transport() { return { send: (id, data) => this.send(id, data) }; }
  send(id, data) {
    if (id !== this.base + 1) return;
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const cmd = data[0], index = v.getUint16(1, true), sub = data[3], value = v.getUint32(4, true);
    const i = this.at.get(index * 256 + sub);
    const out = [];
    const reply = (c, a, s, val) => out.push(frame(c, a, s, val));
    switch (cmd) {
      case 20: this.staged = this.table.map((p) => p.default); this.count = 0; this.wcrc = []; reply(20, 0, 0, 0); break;
      case 21:
        if (i === undefined) { this.rejected.push([index, sub, 25]); reply(25, index, sub, 0); break; }
        if (!this.inRange(this.table[i], value)) { this.rejected.push([index, sub, 26]); reply(26, index, sub, value); break; }
        this.staged[i] = value; this.count++; this.wcrc.push(value);
        break;
      case 22: {
        // Applied before the answer is encoded, so a new baseId answers on the new base.
        if (this.count === index) this.live = this.staged.slice();
        out.push([this.base, frame(22, this.count, 0, this.crc(this.wcrc))]);
        break;
      }
      case 2:
        if (i !== undefined && this.inRange(this.table[i], value)) { this.live[i] = value; reply(2, index, sub, value); }
        break;
      case 1: reply(i === undefined ? 5 : 1, index, sub, i === undefined ? 0 : this.live[i]); break;
      case 34: reply(35, 0, 0, this.crc(this.live)); break;
      case 10:
        reply(10, 0, 0, 0);
        this.table.forEach((p, k) => reply(11, p.index, p.sub, this.live[k]));
        reply(12, this.table.length, 0, this.crc(this.live));
        break;
      case 31: reply(31, 0, 0, 0x08000500); break; // 0.5.8
      case 30: { // burn: WriteConfig()'s result (0 on the milestone-1 C6, which has no persistence)
        const magic = data[1] === 1 && data[2] === 3 && data[3] === 8;
        if (magic) { this.burns = (this.burns ?? 0) + 1; reply(30, 0, 0, this.burnResult ?? 1); }
        break;
      }
    }
    const base = this.base;
    setTimeout(() => {
      for (const f of out) {
        if (Array.isArray(f)) this.dingo.pushFrame(f[0], f[1]);
        else this.dingo.pushFrame(base, f);
      }
    }, 0);
  }
}

test("c6body_v1: encode(examples) equals native Go and the firmware's own count + CRC", async () => {
  for (const n of ["c6-empty", "c6-test"]) {
    const g = golden(c6Path(n), C6_BASE);
    const r = await ok(dingo.encode(c6Text(n), C6_BASE));
    assert.equal(r.board, "c6body_v1");
    assert.equal(r.pdmType, 12);
    assert.equal(r.baseId, 0x500);
    assert.equal(r.count, fw.board.numParams);
    assert.equal(r.count, g.count);
    assert.deepEqual(r.params, g.params);
    assert.equal(r.crc, g.crc);
    assert.equal(r.crc, crcOf(r.params));
    // The firmware's answers when sent exactly these params.
    for (const k of ["writeCrc", "checkCrc", "readCrc"]) assert.equal(r.crc, c6Run[n][k], `${n} ${k}`);
    assert.equal(c6Run[n].writeCount, r.count);
    // Same index/sub sequence as the firmware's table (the CRC order).
    assert.deepEqual(r.params.map((p) => [p.index, p.sub]), fw.params.map((p) => [p.index, p.sub]));
  }
  assert.equal((await ok(dingo.encode(c6Text("c6-empty")))).crc, fw.defaultsCrc, "c6-empty is the defaults");
});

test("c6body_v1: devices / paramNames / rejected documents", async () => {
  const d = await ok(dingo.devices(c6Text("c6-test")));
  assert.deepEqual(d.devices, [{ kind: "PdmDevices", name: "c6-body-test", baseId: 1280, pdmType: 12 }]);
  const n = await ok(dingo.paramNames(12));
  assert.equal(n.board, "c6body_v1");
  assert.equal(n.pdmType, 12);
  assert.equal(n.names.length, 385);
  assert.ok(n.names.includes("flasher[4].singleCycle"));
  assert.ok(!n.names.some((x) => x.startsWith("output[") || x.startsWith("keypad[") || x.startsWith("canInput[9]")));
  const doc = (dev) => JSON.stringify({ PdmDevices: [{ pdmType: 12, baseId: 1280, ...dev }] });
  await err(dingo.encode(doc({ outputs: [{ enabled: true }] })), "no firmware param for index 0x1000", "c6body_v1");
  await err(dingo.encode(doc({ virtualInputs: [{ var0: "Out1Active" }] })), 'unknown variable "Out1Active"');
  await err(dingo.encode(doc({ pdmType: 13 })), "unknown pdmType 13", "12 (c6body_v1)");
  // Var names resolve against the C6's var map, not the PDM's.
  const r = await ok(dingo.encode(doc({ canOutputs: [{ input: "CanIn1Out" }] })));
  assert.equal(r.params.find((p) => p.index === 0x2000 && p.sub === 1).value, 3);
});

test("c6body_v1: apply / checkCrc / readAll / setParam / burn against a node with the firmware's table", async () => {
  const node = new FakeTableNode(dingo, fw.params);
  dingo.setTransport(node.transport());
  try {
    const want = fw.defaultsCrc;
    assert.equal((await ok(dingo.checkCrc(C6_BASE))).crc, want, "a fresh node verifies as c6-empty");
    for (const n of ["c6-test", "c6-empty", "c6-test"]) {
      const a = await ok(dingo.apply(C6_BASE, c6Text(n)));
      assert.equal(a.board, "c6body_v1");
      assert.equal(a.applied, 385);
      assert.equal(a.crc, c6Run[n].writeCrc);
      assert.deepEqual(node.rejected, []);
      assert.equal((await ok(dingo.checkCrc(C6_BASE))).crc, c6Run[n].checkCrc);
      const ra = await ok(dingo.readAll(C6_BASE));
      assert.equal(ra.count, 385);
      assert.equal(ra.crc, c6Run[n].readCrc);
    }
    // setParam/getParam resolve names and var names on the C6's table.
    const s = await ok(dingo.setParam(C6_BASE, "canOutput[1].input", "CanIn1Out", { pdmType: 12 }));
    assert.deepEqual([s.board, s.index, s.sub, s.raw, s.value], ["c6body_v1", 0x2000, 1, 3, "CanIn1Out"]);
    const g = await ok(dingo.getParam(C6_BASE, "canOutput[1].input", { pdmType: 12 }));
    assert.deepEqual([g.raw, g.value], [3, "CanIn1Out"]);
    // Without pdmType the PDM's var map applies: CanIn1Out is 7 there, which
    // on the C6 is CanIn3Out. That is why pdmType matters.
    const p = await ok(dingo.getParam(C6_BASE, "canOutput[1].input"));
    assert.equal(p.board, "dingoPDM");
    assert.equal(p.value, "BoardTemp");
    await err(dingo.setParam(C6_BASE, "output[1].enabled", true, { pdmType: 12 }), "unknown param: output[1].enabled");
    await err(dingo.getParam(C6_BASE, "x", { pdmType: 3 }), "unknown pdmType 3");
    // burn: the node's WriteConfig() result is reported either way.
    await ok(dingo.burn(C6_BASE));
    node.burnResult = 0;
    await err(dingo.burn(C6_BASE), "burn rejected: device WriteConfig returned 0");
    assert.equal(node.burns, 2);
    // A dingoPDM config to the C6: the first PDM-only param is answered
    // "not found", so the device's count falls short and apply fails.
    await err(dingo.apply(C6_BASE, exampleText.replace('"baseId": 222', '"baseId": 1280')), "write count mismatch: device staged");
    assert.ok(node.rejected.some(([, , c]) => c === 25));
  } finally {
    dingo.setTransport(fake.transport());
  }
});

test("logic graph: graph / graphEdit / graphNode (c6-test)", async () => {
  const text = c6Text("c6-test");
  const g = await ok(dingo.graph(text));
  assert.equal(g.board, "c6body_v1");
  assert.deepEqual(g.graph.nodes.map((n) => n.id), ["device", "virtualInput-1", "flasher-1", "canOutput-1", "canOutput-2"]);
  assert.equal(g.graph.edges.length, 5);
  const fl = g.graph.nodes.find((n) => n.id === "flasher-1");
  assert.deepEqual(fl.outputs[0], { id: "out:27", label: "State", dataTypes: ["bool"], var: "27", connected: true });
  assert.equal(fl.inputs[0].var, null);
  assert.equal(g.slots.length, 40);
  // Connect flasher-1 → virtualInput-1 var2: the config gains var2: 27, and the CRC is the new text's.
  const e = await ok(dingo.graphEdit(text, { op: "connect", source: "flasher-1", sourceHandle: "out:27", target: "virtualInput-1", targetHandle: "in:var2" }));
  assert.equal(JSON.parse(e.config).PdmDevices[0].virtualInputs[0].var2, 27);
  assert.ok(e.changed);
  assert.equal(e.crc, (await ok(dingo.encode(e.config))).crc);
  assert.notEqual(e.crc, (await ok(dingo.encode(text))).crc);
  assert.ok(e.graph.edges.some((x) => x.id === "virtualInput-1:var2" && x.source === "flasher-1"));
  // The edit may also be JSON text; base selects the entry.
  await ok(dingo.graphEdit(text, JSON.stringify({ op: "move", moves: [{ id: "device", x: 10, y: 20 }] }), 1280));
  await err(dingo.graphEdit(text, { op: "connect", sourceHandle: "out:4", target: "flasher-1", targetHandle: "in:input" }), "Input accepts bool, not float");
  await err(dingo.graphEdit(text, { op: "nope" }), "unknown edit op");
  await err(dingo.graphEdit(text, { op: "move", bogus: 1 }), "unknown field");
  await err(dingo.graph("{"), "malformed JSON");
  const p = await ok(dingo.graphNode(text, "canOutput-1"));
  assert.equal(p.fields.find((f) => f.field === "id").value, 1520);
  await err(dingo.graphNode(text, "device"), "no properties panel");
});

test("flow.js: the fake dotnet routes the vendored editor's calls through api.graphEdit", async () => {
  const { createApi } = await import(join(webDir, "api.js"));
  const { createFlowController } = await import(join(webDir, "flow.js"));
  const api = createApi({ dingo, log: () => {} });
  let text = c6Text("c6-test");
  const pushed = []; const errors = []; const asked = [];
  let created; let answer = true;
  // Stands in for flow-editor.js: records what the adapter gives create() and pushes.
  const editorModule = {
    create: async (element, dotnet, graph) => {
      created = { element, dotnet, graph };
      return { setGraph: (g) => pushed.push(g), setPropertiesNode() {}, selectNode() {}, fitView() {}, getViewportCenter: () => ({ x: 300, y: 200 }), dispose() {} };
    },
  };
  const fc = createFlowController({
    api, getText: () => text, setText: (t) => { text = t; },
    confirm: async (m) => { asked.push(m); return answer; }, onError: (m) => errors.push(m), loadEditor: async () => editorModule,
  });
  assert.ok((await fc.mount({})).ok);
  assert.equal(created.graph.nodes.length, 5);
  const net = created.dotnet;
  const dev = () => JSON.parse(text).PdmDevices[0];

  assert.equal(await net.invokeMethodAsync("OnConnect", "flasher-1", "out:27", "virtualInput-1", "in:var2"), undefined);
  assert.equal(dev().virtualInputs[0].var2, 27);
  assert.ok(pushed.at(-1).edges.some((e) => e.id === "virtualInput-1:var2" && e.source === "flasher-1"));

  // A refused edit reports the error and redraws the canvas from the config.
  const n = pushed.length; const before = text;
  await net.invokeMethodAsync("OnConnect", "canInput-1", "out:4", "flasher-1", "in:input");
  assert.match(errors.at(-1), /Input accepts bool, not float/);
  assert.equal(pushed.length, n + 1);
  assert.equal(text, before);

  // ConfirmRemoveNodes asks the page (FlowEditorTab's wording) and returns its answer.
  answer = false;
  assert.equal(await net.invokeMethodAsync("ConfirmRemoveNodes", ["virtualInput-1"]), false);
  assert.equal(asked.at(-1), "Disable always-on (VirtIn1 = var 19) (Virtual Input 1)? 2 input(s) using it will be disconnected.");
  answer = true;
  assert.equal(await net.invokeMethodAsync("ConfirmRemoveNodes", ["virtualInput-1"]), true);
  assert.equal(await net.invokeMethodAsync("ConfirmRemoveNodes", ["device"]), false);

  await net.invokeMethodAsync("OnDeleted", ["virtualInput-1"], [{ target: "canOutput-2", targetHandle: "in:input" }]);
  assert.equal(dev().virtualInputs[0].enabled, false);
  assert.equal(dev().flashers[0].input, 0);
  assert.equal(dev().canOutputs[0].input, 0);
  assert.equal(dev().canOutputs[1].input, 0);
  assert.ok(!pushed.at(-1).nodes.some((x) => x.id === "virtualInput-1"));

  await net.invokeMethodAsync("OnNodesMoved", [{ id: "flasher-1", x: 5.5, y: 6 }]);
  assert.deepEqual(dev().flowLayout["flasher-1"], { x: 5.5, y: 6 });

  await net.invokeMethodAsync("OnOpenProperties", "flasher-1");
  assert.equal(fc.propsId, "flasher-1");
  const p = await fc.props("flasher-1");
  assert.ok(p.fields.some((f) => f.field === "onTime" && f.value === 500));
  await fc.set("flasher-1", "onTime", 250);
  assert.equal(dev().flashers[0].onTime, 250);

  // Add Function: enabled at the view's centre, offset as dingoConfig does.
  assert.ok((await fc.add("counter-2")).ok);
  assert.equal(dev().counters[1].enabled, true);
  assert.deepEqual(dev().flowLayout["counter-2"], { x: 200, y: 160 });

  await assert.rejects(net.invokeMethodAsync("Nope"), /not handled/);
  assert.equal((await ok(dingo.encode(text))).crc, (await ok(dingo.graphEdit(text, { op: "move", moves: [] }))).crc);
});

// ---------------------------------------------------------------------------

let failed = 0;
for (const [name, fn] of tests) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok   - ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL - ${name}\n       ${String(e?.stack || e).split("\n").join("\n       ")}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);

// fake-dingo.mjs — a JS stand-in for the Go→WASM `globalThis.dingo` module,
// implementing the same contract (setTransport / pushFrame / promise-returning
// ops resolving to {ok:true,...} | {ok:false,error}) and speaking the real dingo
// parameter protocol over the transport, so the tests exercise bridge + filter
// + fake PDM end to end.

import { CMD, frameBytes, decodeMsg, crcOfParams } from './fake-bluetooth.mjs';

const PARAMS = {
  'device.baseId': { index: 0x1000, sub: 1 },
  'output[0].currentLimit': { index: 0x1100, sub: 2 },
  'outputs[0].enabled': { index: 0x1100, sub: 1 },
};

export function createFakeDingo({ requestTimeoutMs = 150, tries = 3, withParamNames = true } = {}) {
  let transport = null;
  const waiters = new Set(); // { base, want, resolve }
  const listeners = new Set();
  const calls = [];

  function pushFrame(id, data) {
    const d = data instanceof Uint8Array ? data : Uint8Array.from(data);
    for (const l of listeners) l(id, d);
  }
  function onResp(base, cb) {
    const l = (id, d) => { if (id === base && d.length >= 8) cb(decodeMsg(d)); };
    listeners.add(l); return () => listeners.delete(l);
  }
  async function send(base, d) {
    if (!transport) throw new Error('no transport set');
    await transport.send(base + 1, d);
  }
  async function request(base, d, want, timeoutMs = requestTimeoutMs, n = tries) {
    for (let i = 0; i < n; i++) {
      let off;
      const got = new Promise((resolve) => { off = onResp(base, (m) => { if (m.cmd === want) resolve(m); }); });
      try {
        await send(base, d);
        const r = await Promise.race([got, new Promise((res) => setTimeout(() => res(null), timeoutMs))]);
        if (r) return r;
      } finally { off(); }
    }
    throw new Error(`no response (want cmd ${want}) after ${n} tries`);
  }
  const wrap = (name, fn) => async (...a) => { calls.push(name); try { return { ok: true, ...(await fn(...a)) }; } catch (e) { return { ok: false, error: e.message }; } };

  function pickDevice(text, base) {
    let cfg;
    try { cfg = JSON.parse(text); } catch (e) { throw new Error('parse config: ' + e.message); }
    const pdms = cfg.PdmDevices || [];
    if (!pdms.length) throw new Error('config has no PdmDevices');
    const dev = base === undefined || pdms.length === 1 ? pdms[0] : pdms.find((p) => p.baseId === base);
    if (!dev) throw new Error(`no PdmDevice with baseId ${base} in config (have: ${pdms.map((p) => p.baseId).join(', ')})`);
    return dev;
  }
  function flatten(o, out = []) {
    for (const k of Object.keys(o).sort()) {
      const v = o[k];
      if (typeof v === 'number') out.push(v >>> 0);
      else if (typeof v === 'boolean') out.push(v ? 1 : 0);
      else if (v && typeof v === 'object') flatten(v, out);
    }
    return out;
  }
  function encodeDev(dev) {
    const vals = flatten(dev);
    const params = vals.map((value, i) => ({ index: 0x2000 + (i >> 4), sub: i & 15, value }));
    return { name: dev.name ?? '', pdmType: dev.pdmType ?? 0, baseId: dev.baseId ?? 222, count: params.length, crc: crcOfParams(params), params };
  }

  const dingo = {
    info: { fake: true, version: 'fake-1' },
    calls,
    setTransport(t) { transport = t; },
    pushFrame,
    deviceVersion: wrap('deviceVersion', async (base) => {
      const m = await request(base, Uint8Array.of(CMD.version, 0, 0, 0, 0, 0, 0, 0), CMD.version);
      const v = m.value;
      const major = v & 0xff; const minor = (v >> 8) & 0xff; const build = (((v >> 16) & 0xff) << 8) | ((v >>> 24) & 0xff);
      return { major, minor, build, text: `v${major}.${minor}.${build}` };
    }),
    checkCrc: wrap('checkCrc', async (base) => ({ crc: (await request(base, frameBytes(CMD.checkCrc, 0, 0, 0), CMD.checkCrcRsp)).value })),
    readAll: wrap('readAll', async (base) => {
      const params = [];
      let off;
      const done = new Promise((resolve, reject) => {
        off = onResp(base, (m) => {
          if (m.cmd === CMD.readAllRsp) params.push({ index: m.index, sub: m.sub, value: m.value });
          if (m.cmd === CMD.readAllComplete) {
            if (m.index !== params.length) reject(new Error(`read count mismatch: device=${m.index} received=${params.length}`));
            else if (crcOfParams(params) !== m.value) reject(new Error('read CRC mismatch'));
            else resolve({ count: params.length, crc: m.value, params });
          }
        });
      });
      try {
        await send(base, frameBytes(CMD.readAll, 0, 0, 0));
        return await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('ReadAll: device not responding')), requestTimeoutMs * tries))]);
      } finally { off(); }
    }),
    apply: wrap('apply', async (base, text, opts = {}) => {
      const e = encodeDev(pickDevice(text, base));
      await request(base, frameBytes(CMD.writeAll, 0, 0, 0), CMD.writeAll);
      for (let i = 0; i < e.params.length; i++) {
        const p = e.params[i];
        await send(base, frameBytes(CMD.writeAllVal, p.index, p.sub, p.value));
        if ((i + 1) % 8 === 0) opts.onProgress?.({ done: i + 1, total: e.params.length });
      }
      const r = await request(base, frameBytes(CMD.writeAllComplete, e.params.length, 0, 0), CMD.writeAllComplete);
      if (r.index !== e.params.length) throw new Error(`write count mismatch: device staged ${r.index} of ${e.params.length}`);
      if (r.value !== e.crc) throw new Error('write CRC mismatch');
      let burned = false;
      if (opts.burn) { await request(base, Uint8Array.of(CMD.burn, 1, 3, 8, 0, 0, 0, 0), CMD.burn, 500, 1); burned = true; }
      return { applied: e.params.length, crc: e.crc, burned };
    }),
    burn: wrap('burn', async (base) => {
      const r = await request(base, Uint8Array.of(CMD.burn, 1, 3, 8, 0, 0, 0, 0), CMD.burn, 500, 1);
      if ((r.value & 0xff) !== 1) throw new Error('burn rejected');
      return {};
    }),
    setParam: wrap('setParam', async (base, name, value, opts = {}) => {
      const d = PARAMS[name];
      if (!d) throw new Error(`unknown param: ${name}`);
      const v = Number(value) >>> 0;
      const r = await request(base, frameBytes(CMD.write, d.index, d.sub, v), CMD.write);
      if (r.value !== v) throw new Error('set: device stored a different value');
      if (opts.burn) await request(base, Uint8Array.of(CMD.burn, 1, 3, 8, 0, 0, 0, 0), CMD.burn, 500, 1);
      return { value: v, index: d.index, sub: d.sub, burned: !!opts.burn };
    }),
    getParam: wrap('getParam', async (base, name) => {
      const d = PARAMS[name];
      if (!d) throw new Error(`unknown param: ${name}`);
      const r = await request(base, frameBytes(CMD.read, d.index, d.sub, 0), CMD.read);
      return { value: r.value, index: d.index, sub: d.sub };
    }),
    encode: (text, base) => { try { const e = encodeDev(pickDevice(text, base)); return { ok: true, ...e }; } catch (e) { return { ok: false, error: e.message }; } },
    devices: (text) => {
      try {
        const cfg = JSON.parse(text);
        return { ok: true, devices: (cfg.PdmDevices || []).map((p) => ({ kind: 'pdm', name: p.name ?? '', baseId: p.baseId, pdmType: p.pdmType ?? 0 })) };
      } catch (e) { return { ok: false, error: 'parse config: ' + e.message }; }
    },
  };
  // Like the real WASM: a board type selects a board (and names it); an unknown type fails.
  const BOARDS = { 0: 'dingoPDM', 1: 'dingoPDM-Max', 2: 'PT-DPDM', 12: 'c6body_v1' };
  if (withParamNames) {
    dingo.paramNames = (type = 0) => (BOARDS[type] === undefined
      ? { ok: false, error: `paramNames: no board with pdmType ${type}` }
      : { ok: true, board: BOARDS[type], pdmType: type, names: Object.keys(PARAMS) });
  }
  return dingo;
}

// api.js — window.api: the surface an AI agent (or the page's own buttons) drives.
//
// One registry (FUNCTIONS below) defines every function: its metadata (summary,
// args, returns, example) AND its implementation. describe() is generated from
// that same table, so the tool list cannot drift from what exists.
//
// Every function is async, never throws, and resolves to plain JSON data:
//   { ok: true, ... }  or  { ok: false, error: "...", hint?: "what to do next" }

import { MAX_ID, hex3, toHex, fmtFilter, ROLE_REFUSED } from './ble.js';

export const API_NAME = 'dingo-web';
export const API_VERSION = '1.1.0';

// ------------------------------------------------------------------ log ----

/** A ring buffer of timestamped lines. log(level, msg); lines(last) → string[]. */
export function createLogger({ max = 500, sink, now = () => new Date() } = {}) {
  const buf = [];
  const listeners = new Set();
  function log(level, msg) {
    const d = now();
    const ts = d.toISOString().slice(11, 23);
    const line = `${ts} ${String(level).toUpperCase().padEnd(5)} ${msg}`;
    buf.push(line);
    if (buf.length > max) buf.splice(0, buf.length - max);
    try { sink?.(level, line); } catch { /* ignore */ }
    for (const cb of listeners) { try { cb(line); } catch { /* ignore */ } }
  }
  return { log, lines: (last = 50) => buf.slice(-Math.max(0, last | 0)), total: () => buf.length, onLine: (cb) => { listeners.add(cb); return () => listeners.delete(cb); } };
}

// -------------------------------------------------------------- helpers ----

class ApiError extends Error {
  constructor(message, hint) { super(message); this.hint = hint; }
}

const errText = (e) => (e?.message ? e.message : String(e));
const baseHex = (b) => '0x' + hex3(b);
/** CRC as a number: the WASM gives an 8-digit hex string ("1A2B3C4D"); fakes may give a number. */
function crcNum(c) {
  if (typeof c === 'number') return c >>> 0;
  if (typeof c === 'string' && /^(0x)?[0-9a-f]{1,8}$/i.test(c.trim())) return parseInt(c.trim().replace(/^0x/i, ''), 16) >>> 0;
  return null;
}
const crcHex = (c) => { const n = crcNum(c); return n === null ? String(c) : '0x' + n.toString(16).toUpperCase().padStart(8, '0'); };

/** JSON-safe deep copy: byte arrays → hex strings, bigint → number, functions dropped. */
export function toPlain(v) {
  return JSON.parse(JSON.stringify(v, (k, x) => {
    if (typeof x === 'bigint') return Number(x);
    if (x instanceof Uint8Array || x instanceof ArrayBuffer || ArrayBuffer.isView(x)) return toHex(x);
    if (x instanceof Error) return x.message;
    if (x instanceof Map) return Object.fromEntries(x);
    if (x instanceof Set) return [...x];
    return x;
  }) ?? 'null');
}

function parseIntish(v, what) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\s*(0x[0-9a-f]+|\d+)\s*$/i.test(v)) return Number(v.trim());
  throw new ApiError(`${what} must be an integer (decimal or "0x.." hex string), got ${JSON.stringify(v)}`);
}

function parseBase(v) {
  if (v === undefined || v === null || v === '') {
    throw new ApiError('base is required', 'pass the PDM base CAN id, e.g. 222 or "0x0DE"; run api.discover() to find it');
  }
  const b = parseIntish(v, 'base');
  if (b < 0 || b > MAX_ID - 1) throw new ApiError(`base ${v} out of range (0..0x7FE; commands go to base+1)`);
  return b;
}

function parseConfig(cfg) {
  if (cfg === undefined || cfg === null || cfg === '') {
    throw new ApiError('config is required', 'pass a dingoConfig object or its JSON text (see skill dingopdm-config)');
  }
  if (typeof cfg === 'string') {
    try { JSON.parse(cfg); } catch (e) { throw new ApiError(`config is not valid JSON: ${errText(e)}`, 'pass the object itself, or JSON.stringify(obj)'); }
    return cfg;
  }
  if (typeof cfg === 'object') return JSON.stringify(cfg);
  throw new ApiError(`config must be an object or JSON text, got ${typeof cfg}`);
}

function parseHexBytes(h) {
  if (Array.isArray(h)) {
    if (h.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) throw new ApiError('data array must hold bytes 0..255');
    return Uint8Array.from(h);
  }
  if (typeof h !== 'string') throw new ApiError('data must be a hex string like "01FF00" (or an array of bytes)');
  const s = h.replace(/^0x/i, '').replace(/[\s:,-]/g, '');
  if (s.length % 2 || !/^[0-9a-f]*$/i.test(s)) throw new ApiError(`data "${h}" is not an even-length hex string`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  if (out.length > 8) throw new ApiError(`data is ${out.length} bytes (max 8)`);
  return out;
}

function clampInt(v, def, lo, hi, what) {
  if (v === undefined || v === null) return def;
  const n = parseIntish(v, what);
  if (n < lo || n > hi) throw new ApiError(`${what} ${n} out of range (${lo}..${hi})`);
  return n;
}

const isPlainObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;

function hintFor(msg, base) {
  const m = msg.toLowerCase();
  // Before the generic connection hints: these are not fixed by retrying.
  if (m.includes(ROLE_REFUSED.toLowerCase())) return "a person must grant this computer the CAN bridge role on the Kindle page (Settings → Bluetooth); retrying from here will not help. Then api.connect()";
  if (m.includes('not granted this page')) return "a person must click the page's \"Choose device…\" button and pick 'hilux' again (Chrome grants the CAN bridge service only on a pick); after that api.connect() works from script";
  if (m.includes('old pairing')) return "ask the person to forget 'hilux' in macOS System Settings → Bluetooth and PAIR again on the Kindle with the CAN bridge role, then click Connect";
  if (m.includes('no remembered') || m.includes('user gesture') || m.includes('chooser')) return "a person must click the page's Connect button once; after that api.connect() works from script";
  if (m.includes('web bluetooth is not available')) return 'open http://localhost:5173 in desktop Chrome; Web Bluetooth needs a secure origin';
  if (m.includes('wasm')) return 'the Go/WASM module is missing or failed to load: check web/dingo.wasm + web/wasm_exec.js exist (web/build.sh) and see api.log()';
  if (m.includes('no response') || m.includes('timed out') || m.includes('timeout') || m.includes('not responding')) {
    return `nothing answered${base !== undefined ? ' at base ' + baseHex(base) : ''}: check the PDM is powered and on the CAN bus, the bitrate matches, and the base id is right (api.discover())`;
  }
  if (m.includes('not connected') || m.includes('link dropped') || m.includes('gatt')) return 'call api.status() to see the connection state, then api.connect(); see api.log() for the BLE events';
  if (m.includes('mismatch')) return 'frames were lost or a value was rejected; retry the operation, and check api.status().stats (rx_dropped / tx_err)';
  return undefined;
}

// -------------------------------------------------------------- the api ----

/**
 * createApi({ bridge, dingo, fetchText, log, opTimeouts? }) → api object.
 *   bridge     from ble.js createBridge()
 *   dingo      the dingo WASM object, or an async loader () => dingo (lazy; may fail)
 *   fetchText  async (url) => string (for skills)
 *   log        a createLogger() object, or a function (level, msg)
 */
export function createApi({ bridge, dingo, fetchText, log, opTimeouts = {}, now = () => Date.now() } = {}) {
  const logger = log && typeof log.lines === 'function' ? log : createLogger({ sink: typeof log === 'function' ? log : undefined });
  const L = (level, msg) => logger.log(level, msg);

  // typeListen: how long apply waits for the node's status frame (every 100 ms) to read its board type.
  const T = { version: 20000, checkCrc: 20000, readAll: 60000, apply: 240000, burn: 20000, setParam: 20000, getParam: 20000, typeListen: 350, ...opTimeouts };

  // ---- state
  let dingoObj = typeof dingo === 'function' ? null : dingo || null;
  const dingoLoader = typeof dingo === 'function' ? dingo : null;
  let dingoError = dingoObj || dingoLoader ? null : 'no dingo WASM module was provided';
  let dingoLoading = null;
  let transportWired = false;
  let busy = null; // { op, since, progress }
  let lastError = null;
  const confirmed = new Map(); // base → version text
  const readCache = new Map(); // base → { at, count, crc, params }
  let skillIndex = null;
  const callListeners = new Set();

  // ---- dingo (WASM)
  async function getDingo() {
    if (dingoObj) return wire(dingoObj);
    if (!dingoLoader) throw new ApiError(`WASM not available: ${dingoError}`);
    if (!dingoLoading) {
      dingoLoading = (async () => {
        try {
          const d = await dingoLoader();
          if (!d || typeof d.encode !== 'function') throw new Error('loader returned no dingo object (globalThis.dingo missing)');
          dingoObj = d; dingoError = null;
          L('info', `wasm loaded${d.info ? ': ' + JSON.stringify(toPlain(d.info)) : ''}`);
          return d;
        } catch (e) {
          dingoError = errText(e);
          L('error', `wasm load failed: ${dingoError}`);
          throw new ApiError(`WASM not available: ${dingoError}`);
        } finally {
          dingoLoading = null;
        }
      })();
    }
    return wire(await dingoLoading);
  }

  function wire(d) {
    if (!transportWired && bridge) {
      d.setTransport({ send: (id, data) => bridge.send(id, data) });
      bridge.onFrame((id, data) => { try { d.pushFrame(id, data); } catch (e) { L('error', 'dingo.pushFrame threw: ' + errText(e)); } });
      transportWired = true;
      L('info', 'wasm transport wired to the BLE bridge');
    }
    return d;
  }

  async function dcall(what, timeoutMs, fn, base) {
    let t;
    const r = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, rej) => { t = setTimeout(() => rej(new ApiError(`${what}: the WASM op did not finish within ${timeoutMs} ms`)), timeoutMs); }),
    ]).finally(() => clearTimeout(t));
    if (!r || typeof r !== 'object') throw new ApiError(`${what}: WASM returned ${JSON.stringify(r)} instead of {ok,...}`);
    if (r.ok === false) throw new ApiError(`${what} failed: ${r.error || 'unknown error'}`, hintFor(String(r.error || ''), base));
    const { ok, ...rest } = r;
    return rest;
  }

  // ---- connection
  async function ensureConnected() {
    if (!bridge) throw new ApiError('no BLE bridge in this page');
    if (bridge.isConnected()) return;
    L('info', 'auto-connecting to the remembered device');
    try {
      await bridge.connect({ allowChooser: false });
    } catch (e) {
      throw new ApiError(`not connected: ${errText(e)}`, hintFor(errText(e)));
    }
  }

  async function forBase(base) {
    await ensureConnected();
    await bridge.setFilter([[base, 0x7ff]]);
  }

  async function probeVersion(d, base) {
    await forBase(base);
    const v = await dcall(`version(${baseHex(base)})`, T.version, () => d.deviceVersion(base), base);
    const text = v.text || `v${v.major}.${v.minor}.${v.build}`;
    confirmed.set(base, text);
    return { major: v.major, minor: v.minor, build: v.build, text };
  }

  /** Writes only go to a base that has answered `version` in this page session. */
  async function ensureConfirmed(d, base) {
    if (confirmed.has(base)) return;
    L('info', `base ${baseHex(base)} not yet confirmed; probing version before writing`);
    try {
      await probeVersion(d, base);
    } catch (e) {
      throw new ApiError(`refusing to write: no dingoPDM answered a version request at base ${baseHex(base)} (${errText(e)})`,
        'run api.discover() to find the PDM base ids on the bus, then retry with a confirmed base');
    }
  }

  // ---- board type
  /**
   * The board type the node at base broadcasts: the high nibble of byte 1 of
   * its first status frame, base+2 (dingoFW boards/<x>/msg.cpp
   * `GetDeviceState() + (PDM_TYPE << 4)`; the C6 body node sends 0xC), sent
   * every 100 ms. Returns as soon as one arrives; { seen:false } after ms.
   */
  async function broadcastType(base, ms) {
    const id = base + 2;
    if (id > MAX_ID) return { seen: false };
    await ensureConnected();
    const prev = bridge.getFilter();
    let done;
    const got = new Promise((r) => { done = r; });
    const off = bridge.onFrame((fid, data) => { if (fid === id && data.length >= 2) done(data); });
    let data = null; let t;
    try {
      await bridge.setFilter([[id, 0x7ff]]);
      data = await Promise.race([got, new Promise((r) => { t = setTimeout(() => r(null), ms); })]);
    } finally {
      clearTimeout(t);
      off();
      try { await bridge.setFilter(prev); } catch (e) { L('warn', `could not restore filter ${fmtFilter(prev)}: ${errText(e)}`); }
    }
    return data ? { seen: true, type: data[1] >> 4, state: data[1] & 0x0f } : { seen: false };
  }

  /** The board name for a broadcast type, from the WASM's own table (null if unknown). */
  async function boardName(d, type) {
    if (typeof d.paramNames !== 'function') return null;
    try { const r = await d.paramNames(type); return r?.ok ? (r.board ?? null) : null; } catch { return null; }
  }

  // ---- listening
  async function capture(ms, ids) {
    await ensureConnected();
    const prev = bridge.getFilter();
    const entries = ids ? ids.map((id) => [id, 0x7ff]) : [[0, 0]];
    const seen = new Map();
    let total = 0;
    let statsBefore = null;
    try { statsBefore = await bridge.stats(); } catch { /* stats are best effort */ }
    const off = bridge.onFrame((id, data) => {
      total++;
      const s = seen.get(id) || { count: 0, first: data, last: null };
      s.count++; s.last = data;
      seen.set(id, s);
    });
    const t0 = now();
    try {
      await bridge.setFilter(entries);
      await new Promise((r) => setTimeout(r, ms));
    } finally {
      off();
      try { await bridge.setFilter(prev); } catch (e) { L('warn', `could not restore filter ${fmtFilter(prev)}: ${errText(e)}`); }
    }
    const elapsed = Math.max(1, now() - t0);
    let statsAfter = null;
    try { statsAfter = await bridge.stats(); } catch { /* best effort */ }
    const list = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([id, s]) => ({
      id, idHex: '0x' + hex3(id), count: s.count, hz: Math.round((s.count * 10000) / elapsed) / 10, dlc: s.last.length, lastHex: toHex(s.last),
      varies: toHex(s.first) !== toHex(s.last), // for discover only (listen leaves it out)
    }));
    const bridgeDropped = statsBefore && statsAfter ? statsAfter.rx_dropped - statsBefore.rx_dropped : null;
    return { total, list, elapsed, bridgeDropped, restoredFilter: prev };
  }

  // Board types to accept when the WASM has no paramNames() to name them: 0-2 the PDMs, 12 the C6.
  const FALLBACK_TYPES = { 0: 'dingoPDM', 1: 'dingoPDM-Max', 2: 'PT-DPDM', 12: 'c6body_v1' };

  /** The board a broadcast type names, or null if it names none (an unknown type). */
  async function knownBoard(d, type) {
    if (typeof d.paramNames !== 'function') return FALLBACK_TYPES[type] ?? null;
    return boardName(d, type);
  }

  // dingoFW sends its cyclic status every CAN_TX_CYCLIC_MSG_DELAY = 100 ms
  // (core/device_config.h). A frame is taken as one only between these rates,
  // with one frame of slack either way for where the listen window cuts.
  const STATUS_HZ_MIN = 7;
  const STATUS_HZ_MAX = 14;
  const DEVICE_STATES = 4; // byte 1 low nibble: DeviceState Run, Sleep, OverTemp, Error (core/enums.h)

  /**
   * Node bases from captured traffic. Version requests go to base+1 of a live
   * bus, so only strong evidence makes a candidate. A dingoFW node (any PDM, the
   * C6 body node) answers on base, takes requests on base+1 (never on the bus
   * unless someone sends one) and sends its status on base+2 every 100 ms:
   * 8 bytes, byte 1 = DeviceState (0-3) + board type << 4 (boards/<x>/msg.cpp
   * TxMsg0). More status ids may follow (a PDM ~27, the C6 1-3).
   *
   * Shape: an 8-byte id whose predecessor was not seen and whose byte 1 names a
   * known board and a valid state. Shape alone is not enough (the C6's 1 Hz
   * presence heartbeat 0x401 `C6 00 …` has it), so a shaped frame must also run
   * at ~10 Hz, or it is returned in `ignored` and never probed. Byte 7 is not
   * checked: it is the C6's heartbeat counter, but on a PDM it is the board
   * temperature's high byte (constant).
   * → { candidates (longest status run first), ignored }
   */
  async function statusCandidates(d, list, minRun, ms) {
    const byId = new Map(list.map((x) => [x.id, x]));
    const candidates = []; const ignored = [];
    for (const x of list) {
      if (x.dlc !== 8 || x.id < 2 || byId.has(x.id - 1)) continue;
      const b1 = parseInt(x.lastHex.slice(2, 4), 16);
      const type = b1 >> 4;
      const board = await knownBoard(d, type);
      if (board === null || (b1 & 0x0f) >= DEVICE_STATES) continue;
      const loHz = Math.max(0, x.count - 1) * 1000 / ms;
      const hiHz = (x.count + 1) * 1000 / ms;
      const c = { base: x.id - 2, baseHex: baseHex(x.id - 2), statusId: x.id, type, board, hz: x.hz };
      if (hiHz < STATUS_HZ_MIN || loHz > STATUS_HZ_MAX) {
        ignored.push({ ...c, reason: `not a dingo status frame: ${x.hz} Hz (status is 10 Hz), ${x.varies ? 'changing' : 'constant'}; not probed` });
        continue;
      }
      let len = 1;
      while (byId.has(x.id + len)) len++;
      if (len < minRun) continue;
      candidates.push({ ...c, runStart: x.id, runLength: len });
    }
    candidates.sort((a, b) => b.runLength - a.runLength || a.base - b.base);
    return { candidates, ignored };
  }

  // ---- skills
  async function loadSkillIndex(refresh) {
    if (skillIndex && !refresh) return skillIndex;
    if (!fetchText) throw new ApiError('no fetchText provided; skills unavailable');
    let txt;
    try { txt = await fetchText('./skills/index.json'); } catch (e) {
      throw new ApiError(`could not load skills/index.json: ${errText(e)}`, 'run web/sync-skills.sh in the container to (re)generate web/skills/');
    }
    try { skillIndex = JSON.parse(txt); } catch (e) { throw new ApiError(`skills/index.json is not valid JSON: ${errText(e)}`); }
    return skillIndex;
  }

  // ---- results helpers
  function paged(arr, offset, limit) {
    const slice = arr.slice(offset, offset + limit);
    return { total: arr.length, offset, limit, returned: slice.length, nextOffset: offset + slice.length < arr.length ? offset + slice.length : null, items: slice };
  }

  // =================================================================== registry
  // kind: 'info' (never locked), 'device' (serialised, adds elapsedMs), 'pure' (no hardware)
  const BASE_ARG = { name: 'base', type: 'integer | "0x.." string', required: true, description: 'node base CAN id (dingoPDM factory default 222 = 0x0DE; the C6 body node 1280 = 0x500). Commands go to base+1, replies come from base+0.' };
  const PDMTYPE_OPT = { name: 'opts.pdmType', type: 'integer', required: false, description: "the node's board type, whose parameter names and var map the name and value resolve against: 0 dingoPDM (default), 1 dingoPDM-Max, 2 PT-DPDM, 12 c6body_v1 (the C6 body node: pass 12, or a var name like 'CanIn1Out' resolves to the PDM's index)" };
  const CONFIG_ARG = { name: 'config', type: 'object | JSON string', required: true, description: 'a dingoConfig file (top-level PdmDevices[] etc.; see skill dingopdm-config)' };

  const FUNCTIONS = [
    {
      name: 'describe', kind: 'info',
      summary: 'This tool list: every function with its args, return shape and an example; plus the workflow, the skills and notes. Call it first.',
      args: [],
      returns: '{ ok, name, version, summary, workflow: string[], functions: [{ name, summary, args: [{name,type,required,description}], returns, example }], skills: [{name, description}], notes: string[] }',
      example: 'await api.describe()',
      run: async () => describe(),
    },
    {
      name: 'status', kind: 'info',
      summary: 'Connection state, device, WASM status, the op running now (with progress), last error, bridge filter and bridge counters.',
      args: [],
      returns: '{ ok, connection: {state, deviceName, deviceId, bluetoothAvailable, lastError, reconnects, txQueued, counters}, filter: [{id,idHex,mask,maskHex}], stats: {tx_ok,tx_err,rx_forwarded,rx_dropped}|null, wasm: {loaded, error, info}, busy: {op, sinceMs, progress}|null, confirmedBases: [{base,baseHex,version}], lastError }',
      example: 'await api.status()',
      run: async () => {
        const conn = bridge ? bridge.info() : { state: 'unavailable', bluetoothAvailable: false };
        let stats = null; let statsError;
        if (bridge?.isConnected()) { try { stats = await bridge.stats(); } catch (e) { statsError = errText(e); } }
        return {
          ok: true,
          connection: { ...conn, filter: undefined },
          filter: (conn.filter || []).map(fmtEntry),
          stats, ...(statsError ? { statsError } : {}),
          wasm: { loaded: !!dingoObj, error: dingoError, info: dingoObj?.info ?? null },
          busy: busy ? { op: busy.op, sinceMs: now() - busy.since, progress: busy.progress ?? null } : null,
          confirmedBases: [...confirmed].map(([b, v]) => ({ base: b, baseHex: baseHex(b), version: v })),
          lastError,
        };
      },
    },
    {
      name: 'connect', kind: 'info',
      summary: "Connect to the remembered 'hilux' C6 bridge (no chooser from script; takes ~1-5 s). Device ops auto-connect, so this is optional. Fails with \"This computer isn't allowed to use the CAN bridge…\" when the C6 has not given this computer the CAN bridge role (granted on the Kindle).",
      args: [],
      returns: '{ ok, state, deviceName, deviceId, already }',
      example: 'await api.connect()',
      run: async () => connectImpl(false),
    },
    {
      name: 'disconnect', kind: 'info',
      summary: 'Disconnect from the bridge (no auto-reconnect afterwards).',
      args: [],
      returns: '{ ok, state }',
      example: 'await api.disconnect()',
      run: async () => { await bridge.disconnect(); confirmed.clear(); return { ok: true, state: bridge.info().state }; },
    },
    {
      name: 'listen', kind: 'device',
      summary: 'Passive bus monitor (like `dingo listen`): forward all frames (or only `ids`) for `ms`, then report each distinct id with count, rate and last payload. Restores the previous filter.',
      args: [
        { name: 'opts.ms', type: 'integer', required: false, description: 'capture time in ms (default 1500, max 30000)' },
        { name: 'opts.ids', type: 'integer[]', required: false, description: 'only these CAN ids (max 8); default: everything' },
        { name: 'opts.max', type: 'integer', required: false, description: 'max ids listed (default 64)' },
      ],
      returns: '{ ok, ms, totalFrames, distinctIds, truncated, bridgeRxDropped, ids: [{ id, idHex, count, hz, dlc, lastHex }], elapsedMs }',
      example: 'await api.listen({ ms: 2000 })',
      run: async (opts = {}) => {
        const ms = clampInt(opts.ms, 1500, 50, 30000, 'ms');
        const max = clampInt(opts.max, 64, 1, 2048, 'max');
        let ids;
        if (opts.ids !== undefined) {
          if (!Array.isArray(opts.ids) || !opts.ids.length || opts.ids.length > 8) throw new ApiError('ids must be an array of 1..8 CAN ids');
          ids = opts.ids.map((x) => { const n = parseIntish(x, 'id'); if (n > MAX_ID) throw new ApiError(`id ${x} > 0x7FF`); return n; });
        }
        const c = await capture(ms, ids);
        return { ok: true, ms, totalFrames: c.total, distinctIds: c.list.length, truncated: c.list.length > max, bridgeRxDropped: c.bridgeDropped, ids: c.list.slice(0, max).map(({ varies, ...x }) => x) };
      },
    },
    {
      name: 'discover', kind: 'device',
      summary: "Find every dingoFW node on the bus (dingoPDMs and the C6 body node): listen, take each node's status frame (base+2: 8 bytes, byte 1 = board type << 4 + state 0-3, sent at 10 Hz, base+1 silent) as a candidate base, and confirm each by asking for its firmware version. Frames of that shape at another rate are listed in `ignored` and never sent anything. Only confirmed bases are safe to write; with several nodes, ask which one to change.",
      args: [
        { name: 'opts.ms', type: 'integer', required: false, description: 'listen time in ms (default 1500)' },
        { name: 'opts.bases', type: 'integer[]', required: false, description: 'skip listening and probe exactly these bases, with no evidence check (a version request goes to each base+1: only bases you know are dingo nodes); board type read from their status frame' },
        { name: 'opts.minRun', type: 'integer', required: false, description: 'min consecutive status ids from base+2 to count as a candidate (default 1; a PDM sends ~27, the C6 1-3)' },
        { name: 'opts.maxProbes', type: 'integer', required: false, description: 'max candidates to probe (default 6; an absent base costs ~6 s)' },
      ],
      returns: '{ ok, nodes: [{ base, baseHex, version, type, board }], pdms: (same as nodes; older name), unconfirmed: [{ base, baseHex, type, board, reason }], ignored: [{ base, baseHex, statusId, type, board, hz, reason }] (status-shaped but not 10 Hz: not probed), idsSeen: number, candidates: [{base, baseHex, statusId, type, board, hz, runStart, runLength}], elapsedMs }',
      example: 'await api.discover()',
      run: async (opts = {}) => {
        const d = await getDingo();
        let cands;
        let ignored = [];
        let idsSeen = null;
        if (opts.bases !== undefined) {
          if (!Array.isArray(opts.bases) || !opts.bases.length) throw new ApiError('bases must be a non-empty array');
          cands = opts.bases.map((b) => ({ base: parseBase(b), statusId: null, type: null, board: null, hz: null, runStart: null, runLength: null }));
        } else {
          const ms = clampInt(opts.ms, 1500, 100, 30000, 'ms');
          const minRun = clampInt(opts.minRun, 1, 1, 64, 'minRun');
          const c = await capture(ms);
          idsSeen = c.list.length;
          if (!c.total) {
            throw new ApiError(`no CAN frames at all in ${ms} ms`, 'the bridge is connected but the bus is silent: is the PDM powered and wired to the C6 CAN bus? (api.status().stats shows bridge counters)');
          }
          ({ candidates: cands, ignored } = await statusCandidates(d, c.list, minRun, ms));
        }
        const maxProbes = clampInt(opts.maxProbes, 6, 1, 32, 'maxProbes');
        const nodes = []; const unconfirmed = [];
        for (const c of cands.slice(0, maxProbes)) {
          busy && (busy.progress = { probing: baseHex(c.base) });
          try {
            const v = await probeVersion(d, c.base);
            if (c.type === null) {
              const ty = await broadcastType(c.base, T.typeListen);
              if (ty.seen) { c.type = ty.type; c.board = await knownBoard(d, ty.type); }
            }
            nodes.push({ base: c.base, baseHex: baseHex(c.base), version: v.text, type: c.type, board: c.board });
          } catch (e) {
            unconfirmed.push({ base: c.base, baseHex: baseHex(c.base), type: c.type, board: c.board, reason: errText(e) });
          }
        }
        for (const c of cands.slice(maxProbes)) unconfirmed.push({ base: c.base, baseHex: baseHex(c.base), type: c.type, board: c.board, reason: 'not probed (maxProbes)' });
        nodes.sort((a, b) => a.base - b.base);
        const out = { ok: true, nodes, pdms: nodes, unconfirmed, ignored, idsSeen, candidates: cands.map((c) => ({ ...c, baseHex: baseHex(c.base) })) };
        if (!nodes.length) out.hint = cands.length ? 'no candidate answered a version request; try api.listen() to see raw traffic, or api.discover({ bases: [0x500] })' : 'no 10 Hz status frame (8 bytes, a board type and state in byte 1) whose base+1 was silent; try api.listen(), then api.discover({ bases: [B] }) for a base you know';
        return out;
      },
    },
    {
      name: 'version', kind: 'device',
      summary: 'Read the firmware version of the PDM at base (like `dingo version`). A success also marks the base as confirmed for writes.',
      args: [BASE_ARG],
      returns: '{ ok, base, baseHex, major, minor, build, text, elapsedMs }',
      example: 'await api.version(222)',
      run: async (base) => {
        const b = parseBase(base); const d = await getDingo();
        return { ok: true, base: b, baseHex: baseHex(b), ...(await probeVersion(d, b)) };
      },
    },
    {
      name: 'verify', kind: 'device',
      summary: "Read the device's live-config CRC (like `dingo verify`). With a config, also encode it and report whether the device holds exactly that config.",
      args: [BASE_ARG, { ...CONFIG_ARG, required: false, description: 'optional dingoConfig to compare against (non-partial apply semantics)' }],
      returns: "{ ok, base, baseHex, crc, crcHex, expected?: { crc, crcHex, count }, matches?: boolean, warning?: (the config's baseId is not base), elapsedMs }",
      example: 'await api.verify(222, cfg)',
      run: async (base, config) => {
        const b = parseBase(base); const d = await getDingo();
        let expected;
        if (config !== undefined && config !== null) {
          const e = await dcall('encode', 10000, () => d.encode(parseConfig(config), b), b);
          expected = { crc: crcNum(e.crc), crcHex: crcHex(e.crc), count: e.count };
          if (Number.isInteger(e.baseId) && e.baseId !== b) expected.baseId = e.baseId;
        }
        await forBase(b);
        const r = await dcall(`checkCrc(${baseHex(b)})`, T.checkCrc, () => d.checkCrc(b), b);
        const out = { ok: true, base: b, baseHex: baseHex(b), crc: crcNum(r.crc), crcHex: crcHex(r.crc) };
        if (expected?.baseId !== undefined) {
          out.warning = `the config's PDM has baseId ${expected.baseId} (${baseHex(expected.baseId)}), not ${b} (${baseHex(b)}): it is a config for another node, so matches says little`;
          delete expected.baseId;
        }
        if (expected) {
          out.expected = expected;
          out.matches = crcNum(r.crc) === expected.crc;
          if (!out.matches) out.hint = 'the device does not hold this config (or it was applied with partial:true); api.apply(base, config) to write it';
        }
        return out;
      },
    },
    {
      name: 'readParams', kind: 'device',
      summary: 'Read every parameter from the device (count + CRC checked), returned a page at a time. offset 0 (or refresh) re-reads the device; later pages come from that read.',
      args: [BASE_ARG,
        { name: 'opts.offset', type: 'integer', required: false, description: 'first param to return (default 0)' },
        { name: 'opts.limit', type: 'integer', required: false, description: 'params per page (default 100, max 1000)' },
        { name: 'opts.refresh', type: 'boolean', required: false, description: 're-read the device even when paging' }],
      returns: '{ ok, base, baseHex, count, crc, crcHex, fromCache, offset, limit, returned, nextOffset|null, params: [{ index, indexHex, sub, value }], elapsedMs }',
      example: 'await api.readParams(222, { offset: 0, limit: 100 })',
      run: async (base, opts = {}) => {
        const b = parseBase(base);
        const offset = clampInt(opts.offset, 0, 0, 1e6, 'offset');
        const limit = clampInt(opts.limit, 100, 1, 1000, 'limit');
        let cached = readCache.get(b);
        const fromCache = !!cached && offset > 0 && !opts.refresh;
        if (!fromCache) {
          const d = await getDingo();
          await forBase(b);
          const r = await dcall(`readAll(${baseHex(b)})`, T.readAll, () => d.readAll(b), b);
          cached = { count: r.count, crc: crcNum(r.crc), params: (r.params || []).map((p) => ({ index: p.index, indexHex: '0x' + p.index.toString(16).toUpperCase().padStart(4, '0'), sub: p.sub ?? p.subIndex, value: p.value })) };
          readCache.set(b, cached);
        }
        const pg = paged(cached.params, offset, limit);
        return { ok: true, base: b, baseHex: baseHex(b), count: cached.count, crc: cached.crc, crcHex: crcHex(cached.crc), fromCache, offset, limit, returned: pg.returned, nextOffset: pg.nextOffset, params: pg.items };
      },
    },
    {
      name: 'encode', kind: 'pure',
      summary: 'Dry run, no hardware: turn a config into device parameters for base (default: the first PDM in the file) and report count + CRC. Always do this before apply.',
      args: [CONFIG_ARG,
        { name: 'base', type: 'integer | "0x.." string', required: false, description: 'which PdmDevices[].baseId to encode (default: first PDM)' },
        { name: 'opts.params', type: 'boolean', required: false, description: 'include the encoded params (paged)' },
        { name: 'opts.offset', type: 'integer', required: false, description: 'param page start (default 0)' },
        { name: 'opts.limit', type: 'integer', required: false, description: 'param page size (default 100)' }],
      returns: '{ ok, name, pdmType, baseId, baseHex, count, crc, crcHex, params?: [{index, sub, value}], nextOffset?, elapsedMs }',
      example: 'await api.encode(cfg, 222)',
      run: async (config, base, opts = {}) => {
        const txt = parseConfig(config);
        const b = base === undefined || base === null ? undefined : parseBase(base);
        const d = await getDingo();
        const r = await dcall('encode', 10000, () => (b === undefined ? d.encode(txt) : d.encode(txt, b)), b);
        const out = { ok: true, name: r.name, pdmType: r.pdmType, baseId: r.baseId ?? null, baseHex: Number.isInteger(r.baseId) ? baseHex(r.baseId) : null, board: r.board ?? null, count: r.count, crc: crcNum(r.crc), crcHex: crcHex(r.crc), ...(r.warning ? { warning: r.warning } : {}) };
        if (opts.params) {
          const pg = paged(r.params || [], clampInt(opts.offset, 0, 0, 1e6, 'offset'), clampInt(opts.limit, 100, 1, 1000, 'limit'));
          out.params = pg.items; out.offset = pg.offset; out.nextOffset = pg.nextOffset;
        }
        return out;
      },
    },
    {
      name: 'devices', kind: 'pure',
      summary: 'List the devices in a config file (kind, name, baseId, pdmType). No hardware.',
      args: [CONFIG_ARG],
      returns: '{ ok, devices: [{ kind, name, baseId, baseHex, pdmType }] }',
      example: 'await api.devices(cfg)',
      run: async (config) => {
        const txt = parseConfig(config); const d = await getDingo();
        const r = await dcall('devices', 10000, () => d.devices(txt));
        return { ok: true, devices: (r.devices || []).map((x) => ({ ...x, baseHex: Number.isInteger(x.baseId) ? baseHex(x.baseId) : null })) };
      },
    },
    {
      name: 'graph', kind: 'pure', quiet: true,
      summary: "The config's function logic as a node graph (what the page's Logic view draws): one node per enabled function (plus the device node, and dimmed disabled functions an input still uses), one edge per function input wired to another function's variable. No hardware.",
      args: [CONFIG_ARG, { name: 'base', type: 'integer | "0x.." string', required: false, description: 'which PdmDevices[].baseId (default: the file\'s only PDM)' }],
      returns: "{ ok, board, pdmType, name, baseId, graph: { nodes: [{ id ('device', '<kind>-<n>' e.g. 'flasher-1'), category, label, subtitle, x, y, enabled, deletable, inputs: [{ id: 'in:<field>', label, dataTypes, connected }], outputs: [{ id: 'out:<varIndex>', label, dataTypes, var, connected }] }], edges: [{ id, source, sourceHandle, target, targetHandle, var }] }, slots: [{ id, kind, type, label, name, enabled, onCanvas, references }] }",
      example: 'await api.graph(cfg)',
      run: async (config, base) => {
        const txt = parseConfig(config); const b = base === undefined || base === null ? undefined : parseBase(base);
        const d = await getDingo();
        if (typeof d.graph !== 'function') throw new ApiError('this WASM build has no graph(); rebuild it (web/build.sh)');
        return { ok: true, ...(await dcall('graph', 10000, () => d.graph(txt, b))) };
      },
    },
    {
      name: 'graphEdit', kind: 'pure', quiet: true,
      summary: "Apply one logic-graph edit to a config and return the new config text (no hardware). connect sets the target function input to the source's var-map index (data types must match: bool/int/float); delete clears wires and disables functions (and disconnects their users); move stores node positions in the device's flowLayout (dingoConfig's field; does not change the CRC). Returns the new count + CRC, as encode would.",
      args: [CONFIG_ARG,
        { name: 'edit', type: 'object', required: true, description: "one of { op:'connect', sourceHandle:'out:<var>', target:'<nodeId>', targetHandle:'in:<field>' } | { op:'disconnect', target, targetHandle } | { op:'delete', nodeIds:[], edges:[{target,targetHandle}] } | { op:'move', moves:[{id,x,y}] } | { op:'add', id, x?, y? } (enable a function) | { op:'remove', id } | { op:'set', id, field, value } (a property; see graphNode)" },
        { name: 'base', type: 'integer | "0x.." string', required: false, description: 'which PdmDevices[].baseId (default: the only PDM)' }],
      returns: '{ ok, config (the new JSON text), changed, count, crc, crcHex, board, name, baseId, graph, slots }',
      example: "await api.graphEdit(cfg, { op: 'connect', sourceHandle: 'out:27', target: 'virtualInput-1', targetHandle: 'in:var2' })",
      run: async (config, edit, base) => {
        const txt = parseConfig(config); const b = base === undefined || base === null ? undefined : parseBase(base);
        if (!isPlainObject(edit) && typeof edit !== 'string') throw new ApiError("edit must be an object such as { op: 'connect', sourceHandle, target, targetHandle }");
        const d = await getDingo();
        if (typeof d.graphEdit !== 'function') throw new ApiError('this WASM build has no graphEdit(); rebuild it (web/build.sh)');
        const r = await dcall('graphEdit', 10000, () => d.graphEdit(txt, edit, b));
        return { ok: true, ...r, crc: crcNum(r.crc), crcHex: crcHex(r.crc) };
      },
    },
    {
      name: 'graphNode', kind: 'pure', quiet: true,
      summary: "One function's properties (the Logic view's properties panel): its scalar firmware parameters with type, range, enum names and current value. Change one with graphEdit({ op:'set', id, field, value }). Inputs are not listed: they are the graph's wires.",
      args: [CONFIG_ARG, { name: 'id', type: 'string', required: true, description: "node id, e.g. 'canOutput-1'" },
        { name: 'base', type: 'integer | "0x.." string', required: false, description: 'which PdmDevices[].baseId (default: the only PDM)' }],
      returns: '{ ok, id, kind, label, name, enabled, fields: [{ field, param, type, enum?, values?, min, max, default, value, present }], missing? }',
      example: "await api.graphNode(cfg, 'canOutput-1')",
      run: async (config, id, base) => {
        const txt = parseConfig(config); const b = base === undefined || base === null ? undefined : parseBase(base);
        if (typeof id !== 'string' || !id) throw new ApiError("id must be a node id such as 'canOutput-1'");
        const d = await getDingo();
        if (typeof d.graphNode !== 'function') throw new ApiError('this WASM build has no graphNode(); rebuild it (web/build.sh)');
        return { ok: true, ...(await dcall('graphNode', 10000, () => d.graphNode(txt, id, b))) };
      },
    },
    {
      name: 'apply', kind: 'device',
      summary: 'Write a config to the PDM at base (like `dingo apply`): every param (absent fields reset to firmware defaults) or with partial only the fields the file sets; count + CRC verified. Live only unless burn:true. The base must answer `version` first, and the board type the node broadcasts must equal the config pdmType (both checked automatically).',
      args: [BASE_ARG, CONFIG_ARG,
        { name: 'opts.burn', type: 'boolean', required: false, description: 'also persist to flash (default false — only when the user asked)' },
        { name: 'opts.partial', type: 'boolean', required: false, description: 'write only fields present in the file (default false)' },
        { name: 'opts.allowBaseChange', type: 'boolean', required: false, description: "allow a config whose PDM baseId differs from base (rewrites the device's base id; default false = refused)" },
        { name: 'opts.allowTypeMismatch', type: 'boolean', required: false, description: 'apply even if the board type the node broadcasts (status frame base+2) differs from the config pdmType (default false = refused)' }],
      returns: '{ ok, base, baseHex, applied, crc, crcHex, burned, partial, board, typeCheck: { seen, configType, configBoard, deviceType?, deviceBoard?, matches? }, warning?, elapsedMs }',
      example: 'await api.apply(222, cfg)',
      run: async (base, config, opts = {}) => {
        const b = parseBase(base); const txt = parseConfig(config); const d = await getDingo();
        // Dry-run first: the WASM (like the CLI) applies a single-PDM file whatever
        // base is passed, which would rewrite the device's baseId. Refuse that unless asked.
        const enc = await dcall('encode', 10000, () => d.encode(txt, b), b);
        if (enc.baseId !== b && !opts.allowBaseChange) {
          throw new ApiError(`refusing to apply: the config's PDM has baseId ${enc.baseId === null || enc.baseId === undefined ? '(none)' : enc.baseId + ' (' + baseHex(enc.baseId) + ')'} but you targeted ${b} (${baseHex(b)}); applying would change the device's base id`,
            `set PdmDevices[].baseId to ${b} in the config, or pass { allowBaseChange: true } if changing the base id is intended`);
        }
        await ensureConnected();
        await ensureConfirmed(d, b);
        // The node's broadcast board type must match the config's pdmType: a
        // config for another board writes a different parameter table.
        const ty = await broadcastType(b, T.typeListen);
        const typeCheck = { seen: ty.seen, configType: enc.pdmType ?? null, configBoard: enc.board ?? null };
        if (ty.seen) {
          typeCheck.deviceType = ty.type;
          typeCheck.deviceBoard = await boardName(d, ty.type);
          typeCheck.matches = ty.type === enc.pdmType;
          if (!typeCheck.matches && !opts.allowTypeMismatch) {
            throw new ApiError(`refusing to apply: the node at base ${baseHex(b)} broadcasts board type ${ty.type}${typeCheck.deviceBoard ? ' (' + typeCheck.deviceBoard + ')' : ''} but the config is for ${enc.board ?? 'another board'} (pdmType ${enc.pdmType})`,
              "wrong base id or wrong config: check api.discover()/api.version() and the config's pdmType; pass { allowTypeMismatch: true } only if this node is known to broadcast the wrong type");
          }
        } else {
          L('warn', `no status frame on ${baseHex(b + 2)} within ${T.typeListen} ms; board type not checked`);
        }
        await forBase(b);
        readCache.delete(b);
        const o = { burn: !!opts.burn, partial: !!opts.partial, onProgress: (...a) => { if (busy) busy.progress = toPlain(a.length === 1 ? a[0] : a); } };
        const r = await dcall(`apply(${baseHex(b)})`, T.apply, () => d.apply(b, txt, o), b);
        L('info', `applied ${r.applied} params to ${baseHex(b)} crc ${crcHex(r.crc)}${r.burned ? ' + burned' : ''}`);
        return { ok: true, base: b, baseHex: baseHex(b), applied: r.applied, crc: crcNum(r.crc), crcHex: crcHex(r.crc), burned: !!r.burned, partial: !!opts.partial, board: r.board ?? null, typeCheck, ...(r.warning ? { warning: r.warning } : {}) };
      },
    },
    {
      name: 'burn', kind: 'device',
      summary: "Persist the PDM's live config to flash (like `dingo burn`). Only when the user asked; verify first.",
      args: [BASE_ARG],
      returns: '{ ok, base, baseHex, burned: true, elapsedMs }',
      example: 'await api.burn(222)',
      run: async (base) => {
        const b = parseBase(base); const d = await getDingo();
        await ensureConnected();
        await ensureConfirmed(d, b);
        await forBase(b);
        const r = await dcall(`burn(${baseHex(b)})`, T.burn, () => d.burn(b), b);
        return { ok: true, base: b, baseHex: baseHex(b), burned: true, ...r };
      },
    },
    {
      name: 'setParam', kind: 'device',
      summary: 'Write one parameter by name to the live config (like `dingo set <name> <value>`); device echo verified.',
      args: [BASE_ARG,
        { name: 'name', type: 'string', required: true, description: 'parameter name (see api.paramNames())' },
        { name: 'value', type: 'number | string | boolean', required: true, description: 'value in engineering units' },
        { name: 'opts.burn', type: 'boolean', required: false, description: 'also persist to flash' },
        PDMTYPE_OPT],
      returns: '{ ok, base, baseHex, name, ...wasm result fields, elapsedMs }',
      example: "await api.setParam(222, 'output[0].currentLimit', 10)",
      run: async (base, name, value, opts = {}) => {
        const b = parseBase(base);
        if (typeof name !== 'string' || !name) throw new ApiError('name must be a parameter name string', 'see api.paramNames()');
        if (value === undefined || value === null) throw new ApiError('value is required');
        const d = await getDingo();
        await ensureConnected();
        await ensureConfirmed(d, b);
        await forBase(b);
        readCache.delete(b);
        const o = { burn: !!opts.burn, ...(opts.pdmType !== undefined ? { pdmType: parseIntish(opts.pdmType, 'pdmType') } : {}) };
        const r = await dcall(`setParam(${name})`, T.setParam, () => d.setParam(b, name, value, o), b);
        return { ok: true, base: b, baseHex: baseHex(b), name, ...r };
      },
    },
    {
      name: 'getParam', kind: 'device',
      summary: 'Read one parameter by name (like `dingo getn -name`).',
      args: [BASE_ARG, { name: 'name', type: 'string', required: true, description: 'parameter name' }, PDMTYPE_OPT],
      returns: '{ ok, base, baseHex, name, ...wasm result fields (value etc.), elapsedMs }',
      example: "await api.getParam(222, 'output[0].currentLimit')",
      run: async (base, name, opts = {}) => {
        const b = parseBase(base);
        if (typeof name !== 'string' || !name) throw new ApiError('name must be a parameter name string', 'see api.paramNames()');
        const d = await getDingo();
        await forBase(b);
        const r = await dcall(`getParam(${name})`, T.getParam, () => (opts.pdmType === undefined ? d.getParam(b, name) : d.getParam(b, name, { pdmType: parseIntish(opts.pdmType, 'pdmType') })), b);
        return { ok: true, base: b, baseHex: baseHex(b), name, ...r };
      },
    },
    {
      name: 'paramNames', kind: 'pure',
      summary: 'Parameter names accepted by setParam/getParam (paged, optional substring filter). Needs a WASM build that exports paramNames.',
      args: [{ name: 'opts.filter', type: 'string', required: false, description: 'case-insensitive substring' },
        { name: 'opts.pdmType', type: 'integer', required: false, description: 'board type (pdmType): 0 dingoPDM (default), 1 dingoPDM-Max, 2 PT-DPDM, 12 c6body_v1 (the C6 body node)' },
        { name: 'opts.offset', type: 'integer', required: false, description: 'page start (default 0)' },
        { name: 'opts.limit', type: 'integer', required: false, description: 'page size (default 200)' }],
      returns: '{ ok, total, offset, nextOffset|null, names: string[] }',
      example: "await api.paramNames({ filter: 'output[0]' })",
      run: async (opts = {}) => {
        const d = await getDingo();
        if (typeof d.paramNames !== 'function') throw new ApiError('this WASM build does not export paramNames()');
        const r = await dcall('paramNames', 10000, () => (opts.pdmType === undefined ? d.paramNames() : d.paramNames(opts.pdmType)));
        let names = (r.names || r.params || []).map((n) => (typeof n === 'string' ? n : n.name));
        if (opts.filter) { const f = String(opts.filter).toLowerCase(); names = names.filter((n) => n.toLowerCase().includes(f)); }
        const pg = paged(names, clampInt(opts.offset, 0, 0, 1e6, 'offset'), clampInt(opts.limit, 200, 1, 5000, 'limit'));
        return { ok: true, total: pg.total, offset: pg.offset, nextOffset: pg.nextOffset, names: pg.items };
      },
    },
    {
      name: 'sendFrame', kind: 'device',
      summary: 'Low-level: transmit one raw CAN frame through the bridge (like `dingo tx`). DLC = number of bytes given.',
      args: [{ name: 'id', type: 'integer | "0x.." string', required: true, description: '11-bit CAN id (0..0x7FF)' },
        { name: 'data', type: 'hex string | byte[]', required: true, description: 'payload, 0..8 bytes, e.g. "0100000000000000"' }],
      returns: '{ ok, id, idHex, dlc, dataHex, elapsedMs }',
      example: "await api.sendFrame(0x643, '01000000')",
      run: async (id, data) => {
        const n = parseIntish(id, 'id');
        if (n < 0 || n > MAX_ID) throw new ApiError(`id ${id} is not an 11-bit CAN id (0..0x7FF)`);
        const bytes = parseHexBytes(data ?? '');
        await ensureConnected();
        await bridge.send(n, bytes);
        return { ok: true, id: n, idHex: '0x' + hex3(n), dlc: bytes.length, dataHex: toHex(bytes) };
      },
    },
    {
      name: 'filter', kind: 'device',
      summary: 'Low-level: get (no args) or set the bridge rx filter. Entries are [id, mask] pairs (max 8); [[0,0]] forwards everything, [] nothing. Device ops overwrite it with [[base, 0x7FF]].',
      args: [{ name: 'entries', type: '[id, mask][] | {id, mask}[]', required: false, description: 'omit to read the current filter' }],
      returns: '{ ok, filter: [{ id, idHex, mask, maskHex }], device?: [...] (what the C6 reports), text }',
      example: 'await api.filter([[0x642, 0x7FF]])',
      run: async (entries) => {
        await ensureConnected();
        if (entries !== undefined) {
          let norm;
          try { norm = entries.map((e) => (Array.isArray(e) ? [parseIntish(e[0], 'id'), parseIntish(e[1], 'mask')] : { id: parseIntish(e?.id, 'id'), mask: parseIntish(e?.mask, 'mask') })); } catch (e) {
            throw e instanceof ApiError ? e : new ApiError('entries must be an array of [id, mask] or {id, mask}');
          }
          try { await bridge.setFilter(norm); } catch (e) { throw new ApiError(errText(e)); }
        }
        const local = bridge.getFilter();
        let device;
        try { device = (await bridge.readFilter()).map(fmtEntry); } catch (e) { device = 'read failed: ' + errText(e); }
        return { ok: true, filter: local.map(fmtEntry), device, text: fmtFilter(local) };
      },
    },
    {
      name: 'skills', kind: 'info',
      summary: 'List the skills (markdown guides) this page serves. Read web-api and dingopdm-config before building a config.',
      args: [],
      returns: '{ ok, skills: [{ name, description, chars, assets? }] }',
      example: 'await api.skills()',
      run: async () => {
        const idx = await loadSkillIndex(true);
        return { ok: true, skills: idx.map((s) => ({ name: s.name, description: s.description, chars: s.chars, ...(s.assets?.length ? { assets: s.assets } : {}) })) };
      },
    },
    {
      name: 'skill', kind: 'info',
      summary: 'Read one skill’s markdown, in chunks: call again with offset = nextOffset until nextOffset is null.',
      args: [{ name: 'name', type: 'string', required: true, description: 'skill name from api.skills()' },
        { name: 'opts.offset', type: 'integer', required: false, description: 'character offset (default 0)' },
        { name: 'opts.maxChars', type: 'integer', required: false, description: 'chunk size (default 12000, max 100000)' }],
      returns: '{ ok, name, description, totalChars, offset, nextOffset|null, markdown }',
      example: "await api.skill('web-api')",
      run: async (name, opts = {}) => {
        if (typeof name !== 'string' || !name) throw new ApiError('name is required', 'see api.skills()');
        const idx = await loadSkillIndex(false);
        const s = idx.find((x) => x.name === name || x.dir === name);
        if (!s) throw new ApiError(`no skill named '${name}'`, `available: ${idx.map((x) => x.name).join(', ')}`);
        const offset = clampInt(opts.offset, 0, 0, 1e8, 'offset');
        const maxChars = clampInt(opts.maxChars, 12000, 100, 100000, 'maxChars');
        let md;
        try { md = await fetchText('./' + s.path); } catch (e) { throw new ApiError(`could not fetch ${s.path}: ${errText(e)}`, 'run web/sync-skills.sh'); }
        const chunk = md.slice(offset, offset + maxChars);
        return { ok: true, name: s.name, description: s.description, totalChars: md.length, offset, nextOffset: offset + chunk.length < md.length ? offset + chunk.length : null, markdown: chunk };
      },
    },
    {
      name: 'log', kind: 'info',
      summary: 'Recent app log lines (connects, ops, errors, BLE events), oldest first.',
      args: [{ name: 'opts.last', type: 'integer', required: false, description: 'how many lines (default 50, max 500)' }],
      returns: '{ ok, total, lines: string[] }',
      example: 'await api.log({ last: 100 })',
      run: async (opts = {}) => {
        const last = clampInt(opts.last, 50, 1, 500, 'last');
        return { ok: true, total: logger.total ? logger.total() : null, lines: logger.lines(last) };
      },
    },
  ];

  function fmtEntry(e) { return { id: e.id, idHex: '0x' + hex3(e.id), mask: e.mask, maskHex: '0x' + hex3(e.mask) }; }

  async function connectImpl(allowChooser) {
    if (!bridge) throw new ApiError('no BLE bridge in this page');
    try {
      const r = await bridge.connect({ allowChooser });
      return { ok: true, state: bridge.info().state, deviceName: r.deviceName, deviceId: r.deviceId, already: !!r.already };
    } catch (e) {
      throw new ApiError(errText(e), hintFor(errText(e)));
    }
  }

  async function describe() {
    let skills = []; const notes = [];
    try { skills = (await loadSkillIndex(false)).map((s) => ({ name: s.name, description: s.description })); } catch (e) { notes.push(`skills unavailable: ${errText(e)}`); }
    return {
      ok: true,
      name: API_NAME,
      version: API_VERSION,
      summary: 'Program dingoPDM power-distribution modules, and the hilux C6 body node (board c6body_v1), over Web Bluetooth: this page talks to the hilux ESP32-C6 CAN bridge, which puts dingo parameter-protocol frames on the CAN bus. Same operations as the `dingo` CLI (apply / verify / burn / version / listen ...), as async functions on window.api.',
      workflow: [
        "1. api.status() — is the bridge connected, is the WASM loaded? If connect fails with 'no remembered device', ask the person to click Connect once; if it says this computer isn't allowed to use the CAN bridge, ask them to grant the CAN bridge role on the Kindle.",
        "2. api.skill('web-api') then api.skill('dingopdm-config') (and 'dingopdm-hardware' for pins/wiring) — read them fully before building a config.",
        '3. api.discover() (or api.listen()) — find the nodes on the bus (nodes: base, version, board). Only touch a base that discover/version confirmed; with several nodes, ask the user which one.',
        '4. Build the config object (dingoConfig JSON) per the dingopdm-config skill; check api.devices(cfg) shows the PDM with the right baseId.',
        '5. api.encode(cfg, base) — dry run: parameter count + CRC, no hardware. Fix any error before going on.',
        '6. api.apply(base, cfg) — writes the live config (count + CRC verified). Do NOT pass burn unless the user asked to persist.',
        '7. api.verify(base, cfg) — device CRC must equal the encoded CRC (matches: true).',
        '8. api.burn(base) — only when the user asks to make it permanent.',
        '9. On any { ok:false }: read error + hint, then api.status() and api.log({ last: 50 }).',
      ],
      functions: FUNCTIONS.map((f) => ({ name: f.name, summary: f.summary, args: f.args.map((a) => ({ name: a.name, type: a.type, required: !!a.required, description: a.description })), returns: f.returns, example: f.example })),
      skills,
      notes: [
        'Every function is async: use `await api.fn(...)`. None throws; check `ok`. Errors carry `error` and often `hint`.',
        "Positional args are listed in order; names starting 'opts.' go in one trailing options object, e.g. api.apply(222, cfg, { burn: false }). You may also pass one object with the positional names: api.version({ base: 222 }).",
        'Device ops (listen, discover, version, verify, readParams, apply, burn, setParam, getParam, sendFrame, filter) run one at a time; a second call while one runs returns { ok:false, error:"busy: <op> running" } — wait and retry. api.status().busy shows the running op and its progress.',
        "Device ops auto-connect to the remembered hilux device. From script the Bluetooth chooser can never open; a person must click Connect once per browser profile (Connect uses the remembered device and opens the chooser only when there is none; the page's \"Choose device…\" button always opens it).",
        "verify(base, cfg) adds a warning when the config's baseId is not base (its matches then compares a config for another node). The page itself refuses Encode/Apply/Verify/Burn while its Base id field differs from the loaded config's baseId.",
        "Access is per device: the C6 serves the CAN bridge only to a computer paired with it that has the CAN bridge role, granted on the Kindle page (Settings → Bluetooth: Pair new device with CAN bridge, or tap an already paired device and turn CAN bridge on). Without it every op fails with \"This computer isn't allowed to use the CAN bridge — grant it the CAN bridge role on the Kindle\"; only a person at the Kindle can fix that, so do not retry.",
        "If connecting keeps failing with a hint about an old pairing, this computer holds a pairing the C6 has forgotten: the person must forget 'hilux' in macOS Bluetooth settings and PAIR again on the Kindle.",
        'Writes (apply, burn, setParam) first confirm the base answers a version request; an unconfirmed base is refused.',
        "apply refuses a config whose PdmDevices baseId differs from the target base (that would rewrite the device's base id) unless opts.allowBaseChange is true.",
        'apply also reads the board type the node broadcasts (high nibble of byte 1 of its status frame, base+2) and refuses a config whose pdmType differs, unless opts.allowTypeMismatch is true. The result says what it saw (typeCheck); a node that sent no status frame within 350 ms is not checked.',
        "The C6 body node (board c6body_v1) is configured exactly like a PDM: a PdmDevices entry with pdmType 12 (required: an output-less entry is never inferred), base 0x500 (1280) by default, blocks canInputs (8), canOutputs (8), virtualInputs (8), conditions (8), counters (4), flashers (4); no outputs, inputs, wipers, starter or keypads yet. Its var map differs from a PDM's (43 entries: AlwaysFalse 0, AlwaysTrue 1, State 2, CanIn<n>Out/Val 3-18, VirtIn1-8 19-26, Flasher1-4 27-30, Cond1-8 31-38, Counter1-4 39-42; var fields also accept these names as strings), and so do its parameter names: api.paramNames({ pdmType: 12 }). discover() lists it with board c6body_v1 (type 12), like any PDM. Examples: examples/c6-empty.json (every default; also what a never-configured node verifies as), examples/c6-test.json.",
        'CAN ids/base ids accept numbers or "0x.." strings. Results give both decimal and hex (idHex/baseHex/crcHex).',
        'apply without opts.partial resets every parameter not in the file to the firmware default — that is the intended, reproducible way to apply a full config.',
        'Large results are paged (readParams, encode params, skill, paramNames): follow nextOffset.',
        "graph / graphEdit / graphNode are the page's Logic view (Cory Grant's dingoConfig flow editor): a function input is wired by setting it to another function's var-map index, so graphEdit({op:'connect'}) is the same change as writing that index into the config. They work on config text only (no hardware); apply the returned config to send it. Node positions go in the PdmDevices entry's flowLayout ({ '<nodeId>': {x, y} }, the field dingoConfig uses), which the encoder ignores.",
        ...notes,
      ],
    };
  }

  // ------------------------------------------------------------ wrapper ----

  function bindArgs(f, raw) {
    const positional = f.args.filter((a) => !a.name.startsWith('opts.'));
    if (raw.length === 1 && isPlainObject(raw[0]) && positional.length && Object.prototype.hasOwnProperty.call(raw[0], positional[0].name)) {
      const o = raw[0];
      const out = positional.map((a) => o[a.name]);
      const rest = {};
      for (const k of Object.keys(o)) if (!positional.some((a) => a.name === k)) rest[k] = o[k];
      if (f.args.some((a) => a.name.startsWith('opts.'))) out.push(rest);
      return out;
    }
    return raw;
  }

  function summarise(r) {
    if (!r.ok) return `error: ${r.error}`;
    const s = JSON.stringify(r);
    return s.length > 160 ? s.slice(0, 157) + '...' : s;
  }

  function makeFn(f) {
    return async (...raw) => {
      const t0 = now();
      const locked = f.kind === 'device';
      if (locked && busy) {
        return { ok: false, error: `busy: ${busy.op} running`, hint: `wait for ${busy.op} to finish (started ${now() - busy.since} ms ago), then retry; api.status().busy shows progress` };
      }
      if (locked) busy = { op: f.name, since: t0, progress: null };
      let r;
      // quiet: no log lines (info calls; and the graph calls, which the Logic view makes on every drag).
      const quiet = f.quiet || (f.kind === 'info' && f.name !== 'connect' && f.name !== 'disconnect');
      if (!quiet) L('info', `${f.name}(${raw.map(argPreview).join(', ')}) …`);
      try {
        const args = bindArgs(f, raw);
        r = await f.run(...args);
      } catch (e) {
        r = { ok: false, error: errText(e) };
        const h = e instanceof ApiError ? e.hint : undefined;
        if (h) r.hint = h; else { const h2 = hintFor(errText(e)); if (h2) r.hint = h2; }
      } finally {
        if (locked) busy = null;
      }
      try { r = toPlain(r); } catch (e) { r = { ok: false, error: `internal: result not serialisable: ${errText(e)}` }; }
      if (locked || f.kind === 'pure') r.elapsedMs = now() - t0;
      if (!r.ok) { lastError = `${f.name}: ${r.error}`; L('error', `${f.name} failed after ${now() - t0} ms: ${r.error}`); } else if (!quiet) L('info', `${f.name} ok in ${now() - t0} ms: ${summarise(r)}`);
      for (const cb of callListeners) { try { cb({ name: f.name, args: raw.map(argPreview), result: r }); } catch { /* ignore */ } }
      return r;
    };
  }

  function argPreview(a) {
    if (typeof a === 'string') return a.length > 40 ? JSON.stringify(a.slice(0, 37) + '...') : JSON.stringify(a);
    if (a && typeof a === 'object') { const s = JSON.stringify(a); return s && s.length > 60 ? s.slice(0, 57) + '...' : s; }
    return String(a);
  }

  const api = {};
  for (const f of FUNCTIONS) api[f.name] = makeFn(f);

  // Non-enumerable extras for the page itself (not part of the agent surface).
  Object.defineProperty(api, '_connectWithChooser', { value: async () => {
    try { return { ok: true, ...(await connectImpl(true)) }; } catch (e) { lastError = `connect: ${errText(e)}`; L('error', `connect (chooser) failed: ${errText(e)}`); return { ok: false, error: errText(e), ...(e.hint ? { hint: e.hint } : {}) }; }
  } });
  Object.defineProperty(api, '_chooseDevice', { value: async () => {
    try {
      const r = await bridge.connect({ forceChooser: true });
      return { ok: true, state: bridge.info().state, deviceName: r.deviceName, deviceId: r.deviceId, already: !!r.already };
    } catch (e) { lastError = `connect: ${errText(e)}`; L('error', `choose device failed: ${errText(e)}`); return { ok: false, error: errText(e), ...(hintFor(errText(e)) ? { hint: hintFor(errText(e)) } : {}) }; }
  } });
  // What the page shows about the editor's config: no log line, no _onCall (it runs as you type).
  Object.defineProperty(api, '_inspectConfig', { value: async (text) => {
    try {
      const txt = parseConfig(text); const d = await getDingo();
      const r = await d.devices(txt);
      if (!r?.ok) return { ok: false, error: r?.error || 'devices failed' };
      const pdms = (r.devices || []).filter((x) => Number.isInteger(x.baseId) && /pdm/i.test(x.kind || ''))
        .map((x) => ({ name: x.name ?? '', baseId: x.baseId, baseHex: baseHex(x.baseId), pdmType: x.pdmType ?? null }));
      for (const p of pdms) {
        const e = await d.encode(txt, p.baseId);
        p.board = e?.ok ? (e.board ?? null) : null;
        if (e?.ok) { p.count = e.count; p.crc = crcNum(e.crc); p.crcHex = crcHex(e.crc); } else p.error = e?.error;
      }
      return { ok: true, pdms };
    } catch (e) { return { ok: false, error: errText(e) }; }
  } });
  // The running device op and its progress, for the page's Apply panel: status()
  // without its stats read, which would queue a GATT read behind the writes.
  Object.defineProperty(api, '_busy', { value: () => (busy ? { op: busy.op, sinceMs: now() - busy.since, progress: busy.progress ?? null } : null) });
  Object.defineProperty(api, '_onCall', { value: (cb) => { callListeners.add(cb); return () => callListeners.delete(cb); } });
  Object.defineProperty(api, '_registry', { value: FUNCTIONS });
  return api;
}

/**
 * Wrap the api so calling an unknown function returns a clear error instead of
 * "api.foo is not a function". Thenable/JSON/symbol probes stay undefined.
 */
export function withUnknownGuard(api) {
  const passthrough = new Set(['then', 'toJSON', 'constructor', 'valueOf', 'toString', 'inspect', 'nodeType', '$$typeof', 'asymmetricMatch']);
  return new Proxy(api, {
    get(t, p, r) {
      if (typeof p === 'symbol' || p in t || passthrough.has(p)) return Reflect.get(t, p, r);
      return async () => ({ ok: false, error: `api.${p} does not exist`, hint: `call api.describe() for the function list: ${Object.keys(t).join(', ')}` });
    },
  });
}

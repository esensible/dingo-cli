// ui.js — the page's logic that needs no DOM, so it can be tested in Node:
// Base id parsing and display, the guard that keeps config operations on the
// loaded config's node, node labels, the examples, the HTML for listen and
// discover results, the Logic | JSON view choice, what an error means to a
// person (explainError), the Activity timeline (activityEvent, activityHtml,
// bugReport), the selected node's status panel and the Apply steps. app.js
// wires these to the page.

import { hex3 } from './ble.js';
import { slotName } from './firmware.js';

/** A firmware digest for a sentence: its first 12 hex digits (the full one is in the panel and the detail). */
export const shortSha = (s) => (typeof s === 'string' && s ? s.slice(0, 12) : '?');
/** Bytes for people: "1.32 MiB", "20 KiB", "300 B". */
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MiB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KiB`;
  return `${n} B`;
}

export const EXAMPLES = [
  { name: 'bench-toggle', path: './examples/bench-toggle.json' },
  { name: 'c6-empty', path: './examples/c6-empty.json' },
  { name: 'c6-test', path: './examples/c6-test.json' },
];

/** Board types as people call them (the WASM names: dingoPDM, dingoPDM-Max, PT-DPDM, c6body_v1). */
const FRIENDLY = { 0: 'dingoPDM', 1: 'dingoPDM-Max', 2: 'PT-DPDM', 12: 'C6 body node' };

export function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

export const fmtBase = (n) => '0x' + hex3(n);

/**
 * The Base id field: decimal ("1280") or hex ("0x500"). → { value: int } |
 * { value: null } (empty) | { value: null, error }.
 */
export function parseBaseInput(s) {
  const t = String(s ?? '').trim();
  if (!t) return { value: null };
  if (!/^(0x[0-9a-f]+|\d+)$/i.test(t)) return { value: null, error: `"${t}" is not a base id (decimal like 1280, or hex like 0x500)` };
  const n = Number(t);
  if (n > 0x7fe) return { value: null, error: `${t} is out of range (0..0x7FE; commands go to base+1)` };
  return { value: n };
}

/** "dingoPDM", "C6 body node", or the board name the WASM gave. */
export function boardLabel(n) {
  if (!n) return 'unknown board';
  return FRIENDLY[n.type ?? n.pdmType] ?? n.board ?? (Number.isInteger(n.type) ? `board type ${n.type}` : 'unknown board');
}

/** "C6 body node · 0x500 · 0.5.8" for a discover/version node. */
export function nodeLabel(n) {
  const parts = [Number.isInteger(n.type) || n.board ? boardLabel(n) : 'node', n.baseHex ?? fmtBase(n.base)];
  if (n.version) parts.push(n.version);
  return parts.join(' · ');
}

/** "c6-body-test · C6 body node (c6body_v1) · 0x500" for a config's PDM entry (api._inspectConfig). */
export function configLabel(p) {
  const board = p.board && FRIENDLY[p.pdmType] && FRIENDLY[p.pdmType] !== p.board ? `${FRIENDLY[p.pdmType]} (${p.board})` : boardLabel(p);
  return [p.name || '(unnamed)', board, p.baseHex ?? fmtBase(p.baseId)].join(' · ');
}

/**
 * Which base a config operation (Encode / Verify / Apply / Burn with a config)
 * may use. The loaded config's baseId is the truth; the Base id field must
 * name it (or, for a file with several PDMs, one of them).
 *   field   parseBaseInput() of the Base id field
 *   info    api._inspectConfig(text) result ({ ok, pdms: [{ name, baseId, baseHex, ... }] })
 *   nodes   Map base → node (what discover/version found), for naming the field's node
 * → { ok: true, base } | { ok: false, message, fixes: [baseId] }
 */
export function configGuard(field, info, nodes = new Map()) {
  if (field.error) return { ok: false, message: `Base id: ${field.error}`, fixes: info?.ok ? info.pdms.map((p) => p.baseId) : [] };
  if (!info?.ok || !info.pdms.length) {
    // No PDM entry to compare with: the api reports what is wrong with the config.
    return { ok: true, base: field.value };
  }
  if (info.pdms.some((p) => p.baseId === field.value)) return { ok: true, base: field.value };
  const cfg = info.pdms.map((p) => `${p.baseHex ?? fmtBase(p.baseId)}${p.name ? ` (${p.name})` : ''}`).join(' / ');
  let fieldText = 'empty';
  if (field.value !== null) {
    const n = nodes.get(field.value);
    fieldText = fmtBase(field.value) + (n ? ` (${[boardLabel(n), n.version].filter(Boolean).join(' ')})` : '');
  }
  return { ok: false, message: `Config is for ${cfg}; Base id is ${fieldText}`, fixes: info.pdms.map((p) => p.baseId) };
}

/** The Base id after loading a config (a person's action): keep the field if the config has it, else its first PDM. */
export function baseAfterLoad(info, current) {
  if (!info?.ok || !info.pdms.length) return current;
  if (info.pdms.some((p) => p.baseId === current)) return current;
  return info.pdms[0].baseId;
}

/** The Base id after Discover: set only when exactly one node answered. */
export function baseAfterDiscover(nodes, current) {
  return nodes?.length === 1 ? nodes[0].base : current;
}

/** Load an example by name through fetchText; → { name, path, text } or throws. */
export async function loadExample(name, fetchText) {
  const ex = EXAMPLES.find((e) => e.name === name);
  if (!ex) throw new Error(`no example named '${name}' (have: ${EXAMPLES.map((e) => e.name).join(', ')})`);
  const text = await fetchText(ex.path);
  JSON.parse(text); // a broken example must not land in the editor silently
  return { name: ex.name, path: ex.path, text };
}

const spaced = (hex) => (hex || '').replace(/(..)(?=.)/g, '$1 ');

/** listen() result → HTML table (ID, count, Hz, DLC, last data). */
export function listenHtml(r) {
  const rows = r.ids.map((x) => `<tr><td class="mono">${esc(x.idHex)}</td><td class="num">${x.count}</td><td class="num">${x.hz}</td><td class="num">${x.dlc}</td><td class="mono">${esc(spaced(x.lastHex))}</td></tr>`).join('');
  const head = `<p class="hint">${r.totalFrames} frames, ${r.distinctIds} ids in ${r.ms} ms${r.truncated ? ' (list truncated)' : ''}${r.bridgeRxDropped ? `, <span class="err">${r.bridgeRxDropped} dropped by the bridge</span>` : ''}</p>`;
  if (!r.ids.length) return head + '<p>No frames.</p>';
  return head + `<table class="tbl"><thead><tr><th>ID</th><th>count</th><th>Hz</th><th>DLC</th><th>last data</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Nodes as clickable entries (data-base); the current base is marked. */
export function nodesHtml(nodes, current) {
  if (!nodes.length) return '';
  return '<div class="nodes">' + nodes.map((n) => `<button type="button" class="node${n.base === current ? ' current' : ''}" data-base="${n.base}" title="use base ${esc(n.baseHex ?? fmtBase(n.base))}">${esc(nodeLabel(n))}</button>`).join('') + '</div>';
}

/** discover() result → HTML: the nodes (clickable) and what did not answer. */
export function discoverHtml(r, current) {
  let h = r.nodes.length
    ? `<p class="hint">${r.nodes.length === 1 ? '1 node answered' : `${r.nodes.length} nodes answered — click one to use its base`}:</p>` + nodesHtml(r.nodes, current)
    : `<p>No node answered.${r.hint ? ' ' + esc(r.hint) : ''}</p>`;
  if (r.unconfirmed?.length) {
    h += '<p class="hint">Not confirmed:</p><ul class="hint">' + r.unconfirmed.map((u) => `<li>${esc(u.baseHex)}${u.board ? ' (' + esc(boardLabel(u)) + ')' : ''}: ${esc(u.reason)}</li>`).join('') + '</ul>';
  }
  if (r.ignored?.length) {
    h += '<p class="hint">Ignored (nothing sent):</p><ul class="hint">' + r.ignored.map((u) => `<li>${esc('0x' + hex3(u.statusId))} → base ${esc(u.baseHex)}: ${esc(u.reason)}</li>`).join('') + '</ul>';
  }
  return h;
}

// ------------------------------------------------------------- the view ----

/** Logic | JSON: JSON when there is no config to draw; else the remembered choice (Logic by default). */
export function viewFor(stored, hasConfig) {
  if (!hasConfig) return 'json';
  return stored === 'json' ? 'json' : 'logic';
}

// ---------------------------------------------------------------- times ----

const pad2 = (n) => String(n).padStart(2, '0');
/** "23:40:37" (local time). */
export function fmtClock(ms) { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
/** "113 ms", "2.0 s", "1 min 4 s"; "—" when unknown. */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
}
/** "just now", "2 s ago", "1 min ago", "3 h ago". */
export function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms < 1000) return 'just now';
  if (ms < 60000) return `${Math.floor(ms / 1000)} s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)} min ago`;
  return `${Math.floor(ms / 3600000)} h ago`;
}

// ---------------------------------------------------------------- names ----

/** "C6 body node" for a known node; "Node" when its board is unknown. */
export function nodeTitle(n) { return n && (Number.isInteger(n.type) || n.board) ? boardLabel(n) : 'Node'; }
/** "C6 body node · 0x500" (or "node 0x500" when nothing is known about it). */
export function nodeRef(n, base) {
  const b = n?.baseHex ?? (Number.isInteger(base ?? n?.base) ? fmtBase(base ?? n.base) : '?');
  return n && (Number.isInteger(n.type) || n.board) ? `${boardLabel(n)} · ${b}` : `node ${b}`;
}

/** "C6 body node at 0x500" / "node at 0x500", for sentences. */
export function nodeAt(n, base) {
  const b = Number.isInteger(base) ? fmtBase(base) : n?.baseHex ?? fmtBase(n.base);
  return `${n && (Number.isInteger(n.type) || n.board) ? boardLabel(n) : 'node'} at ${b}`;
}

const OP_LABEL = {
  apply: 'Apply', verify: 'Check', burn: 'Burn', version: 'Version', discover: 'Find nodes', listen: 'Listen',
  connect: 'Connect', readParams: 'Read parameters', setParam: 'Set parameter', getParam: 'Read parameter',
  encode: 'Encode', sendFrame: 'Send frame', filter: 'Filter', disconnect: 'Disconnect', devices: 'Devices', paramNames: 'Parameter names',
  firmwareInfo: 'Firmware info', firmwareCheck: 'Firmware check', firmwareUpdate: 'Firmware update', firmwareConnect: 'Firmware connect',
};
export const opLabel = (op) => OP_LABEL[op] ?? op;

// --------------------------------------------------------------- errors ----

const CONNECT_STEPS_ROLE = [
  "On the Kindle: Settings › Bluetooth › this computer's name",
  'Turn on CAN bridge, and tap again to confirm',
  "If this computer isn't listed: Pair new device › CAN bridge, then click Connect here while that window is open",
];
const CONNECT_STEPS_STALE = [
  'On this Mac: System Settings › Bluetooth › hilux › Forget This Device',
  'On the Kindle: Pair new device › CAN bridge',
  'Then Connect, and accept the pairing prompt',
];

/**
 * What a failed result means to a person: a plain headline, one sentence of
 * meaning, the next step (buttons the page can do, numbered steps only a
 * person can) and the raw error as technical detail. Matched on the error text
 * (the api's results carry no error codes; ble.js's codes surface as these
 * messages).
 *   r    { ok:false, error, hint? }
 *   ctx  { op, node: "C6 body node · 0x500" | null, progress: { done, total } | null }
 * → { where: 'connection' | 'action', tone: 'danger' | 'warning', icon, headline, meaning, steps: [], actions: [{ action, label, primary? }], detail }
 */
// The Firmware role (hilux FIRMWARE.md "Access"): granted like the CAN bridge's.
const FIRMWARE_STEPS_ROLE = [
  "On the Kindle: Settings › Bluetooth › this computer's name",
  'Turn on Firmware, and tap again to confirm',
  "If this computer isn't listed: Pair new device › Firmware, then click Read firmware info here while that window is open",
];
const FIRMWARE_STEPS_STALE = [
  'On this Mac: System Settings › Bluetooth › hilux › Forget This Device',
  'On the Kindle: Pair new device › Firmware',
  'Then Read firmware info here, and accept the pairing prompt',
];

/**
 * explainError for the firmware calls (firmwareInfo / firmwareCheck /
 * firmwareUpdate / the panel's connect): by the result's `code` (firmware.js:
 * the C6's error names, BUSY, ON_TRIAL, IMAGE…, and the link's), shown in the
 * Firmware panel (where 'firmware'). x.code is the name, for the eyebrow.
 */
export function explainFirmwareError(r, ctx = {}) {
  const err = String(r?.error ?? 'unknown error');
  const code = r?.code ?? null;
  const detail = err + (r?.hint ? `\nhint: ${r.hint}` : '');
  const hint = r?.hint ? `${r.hint[0].toUpperCase()}${r.hint.slice(1)}.` : '';
  const fromBox = /^(Info|Begin|Commit|Abort|data): [A-Z_]+: /.test(err);
  const what = err.replace(/^(Info|Begin|Commit|Abort|data): [A-Z_]+: /, '');
  const out = (o) => ({ where: 'firmware', tone: 'danger', icon: 'alert', steps: [], actions: [], detail, code, ...o });
  const again = (label = 'Try again') => ({ action: 'fw-retry', label, primary: true });
  switch (code) {
    case 'NOT_AUTHORISED':
      return out({ icon: 'lock', headline: "This computer isn't allowed to update hilux's firmware",
        meaning: "It reached hilux, but hilux hasn't given it the Firmware role (the CAN bridge role doesn't include it). Only the Kindle can grant it; trying again from here won't help until then.",
        steps: FIRMWARE_STEPS_ROLE, actions: [{ action: 'fw-info', label: 'Try again', primary: true }] });
    case 'STALE_PAIRING_SUSPECTED':
      return out({ icon: 'btOff', headline: "hilux seems to have refused this Mac's pairing",
        meaning: "The link dropped while connecting. Chrome doesn't say why; the usual cause is that this Mac still holds a pairing hilux no longer has, and macOS won't pair again by itself.",
        steps: FIRMWARE_STEPS_STALE, actions: [{ action: 'connect', label: 'Connect', primary: true }] });
    case 'SERVICE_NOT_GRANTED':
      return out({ icon: 'bt', headline: 'Chrome needs you to pick hilux again',
        meaning: "Chrome hasn't let this page use hilux's firmware service (hilux was picked before the page asked for it). Connect opens Chrome's chooser: pick hilux there.",
        actions: [{ action: 'connect', label: 'Connect', primary: true }] });
    case 'NO_FIRMWARE_SERVICE':
      return out({ headline: "hilux doesn't offer firmware updates",
        meaning: 'It connected, but has no firmware service: its firmware predates updates over Bluetooth (it needs the probe once, the one-time move to the OTA partition table), or this Mac keeps hilux\'s services from before.',
        steps: ["If hilux has the firmware service: forget 'hilux' in macOS System Settings → Bluetooth, then PAIR on the Kindle and connect again (the Mac then reads its services afresh)", "Otherwise: the wireless-can README, \"The one-time move to the OTA partition table\""],
        actions: [{ action: 'fw-info', label: 'Try again' }] });
    case 'NEEDS_USER_GESTURE':
      return out({ tone: 'warning', icon: 'bt', headline: 'Connect once to pick hilux',
        meaning: "This browser hasn't been given a hilux device yet. Chrome opens the Bluetooth chooser only from a click.",
        actions: [{ action: 'connect', label: 'Connect', primary: true }] });
    case 'NO_BLUETOOTH':
      return out({ headline: "This browser can't use Bluetooth", meaning: 'Web Bluetooth needs desktop Chrome or Edge, on a secure origin such as localhost.', steps: ['Open http://localhost:5173 in desktop Chrome'] });
    case 'UNAVAILABLE':
      return out({ tone: 'warning', icon: 'info', headline: "This hilux doesn't take updates yet",
        meaning: `${what[0].toUpperCase()}${what.slice(1)}. Nothing was written.`,
        steps: ["The one-time move needs the probe: the wireless-can README, \"The one-time move to the OTA partition table\""] });
    case 'BUSY':
      return out({ tone: 'warning', icon: 'info', headline: 'Another update is running on hilux',
        meaning: "Another connection's upload is in progress. hilux drops it 60 s after its last bytes; then update again. Nothing was written.", actions: [again()] });
    case 'ON_TRIAL':
      return out({ tone: 'warning', icon: 'info', headline: 'hilux is still trying out its last update',
        meaning: 'The firmware it runs is an update not yet confirmed (it confirms itself 20 s after its boot). Until then a new upload is refused, so the slot it would roll back to stays intact. Nothing was written.',
        actions: [again('Try again'), { action: 'fw-info', label: 'Read firmware info' }] });
    case 'SAME':
      return out({ tone: 'warning', icon: 'info', headline: 'hilux already runs this image', meaning: 'The file is the firmware hilux runs now (same digest). Nothing was sent.', actions: [{ action: 'fw-file', label: 'Choose another file…', primary: true }] });
    case 'IMAGE':
      return fromBox
        ? out({ headline: 'hilux refused the image', meaning: `It received every byte, checked the image in flash and refused it: ${what}. Nothing changed; it keeps running its firmware.`, steps: r?.hint ? [hint] : [] })
        : out({ tone: 'warning', icon: 'file', headline: "This file isn't a hilux firmware image", meaning: `${err[0].toUpperCase()}${err.slice(1)}. Nothing was sent.`, steps: r?.hint ? [hint] : [], actions: [{ action: 'fw-file', label: 'Choose another file…', primary: true }] });
    case 'NO_SPACE':
      return out({ tone: 'warning', icon: 'file', headline: "The image doesn't fit hilux's app slot", meaning: `${what[0].toUpperCase()}${what.slice(1)}. Nothing was written.`, actions: [{ action: 'fw-file', label: 'Choose another file…', primary: true }] });
    case 'HASH':
      return out({ headline: 'The image arrived damaged', meaning: "hilux's SHA-256 of the bytes it received isn't the image's digest. Nothing changed; update again.", actions: [again('Update again')] });
    case 'FLASH':
      return out({ headline: "hilux couldn't write its flash", meaning: `${what[0].toUpperCase()}${what.slice(1)}. Nothing changed; it keeps running its firmware.`, actions: [again('Update again')] });
    case 'SWITCH':
      return out({ headline: "hilux couldn't switch to the update", meaning: 'The image checked out, but hilux could not record the update or select its slot. Nothing changed and it did not reset.', actions: [again('Update again')] });
    case 'DROPPED': case 'STALLED': case 'TIMEOUT': case 'NOT_CONNECTED':
      return out({ icon: 'btOff', headline: code === 'STALLED' ? 'hilux stopped acknowledging the upload' : code === 'TIMEOUT' && !fromBox ? "hilux didn't answer" : fromBox ? 'hilux dropped the upload' : 'Lost the link during the update',
        meaning: fromBox ? `${what[0].toUpperCase()}${what.slice(1)}. Update again: it begins afresh.` : 'hilux keeps what it received for 60 s after the last bytes: update again with the same file and it resumes from there. It keeps running its firmware until an update is complete and checked.',
        actions: [again('Resume the update')] });
    case 'NO_RESET': case 'NOT_BACK': case 'NOT_CONFIRMED':
      return out({ tone: 'warning', icon: 'info', headline: code === 'NOT_BACK' ? "hilux hasn't come back after its reset" : code === 'NO_RESET' ? "hilux didn't reset" : "The update isn't confirmed yet",
        meaning: `${err[0].toUpperCase()}${err.slice(1)}. An update confirms itself 20 s after it boots, or rolls back to the firmware it came from after three boots.`, actions: [{ action: 'fw-info', label: 'Read firmware info', primary: true }] });
    case 'ROLLED_BACK':
      return out({ headline: 'The update was rolled back',
        meaning: `${err[0].toUpperCase()}${err.slice(1)}. hilux runs the firmware it had before; nothing else changed.`, steps: r?.hint ? [hint] : [] });
    default: {
      const x = explainError(r, { ...ctx, op: 'firmware-generic' });
      return { ...x, where: 'firmware', code, headline: x.headline === 'firmware-generic failed' ? `${opLabel(ctx.op) || 'Firmware'} failed` : x.headline,
        actions: x.actions.map((a) => ({ ...a, action: a.action === 'retry' ? 'fw-retry' : a.action })) };
    }
  }
}

export function explainError(r, ctx = {}) {
  const op = ctx.op || '';
  if (op.startsWith('firmware') && op !== 'firmware-generic') return explainFirmwareError(r, ctx);
  const err = String(r?.error ?? 'unknown error');
  const m = err.toLowerCase();
  const node = ctx.node || 'The node';
  const detail = err + (r?.hint ? `\nhint: ${r.hint}` : '');
  const out = (o) => ({ where: 'action', tone: 'danger', icon: 'alert', steps: [], actions: [], detail, ...o });
  const conn = (o) => out({ where: 'connection', icon: 'btOff', ...o });
  const retry = (label) => ({ action: 'retry', label, primary: true });

  // Connection problems (also when a device op's auto-connect hit them).
  if (m.includes("isn't allowed to use the can bridge")) {
    return conn({ icon: 'lock', headline: "This computer isn't allowed to use the CAN bridge",
      meaning: "It reached hilux, but hilux hasn't given it the CAN bridge role, so it can't talk to the nodes. Only the Kindle can grant it; trying again from here won't help until then.",
      steps: CONNECT_STEPS_ROLE, actions: [{ action: 'connect', label: 'Connect', primary: true }] });
  }
  if (m.includes('old pairing') || m.includes('link dropped while connecting')) {
    return conn({ headline: "hilux seems to have refused this Mac's pairing",
      meaning: "The link dropped while connecting. Chrome doesn't say why; the usual cause is that this Mac still holds a pairing hilux no longer has (for example after Forget on the Kindle), and macOS won't pair again by itself.",
      steps: CONNECT_STEPS_STALE, actions: [{ action: 'connect', label: 'Connect', primary: true }] });
  }
  if (m.includes('not granted this page')) {
    return conn({ headline: 'Chrome needs you to pick hilux again',
      meaning: "Chrome hasn't let this page use hilux's CAN bridge service (hilux was picked before that service existed). Connect opens Chrome's chooser: pick hilux there.",
      actions: [{ action: 'connect', label: 'Connect', primary: true }] });
  }
  if (m.includes('user cancelled') || m.includes('user canceled')) {
    return conn({ tone: 'warning', icon: 'bt', headline: 'No device was picked',
      meaning: 'The Bluetooth chooser closed without a pick, so nothing changed.',
      actions: [{ action: 'connect', label: 'Connect', primary: true }] });
  }
  if (m.includes('no remembered')) {
    return conn({ tone: 'warning', icon: 'bt', headline: 'Connect once to pick hilux',
      meaning: "This browser hasn't been given a hilux device yet. Chrome opens the Bluetooth chooser only from a click, so a script can't do it.",
      actions: [{ action: 'connect', label: 'Connect', primary: true }] });
  }
  if (m.includes('web bluetooth is not available')) {
    return conn({ headline: "This browser can't use Bluetooth",
      meaning: 'Web Bluetooth needs desktop Chrome or Edge, on a secure origin such as localhost.',
      steps: ['Open http://localhost:5173 in desktop Chrome'] });
  }
  if (m.includes('waiting for an advertisement')) {
    return conn({ tone: 'warning', icon: 'bt', headline: "Can't find hilux",
      meaning: "It isn't advertising nearby. Check the controller has power and this computer is within a few metres, then try again. The page listens for it for 12 s after each try.",
      actions: [{ action: 'connect', label: 'Connect', primary: true }] });
  }
  if (m.includes('can bridge service') && m.includes('was not found')) {
    return conn({ headline: "hilux isn't offering the CAN bridge",
      meaning: 'It connected, but the bridge service is missing: the C6 may be running firmware without the bridge.',
      actions: [{ action: 'connect', label: 'Connect', primary: true }] });
  }
  if (m.includes('wasm not available')) {
    return conn({ icon: 'alert', headline: "The page's dingo module didn't load",
      meaning: 'Every node operation runs in dingo.wasm, so none of them can work until it loads.',
      steps: ['In the dingo-web container: web/build.sh', 'Reload this page'] });
  }
  if (m.includes('reconnect gave up') || m.includes('link dropped') || /(^|\W)not connected/.test(m) || m.includes('cannot send') || m === 'disconnected' || m.includes('gatt.connect()') || m.includes('connection attempt failed')) {
    const lost = m.includes('auto-reconnect') || m.includes('link dropped') || m.includes('cannot send');
    return conn({ headline: lost ? 'Lost the connection to hilux' : "Couldn't connect to hilux",
      meaning: lost ? "The Bluetooth link dropped and the page couldn't get it back." : 'hilux did not complete the connection. Check it has power and is in range.',
      actions: [{ action: 'connect', label: 'Connect', primary: true }] });
  }

  // Stopped on purpose by the api: nothing was sent.
  if (m.startsWith('busy:')) {
    const what = (err.match(/^busy: (\w+)/) || [])[1];
    return out({ tone: 'warning', icon: 'info', headline: 'Another operation is still running',
      meaning: `${what ? opLabel(what) : 'An operation'} is in progress; wait for it to finish, then try again. Nothing was sent.` });
  }
  if (m.includes('refusing to apply') && m.includes('baseid')) {
    return out({ tone: 'warning', icon: 'info', headline: "This config would change the node's address",
      meaning: `Its baseId isn't the address it was aimed at, so applying it would rewrite ${node}'s address. Nothing was sent.`,
      actions: [{ action: 'json', label: 'Show JSON' }] });
  }
  const ty = err.match(/broadcasts board type (\d+)(?: \(([^)]+)\))? but the config is for (\S+)/);
  if (ty) {
    return out({ tone: 'warning', icon: 'info', headline: 'This config is for a different kind of board',
      meaning: `The node says it is a ${ty[2] ?? 'board of type ' + ty[1]}, but the config is for ${ty[3]}. Nothing was written.`,
      actions: [{ action: 'discover', label: 'Find nodes' }, { action: 'open-file', label: 'Choose another config' }] });
  }
  if (m.includes('refusing to write')) {
    return out({ headline: `${node} didn't answer`,
      meaning: "It didn't reply to a version request, so nothing was written. Check it's powered and on the bus, and that the address is right.",
      actions: [retry('Try again'), { action: 'discover', label: 'Find nodes' }] });
  }

  // The node or the bus.
  if (m.includes('no can frames at all')) {
    return out({ headline: 'The CAN bus is silent',
      meaning: 'hilux is connected but heard no frames at all: is the node powered and wired to the bus?',
      actions: [retry('Look again')] });
  }
  if (m.includes('but burn failed')) {
    return out({ headline: `Applied to ${node}, but the burn failed`,
      meaning: 'The new config is running (count and CRC checked), but writing it to flash failed, so a power cycle brings back the burned one.',
      actions: [{ action: 'burn', label: 'Burn to flash…', primary: true }] });
  }
  if (m.includes('burn rejected')) {
    return out({ headline: `${node} refused to burn`,
      meaning: 'It answered, but reported that writing flash failed. Its running config is unchanged; nothing new is in flash.',
      actions: [retry('Try again')] });
  }
  if (m.includes('no response') || m.includes('timed out') || m.includes('timeout') || m.includes('did not finish within') || m.includes('not responding')) {
    if (op === 'apply') {
      const p = ctx.progress && Number.isFinite(ctx.progress.total) && ctx.progress.total > 0 ? ctx.progress : null;
      return out({ headline: `${node} stopped answering during Apply`,
        meaning: `${p ? `It took ${p.done} of ${p.total} parameters, then went quiet, and` : 'It went quiet, and'} didn't confirm the new config. Its running config may be partly changed; nothing was burned. Check it's powered and on the bus, then apply again.`,
        actions: [retry('Apply again'), { action: 'check', label: 'Check the node' }] });
    }
    return out({ headline: `${node} didn't answer`,
      meaning: "Check it's powered and on the bus, that the CAN bitrate matches, and that the address is right.",
      actions: [retry('Try again'), { action: 'discover', label: 'Find nodes' }] });
  }
  if (m.includes('mismatch')) {
    return out({ headline: `${node} didn't confirm the write`,
      meaning: "The count or CRC read back after writing didn't match: frames were lost or a value was rejected. Nothing was burned; try again.",
      actions: [retry(op === 'apply' ? 'Apply again' : 'Try again')] });
  }
  if (m.includes('malformed json') || m.includes('not valid json') || m.includes('config is required') || m.includes('editor is empty') || /^encode/.test(m)) {
    return out({ tone: 'warning', icon: 'info', headline: "The config can't be used",
      meaning: `${(r?.error || '').replace(/^\w+( failed)?: /, '')}. Nothing was sent.`,
      actions: [{ action: 'json', label: 'Show JSON' }] });
  }
  return out({ headline: `${opLabel(op) || 'The operation'} failed`, meaning: r?.hint ? `${r.hint[0].toUpperCase()}${r.hint.slice(1)}.` : 'See the technical detail for what the node or the bridge said.' });
}

// ------------------------------------------------------------- activity ----

export const ICONS = {
  check: '<path d="M5 12l5 5 9-10"/>',
  apply: '<path d="M4 12h14M13 6l6 6-6 6"/>',
  burn: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  bt: '<path d="M7 7l10 10-5 4V3l5 4L7 17"/>',
  btOff: '<path d="M7 7l10 10-5 4V3l5 4L7 17"/><path d="M3 3l18 18"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  alert: '<path d="M12 9v4M12 17v.5"/><path d="M10.3 3.9L2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16v.5"/>',
  wave: '<path d="M3 12h3l3-7 4 14 3-7h5"/>',
  differs: '<circle cx="12" cy="12" r="9"/><path d="M8 10h8M8 14h8M15 7l-6 10"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
};
export const icon = (name, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ICONS.info}</svg>`;

/** An argument preview (api's argPreview) with config text left out. */
export function scrubArg(a) { return /^"[{[]/.test(String(a)) ? '<config>' : String(a); }
/** Log lines and other text with quoted JSON config text left out. */
export function scrubText(s) { return String(s).replace(/"[{[](?:[^"\\]|\\.)*"/g, '<config>'); }

const QUIET_CALLS = new Set(['status', 'log', 'describe', 'skills', 'skill']);

/**
 * One Activity entry for a finished api call (the page's or an agent's), or
 * null for calls that are not activity (status, describe, the Logic view's graph calls).
 *   ctx  { at, nodes: Map base → node, config: { name, crc } | null (the loaded config), progress, durationMs?, via? }
 * → { at, kind, tone: 'ok'|'info'|'problem'|'stopped', icon, title, sub, durationMs, detail, html?, call }
 */
export function activityEvent(name, args, r, ctx = {}) {
  if (QUIET_CALLS.has(name) || name.startsWith('graph')) return null;
  const nodes = ctx.nodes || new Map();
  const argBase = parseBaseInput(String(args?.[0] ?? '').replace(/^"|"$/g, '')).value;
  const base = Number.isInteger(r?.base) ? r.base : argBase;
  const node = Number.isInteger(base) ? nodeRef(nodes.get(base), base) : null;
  const call = `api.${name}(${(args || []).map(scrubArg).join(', ')})`;
  const raw = JSON.stringify(r, null, 2);
  const ev = { at: ctx.at ?? Date.now(), kind: name, tone: 'ok', icon: 'check', title: '', sub: '', durationMs: r?.elapsedMs ?? ctx.durationMs ?? null, detail: `${call}\n${raw}`, call };

  if (!r?.ok) {
    const x = explainError(r, { op: name, node, progress: ctx.progress });
    const verb = name === 'connect' ? "Couldn't connect" : `${opLabel(name)} ${x.tone === 'warning' ? 'stopped' : 'failed'}`;
    return { ...ev, tone: x.tone === 'warning' ? 'stopped' : 'problem', icon: x.icon, title: `${verb}: ${x.headline}`, sub: x.meaning, where: x.where };
  }
  const cfgName = (crc) => (ctx.config && ctx.config.crc === crc ? ctx.config.name || 'the loaded config' : 'the given config');
  switch (name) {
    case 'connect':
      return { ...ev, icon: 'bt', title: `Connected to ${r.deviceName || 'hilux'}`,
        sub: r.already ? 'Was already connected' : ctx.via === 'chooser' ? 'Picked in the Bluetooth chooser' : ctx.via === 'click' ? 'Connect clicked: the remembered device, or the chooser if there was none' : 'Remembered device, no chooser' };
    case 'disconnect':
      return { ...ev, tone: 'info', icon: 'btOff', title: 'Disconnected from hilux', sub: '' };
    case 'discover': {
      const n = r.nodes.length;
      const extra = [r.unconfirmed?.length ? `${r.unconfirmed.length} didn't answer` : '', r.ignored?.length ? `${r.ignored.length} ignored (not a 10 Hz status frame; nothing sent)` : ''].filter(Boolean).join(' · ');
      return { ...ev, tone: n ? 'ok' : 'info', icon: 'search', title: n ? `Found ${n} node${n === 1 ? '' : 's'}` : 'No node answered',
        sub: n ? r.nodes.map(nodeLabel).join(', ') + (extra ? ` · ${extra}` : '') : (extra || r.hint || ''), html: discoverHtml(r, ctx.current ?? null) };
    }
    case 'listen':
      return { ...ev, tone: 'info', icon: 'wave', title: `Listened to the bus for ${fmtDuration(r.ms)}`, sub: `${r.totalFrames} frames, ${r.distinctIds} ids${r.bridgeRxDropped ? `, ${r.bridgeRxDropped} dropped by the bridge` : ''}`, html: listenHtml(r) };
    case 'version':
      return { ...ev, tone: 'info', icon: 'info', title: `${node} runs firmware ${r.text}`, sub: 'It answered a version request, so it is confirmed for writes this session' };
    case 'verify': {
      if (r.matches === undefined) return { ...ev, tone: 'info', icon: 'info', title: `Read ${node}'s running CRC: ${r.crcHex}`, sub: 'No config to compare with' };
      const nm = cfgName(r.expected.crc);
      return { ...ev, tone: r.matches ? 'ok' : 'info', icon: r.matches ? 'check' : 'differs', title: `Checked ${node}: ${r.matches ? 'matches' : 'differs from'} ${nm}`,
        sub: r.matches ? `CRC ${r.crcHex}, ${r.expected.count} parameters` : `node CRC ${r.crcHex}, ${nm} ${r.expected.crcHex}${r.warning ? ` · ${r.warning}` : ''}` };
    }
    case 'apply': {
      const tc = r.typeCheck?.seen ? `board ${r.typeCheck.deviceBoard ?? r.typeCheck.deviceType} confirmed` : 'board type not checked (no status frame)';
      return { ...ev, icon: 'apply', title: `Applied ${cfgName(r.crc)} to ${node}`,
        sub: [`${r.applied} parameters, checked: CRC ${r.crcHex}`, r.partial ? 'partial' : '', r.burned ? 'burned to flash' : 'not burned', tc, r.warning || ''].filter(Boolean).join(' · ') };
    }
    case 'burn':
      return { ...ev, icon: 'burn', title: `Burned ${node} to flash`, sub: 'Its running config now survives a power cycle' };
    case 'readParams':
      return { ...ev, tone: 'info', icon: 'info', title: `Read ${r.count} parameters from ${node}`, sub: `CRC ${r.crcHex}${r.fromCache ? ' (page from the last read)' : ''}` };
    case 'setParam':
      return { ...ev, icon: 'apply', title: `Set ${r.name} = ${JSON.stringify(r.value)} on ${node}`, sub: r.burned ? 'burned to flash' : 'not burned' };
    case 'getParam':
      return { ...ev, tone: 'info', icon: 'info', title: `${node}: ${r.name} = ${JSON.stringify(r.value)}`, sub: '' };
    case 'encode':
      return { ...ev, tone: 'info', icon: 'info', title: `Encoded ${r.name || 'a config'}: ${r.count} parameters`, sub: `CRC ${r.crcHex} · nothing sent` };
    case 'sendFrame':
      return { ...ev, tone: 'info', icon: 'wave', title: `Sent frame ${r.idHex} ${r.dataHex.replace(/(..)(?=.)/g, '$1 ')}`, sub: '' };
    case 'filter':
      return { ...ev, tone: 'info', icon: 'info', title: `Bridge filter: ${r.text}`, sub: '' };
    case 'firmwareInfo':
      return { ...ev, tone: 'info', icon: 'info', title: `hilux runs firmware ${shortSha(r.sha256)} from ${r.slotName}`,
        sub: [r.pending ? 'an update on trial, not yet confirmed' : 'confirmed', r.updatable ? `room for ${fmtBytes(r.maxLen)}` : 'takes no updates'].join(' · ') };
    case 'firmwareCheck':
      return { ...ev, tone: 'info', icon: 'file', title: `Checked a firmware image: ${shortSha(r.sha256)}, ${fmtBytes(r.len)}`,
        sub: [r.fits === false ? `too big (room for ${fmtBytes(r.maxLen)})` : '', r.sameAsRunning ? 'hilux already runs it' : '', 'nothing sent'].filter(Boolean).join(' · ') };
    case 'firmwareUpdate':
      return { ...ev, icon: 'check', title: `Updated hilux's firmware to ${shortSha(r.sha256)}`,
        sub: [`${slotName(r.previous?.slot)} → ${r.slotName}`, `${fmtBytes(r.len)} at ${r.kbps} kB/s`, r.resumes ? `${r.resumes} resume${r.resumes === 1 ? '' : 's'}` : '', `confirmed ${fmtDuration(r.confirmMs)} after the reset`].filter(Boolean).join(' · ') };
    default:
      return { ...ev, tone: 'info', icon: 'info', title: `${opLabel(name)} done`, sub: '' };
  }
}

/** A page-made "stopped" entry: the page refused before sending anything. */
export function stoppedEvent(op, headline, at = Date.now()) {
  return { at, kind: op, tone: 'stopped', icon: 'info', title: `Stopped ${opLabel(op)}: ${headline}`, sub: 'Nothing was sent.', durationMs: null, detail: '' };
}

const TONE_COLOR = { ok: 'c-info', info: 'c-muted', problem: 'c-danger', stopped: 'c-warn' };
export const isProblem = (ev) => ev.tone === 'problem' || ev.tone === 'stopped';

/** The timeline, newest first; filter 'problems' keeps failures and stops. Each entry's raw detail is collapsible. */
export function activityHtml(events, filter = 'all') {
  const list = [...events].reverse().filter((e) => filter !== 'problems' || isProblem(e));
  if (!list.length) return `<p class="empty">${filter === 'problems' ? 'No problems this session.' : 'Nothing yet this session.'}</p>`;
  return list.map((e) => {
    const detail = e.detail || e.html ? `<details class="raw"><summary>Technical detail</summary>${e.html ? `<div class="raw-html">${e.html}</div>` : ''}${e.detail ? `<pre>${esc(e.detail)}</pre>` : ''}</details>` : '';
    return `<div class="ev${e.tone === 'problem' ? ' ev-problem' : ''}"><span class="t">${fmtClock(e.at)}</span><span class="${TONE_COLOR[e.tone] ?? 'c-muted'}">${icon(e.icon)}</span><span class="what${e.tone === 'problem' ? ' c-danger' : ''}">${esc(e.title)}</span><span class="dur">${fmtDuration(e.durationMs)}</span>${e.sub ? `<span class="sub">${esc(e.sub)}</span>` : ''}${detail}</div>`;
  }).join('');
}

/**
 * "Copy for a bug report": every event with its detail, plus the versions and
 * the connection, and the scrubbed page log. Never config file contents.
 *   meta { page, url, userAgent, wasm, connection, nodes: [label], log: [line] }
 */
export function bugReport(events, meta = {}) {
  const L = ['dingo-web bug report', `generated: ${new Date(meta.now ?? Date.now()).toISOString()}`];
  L.push(`page: ${meta.page ?? '?'}${meta.url ? ` (${meta.url})` : ''}`);
  L.push(`wasm: ${meta.wasm ? JSON.stringify(meta.wasm) : 'not loaded'}`);
  if (meta.userAgent) L.push(`browser: ${meta.userAgent}`);
  if (meta.connection) L.push(`connection: ${meta.connection}`);
  L.push(`nodes (firmware): ${meta.nodes?.length ? meta.nodes.join(', ') : 'none found this session'}`);
  L.push('', `events, newest first (${events.length}):`);
  for (const e of [...events].reverse()) {
    L.push(`[${fmtClock(e.at)}] ${e.tone.toUpperCase()} ${e.title}${Number.isFinite(e.durationMs) ? ` (${fmtDuration(e.durationMs)})` : ''}`);
    if (e.sub) L.push(`  ${e.sub}`);
    if (e.detail) L.push(...scrubText(e.detail).split('\n').map((l) => `    ${l}`));
  }
  if (meta.log?.length) L.push('', `page log (last ${meta.log.length} lines):`, ...meta.log.map(scrubText));
  return L.join('\n') + '\n';
}

// ------------------------------------------------------- the node panel ----

/**
 * The selected node's status panel, claiming only what this page has seen.
 *   rec     { crc, crcHex, count?, at, source: 'check'|'apply', burned: { at, crc } | null } | null
 *   loaded  { name, crc, crcHex, count } | null (the loaded config's entry for this node)
 * → { tone: 'info'|'neutral', icon, headline, line, burnLine }
 */
export function nodeStatus(rec, loaded, now = Date.now()) {
  const burnLine = (() => {
    if (!rec?.burned) return 'Nothing was burned to flash from this page this session.';
    const when = `at ${fmtClock(rec.burned.at).slice(0, 5)} (this session)`;
    if (rec.burned.crc === null || rec.burned.crc === undefined) return `Burned to flash from this page ${when}.`;
    if (rec.burned.crc === rec.crc) return `Burned to flash from this page ${when}, so it survives a power cycle.`;
    return `Burned to flash from this page ${when}, but the running config has changed since: a power cycle brings back the burned one.`;
  })();
  if (!rec || rec.crc === null || rec.crc === undefined) {
    return { tone: 'neutral', icon: 'info', headline: rec ? 'Not checked since it last changed' : 'Not checked yet', line: 'Check reads the CRC of the config the node is running now.', burnLine };
  }
  const ago = `${rec.source === 'apply' ? 'applied' : 'checked'} ${fmtAgo(now - rec.at)}`;
  if (!loaded) return { tone: 'neutral', icon: 'info', headline: `Running config CRC ${rec.crcHex}`, line: `${ago} · load a config to compare`, burnLine };
  const name = loaded.name || 'the loaded config';
  if (rec.crc === loaded.crc) {
    return { tone: 'info', icon: 'check', headline: `Running config matches ${name}`, line: `CRC ${rec.crcHex}${Number.isFinite(loaded.count) ? ` · ${loaded.count} parameters` : ''} · ${ago}`, burnLine };
  }
  return { tone: 'neutral', icon: 'differs', headline: `Running config differs from ${name}`, line: `node CRC ${rec.crcHex} · ${name} ${loaded.crcHex} · ${ago}`, burnLine };
}

// ---------------------------------------------------------- Apply steps ----

/**
 * The Apply panel's steps: confirm the board → write → check the CRC.
 *   s { progress: { done, total } | null, result: api.apply result | null, total, board, crcHex }
 * → [{ label, status: 'done'|'now'|'todo'|'failed', note }]
 */
export function applySteps(s) {
  const total = s.result?.applied ?? s.progress?.total ?? s.total;
  const steps = [
    { label: s.board ? `Confirm the node is a ${s.board}` : "Confirm the node's board type", note: '' },
    { label: `Write ${Number.isFinite(total) ? total + ' ' : ''}parameters`, note: '' },
    { label: "Check the node's CRC matches", note: s.crcHex ?? '' },
  ];
  let at; // index of the step under way
  if (s.result?.ok) at = 3;
  else if (!s.progress) at = 0;
  else if (s.progress.done < s.progress.total) at = 1;
  else at = 2;
  if (s.result?.ok) {
    const tc = s.result.typeCheck;
    steps[0].label = tc?.seen ? `Confirmed the node is a ${s.board ?? tc.deviceBoard}` : 'Board type not checked: the node sent no status frame in time';
    steps[0].note = tc?.seen ? `board ${tc.deviceBoard ?? tc.deviceType}` : '';
    steps[1].label = `Wrote ${s.result.applied} parameters`;
    steps[2].label = "The node's count and CRC match";
    steps[2].note = s.result.crcHex;
  } else if (s.progress && Number.isFinite(s.progress.total)) {
    steps[1].note = `${s.progress.done} of ${s.progress.total}`;
  }
  const failed = s.result && !s.result.ok;
  return steps.map((st, i) => ({ ...st, status: i < at ? 'done' : i === at ? (failed ? 'failed' : 'now') : 'todo' }));
}

/** Rough time left from progress so far: "about 3 s left", or '' too early to say. */
export function etaText(progress, elapsedMs) {
  if (!progress || !Number.isFinite(progress.total) || progress.done < 8 || progress.done >= progress.total || !(elapsedMs > 0)) return '';
  const left = (elapsedMs / progress.done) * (progress.total - progress.done);
  return `about ${Math.max(1, Math.round(left / 1000))} s left`;
}

// ------------------------------------------------------------ the guard ----

/**
 * The amber "config is for a different node" block from configGuard().
 * → null (no block) | { headline, meaning, fixes: [{ base, label }] }
 */
export function guardView(g, info, nodes = new Map(), selected = null, cfgName = '') {
  if (!g || g.ok) return null;
  const pdms = info?.ok ? info.pdms : [];
  const target = pdms.map((p) => `the ${nodeAt(nodes.get(p.baseId) ?? { type: p.pdmType, board: p.board }, p.baseId)}`).join(' or ');
  const fixes = (g.fixes || []).map((b) => {
    const p = pdms.find((x) => x.baseId === b);
    const n = nodes.get(b) ?? (p ? { type: p.pdmType, board: p.board } : null);
    return { base: b, label: `Select ${n ? nodeTitle(n) : 'node'}${g.fixes.length > 1 || !n ? ' at ' + fmtBase(b) : ''}` };
  });
  const name = cfgName || 'This config';
  if (selected === null || selected === undefined) {
    return { headline: 'No node selected', meaning: `${name} is for ${target || 'another node'}. Select it to apply, check or burn.`, fixes };
  }
  const sel = nodes.get(selected);
  const selText = `the ${nodeAt(sel, selected)}`;
  return { headline: 'This config is for a different node', meaning: `${name} is for ${target || 'another node'}, but the selected node is ${selText}. Nothing is sent until they agree.`, fixes };
}

// ------------------------------------------------------------- firmware ----

/** What each firmware update phase (firmware.js / ota-client.js onProgress) is, for a person. */
export const FIRMWARE_PHASES = {
  begin: 'Starting the upload',
  upload: 'Sending the image',
  reconnect: 'The link dropped: reconnecting to resume',
  rebooting: 'Committed: hilux checked the image and is resetting',
  booting: 'Waiting for hilux to come back',
  trial: 'Running the update on trial (it confirms itself 20 s after its boot)',
};

/**
 * The firmware update's progress line → { label, pct, sentText, rateText, etaText }.
 * p: the last onProgress ({ phase, sent, total, kbps }); sent survives
 * the phases that report 0 (begin/reconnect after a drop) as `lastSent`.
 */
export function firmwareProgress(p, lastSent = 0) {
  if (!p) return { label: 'Starting', pct: 0, sentText: '', rateText: '', etaText: '' };
  const total = p.total || 0;
  const sent = p.phase === 'upload' ? p.sent : Math.max(p.sent || 0, ['rebooting', 'booting', 'trial'].includes(p.phase) ? total : lastSent);
  const pct = total ? Math.min(100, Math.round((sent * 100) / total)) : 0;
  const kbps = Number.isFinite(p.kbps) && p.kbps > 0 ? p.kbps : null;
  const eta = p.phase === 'upload' && kbps && sent < total ? `about ${Math.max(1, Math.round((total - sent) / kbps / 1000))} s left` : '';
  return { label: FIRMWARE_PHASES[p.phase] ?? p.phase, pct, sentText: total ? `${fmtBytes(sent)} of ${fmtBytes(total)}` : '', rateText: kbps ? `${kbps} kB/s` : '', etaText: eta };
}

/**
 * The Firmware panel's body (all but a problem block, which app.js draws with
 * its problemHtml). fw: { info, infoAt, reading, file: { name, size, check }
 * | null, confirming, running, progress, lastSent, started, result }.
 */
export function firmwareHtml(fw, now = Date.now()) {
  const stat = (k, v, cls = '', title = '') => `<div class="stat"${title ? ` title="${esc(title)}"` : ''}><span class="eb">${k}</span><div class="v ${cls}">${esc(v)}</div></div>`;
  const i = fw.info;
  const infoHtml = i
    ? `<div class="stats fwstats">${stat('Running', shortSha(i.sha256), 'mono', `sha256 ${i.sha256}`)}${stat('Slot', i.slotName, 'mono')}${stat('State', i.pending ? 'On trial' : 'Confirmed', 'txt')}${stat('Room', i.updatable ? fmtBytes(i.maxLen) : 'no updates', i.updatable ? 'mono' : 'txt', i.updatable ? `${i.maxLen} bytes` : '')}</div>
       <p class="hint" style="margin:0">Read ${fmtAgo(now - (fw.infoAt ?? now))}. The digest is the image's last 32 bytes, its identity (the C6 logs it at boot).${i.pending ? ' On trial: an update not yet confirmed; it confirms itself 20 s after its boot, and a new update waits until then.' : ''}</p>`
    : `<p class="hint" style="margin:0">${fw.reading ? 'Reading…' : "Not read yet. Read firmware info connects to hilux's firmware service (it needs the Firmware role, granted on the Kindle)."}</p>`;
  let fileHtml;
  const f = fw.file;
  if (!f) {
    fileHtml = `<div class="file fwdrop">${icon('file')}<div style="display:flex;flex-direction:column;gap:2px;min-width:0"><span class="nm">No image chosen</span><span class="sub">Drop wireless-can.bin here, or choose it. It is checked before anything is sent.</span></div></div>`;
  } else {
    const c = f.check;
    const sub = !c ? 'Checking…'
      : !c.ok ? `Not usable: ${c.error}`
        : [`${fmtBytes(c.len)}`, `sha256 ${shortSha(c.sha256)}`, c.fits === false ? `too big: room for ${fmtBytes(c.maxLen)}` : '', c.sameAsRunning ? 'hilux already runs it' : c.running ? 'differs from what hilux runs' : ''].filter(Boolean).join(' · ');
    fileHtml = `<div class="file fwdrop">${icon('file')}<div style="display:flex;flex-direction:column;gap:2px;min-width:0"><span class="nm">${esc(f.name)}</span><span class="sub${c && !c.ok ? ' c-danger' : ''}"${c?.ok ? ` title="sha256 ${esc(c.sha256)}"` : ''}>${esc(sub)}</span></div></div>`;
  }
  const canUpdate = !!(f?.check?.ok && f.check.fits !== false && !fw.running);
  const buttons = `<div class="actions">
      <button type="button" class="btn" data-act="fw-file"${fw.running ? ' disabled' : ''}>${icon('file')}Choose image…</button>
      <button type="button" class="btn pri" data-act="fw-confirm"${canUpdate && !fw.confirming ? '' : ' disabled'}>${icon('apply')}Update firmware…</button>
      <span class="hint">Update when parked: CAN frames are dropped during the 1–2 minute transfer (the PDMs keep running), then hilux resets.</span>
    </div>`;
  let confirmHtml = '';
  if (fw.confirming && f?.check?.ok) {
    confirmHtml = `<section class="prob confirm" role="alertdialog" aria-label="Confirm firmware update">${icon('alert')}<div class="body">
      <span class="eb c-danger">Firmware update · asks first</span>
      <h2 class="title">Update hilux to ${esc(shortSha(f.check.sha256))}?</h2>
      <p>${esc(f.name)} (${esc(fmtBytes(f.check.len))}) goes into the app slot hilux is not running${i ? ` (it runs ${esc(i.slotName)})` : ''}, is checked there, and boots next. While it uploads, CAN frames are dropped, so do this parked. hilux then resets (WiFi, Bluetooth and CAN go for a few seconds) and runs the update on trial: if it doesn't confirm itself within 20 s of booting, three times, hilux goes back to the firmware it runs now.</p>
      <div class="btns"><button type="button" class="btn danger solid" data-act="fw-go">Update firmware</button><button type="button" class="btn" data-act="fw-cancel">Cancel</button></div>
    </div></section>`;
  }
  let progressHtml = '';
  if (fw.running || fw.result) {
    const pr = firmwareProgress(fw.progress, fw.lastSent);
    const done = fw.result?.ok;
    const pct = done ? 100 : pr.pct;
    const indet = !done && ['begin', 'reconnect', 'booting', 'trial', 'rebooting'].includes(fw.progress?.phase ?? 'begin');
    const meta = [pr.sentText, pr.rateText, pr.etaText, fw.started ? fmtDuration(now - fw.started) : ''].filter(Boolean).join(' · ');
    progressHtml = `<div>
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
          <span style="font-weight:600">${esc(done ? 'Updated and confirmed' : fw.running ? pr.label : 'Stopped')}</span>
          <span class="mono hint">${esc(done ? `${fmtBytes(fw.result.len)} at ${fw.result.kbps} kB/s` : meta)}</span>
        </div>
        <div class="bar${indet && fw.running ? ' indet' : ''}" role="progressbar" aria-label="Firmware sent" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" style="margin-top:12px"><div style="${indet && fw.running ? '' : `width:${pct}%`}"></div></div>
      </div>`;
    if (done) {
      const r = fw.result;
      progressHtml += `<div class="result"><span class="st">${icon('check', 'ico sm')}</span><div style="display:flex;flex-direction:column;gap:6px;flex:1">
        <span class="eb c-info">Finished in ${esc(fmtDuration(r.ms))}</span>
        <span class="title">hilux runs ${esc(shortSha(r.sha256))}</span>
        <span>${esc(`From ${slotName(r.previous?.slot)} to ${r.slotName}; uploaded in ${fmtDuration(r.uploadMs)}${r.resumes ? `, resumed ${r.resumes} time${r.resumes === 1 ? '' : 's'} after a dropped link` : ''}; it confirmed itself ${fmtDuration(r.confirmMs)} after the reset.`)}</span>
        <div class="btns" style="display:flex;gap:10px;margin-top:6px"><button type="button" class="btn" data-act="fw-done">Done</button></div>
      </div></div>`;
    }
  }
  return `${infoHtml}${fileHtml}${buttons}${confirmHtml}${progressHtml}`;
}

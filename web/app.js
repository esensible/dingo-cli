// app.js — the human UI. Every button goes through window.api, so what a person
// sees is exactly what an agent gets (and an agent's calls show up in Activity
// too). The api is created before anything that can fail (WASM, Bluetooth), so
// window.api.describe() always works. The logic that needs no DOM lives in
// ui.js (tested in Node).

import { createBridge } from './ble.js';
import { createApi, createLogger, withUnknownGuard, API_NAME, API_VERSION } from './api.js';
import {
  esc, fmtBase, parseBaseInput, nodeLabel, boardLabel, configGuard, baseAfterLoad, baseAfterDiscover, loadExample,
  viewFor, fmtClock, fmtDuration, fmtAgo, nodeTitle, nodeRef, nodeAt, opLabel, explainError, icon,
  activityEvent, stoppedEvent, activityHtml, isProblem, bugReport, nodeStatus, applySteps, etaText, guardView,
} from './ui.js';
import { createFlowController, addOptionsHtml, propsHtml, propValue } from './flow.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------- log ----
// No log pane: the lines go to the console, into each Activity entry's
// technical detail (the lines logged while it ran) and into the bug report.

const logger = createLogger({
  max: 500,
  sink: (level, line) => { (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)('[dingo-web]', line); },
});
const logLines = []; // { t, line }
logger.onLine((line) => { logLines.push({ t: Date.now(), line }); if (logLines.length > 1000) logLines.splice(0, logLines.length - 1000); });

const bridge = createBridge({ bluetooth: navigator.bluetooth, log: logger.log });

async function loadDingoLazily() {
  // Dynamic import: a missing dingo-loader.js / dingo.wasm must not blank the page.
  const mod = await import('./dingo-loader.js');
  return mod.loadDingo();
}

async function fetchText(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

const api = createApi({ bridge, dingo: loadDingoLazily, fetchText, log: logger });
window.api = withUnknownGuard(api);

logger.log('info', `page loaded; Web Bluetooth ${navigator.bluetooth ? 'available' : 'NOT available'}${navigator.bluetooth && typeof navigator.bluetooth.getDevices === 'function' ? ', getDevices() supported' : ''}`);

// Per-viewer conveniences only: storage may be blocked (private window etc.).
function stored(key) { try { return localStorage.getItem(key); } catch { return null; } }
function store(key, v) { try { localStorage.setItem(key, v); } catch { /* ignore */ } }

// ----------------------------------------------------------------- state ----

const knownNodes = new Map(); // base → { base, baseHex, version, type, board } (discover / version this session)
const nodeRecs = new Map(); // base → { crc, crcHex, count?, at, source, burned } (what this page saw)
let selectedBase = null;
let lastDiscover = null; // { at, count }
const events = []; // Activity
let activityFilter = 'all';
let connProblem = null; // explainError() of the last connection failure (the banner)
const problems = { rail: null, action: null }; // { x: explainError(), op, retry }
let applyState = null; // the Apply panel
let busyOp = null; // a page-started device op

// ---------------------------------------------------------------- events ----

/** Add an Activity entry; the log lines written while it ran go into its detail. */
function addEvent(ev) {
  if (!ev) return;
  if (Number.isFinite(ev.durationMs)) {
    const from = ev.at - ev.durationMs - 50;
    const lines = logLines.filter((l) => l.t >= from && l.t <= ev.at + 5).map((l) => l.line);
    if (lines.length) ev.detail = `${ev.detail ? ev.detail + '\n\n' : ''}log:\n${lines.join('\n')}`;
  }
  events.push(ev);
  if (events.length > 300) events.splice(0, events.length - 300);
  renderLast();
  if (activityShown()) renderActivity();
}

// ---------------------------------------------------------------- status ----

// The filter as the C6 reports it, read back after every operation: the page's
// own copy (bridge.getFilter) is only what it last asked for. Shown in the
// connection pill's tooltip and the bug report.
let deviceFilter = null; // { entries } | { error } | null
const fmtEntries = (es) => (es.length ? es.map((e) => '0x' + e.id.toString(16).toUpperCase() + '/0x' + e.mask.toString(16).toUpperCase()).join(' ') : 'none');
let connecting = false; // a Connect click in progress (state may not have moved yet)

function connectionText() {
  const i = bridge.info();
  const parts = [`state ${i.state}`];
  if (i.deviceName) parts.push(`device ${i.deviceName}`);
  if (deviceFilter?.entries) {
    const local = fmtEntries(i.filter); const dev = fmtEntries(deviceFilter.entries);
    parts.push(`filter ${dev}${dev !== local ? ` (page set ${local})` : ''}`);
  } else if (deviceFilter?.error) parts.push(`filter unreadable: ${deviceFilter.error}`);
  parts.push(`tx ${i.counters.framesSent} rx ${i.counters.framesReceived}`, `reconnects ${i.reconnects}`);
  if (i.lastError) parts.push(`last error: ${i.lastError}`);
  return parts.join(' · ');
}

function renderTop() {
  const i = bridge.info();
  const pill = $('connPill');
  let cls = ''; let html;
  if (!i.bluetoothAvailable) html = `${icon('btOff', 'ico sm')}No Bluetooth in this browser`;
  else if (i.state === 'connected') { cls = 'connected'; html = `${icon('bt', 'ico sm')}Connected to ${esc(i.deviceName || 'hilux')}`; }
  else if (connecting || i.state === 'connecting') html = '<span class="spin"></span>Connecting…';
  else if (i.state === 'reconnecting') html = '<span class="spin"></span>Reconnecting…';
  else if (i.state === 'failed') { cls = 'failed'; html = `${icon('btOff', 'ico sm')}Connection lost`; }
  else html = `${icon('bt', 'ico sm')}Not connected`;
  pill.className = `pill ${cls}`;
  if (pill.innerHTML !== html) pill.innerHTML = html;
  pill.title = connectionText();
  const live = ['connected', 'connecting', 'reconnecting'].includes(i.state);
  $('btnConnect').hidden = i.state === 'connected';
  $('btnConnect').disabled = connecting || live;
  $('btnDisconnect').hidden = i.state === 'disconnected';
  $('btnChoose').disabled = connecting || ['connecting', 'reconnecting'].includes(i.state);
}

let filterRead = null;
function refreshDeviceFilter() {
  if (!bridge.isConnected()) { deviceFilter = null; renderTop(); return Promise.resolve(); }
  // Coalesce: one read at a time, and one more after it if asked meanwhile.
  if (filterRead) { filterRead.again = true; return filterRead.p; }
  const run = { again: false };
  run.p = (async () => {
    do {
      run.again = false;
      try { deviceFilter = { entries: await bridge.readFilter() }; } catch (e) { deviceFilter = { error: e.message }; }
      renderTop();
    } while (run.again && bridge.isConnected());
    filterRead = null;
  })();
  filterRead = run;
  return run.p;
}

let prevState = bridge.info().state;
bridge.onState((s) => {
  const i = bridge.info();
  if (s === 'connected') { refreshDeviceFilter(); connProblem = null; renderBanner(); } else deviceFilter = null;
  // Link events no api call reports: a drop, the reconnect, giving up.
  if (s === 'reconnecting' && prevState === 'connected') addEvent({ at: Date.now(), kind: 'link', tone: 'problem', icon: 'btOff', title: 'Lost the link to hilux; reconnecting', sub: 'The page retries 3 times', durationMs: null, detail: i.lastError || '' });
  if (s === 'connected' && prevState === 'reconnecting') addEvent({ at: Date.now(), kind: 'link', tone: 'ok', icon: 'bt', title: 'Reconnected to hilux', sub: 'The bridge filter was written again', durationMs: null, detail: '' });
  if (s === 'failed') {
    const x = explainError({ ok: false, error: i.lastError || 'auto-reconnect gave up' }, { op: 'connect' });
    connProblem = x; renderBanner();
    addEvent({ at: Date.now(), kind: 'link', tone: 'problem', icon: x.icon, title: `Couldn't reconnect: ${x.headline}`, sub: x.meaning, durationMs: null, detail: i.lastError || '' });
  }
  prevState = s;
  renderTop();
});
setInterval(() => { renderTop(); renderNodeCard(); renderRailNote(); }, 1000);

// -------------------------------------------------------------- problems ----

/** A problem block: headline, one sentence, next step (buttons / numbered steps), raw detail. */
function problemHtml(x, { eyebrow, slot, extraActions = [], dismiss = !!slot } = {}) {
  const acts = [...x.actions, ...extraActions];
  const btns = acts.map((a) => `<button type="button" class="btn${a.primary ? ' pri' : ''}" data-act="${esc(a.action)}"${slot ? ` data-slot="${slot}"` : ''}${a.base !== undefined ? ` data-base="${a.base}"` : ''}>${esc(a.label)}</button>`).join('');
  return `<section class="prob${x.tone === 'warning' ? ' warning' : ''}" role="alert">${icon(x.icon)}
    <div class="body">
      ${eyebrow ? `<span class="eb">${esc(eyebrow)}</span>` : ''}
      <h2 class="title">${esc(x.headline)}</h2>
      <p>${esc(x.meaning)}</p>
      ${x.steps.length ? `<ol>${x.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
      ${btns ? `<div class="btns">${btns}</div>` : ''}
      ${x.detail ? `<details class="raw"><summary>Technical detail</summary><pre>${esc(x.detail)}</pre></details>` : ''}
    </div>
    ${dismiss ? `<button type="button" class="btn quiet sm x" data-act="dismiss" data-slot="${slot}" aria-label="Dismiss">✕</button>` : ''}
  </section>`;
}

function renderBanner() {
  $('banner').innerHTML = connProblem ? problemHtml(connProblem, { eyebrow: connProblem.tone === 'warning' ? 'Connection' : 'Connection problem', slot: 'banner' }) : '';
}
function renderProblems() {
  for (const slot of ['rail', 'action']) {
    const p = problems[slot];
    $(slot === 'rail' ? 'railProblem' : 'actionProblem').innerHTML = p ? problemHtml(p.x, { eyebrow: `${opLabel(p.op)} · ${p.x.tone === 'warning' ? 'stopped, nothing sent' : 'failed'}`, slot }) : '';
  }
}
const SLOT_OF = { discover: 'rail', listen: 'rail', apply: 'action', verify: 'action', burn: 'action', version: 'action', setParam: 'action', getParam: 'action', readParams: 'action' };
const retries = {}; // slot → the function that last ran there

/** A person-facing problem in a slot (not from an api call: e.g. no node selected). */
function showProblem(slot, op, x) { problems[slot] = { x, op }; renderProblems(); $(slot === 'rail' ? 'railProblem' : 'actionProblem').scrollIntoView?.({ block: 'nearest' }); }

// One handler for every next-step button (banner, slots, guard, Apply panel).
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-act]');
  if (!b) {
    const n = e.target.closest?.('button.node[data-base]');
    if (n) { setBase(Number(n.dataset.base)); if (activityShown()) location.hash = ''; }
    return;
  }
  const slot = b.dataset.slot;
  const act = b.dataset.act;
  if (act === 'dismiss') { if (slot === 'banner') { connProblem = null; renderBanner(); } else { problems[slot] = null; renderProblems(); } return; }
  if (act === 'connect') return $('btnConnect').hidden ? null : $('btnConnect').click();
  if (act === 'choose') return $('btnChoose').click();
  if (act === 'retry') return retries[slot]?.();
  if (act === 'discover') return $('btnDiscover').click();
  if (act === 'check') return $('btnVerify').click();
  if (act === 'burn') return openBurnConfirm();
  if (act === 'json') return setView('json', true);
  if (act === 'open-file') return $('file').click();
  if (act === 'select') return setBase(Number(b.dataset.base));
  if (act === 'apply-done') { applyState = null; renderApplyPanel(); renderActions(); return; }
});

// ----------------------------------------------------------------- calls ----

/** The loaded config's entry for base (name, count, CRC), if the editor's config has one. */
function loadedFor(base) {
  if (!cfgInfo?.ok || !inspected || inspected !== $('config').value.trim()) return null;
  const p = cfgInfo.pdms.find((x) => x.baseId === base);
  return p && p.crc !== undefined ? { name: p.name || cfgSource || 'the loaded config', crc: p.crc, crcHex: p.crcHex, count: p.count, board: p.board, pdmType: p.pdmType } : null;
}

const QUIET = new Set(['status', 'log', 'describe', 'skills', 'skill']);
// Every non-trivial call, including ones an agent makes from script.
api._onCall(({ name, args, result: r }) => {
  if (QUIET.has(name) || name.startsWith('graph')) return; // the Logic view (every drag is a graphEdit) shows its own errors
  const at = Date.now();
  if (r.ok) {
    if (name === 'discover') { for (const n of r.nodes) knownNodes.set(n.base, n); lastDiscover = { at, count: r.nodes.length }; }
    if (name === 'version') knownNodes.set(r.base, { ...knownNodes.get(r.base), base: r.base, baseHex: r.baseHex, version: r.text });
    const prev = nodeRecs.get(r.base);
    if (name === 'verify') nodeRecs.set(r.base, { crc: r.crc, crcHex: r.crcHex, count: r.expected?.count, at, source: 'check', burned: prev?.burned ?? null });
    if (name === 'apply') nodeRecs.set(r.base, { crc: r.crc, crcHex: r.crcHex, count: r.applied, at, source: 'apply', burned: r.burned ? { at, crc: r.crc } : prev?.burned ?? null });
    if (name === 'burn') nodeRecs.set(r.base, { ...(prev ?? { crc: null, crcHex: null, at, source: 'check' }), burned: { at, crc: prev?.crc ?? null } });
    if (name === 'setParam') nodeRecs.set(r.base, { ...(prev ?? { at, source: 'check' }), crc: null, crcHex: null, burned: r.burned ? { at, crc: null } : prev?.burned ?? null });
  }
  const argBase = parseBaseInput(String(args?.[0] ?? '').replace(/^"|"$/g, '')).value;
  const base = Number.isInteger(r.base) ? r.base : argBase;
  const progress = name === 'apply' ? applyState?.progress ?? null : null;
  const ev = activityEvent(name, args, r, { at, nodes: knownNodes, config: Number.isInteger(base) ? loadedFor(base) : null, progress, current: selectedBase, via: name === 'connect' ? 'script' : undefined });
  addEvent(ev);
  if (!r.ok) {
    const x = explainError(r, { op: name, node: Number.isInteger(base) ? nodeRef(knownNodes.get(base), base) : null, progress });
    if (x.where === 'connection') { connProblem = x; renderBanner(); }
    // The Apply panel shows its own failure.
    else if (SLOT_OF[name] && !(name === 'apply' && applyState && !applyState.result)) problems[SLOT_OF[name]] = { x, op: name };
  } else if (problems[SLOT_OF[name]]?.op === name) problems[SLOT_OF[name]] = null;
  renderProblems();
  renderRail();
  renderNodeCard();
  renderCfgSummary();
  renderGuard();
  renderActions();
  refreshDeviceFilter();
});

// --------------------------------------------------------- selected node ----

function setBase(b) {
  selectedBase = Number.isInteger(b) ? b : null;
  $('base').value = selectedBase === null ? '' : fmtBase(selectedBase);
  $('base').classList.remove('bad');
  $('baseHint').textContent = '';
  if (selectedBase !== null) store('dingo-web.base', String(selectedBase));
  renderRail(); renderNodeCard(); renderCfgSummary(); renderGuard(); renderActions();
  if (flow.mounted && (cfgInfo?.pdms?.length ?? 0) > 1) flow.refresh(); // a file with several PDMs: draw the selected one
}
{
  const last = parseBaseInput(stored('dingo-web.base') ?? '');
  if (last.value !== null) { selectedBase = last.value; $('base').value = fmtBase(last.value); }
}
function useTypedBase() {
  const f = parseBaseInput($('base').value);
  if (f.value === null) { $('base').classList.add('bad'); $('baseHint').textContent = f.error || 'enter an address such as 0x500'; $('base').focus(); return; }
  setBase(f.value);
}
$('btnUseBase').onclick = useTypedBase;
$('base').addEventListener('keydown', (e) => { if (e.key === 'Enter') useTypedBase(); });

function renderRail() {
  const list = [...knownNodes.values()].sort((a, b) => a.base - b.base);
  if (selectedBase !== null && !knownNodes.has(selectedBase)) list.push({ base: selectedBase, unconfirmed: true });
  $('nodes').innerHTML = list.map((n) => {
    const on = n.base === selectedBase;
    const meta = n.unconfirmed ? `${fmtBase(n.base)} · not confirmed` : `${n.baseHex ?? fmtBase(n.base)}${n.version ? ` · fw ${esc(n.version)}` : ''}`;
    return `<button type="button" class="node${on ? ' on' : ''}" data-base="${n.base}"${on ? ' aria-current="true"' : ''} title="${n.unconfirmed ? 'entered by address; Find nodes or Read firmware version confirms it' : 'answered a version request this session'}">
      <span class="dot${n.unconfirmed ? '' : ' ok'}"></span>
      <span style="display:flex;flex-direction:column;gap:2px;min-width:0"><span class="nm">${esc(n.unconfirmed ? 'Node' : nodeTitle(n))}</span><span class="meta">${meta}</span></span></button>`;
  }).join('');
  renderRailNote();
}
function renderRailNote() {
  const how = 'Nodes are found by their 10 Hz status frames, then confirmed with a version request; nothing else is sent to them.';
  const t = lastDiscover
    ? `${lastDiscover.count ? `Found ${lastDiscover.count} node${lastDiscover.count === 1 ? '' : 's'}` : 'No node answered'} ${fmtAgo(Date.now() - lastDiscover.at)}. ${how}`
    : knownNodes.size ? how : `Not searched yet. ${how}`;
  if ($('railNote').textContent !== t) $('railNote').textContent = t;
}

function renderNodeCard() {
  const el = $('nodeCard');
  if (selectedBase === null) {
    el.innerHTML = `<div style="flex:1 1 320px"><span class="eb">Selected node</span><h1>No node selected</h1><p class="hint" style="margin:8px 0 0">Find nodes on the bus, or enter an address, then pick one on the left.</p></div>`;
    return;
  }
  const n = knownNodes.get(selectedBase);
  const st = nodeStatus(nodeRecs.get(selectedBase), loadedFor(selectedBase));
  const board = n?.board ?? (Number.isInteger(n?.type) ? `type ${n.type}` : null);
  const html = `<div style="flex:1 1 320px;display:flex;flex-direction:column;gap:14px">
      <div><span class="eb">Selected node</span><h1>${esc(n ? nodeTitle(n) : 'Node')}</h1></div>
      <dl class="kv">
        <dt>Address</dt><dd class="mono">${fmtBase(selectedBase)}</dd>
        <dt>Firmware</dt><dd class="${n?.version ? 'mono' : 'hint'}">${n?.version ? esc(n.version) : 'not read yet'}</dd>
        <dt>Board</dt><dd class="${board ? 'mono' : 'hint'}">${board ? esc(board) : 'unknown until Find nodes'}</dd>
      </dl>
    </div>
    <div class="status ${st.tone}">
      <span class="head">${icon(st.icon)}${esc(st.headline)}</span>
      <span class="line">${esc(st.line)}</span>
      <span class="burn">${esc(st.burnLine)}</span>
    </div>`;
  if (el.innerHTML !== html) el.innerHTML = html;
}

// -------------------------------------------------------------- config ----

const ta = $('config');
let cfgSource = null; // where the editor text came from ("c6-test.json", "example c6-test", ...)
let cfgInfo = null; // api._inspectConfig() of the editor text
let inspected = null; // the text cfgInfo describes
let inspecting = null; // { text, p }: the inspection of the editor text, done or under way

function inspect() {
  const text = ta.value.trim();
  if (inspecting?.text === text) return inspecting.p;
  const p = (async () => {
    const info = text ? await api._inspectConfig(text) : null;
    if (inspecting?.text === text) { cfgInfo = info; inspected = text; renderCfgSummary(); renderNodeCard(); renderGuard(); renderActions(); }
    return info;
  })();
  inspecting = { text, p };
  return p;
}

/** The PDM entry the page acts on: the selected node's, else the first. */
function shownPdm() {
  if (!cfgInfo?.ok || !cfgInfo.pdms.length) return null;
  return cfgInfo.pdms.find((p) => p.baseId === selectedBase) ?? cfgInfo.pdms[0];
}
function cfgName() { const p = shownPdm(); return p?.name || cfgSource || 'This config'; }

function renderCfgSummary() {
  const el = $('cfgSummary');
  const text = ta.value.trim();
  const fileBox = (name, sub, bad) => `<div class="file">${icon('file', 'ico')}<div style="display:flex;flex-direction:column;gap:2px;min-width:0"><span class="nm">${esc(name)}</span><span class="sub${bad ? ' c-danger' : ''}">${esc(sub)}</span></div></div>`;
  if (!text) { el.innerHTML = fileBox('No config loaded', 'Choose an example or open a dingoConfig .json file (or paste one in the JSON view).'); return; }
  if (!inspected || inspected !== text) return; // inspecting: keep what is shown
  const src = cfgSource || 'Pasted config';
  if (!cfgInfo?.ok) { el.innerHTML = fileBox(src, `Not a usable config: ${cfgInfo?.error ?? 'unreadable'}`, true); return; }
  if (!cfgInfo.pdms.length) { el.innerHTML = fileBox(src, 'No PdmDevices entry with a baseId, so there is nothing to apply.', true); return; }
  const sub = cfgInfo.pdms.map((p) => `${p.name || '(unnamed)'} · for ${nodeAt(knownNodes.get(p.baseId) ?? { type: p.pdmType, board: p.board }, p.baseId)}${p.error ? ` · can't encode: ${p.error}` : ''}`).join('; ');
  const p = shownPdm();
  const stat = (k, v, cls = '') => `<div class="stat"><span class="eb">${k}</span><div class="v ${cls}">${esc(v)}</div></div>`;
  el.innerHTML = fileBox(src, sub, cfgInfo.pdms.some((x) => x.error)) +
    `<div class="stats">${stat('Parameters', p.count ?? '—')}${stat('CRC', p.crcHex ? p.crcHex.replace(/^0x/, '') : '—', 'mono')}${stat('Board', boardLabel({ type: p.pdmType, board: p.board }), 'txt')}</div>`;
}

async function setConfig(text, source) {
  ta.value = text;
  cfgSource = source;
  store('dingo-web.config', text);
  store('dingo-web.configSource', source || '');
  renderCfgSummary();
  const info = await inspect();
  renderCfgSummary(); // the source may have changed even if the text did not
  // Loading is the person's own action, so it may select the config's node.
  const next = baseAfterLoad(info, selectedBase);
  if (next !== selectedBase) setBase(next);
  setView(viewFor(stored('dingo-web.view'), true));
  if (flow.mounted) flow.refresh();
}

$('example').onchange = async (e) => {
  const name = e.target.value;
  if (!name) return;
  try {
    const ex = await loadExample(name, fetchText);
    await setConfig(ex.text, `${ex.name}.json (example)`);
    logger.log('info', `loaded example ${ex.name} (${ex.text.length} chars) into the editor`);
  } catch (err) {
    showProblem('action', 'example', { tone: 'danger', icon: 'alert', headline: `Couldn't load the ${name} example`, meaning: 'The example file did not load or is not valid JSON.', steps: [], actions: [], detail: err.message });
  } finally {
    e.target.value = '';
  }
};

async function loadFile(file) {
  const text = await file.text();
  await setConfig(text, file.name);
  logger.log('info', `loaded ${file.name} (${text.length} chars) into the editor`);
}
$('btnOpen').onclick = () => $('file').click();
$('file').onchange = (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; };
ta.addEventListener('dragover', (e) => { e.preventDefault(); ta.classList.add('drag'); });
ta.addEventListener('dragleave', () => ta.classList.remove('drag'));
ta.addEventListener('drop', (e) => {
  e.preventDefault(); ta.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

function markEdited() {
  if (cfgSource && !/ \(edited\)$/.test(cfgSource)) cfgSource += ' (edited)';
  store('dingo-web.configSource', cfgSource || '');
}
let inspectTimer;
ta.addEventListener('input', () => {
  store('dingo-web.config', ta.value);
  markEdited();
  clearTimeout(inspectTimer);
  inspectTimer = setTimeout(() => { inspect(); renderView(); if (flow.mounted) flow.refresh(); }, 300);
});

// ------------------------------------------------------------- the view ----
// One view area: Logic (Cory Grant's dingoConfig flow editor, vendored and
// unmodified, behind flow.js) or JSON (the text). Same config: a graph edit
// rewrites the text through api.graphEdit; a text edit redraws the graph.

let view = 'json';
let mountSeq = 0;

function setView(v, remember) {
  if (v === 'logic' && !ta.value.trim()) v = 'json';
  if (remember) store('dingo-web.view', v);
  if (v === view && (v !== 'logic' || flow.mounted || mountSeq)) { renderView(); return; }
  view = v;
  renderView();
  if (v === 'logic') mountLogic();
  else { mountSeq = 0; flow.unmount(); flow.closeProps(); }
}

async function mountLogic() {
  const seq = ++mountSeq;
  showLogicError('');
  const r = await flow.mount($('logicHost'));
  if (seq !== mountSeq || view !== 'logic') { if (seq === mountSeq || view !== 'logic') flow.unmount(); return; }
  mountSeq = 0;
  if (!r.ok) logger.log('warn', `logic graph: ${r.error}`);
  renderView();
}

function renderView() {
  const has = !!ta.value.trim();
  $('viewLogic').setAttribute('aria-pressed', String(view === 'logic'));
  $('viewJson').setAttribute('aria-pressed', String(view === 'json'));
  $('viewLogic').disabled = !has;
  $('viewLogic').title = has ? 'the config as a function graph' : 'load a config first';
  $('logicView').hidden = view !== 'logic';
  $('jsonView').hidden = view !== 'json';
  $('logicTools').hidden = view !== 'logic' || !flow.mounted;
  $('logicInfo').hidden = view !== 'logic';
}
$('viewLogic').onclick = () => setView('logic', true);
$('viewJson').onclick = () => setView('json', true);

/** Which PdmDevices entry: the only one, else the selected node's, else the first. */
function logicBase() {
  const pdms = cfgInfo?.ok ? cfgInfo.pdms : [];
  if (pdms.length <= 1) return undefined;
  return pdms.some((p) => p.baseId === selectedBase) ? selectedBase : pdms[0].baseId;
}

/** An edit rewrote the config: put it in the JSON like a person's edit (no graph refresh: it came from the graph). */
function replaceConfigText(text) {
  ta.value = text;
  store('dingo-web.config', text);
  markEdited();
  inspect();
}

function showLogicError(msg) {
  $('logicError').innerHTML = msg ? problemHtml({ tone: 'warning', icon: 'info', headline: "The Logic view can't show this", meaning: msg, steps: [], actions: [{ action: 'json', label: 'Show JSON' }], detail: '' }) : '';
  if (msg) $('logicError').style.marginBottom = '12px';
}

/** Inline two-step confirm (no native dialog: it blocks automation). Resolves true/false. */
let confirmPending = null;
function logicConfirm(message) {
  confirmPending?.(false);
  return new Promise((resolve) => {
    const el = $('logicConfirm');
    let timer;
    const done = (v) => { clearTimeout(timer); el.innerHTML = ''; confirmPending = null; resolve(v); };
    confirmPending = done;
    el.innerHTML = `<section class="prob confirm" style="margin-bottom:12px">${icon('alert')}<div class="body"><h2 class="title">Remove from the flow?</h2><p>${esc(message)}</p>
      <div class="btns"><button type="button" class="btn danger solid" id="btnLogicYes">Remove</button><button type="button" class="btn" id="btnLogicNo">Cancel</button></div></div></section>`;
    $('btnLogicYes').onclick = () => done(true);
    $('btnLogicNo').onclick = () => done(false);
    timer = setTimeout(() => done(false), 20000);
  });
}

function renderLogicInfo(r, e) {
  const nodes = r.graph.nodes.length - 1;
  const parts = [`${r.name || '(unnamed)'} · ${r.board} · ${nodes} function${nodes === 1 ? '' : 's'}, ${r.graph.edges.length} wire${r.graph.edges.length === 1 ? '' : 's'}`];
  if (e && r.crcHex) parts.push(`after ${e.op}: ${r.count} params, CRC ${r.crcHex}${r.changed ? '' : ' (config unchanged)'}`);
  $('logicInfo').textContent = parts.join(' — ');
}

let propsSeq = 0;
async function renderProps(id) {
  const el = $('logicProps');
  const seq = ++propsSeq;
  if (!id) { el.innerHTML = ''; return; }
  const p = await flow.props(id);
  if (seq !== propsSeq) return; // a newer panel was asked for meanwhile
  el.innerHTML = p.ok ? propsHtml(p) : `<p class="c-danger">${esc(p.error)}</p>`;
}

const flow = createFlowController({
  api: window.api,
  getText: () => ta.value,
  setText: (text) => replaceConfigText(text),
  getBase: logicBase,
  confirm: logicConfirm,
  onError: (msg) => showLogicError(msg),
  onChange: (r, e) => {
    showLogicError('');
    $('logicAdd').innerHTML = addOptionsHtml(r.slots);
    renderLogicInfo(r, e);
    if (flow.propsId) renderProps(flow.propsId);
  },
  onProps: (id) => renderProps(id),
});

$('btnFit').onclick = () => flow.fitView();
$('logicAdd').onchange = async (e) => {
  const id = e.target.value;
  e.target.value = '';
  if (id) await flow.add(id);
};
$('logicProps').addEventListener('change', (e) => {
  const el = e.target.closest?.('[data-field]');
  if (el && flow.propsId) flow.set(flow.propsId, el.dataset.field, propValue(el));
});
$('logicProps').addEventListener('click', (e) => {
  const b = e.target.closest?.('button[data-prop-action]');
  if (!b || !flow.propsId) return;
  if (b.dataset.propAction === 'close') flow.closeProps();
  else if (b.dataset.propAction === 'remove') flow.remove(flow.propsId);
});

// ------------------------------------------------------------- the guard ----

/** The guard for config operations, from the selected node and the loaded config. */
function guardNow() {
  const text = ta.value.trim();
  return configGuard({ value: selectedBase }, text && text === inspected ? cfgInfo : null, knownNodes);
}

function renderGuard() {
  const g = guardNow();
  const gv = applyState ? null : guardView(g, cfgInfo, knownNodes, selectedBase, cfgName());
  $('guard').innerHTML = gv ? problemHtml({ tone: 'warning', icon: 'info', headline: gv.headline, meaning: gv.meaning, steps: [], detail: '',
    actions: [...gv.fixes.map((f, i) => ({ action: 'select', label: f.label, primary: i === 0, base: f.base })), { action: 'open-file', label: 'Choose another config' }] },
  { eyebrow: 'Config · blocks Apply, Check and Burn; sends nothing' }) : '';
  return g;
}

/** For a config operation: the base it may use, or null (stopped; says why). */
async function configOp(op) {
  const text = ta.value.trim();
  if (!text) {
    showProblem('action', op, { tone: 'warning', icon: 'info', headline: 'No config loaded', meaning: 'Choose an example or open a file first. Nothing was sent.', steps: [], actions: [{ action: 'open-file', label: 'Open file…' }], detail: '' });
    return null;
  }
  await inspect();
  const g = renderGuard();
  if (!g.ok) {
    const pdms = cfgInfo?.ok ? cfgInfo.pdms.map((p) => fmtBase(p.baseId)).join(' / ') : '?';
    addEvent(stoppedEvent(op, `${cfgName()} is for ${pdms}, selected node is ${selectedBase === null ? 'none' : fmtBase(selectedBase)}`));
    $('guard').scrollIntoView?.({ block: 'nearest' });
    return null;
  }
  return { text, base: g.base };
}

/** For a device-only operation: the selected node, or null (says why). */
function deviceBase(op) {
  if (selectedBase !== null) return selectedBase;
  showProblem('action', op, { tone: 'warning', icon: 'info', headline: 'No node selected', meaning: 'Find nodes on the bus, or enter an address, then pick one. Nothing was sent.', steps: [], actions: [{ action: 'discover', label: 'Find nodes', primary: true }], detail: '' });
  return null;
}

// --------------------------------------------------------------- actions ----

const busyButtons = ['btnDiscover', 'btnApply', 'btnVerify', 'btnBurn', 'btnVersion', 'btnListen'];
async function run(op, slot, fn) {
  busyOp = op;
  if (slot) { problems[slot] = null; renderProblems(); retries[slot] = () => run(op, slot, fn); }
  renderActions();
  try { return await fn(); } finally { busyOp = null; renderActions(); }
}

function renderActions() {
  busyButtons.forEach((b) => { $(b).disabled = !!busyOp; });
  $('btnDiscover').querySelector('span').textContent = busyOp === 'discover' ? 'Finding…' : 'Find nodes';
  $('btnVerify').textContent = busyOp === 'verify' ? 'Checking…' : 'Check';
  const n = selectedBase === null ? null : knownNodes.get(selectedBase);
  $('applyLabel').textContent = busyOp === 'apply' ? 'Applying…' : selectedBase === null ? 'Apply' : `Apply to ${n ? nodeTitle(n) : fmtBase(selectedBase)}`;
  $('actions').hidden = !!applyState;
}

async function connectClick(via, fn) {
  connecting = true;
  renderTop();
  const t0 = Date.now();
  try {
    const r = await fn();
    addEvent(activityEvent('connect', [], r, { at: Date.now(), durationMs: Date.now() - t0, via }));
    if (r.ok) connProblem = null; else connProblem = explainError(r, { op: 'connect' });
    renderBanner();
  } finally {
    connecting = false;
    renderTop();
    refreshDeviceFilter();
  }
}
// A real click: the remembered device first; the chooser only if there is none
// (or Chrome has not granted it the bridge service).
$('btnConnect').onclick = () => connectClick('click', () => api._connectWithChooser());
// Always the chooser (e.g. to pick hilux again).
$('btnChoose').onclick = () => connectClick('chooser', () => api._chooseDevice());
$('btnDisconnect').onclick = () => window.api.disconnect().then(renderTop);

$('btnDiscover').onclick = () => run('discover', 'rail', async () => {
  const r = await window.api.discover();
  if (!r.ok) return;
  const next = baseAfterDiscover(r.nodes, selectedBase);
  if (next !== selectedBase) setBase(next);
});
$('btnVersion').onclick = () => run('version', 'action', async () => { const b = deviceBase('version'); if (b !== null) await window.api.version(b); });
$('btnListen').onclick = () => run('listen', 'rail', async () => {
  const r = await window.api.listen({ ms: 2000 });
  if (r.ok) { openNewest = true; if (activityShown()) renderActivity(); else location.hash = 'activity'; }
});
$('btnVerify').onclick = () => run('verify', 'action', async () => {
  if (ta.value.trim()) { const c = await configOp('verify'); if (c) await window.api.verify(c.base, c.text); return; }
  const b = deviceBase('verify'); if (b !== null) await window.api.verify(b);
});

// Apply: progress from the WASM's onProgress (api._busy().progress), the steps, then the result.
$('btnApply').onclick = () => run('apply', 'action', async () => {
  const c = await configOp('apply'); if (!c) return;
  const p = loadedFor(c.base);
  const partial = $('partial').checked;
  const n = knownNodes.get(c.base);
  applyState = { base: c.base, name: p?.name || cfgName(), total: p?.count, crcHex: partial ? null : p?.crcHex, board: p ? boardLabel({ type: p.pdmType, board: p.board }) : null,
    node: nodeRef(n ?? (p ? { type: p.pdmType, board: p.board } : null), c.base), partial, started: Date.now(), progress: null, result: null, retry: retries.action };
  cancelBurn();
  renderApplyPanel(); renderActions(); renderGuard();
  $('applyPanel').scrollIntoView?.({ block: 'nearest' });
  const poll = setInterval(() => {
    const b = api._busy();
    if (b?.op === 'apply' && b.progress && Number.isFinite(b.progress.total)) { applyState.progress = b.progress; renderApplyPanel(); }
  }, 100);
  let r;
  try { r = await window.api.apply(c.base, c.text, { partial }); } finally { clearInterval(poll); }
  if (applyState) { applyState.result = r; applyState.ended = Date.now(); }
  renderApplyPanel(); renderActions();
});

function renderApplyPanel() {
  const el = $('applyPanel');
  const s = applyState;
  el.hidden = !s;
  if (!s) { el.innerHTML = ''; renderGuard(); return; }
  const steps = applySteps(s);
  const total = s.progress?.total ?? s.total;
  const done = s.result?.ok ? s.result.applied : s.progress?.done ?? 0;
  const known = Number.isFinite(total) && total > 0 && (s.progress || s.result?.ok);
  const pct = known ? Math.min(100, Math.round((done * 100) / total)) : 0;
  const running = !s.result;
  const eta = running ? etaText(s.progress, Date.now() - s.started) : '';
  const stepIco = { done: icon('check', 'ico sm'), failed: '✕', now: '', todo: '' };
  const stepsHtml = steps.map((st, i) => `<div class="row ${st.status}"><span class="st ${st.status}">${stepIco[st.status]}</span><span class="lbl">${esc(st.label)}</span><span class="note">${esc(i === 1 && st.status === 'now' && eta ? `${st.note} · ${eta}` : st.note)}</span></div>`).join('');
  let resultHtml = '';
  if (s.result?.ok) {
    const r = s.result;
    resultHtml = `<div class="result"><span class="st">${icon('check', 'ico sm')}</span><div style="display:flex;flex-direction:column;gap:6px;flex:1">
      <span class="eb c-info">Finished in ${fmtDuration(r.elapsedMs)}</span>
      <span class="title">${r.burned ? 'Applied, checked and burned' : 'Applied and checked'}</span>
      <span>${esc(`${s.node} is running ${s.name} (CRC ${r.crcHex}, ${r.applied} parameters${r.partial ? ', partial apply' : ''}).`)} ${r.burned ? 'It is burned to flash, so it survives a power cycle.' : "It isn't burned yet, so a power cycle brings back whatever is in flash."}</span>
      ${r.warning ? `<span class="c-warn">${esc(r.warning)}</span>` : ''}
      <div class="btns" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px">${r.burned ? '' : '<button type="button" class="btn danger" data-act="burn">Burn to flash…</button>'}<button type="button" class="btn" data-act="apply-done">Done</button></div>
    </div></div>`;
  } else if (s.result) {
    const x = explainError(s.result, { op: 'apply', node: s.node, progress: s.progress });
    resultHtml = problemHtml(x, { eyebrow: `Apply · ${x.tone === 'warning' ? 'stopped, nothing written' : 'failed'}`, slot: 'action', dismiss: false, extraActions: [{ action: 'apply-done', label: 'Close' }] });
  }
  el.innerHTML = `<div><span class="eb">${running ? 'Applying' : 'Applied'} ${esc(s.name)}</span><h2>to ${esc(s.node.replace(/ · 0x[0-9A-F]+$/, ''))} · <span class="mono" style="font-size:24px">${fmtBase(s.base)}</span></h2></div>
    <div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
        <span style="font-weight:600">${running ? (s.progress ? (s.progress.done < s.progress.total ? 'Writing parameters' : 'Checking') : 'Confirming the node') : s.result.ok ? 'Done' : 'Stopped'}</span>
        <span class="mono hint">${known ? `${done} of ${total}` : running ? '' : '—'}</span>
      </div>
      <div class="bar${running && !known ? ' indet' : ''}" role="progressbar" aria-label="Parameters written" aria-valuemin="0"${known ? ` aria-valuemax="${total}" aria-valuenow="${done}"` : ''} style="margin-top:12px"><div style="${known || !running ? `width:${known ? pct : 0}%` : ''}"></div></div>
      <div class="steps" style="margin-top:14px">${stepsHtml}</div>
    </div>
    ${running ? '<p class="hint" style="margin:0">Apply runs to the end once it starts (the page cannot stop it part-way). Nothing is burned to flash by Apply.</p>' : ''}
    ${resultHtml}`;
}

// Burn: an inline two-step confirm (no native dialog: it blocks automation).
let burnTimer;
function cancelBurn() { clearTimeout(burnTimer); $('burnConfirm').innerHTML = ''; }
async function openBurnConfirm() {
  cancelBurn();
  let base;
  if (applyState?.result?.ok) base = applyState.base;
  else if (ta.value.trim()) { const c = await configOp('burn'); if (!c) return; base = c.base; } else base = deviceBase('burn');
  if (base === null || base === undefined) return;
  const n = knownNodes.get(base);
  const who = nodeRef(n, base);
  $('burnConfirm').innerHTML = `<section class="prob confirm" role="alertdialog" aria-label="Confirm burn">${icon('burn')}<div class="body">
      <span class="eb c-danger">Burn to flash · asks first</span>
      <h2 class="title">Burn ${esc(who)} to flash?</h2>
      <p>Burn makes the config the node is running now (what Apply last wrote) survive power cycles. It sends no config itself: Apply, then Check, then Burn. Unburned changes are undone by a power cycle.</p>
      <div class="btns"><button type="button" class="btn danger solid" id="btnBurnYes">Burn ${fmtBase(base)} to flash</button><button type="button" class="btn" id="btnBurnNo">Cancel</button></div>
    </div></section>`;
  $('btnBurnNo').onclick = cancelBurn;
  $('btnBurnYes').onclick = () => {
    cancelBurn();
    run('burn', 'action', async () => {
      const r = await window.api.burn(base);
      if (applyState?.result?.ok && applyState.base === base && r.ok) { applyState.result = { ...applyState.result, burned: true }; renderApplyPanel(); }
    });
  };
  $('burnConfirm').scrollIntoView?.({ block: 'nearest' });
  burnTimer = setTimeout(cancelBurn, 15000);
}
$('btnBurn').onclick = openBurnConfirm;

// -------------------------------------------------------------- activity ----

function activityShown() { return location.hash === '#activity'; }

function renderLast() {
  const el = $('lastActivity');
  const ev = events[events.length - 1];
  const probs = events.filter(isProblem).length;
  const right = `<span class="go">Activity (${events.length})${probs ? ` · ${probs} problem${probs === 1 ? '' : 's'}` : ''}</span>`;
  if (!ev) { el.innerHTML = `<span class="c-muted">${icon('info')}</span><span class="what c-muted">Nothing yet this session</span>${right}`; return; }
  const color = { ok: 'c-info', info: 'c-muted', problem: 'c-danger', stopped: 'c-warn' }[ev.tone];
  el.innerHTML = `<span class="${color}">${icon(ev.icon)}</span><span class="what">${esc(ev.title)}</span><span class="when">${fmtClock(ev.at)}${Number.isFinite(ev.durationMs) ? ` · ${fmtDuration(ev.durationMs)}` : ''}</span>${right}`;
}

function renderActivity() {
  const probs = events.filter(isProblem).length;
  $('fltAll').setAttribute('aria-pressed', String(activityFilter === 'all'));
  $('fltProblems').setAttribute('aria-pressed', String(activityFilter === 'problems'));
  $('fltProblems').textContent = `Problems (${probs})`;
  // Keep open details open across re-renders.
  const open = new Set([...$('events').querySelectorAll('details[open]')].map((d) => d.closest('.ev')?.dataset.i));
  $('events').innerHTML = activityHtml(events, activityFilter);
  const shown = [...events].reverse().filter((e) => activityFilter !== 'problems' || isProblem(e));
  [...$('events').querySelectorAll('.ev')].forEach((row, k) => {
    const i = String(events.indexOf(shown[k]));
    row.dataset.i = i;
    if (open.has(i) || (openNewest && k === 0)) row.querySelector('details')?.setAttribute('open', '');
  });
  openNewest = false;
}
let openNewest = false; // Listen: show its table at once
$('fltAll').onclick = () => { activityFilter = 'all'; renderActivity(); };
$('fltProblems').onclick = () => { activityFilter = 'problems'; renderActivity(); };

$('btnCopy').onclick = async () => {
  const st = await window.api.status();
  const text = bugReport(events, {
    page: `${API_NAME} ${API_VERSION}`, url: location.href, userAgent: navigator.userAgent,
    wasm: st.wasm?.info ?? (st.wasm?.error ? { error: st.wasm.error } : null),
    connection: connectionText(),
    nodes: [...knownNodes.values()].map(nodeLabel),
    log: logger.lines(200),
  });
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const t = document.createElement('textarea');
    t.value = text; document.body.appendChild(t); t.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    t.remove();
  }
  $('copyLabel').textContent = ok ? `Copied (${events.length} events)` : 'Copy failed: see the console';
  if (!ok) console.log(text);
  setTimeout(() => { $('copyLabel').textContent = 'Copy for a bug report'; }, 2500);
};

function route() {
  const act = activityShown();
  $('activityView').hidden = !act;
  $('workspace').hidden = act;
  if (act) { renderActivity(); window.scrollTo(0, 0); }
}
window.addEventListener('hashchange', route);

// ----------------------------------------------------------------- start ----

// Restore the editor between reloads. The selected node is not changed to
// match: the guard says so if they differ.
{
  const saved = stored('dingo-web.config');
  if (saved && !ta.value) {
    ta.value = saved;
    cfgSource = (stored('dingo-web.configSource') || 'last session') + ' (restored)';
  }
}
renderTop(); renderBanner(); renderRail(); renderNodeCard(); renderCfgSummary(); renderActions(); renderLast(); renderProblems(); route();
renderView();
inspect().then(() => setView(viewFor(stored('dingo-web.view'), !!ta.value.trim())));

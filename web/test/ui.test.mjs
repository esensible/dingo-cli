// ui.test.mjs — the page logic that needs no DOM (web/ui.js): Base id input,
// the config-vs-Base-id guard, node labels, examples, result HTML.
//
//   podman exec dingo-web bash -lc 'cd /workspace/web && node --test test/'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXAMPLES, fmtBase, parseBaseInput, boardLabel, nodeLabel, configLabel, configGuard, baseAfterLoad, baseAfterDiscover,
  loadExample, listenHtml, discoverHtml, nodesHtml, esc,
  viewFor, fmtClock, fmtDuration, fmtAgo, nodeTitle, nodeRef, nodeAt, explainError, activityEvent, stoppedEvent, activityHtml,
  bugReport, scrubText, nodeStatus, applySteps, etaText, guardView,
} from '../ui.js';
import { ROLE_REFUSED, STALE_PAIRING } from '../ble.js';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const fetchText = async (url) => {
  const p = join(webDir, url.replace(/^\.\//, ''));
  if (!existsSync(p)) throw new Error(`HTTP 404 for ${url}`);
  return readFileSync(p, 'utf8');
};

const C6_NODE = { base: 0x500, baseHex: '0x500', version: '0.5.8', type: 12, board: 'c6body_v1' };
const PDM_NODE = { base: 0x700, baseHex: '0x700', version: '0.5.3', type: 0, board: 'dingoPDM' };
const nodes = new Map([[0x500, C6_NODE], [0x700, PDM_NODE]]);
const c6Info = { ok: true, pdms: [{ name: 'c6-body-test', baseId: 0x500, baseHex: '0x500', pdmType: 12, board: 'c6body_v1' }] };

test('ui: Base id accepts decimal or hex and is shown in hex', () => {
  assert.deepEqual(parseBaseInput('1280'), { value: 1280 });
  assert.deepEqual(parseBaseInput(' 0x500 '), { value: 1280 });
  assert.deepEqual(parseBaseInput('0X7fe'), { value: 0x7fe });
  assert.deepEqual(parseBaseInput(''), { value: null });
  assert.deepEqual(parseBaseInput(null), { value: null });
  assert.match(parseBaseInput('0x7FF').error, /out of range/);
  assert.match(parseBaseInput('5oo').error, /not a base id/);
  assert.equal(parseBaseInput('5oo').value, null);
  assert.equal(fmtBase(1792), '0x700');
  assert.equal(fmtBase(222), '0x0DE');
});

test('ui: a Base id that differs from the loaded config blocks config operations, with a one-click fix', () => {
  const g = configGuard(parseBaseInput('0x700'), c6Info, nodes);
  assert.deepEqual(g, { ok: false, message: 'Config is for 0x500 (c6-body-test); Base id is 0x700 (dingoPDM 0.5.3)', fixes: [0x500] });
  // the field in decimal names the same node
  assert.equal(configGuard(parseBaseInput('1792'), c6Info, nodes).message, g.message);
  // an unknown node: just the id
  assert.equal(configGuard(parseBaseInput('0x123'), c6Info, nodes).message, 'Config is for 0x500 (c6-body-test); Base id is 0x123');
  // empty or invalid field: blocked too
  assert.deepEqual(configGuard(parseBaseInput(''), c6Info, nodes), { ok: false, message: 'Config is for 0x500 (c6-body-test); Base id is empty', fixes: [0x500] });
  const bad = configGuard(parseBaseInput('zz'), c6Info, nodes);
  assert.equal(bad.ok, false); assert.match(bad.message, /^Base id: /); assert.deepEqual(bad.fixes, [0x500]);
  // agreeing: the config's base
  assert.deepEqual(configGuard(parseBaseInput('1280'), c6Info, nodes), { ok: true, base: 0x500 });
  // several PDMs in one file: the field picks one; otherwise every one is offered
  const two = { ok: true, pdms: [{ name: 'front', baseId: 222, baseHex: '0x0DE' }, { name: 'rear', baseId: 300, baseHex: '0x12C' }] };
  assert.deepEqual(configGuard(parseBaseInput('300'), two), { ok: true, base: 300 });
  const g2 = configGuard(parseBaseInput('0x500'), two, nodes);
  assert.equal(g2.message, 'Config is for 0x0DE (front) / 0x12C (rear); Base id is 0x500 (C6 body node 0.5.8)');
  assert.deepEqual(g2.fixes, [222, 300]);
  // no config, or one that does not parse: device ops use the field (the api reports the config error)
  assert.deepEqual(configGuard(parseBaseInput('0x700'), null), { ok: true, base: 0x700 });
  assert.deepEqual(configGuard(parseBaseInput('0x700'), { ok: false, error: 'not valid JSON' }), { ok: true, base: 0x700 });
});

test('ui: loading a config sets Base id; Discover sets it only when exactly one node answered', () => {
  assert.equal(baseAfterLoad(c6Info, 0x700), 0x500);
  assert.equal(baseAfterLoad(c6Info, null), 0x500);
  assert.equal(baseAfterLoad(c6Info, 0x500), 0x500);
  const two = { ok: true, pdms: [{ baseId: 222 }, { baseId: 300 }] };
  assert.equal(baseAfterLoad(two, 300), 300, 'the field already names one of them');
  assert.equal(baseAfterLoad(two, 0x700), 222);
  assert.equal(baseAfterLoad({ ok: false }, 0x700), 0x700);

  assert.equal(baseAfterDiscover([C6_NODE], 0x700), 0x500);
  assert.equal(baseAfterDiscover([C6_NODE, PDM_NODE], 0x123), 0x123, 'never silently changed with several nodes');
  assert.equal(baseAfterDiscover([], 0x123), 0x123);
});

test('ui: examples load from ./examples and are valid configs', async () => {
  assert.deepEqual(EXAMPLES.map((e) => e.name), ['bench-toggle', 'c6-empty', 'c6-test']);
  for (const e of EXAMPLES) {
    const ex = await loadExample(e.name, fetchText);
    assert.equal(ex.name, e.name);
    assert.ok(Array.isArray(JSON.parse(ex.text).PdmDevices), e.name);
  }
  await assert.rejects(loadExample('nope', fetchText), /no example named 'nope' \(have: bench-toggle, c6-empty, c6-test\)/);
  await assert.rejects(loadExample('c6-test', async () => '{ broken'), SyntaxError);
});

test('ui: node and config labels', () => {
  assert.equal(nodeLabel(PDM_NODE), 'dingoPDM · 0x700 · 0.5.3');
  assert.equal(nodeLabel(C6_NODE), 'C6 body node · 0x500 · 0.5.8');
  assert.equal(nodeLabel({ base: 0x500, baseHex: '0x500', version: '0.5.8' }), 'node · 0x500 · 0.5.8', 'version only, type unknown');
  assert.equal(nodeLabel({ base: 0x300, type: 9, board: null }), 'board type 9 · 0x300');
  assert.equal(boardLabel({ type: 1, board: 'dingoPDM-Max' }), 'dingoPDM-Max');
  assert.equal(configLabel(c6Info.pdms[0]), 'c6-body-test · C6 body node (c6body_v1) · 0x500');
  assert.equal(configLabel({ name: 'bench-toggle', baseId: 0x700, pdmType: 0, board: 'dingoPDM' }), 'bench-toggle · dingoPDM · 0x700');
});

test('ui: listen and discover results render as a table / clickable node list (escaped)', () => {
  const l = listenHtml({ ms: 2000, totalFrames: 40, distinctIds: 2, truncated: false, bridgeRxDropped: 0, ids: [
    { id: 0x502, idHex: '0x502', count: 20, hz: 10, dlc: 8, lastHex: '00C0000000000007' },
    { id: 0x5f0, idHex: '0x5F0', count: 20, hz: 10, dlc: 2, lastHex: '0101' },
  ] });
  assert.match(l, /<th>ID<\/th><th>count<\/th><th>Hz<\/th><th>DLC<\/th><th>last data<\/th>/);
  assert.match(l, /<td class="mono">0x502<\/td><td class="num">20<\/td><td class="num">10<\/td><td class="num">8<\/td><td class="mono">00 C0 00 00 00 00 00 07<\/td>/);
  assert.match(l, /40 frames, 2 ids in 2000 ms/);
  assert.match(listenHtml({ ms: 100, totalFrames: 0, distinctIds: 0, ids: [] }), /No frames/);

  const d = discoverHtml({ nodes: [C6_NODE, PDM_NODE], unconfirmed: [{ baseHex: '0x400', type: 0, board: 'dingoPDM', reason: 'no response <x>' }] }, 0x500);
  assert.match(d, /2 nodes answered — click one/);
  assert.match(d, /<button type="button" class="node current" data-base="1280"[^>]*>C6 body node · 0x500 · 0.5.8<\/button>/);
  assert.match(d, /<button type="button" class="node" data-base="1792"[^>]*>dingoPDM · 0x700 · 0.5.3<\/button>/);
  assert.match(d, /0x400 \(dingoPDM\): no response &lt;x&gt;/);
  const ig = discoverHtml({ nodes: [C6_NODE], unconfirmed: [], ignored: [{ base: 0x3ff, baseHex: '0x3FF', statusId: 0x401, type: 0, board: 'dingoPDM', hz: 1.3, reason: 'not a dingo status frame: 1.3 Hz (status is 10 Hz), constant; not probed' }] }, 0x500);
  assert.match(ig, /Ignored \(nothing sent\):.*0x401 → base 0x3FF: not a dingo status frame: 1.3 Hz \(status is 10 Hz\), constant; not probed/s);
  assert.match(discoverHtml({ nodes: [], unconfirmed: [], hint: 'try listen' }), /No node answered\. try listen/);
  assert.equal(nodesHtml([], null), '');
  assert.equal(esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

// ------------------------------------------------------------ the redesign ----

test('ui: Logic | JSON — Logic by default with a config, the remembered choice otherwise, JSON with nothing to draw', () => {
  assert.equal(viewFor(null, true), 'logic');
  assert.equal(viewFor('logic', true), 'logic');
  assert.equal(viewFor('json', true), 'json');
  assert.equal(viewFor('garbage', true), 'logic');
  assert.equal(viewFor('logic', false), 'json');
  assert.equal(viewFor(null, false), 'json');
});

test('ui: times and durations', () => {
  const d = new Date(2026, 9, 4, 23, 40, 37).getTime();
  assert.equal(fmtClock(d), '23:40:37');
  assert.equal(fmtDuration(113), '113 ms');
  assert.equal(fmtDuration(2049), '2.0 s');
  assert.equal(fmtDuration(64000), '1 min 4 s');
  assert.equal(fmtDuration(null), '—');
  assert.equal(fmtAgo(400), 'just now');
  assert.equal(fmtAgo(2500), '2 s ago');
  assert.equal(fmtAgo(65000), '1 min ago');
  assert.equal(fmtAgo(2 * 3600000), '2 h ago');
});

test('ui: node names by board, with the address', () => {
  assert.equal(nodeTitle(C6_NODE), 'C6 body node');
  assert.equal(nodeTitle({ base: 0x500, version: '0.5.8' }), 'Node');
  assert.equal(nodeRef(C6_NODE), 'C6 body node · 0x500');
  assert.equal(nodeRef(undefined, 0x123), 'node 0x123');
  assert.equal(nodeAt(PDM_NODE, 0x700), 'dingoPDM at 0x700');
  assert.equal(nodeAt(null, 0x123), 'node at 0x123');
});

test('ui: errors → headline, meaning, next step, technical detail; where they appear', () => {
  const role = explainError({ ok: false, error: `${ROLE_REFUSED} (Settings → …) [rx subscribe: NotSupportedError: GATT operation failed for unknown reason.]`, hint: 'a person must grant…' }, { op: 'connect' });
  assert.equal(role.where, 'connection'); assert.equal(role.tone, 'danger'); assert.equal(role.icon, 'lock');
  assert.equal(role.headline, "This computer isn't allowed to use the CAN bridge");
  assert.equal(role.steps.length, 3); assert.deepEqual(role.actions.map((a) => a.action), ['connect']);
  assert.match(role.detail, /rx subscribe: NotSupportedError.*\nhint: a person must grant/s);

  const stale = explainError({ ok: false, error: `NetworkError: Connection Error: Connection attempt failed. (the link dropped while connecting; ${STALE_PAIRING})` }, { op: 'connect' });
  assert.equal(stale.where, 'connection');
  assert.equal(stale.headline, "hilux seems to have refused this Mac's pairing");
  assert.match(stale.meaning, /Chrome doesn't say why/, 'inferred, and says so');
  assert.match(stale.steps[0], /Forget This Device/);

  const grant = explainError({ ok: false, error: `not connected: Chrome has not granted this page the CAN bridge service on hilux (it was picked before the service existed): a person must click the page's "Choose device…" button and pick it again` }, { op: 'apply' });
  assert.equal(grant.where, 'connection'); assert.deepEqual(grant.actions, [{ action: 'choose', label: 'Choose device…', primary: true }]);

  const none = explainError({ ok: false, error: "no remembered 'hilux' device: a person must click the page's Connect button once (Chrome only opens the Bluetooth chooser from a real click)" });
  assert.equal(none.where, 'connection'); assert.equal(none.tone, 'warning'); assert.equal(none.headline, 'Connect once to pick hilux');
  const cancel = explainError({ ok: false, error: 'NotFoundError: User cancelled the requestDevice() chooser.' });
  assert.equal(cancel.headline, 'No device was picked');
  assert.equal(explainError({ ok: false, error: 'Web Bluetooth is not available here (needs Chrome/Edge …)' }).headline, "This browser can't use Bluetooth");
  const far = explainError({ ok: false, error: 'waiting for an advertisement from hilux (is the C6 powered and in range?) timed out after 12000 ms' });
  assert.equal(far.headline, "Can't find hilux"); assert.equal(far.tone, 'warning'); assert.equal(far.where, 'connection');
  assert.equal(explainError({ ok: false, error: 'auto-reconnect gave up after 3 attempts: x' }).headline, 'Lost the connection to hilux');
  assert.equal(explainError({ ok: false, error: 'WASM not available: HTTP 404 for ./dingo.wasm' }).headline, "The page's dingo module didn't load");

  // Node problems: at the action, naming the node.
  const node = 'C6 body node · 0x500';
  const quiet = explainError({ ok: false, error: 'apply(0x500) failed: apply: PDM at base 0x500 (...): no response (want cmd 31) after 6 tries' }, { op: 'apply', node, progress: { done: 212, total: 385 } });
  assert.equal(quiet.where, 'action'); assert.equal(quiet.headline, 'C6 body node · 0x500 stopped answering during Apply');
  assert.match(quiet.meaning, /^It took 212 of 385 parameters, then went quiet/);
  assert.match(quiet.meaning, /nothing was burned/);
  assert.deepEqual(quiet.actions.map((a) => a.label), ['Apply again', 'Check the node']);
  const noAns = explainError({ ok: false, error: 'checkCrc(0x500) failed: no response' }, { op: 'verify', node });
  assert.equal(noAns.headline, "C6 body node · 0x500 didn't answer");
  assert.equal(explainError({ ok: false, error: 'refusing to write: no dingoPDM answered a version request at base 0x500 (x)' }, { op: 'burn', node }).headline, "C6 body node · 0x500 didn't answer");
  const burnFail = explainError({ ok: false, error: 'apply(0x500) failed: apply: PDM ...: applied 385 params (count + CRC verified) but burn failed: burn rejected: device WriteConfig returned 0' }, { op: 'apply', node });
  assert.match(burnFail.headline, /^Applied to C6 body node · 0x500, but the burn failed/);
  assert.equal(explainError({ ok: false, error: 'burn(0x500) failed: burn rejected: device WriteConfig returned 0' }, { op: 'burn', node }).headline, 'C6 body node · 0x500 refused to burn');

  // Stopped on purpose (amber), nothing sent.
  const baseChange = explainError({ ok: false, error: "refusing to apply: the config's PDM has baseId 1792 (0x700) but you targeted 1280 (0x500); applying would change the device's base id" }, { op: 'apply', node });
  assert.equal(baseChange.tone, 'warning'); assert.equal(baseChange.headline, "This config would change the node's address"); assert.match(baseChange.meaning, /Nothing was sent/);
  const type = explainError({ ok: false, error: 'refusing to apply: the node at base 0x500 broadcasts board type 0 (dingoPDM) but the config is for c6body_v1 (pdmType 12)' }, { op: 'apply', node });
  assert.equal(type.tone, 'warning'); assert.equal(type.meaning, 'The node says it is a dingoPDM, but the config is for c6body_v1. Nothing was written.');
  const busy = explainError({ ok: false, error: 'busy: discover running' }, { op: 'apply' });
  assert.equal(busy.tone, 'warning'); assert.match(busy.meaning, /^Find nodes is in progress/);
  const bad = explainError({ ok: false, error: 'encode failed: encode: malformed JSON at line 3, column 6 (byte 26): x' }, { op: 'apply' });
  assert.equal(bad.headline, "The config can't be used"); assert.deepEqual(bad.actions.map((a) => a.action), ['json']);

  // Unknown: the op's name, the api's hint as the meaning, the raw error as detail.
  const other = explainError({ ok: false, error: 'something odd', hint: 'try api.status()' }, { op: 'readParams' });
  assert.equal(other.headline, 'Read parameters failed'); assert.equal(other.meaning, 'Try api.status().'); assert.equal(other.detail, 'something odd\nhint: try api.status()');
});

test('ui: Activity entries from api calls (the page\'s and an agent\'s)', () => {
  const at = new Date(2026, 9, 4, 23, 40, 37).getTime();
  const nodes = new Map([[0x500, C6_NODE]]);
  const config = { name: 'c6-body-test', crc: 0xC1E4D8D1 };
  assert.equal(activityEvent('status', [], { ok: true }), null);
  assert.equal(activityEvent('graphEdit', [], { ok: true }), null);

  const cfgArg = JSON.stringify(JSON.stringify({ PdmDevices: [{ baseId: 1280 }] }).slice(0, 37) + '...');
  const v = activityEvent('verify', ['1280', cfgArg], { ok: true, base: 0x500, baseHex: '0x500', crc: 0xC1E4D8D1, crcHex: '0xC1E4D8D1', expected: { crc: 0xC1E4D8D1, crcHex: '0xC1E4D8D1', count: 385 }, matches: true, elapsedMs: 113 }, { at, nodes, config });
  assert.equal(v.title, 'Checked C6 body node · 0x500: matches c6-body-test');
  assert.equal(v.sub, 'CRC 0xC1E4D8D1, 385 parameters');
  assert.equal(v.tone, 'ok'); assert.equal(v.durationMs, 113);
  assert.equal(v.call, 'api.verify(1280, <config>)', 'config text never in the entry');
  assert.doesNotMatch(v.detail, /PdmDevices/);

  const d = activityEvent('verify', ['1280'], { ok: true, base: 0x500, crc: 1, crcHex: '0x00000001', expected: { crc: 2, crcHex: '0x00000002', count: 385 }, matches: false }, { at, nodes, config });
  assert.equal(d.title, 'Checked C6 body node · 0x500: differs from the given config', 'the name only when the CRC is the loaded config\'s');
  assert.equal(d.tone, 'info');

  const a = activityEvent('apply', ['1280', cfgArg], { ok: true, base: 0x500, applied: 385, crc: 0xC1E4D8D1, crcHex: '0xC1E4D8D1', burned: false, partial: false, typeCheck: { seen: true, deviceBoard: 'c6body_v1' }, elapsedMs: 2049 }, { at, nodes, config });
  assert.equal(a.title, 'Applied c6-body-test to C6 body node · 0x500');
  assert.equal(a.sub, '385 parameters, checked: CRC 0xC1E4D8D1 · not burned · board c6body_v1 confirmed');

  const f = activityEvent('apply', ['1280'], { ok: false, error: 'apply(0x500) failed: no response', elapsedMs: 6000 }, { at, nodes, progress: { done: 10, total: 385 } });
  assert.equal(f.tone, 'problem'); assert.equal(f.title, 'Apply failed: C6 body node · 0x500 stopped answering during Apply');
  const s = activityEvent('apply', ['1280'], { ok: false, error: 'busy: discover running' }, { at, nodes });
  assert.equal(s.tone, 'stopped'); assert.match(s.title, /^Apply stopped: /);
  const c = activityEvent('connect', [], { ok: false, error: 'NotFoundError: User cancelled the requestDevice() chooser.' }, { at });
  assert.equal(c.title, "Couldn't connect: No device was picked");
  assert.equal(activityEvent('connect', [], { ok: true, deviceName: 'hilux' }, { at }).sub, 'Remembered device, no chooser');

  const disc = activityEvent('discover', [], { ok: true, nodes: [C6_NODE, PDM_NODE], unconfirmed: [], ignored: [{ statusId: 0x401, baseHex: '0x3FF', reason: '1 Hz' }], elapsedMs: 8100 }, { at, current: 0x500 });
  assert.equal(disc.title, 'Found 2 nodes');
  assert.equal(disc.sub, 'C6 body node · 0x500 · 0.5.8, dingoPDM · 0x700 · 0.5.3 · 1 ignored (not a 10 Hz status frame; nothing sent)');
  assert.match(disc.html, /data-base="1280"/);
  assert.equal(stoppedEvent('verify', 'c6-test is for 0x500, selected node is 0x700', at).title, 'Stopped Check: c6-test is for 0x500, selected node is 0x700');
});

test('ui: Activity timeline — newest first, Problems filter, escaped, raw detail collapsible', () => {
  const t = new Date(2026, 9, 4, 23, 0, 0).getTime();
  const evs = [
    { at: t, tone: 'ok', icon: 'bt', title: 'Connected to hilux', sub: '', durationMs: 3200, detail: '' },
    { at: t + 1000, tone: 'problem', icon: 'alert', title: 'Apply failed: <x>', sub: 'went quiet', durationMs: 6000, detail: '{"ok":false}' },
    { at: t + 2000, tone: 'stopped', icon: 'info', title: 'Stopped Check', sub: 'Nothing was sent.', durationMs: null, detail: '' },
  ];
  const all = activityHtml(evs);
  assert.ok(all.indexOf('Stopped Check') < all.indexOf('Apply failed') && all.indexOf('Apply failed') < all.indexOf('Connected'), 'newest first');
  assert.match(all, /Apply failed: &lt;x&gt;/);
  assert.match(all, /<details class="raw"><summary>Technical detail<\/summary><pre>\{&quot;ok&quot;:false\}<\/pre><\/details>/);
  assert.match(all, /<span class="t">23:00:00<\/span>/); assert.match(all, /<span class="dur">3.2 s<\/span>/); assert.match(all, /<span class="dur">—<\/span>/);
  const probs = activityHtml(evs, 'problems');
  assert.doesNotMatch(probs, /Connected/); assert.match(probs, /Apply failed/); assert.match(probs, /Stopped Check/);
  assert.match(activityHtml([evs[0]], 'problems'), /No problems this session/);
  assert.match(activityHtml([]), /Nothing yet/);
});

test('ui: bug report has every event, detail and versions, and no config text', () => {
  const t = new Date(2026, 9, 4, 23, 0, 0).getTime();
  const evs = [{ at: t, tone: 'problem', title: 'Apply failed: x', sub: 'went quiet', durationMs: 6000, detail: 'api.apply(1280, <config>)\n{"ok":false}' }];
  const log = ['23:00:00.000 INFO  apply(1280, "{\\"PdmDevices\\":[{\\"pdmType\\":12,\\"na...") …', '23:00:06.000 ERROR apply failed after 6000 ms: no response'];
  const r = bugReport(evs, { now: t, page: 'dingo-web 1.1.0', url: 'http://localhost:5173/', userAgent: 'UA', wasm: { module: 'dingo-cli', go: 'go1.22.6', build: 'v1 x' }, connection: 'state connected', nodes: ['C6 body node · 0x500 · 0.5.8'], log });
  assert.match(r, /^dingo-web bug report\n/);
  assert.match(r, /page: dingo-web 1\.1\.0 \(http:\/\/localhost:5173\/\)/);
  assert.match(r, /wasm: \{"module":"dingo-cli","go":"go1\.22\.6","build":"v1 x"\}/);
  assert.match(r, /nodes \(firmware\): C6 body node · 0x500 · 0\.5\.8/);
  assert.match(r, /\[23:00:00\] PROBLEM Apply failed: x \(6\.0 s\)\n  went quiet\n    api\.apply\(1280, <config>\)\n    \{"ok":false\}/);
  assert.match(r, /INFO {2}apply\(1280, <config>\) …/);
  assert.doesNotMatch(r, /PdmDevices/);
  assert.equal(scrubText('x "[1,2]" y "plain"'), 'x <config> y "plain"');
});

test('ui: the selected node\'s status claims only what the page saw', () => {
  const now = new Date(2026, 9, 4, 23, 15, 30).getTime();
  const loaded = { name: 'c6-body-test', crc: 0xC1E4D8D1, crcHex: '0xC1E4D8D1', count: 385 };
  const none = nodeStatus(null, loaded, now);
  assert.equal(none.headline, 'Not checked yet'); assert.equal(none.burnLine, 'Nothing was burned to flash from this page this session.');
  const rec = { crc: 0xC1E4D8D1, crcHex: '0xC1E4D8D1', at: now - 2000, source: 'check', burned: null };
  const m = nodeStatus(rec, loaded, now);
  assert.equal(m.tone, 'info'); assert.equal(m.headline, 'Running config matches c6-body-test');
  assert.equal(m.line, 'CRC 0xC1E4D8D1 · 385 parameters · checked 2 s ago');
  const diff = nodeStatus({ ...rec, crc: 5, crcHex: '0x00000005', source: 'apply' }, loaded, now);
  assert.equal(diff.headline, 'Running config differs from c6-body-test');
  assert.equal(diff.line, 'node CRC 0x00000005 · c6-body-test 0xC1E4D8D1 · applied 2 s ago');
  assert.equal(nodeStatus(rec, null, now).headline, 'Running config CRC 0xC1E4D8D1');
  const burnAt = new Date(2026, 9, 4, 23, 15, 7).getTime();
  assert.equal(nodeStatus({ ...rec, burned: { at: burnAt, crc: rec.crc } }, loaded, now).burnLine, 'Burned to flash from this page at 23:15 (this session), so it survives a power cycle.');
  assert.match(nodeStatus({ ...rec, burned: { at: burnAt, crc: 7 } }, loaded, now).burnLine, /but the running config has changed since/);
  assert.equal(nodeStatus({ crc: null, at: now, burned: { at: burnAt, crc: null } }, loaded, now).headline, 'Not checked since it last changed');
});

test('ui: Apply steps — confirm the board → write → check the CRC', () => {
  const base = { total: 385, board: 'C6 body node', crcHex: '0xC1E4D8D1' };
  assert.deepEqual(applySteps({ ...base, progress: null, result: null }).map((s) => s.status), ['now', 'todo', 'todo']);
  const w = applySteps({ ...base, progress: { done: 212, total: 385 }, result: null });
  assert.deepEqual(w.map((s) => s.status), ['done', 'now', 'todo']);
  assert.equal(w[0].label, 'Confirm the node is a C6 body node'); assert.equal(w[1].label, 'Write 385 parameters'); assert.equal(w[1].note, '212 of 385'); assert.equal(w[2].note, '0xC1E4D8D1');
  assert.deepEqual(applySteps({ ...base, progress: { done: 385, total: 385 }, result: null }).map((s) => s.status), ['done', 'done', 'now']);
  const ok = applySteps({ ...base, progress: { done: 385, total: 385 }, result: { ok: true, applied: 385, crcHex: '0xC1E4D8D1', typeCheck: { seen: true, deviceBoard: 'c6body_v1' } } });
  assert.deepEqual(ok.map((s) => s.status), ['done', 'done', 'done']);
  assert.deepEqual(ok.map((s) => s.label), ['Confirmed the node is a C6 body node', 'Wrote 385 parameters', "The node's count and CRC match"]);
  assert.equal(ok[0].note, 'board c6body_v1');
  assert.equal(applySteps({ ...base, progress: null, result: { ok: true, applied: 385, crcHex: 'x', typeCheck: { seen: false } } })[0].label, 'Board type not checked: the node sent no status frame in time');
  assert.deepEqual(applySteps({ ...base, progress: { done: 212, total: 385 }, result: { ok: false, error: 'no response' } }).map((s) => s.status), ['done', 'failed', 'todo']);
  assert.deepEqual(applySteps({ ...base, progress: null, result: { ok: false, error: 'refusing' } }).map((s) => s.status), ['failed', 'todo', 'todo']);
  assert.equal(etaText({ done: 200, total: 400 }, 1000), 'about 1 s left');
  assert.equal(etaText({ done: 2, total: 400 }, 100), '', 'too early to say');
  assert.equal(etaText(null, 100), '');
});

test('ui: the config/node guard as a person reads it', () => {
  const g = configGuard({ value: 0x700 }, c6Info, nodes);
  const v = guardView(g, c6Info, nodes, 0x700, 'c6-body-test');
  assert.equal(v.headline, 'This config is for a different node');
  assert.equal(v.meaning, 'c6-body-test is for the C6 body node at 0x500, but the selected node is the dingoPDM at 0x700. Nothing is sent until they agree.');
  assert.deepEqual(v.fixes, [{ base: 0x500, label: 'Select C6 body node' }]);
  const empty = guardView(configGuard({ value: null }, c6Info, nodes), c6Info, new Map(), null, 'c6-body-test');
  assert.equal(empty.headline, 'No node selected');
  assert.equal(empty.fixes[0].label, 'Select C6 body node', 'named from the config when the node has not been found');
  assert.equal(guardView(configGuard({ value: 0x500 }, c6Info, nodes), c6Info, nodes, 0x500), null);
});

// timers.js: native timers while visible; a MessageChannel loop for timers
// due soon while the tab is hidden (where native timers are late by up to ~1 s).
//
//   node --test web/test/timers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimers, HIDDEN_SLACK_MS } from '../timers.js';

function fakeDoc(state = 'visible') {
  const listeners = [];
  return {
    visibilityState: state,
    addEventListener: (ev, cb) => { if (ev === 'visibilitychange') listeners.push(cb); },
    set(s) { this.visibilityState = s; listeners.forEach((cb) => cb()); },
  };
}

function fakeNative() {
  const calls = [];
  let n = 0;
  return {
    calls,
    setTimeoutFn: (cb, ms) => { const h = ++n; calls.push({ h, cb, ms, cleared: false }); return h; },
    clearTimeoutFn: (h) => { const c = calls.find((x) => x.h === h); if (c) c.cleared = true; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('visible: a native timer for the whole delay', () => {
  const nat = fakeNative();
  const t = createTimers({ doc: fakeDoc('visible'), ...nat });
  let fired = 0;
  t.setTimeout(() => fired++, 8);
  assert.equal(nat.calls.length, 1);
  assert.ok(Math.abs(nat.calls[0].ms - 8) < 1);
  nat.calls[0].cb();
  assert.equal(fired, 1);
  assert.equal(t.pending(), 0);
});

test('no document (node, tests): native timers', () => {
  const nat = fakeNative();
  const t = createTimers({ doc: undefined, ...nat });
  t.setTimeout(() => {}, 5);
  assert.equal(nat.calls.length, 1);
});

test('hidden: a timer due soon runs off the message loop, on time, with no native timer', async () => {
  const nat = fakeNative();
  const t = createTimers({ doc: fakeDoc('hidden'), ...nat });
  const t0 = performance.now();
  const at = await new Promise((r) => t.setTimeout(() => r(performance.now()), 8));
  assert.equal(nat.calls.length, 0, 'no native timer for a short hidden timer');
  assert.ok(at - t0 >= 8, `fired early: ${at - t0} ms`);
  assert.ok(at - t0 < 100, `fired late: ${at - t0} ms`);
  assert.equal(t.pending(), 0);
});

test('hidden: several timers fire in due order; a cleared one never fires', async () => {
  const t = createTimers({ doc: fakeDoc('hidden'), ...fakeNative() });
  const order = [];
  t.setTimeout(() => order.push('c'), 30);
  t.setTimeout(() => order.push('a'), 5);
  const gone = t.setTimeout(() => order.push('x'), 10);
  t.setTimeout(() => order.push('b'), 15);
  t.clearTimeout(gone);
  await sleep(80);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(t.pending(), 0);
});

test('hidden: a long timer sleeps natively until HIDDEN_SLACK_MS before it is due', () => {
  const nat = fakeNative();
  const t = createTimers({ doc: fakeDoc('hidden'), ...nat });
  t.setTimeout(() => {}, 5000);
  assert.equal(nat.calls.length, 1);
  assert.ok(Math.abs(nat.calls[0].ms - (5000 - HIDDEN_SLACK_MS)) < 2, `native ${nat.calls[0].ms}`);
  t.clearTimeout(1);
  assert.equal(nat.calls[0].cleared, true);
});

test('going hidden re-arms a pending native timer, which then fires on time', async () => {
  const doc = fakeDoc('visible');
  const nat = fakeNative();
  const t = createTimers({ doc, ...nat });
  const t0 = performance.now();
  const fired = new Promise((r) => t.setTimeout(() => r(performance.now()), 20));
  assert.equal(nat.calls.length, 1);
  doc.set('hidden');
  assert.equal(nat.calls[0].cleared, true, 'the native timer is replaced');
  const at = await fired;
  assert.ok(at - t0 >= 20 && at - t0 < 120, `fired at ${at - t0} ms`);
});

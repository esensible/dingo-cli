// timers.js — setTimeout/clearTimeout that keep time while the tab is hidden.
//
// Why: Chrome (and macOS under it) coarsens timers in a hidden tab. Measured
// on the hardware (2026-10-19, Chrome on macOS, the dingo-web tab in the
// background): setTimeout(5) fired after 337 ms, setTimeout(2) after up to
// 1036 ms; a dedicated Worker's setTimeout(2) after ~64 ms. The WASM's
// protocol keeps time with Go timers, which wasm_exec.js turns into
// setTimeout: WriteAll's 8 ms pause after every 8 params became ~0.5-1 s, so
// an apply of 2269 params ran 135 s instead of ~4 s and the PDM staged only
// 2112 of them (`write count mismatch`). Message events are not coarsened
// (a MessageChannel round trip measured 0.1 ms in the same hidden tab).
//
// So: while the tab is visible a timer is the native setTimeout. While it is
// hidden, a timer due within HIDDEN_SLACK_MS is run off a MessageChannel
// loop that checks performance.now() (a native timer would be late by up to
// about a second); one due later sleeps natively until HIDDEN_SLACK_MS before
// it is due, then joins the loop. A tab that becomes hidden re-arms its
// pending native timers the same way. The loop runs only while a timer is
// that close to due, so a hidden page spends CPU only during the short waits
// of a device op (and, at most, the last HIDDEN_SLACK_MS of a longer one).
//
// No DOM access beyond document.visibilityState and its visibilitychange
// event; everything is injectable for tests.

export const HIDDEN_SLACK_MS = 1100;

/**
 * createTimers({ doc, now, setTimeoutFn, clearTimeoutFn, MessageChannelCtor })
 *   → { setTimeout(cb, ms) → id, clearTimeout(id), pending() }
 */
export function createTimers({
  doc = globalThis.document,
  now = () => globalThis.performance.now(),
  setTimeoutFn = globalThis.setTimeout.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout.bind(globalThis),
  MessageChannelCtor = globalThis.MessageChannel,
} = {}) {
  const timers = new Map(); // id → { cb, due, native }
  const spinning = new Set(); // ids run off the message loop
  let seq = 0;
  let channel = null;
  let looping = false;

  const hidden = () => !!doc && doc.visibilityState === 'hidden';

  function fire(id) {
    const t = timers.get(id);
    if (!t) return;
    timers.delete(id);
    spinning.delete(id);
    t.cb();
  }

  function loop() {
    const n = now();
    for (const id of [...spinning]) {
      const t = timers.get(id);
      if (t && t.due <= n) fire(id);
    }
    if (spinning.size) { channel.port2.postMessage(0); return; }
    // idle: let the channel go (an open port also keeps a node process alive)
    looping = false;
    channel.port1.close();
    channel = null;
  }

  function kick() {
    if (looping) return;
    if (!channel) {
      channel = new MessageChannelCtor();
      channel.port1.onmessage = loop;
    }
    looping = true;
    channel.port2.postMessage(0);
  }

  function arm(id, t) {
    const left = t.due - now();
    if (!hidden() || !MessageChannelCtor) {
      t.native = setTimeoutFn(() => { t.native = null; fire(id); }, Math.max(0, left));
      return;
    }
    if (left > HIDDEN_SLACK_MS) {
      t.native = setTimeoutFn(() => { t.native = null; if (timers.has(id)) arm(id, t); }, left - HIDDEN_SLACK_MS);
      return;
    }
    spinning.add(id);
    kick();
  }

  // A tab going hidden: native timers already set would now be late.
  doc?.addEventListener?.('visibilitychange', () => {
    if (!hidden()) return;
    for (const [id, t] of timers) {
      if (t.native === null) continue;
      clearTimeoutFn(t.native);
      t.native = null;
      arm(id, t);
    }
  });

  return {
    setTimeout(cb, ms = 0) {
      const id = ++seq;
      const t = { cb, due: now() + Math.max(0, Number(ms) || 0), native: null };
      timers.set(id, t);
      arm(id, t);
      return id;
    },
    clearTimeout(id) {
      const t = timers.get(id);
      if (!t) return;
      if (t.native !== null) clearTimeoutFn(t.native);
      timers.delete(id);
      spinning.delete(id);
    },
    pending() { return timers.size; },
  };
}

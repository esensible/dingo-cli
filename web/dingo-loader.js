// dingo-loader.js — load web/dingo.wasm (the dingo-cli Go module) and return
// globalThis.dingo. See web/README.md for the API.
//
//   import { loadDingo } from "./dingo-loader.js";
//   const dingo = await loadDingo();          // fetches ./dingo.wasm
//
// `source` may be a URL/string to fetch, or the module bytes (ArrayBuffer /
// TypedArray) when they are already in hand. Loading is idempotent: later calls
// return the same instance. Unlike the dingo.* operations, loadDingo rejects
// (throws) if the module cannot be loaded, since there is no dingo to report to.

import { createTimers } from "./timers.js";

let loading = null;

/**
 * The Go runtime's timers (time.Sleep, timeouts) on `timers` instead of the
 * page's setTimeout, which a hidden tab coarsens to up to ~1 s (timers.js):
 * the protocol's pacing (WriteAll's 8 ms pauses) and its timeouts keep time
 * in a background tab. Same logic as wasm_exec.js's own
 * runtime.scheduleTimeoutEvent / clearTimeoutEvent (Go 1.22), which this
 * replaces in the import object; wasm_exec.js itself stays Go's file.
 */
function useTimers(go, timers) {
  const gojs = go.importObject.gojs;
  const getInt64 = (addr) => go.mem.getUint32(addr, true) + go.mem.getInt32(addr + 4, true) * 4294967296;
  gojs["runtime.scheduleTimeoutEvent"] = (sp) => {
    sp >>>= 0;
    const id = go._nextCallbackTimeoutID;
    go._nextCallbackTimeoutID++;
    go._scheduledTimeouts.set(id, timers.setTimeout(() => {
      go._resume();
      while (go._scheduledTimeouts.has(id)) {
        // as wasm_exec.js: https://github.com/golang/go/issues/28975
        console.warn("scheduleTimeoutEvent: missed timeout event");
        go._resume();
      }
    }, getInt64(sp + 8)));
    go.mem.setInt32(sp + 16, id, true);
  };
  gojs["runtime.clearTimeoutEvent"] = (sp) => {
    sp >>>= 0;
    const id = go.mem.getInt32(sp + 8, true);
    timers.clearTimeout(go._scheduledTimeouts.get(id));
    go._scheduledTimeouts.delete(id);
  };
}

export function loadDingo(source = "./dingo.wasm") {
  if (!loading) {
    loading = load(source).catch((e) => {
      loading = null; // allow a retry after a failed load
      throw e;
    });
  }
  return loading;
}

async function load(source) {
  if (typeof globalThis.Go !== "function") {
    // wasm_exec.js is a classic script that defines globalThis.Go; importing it
    // evaluates it. Resolve it next to this module, not the page.
    await import(new URL("./wasm_exec.js", import.meta.url).href);
    if (typeof globalThis.Go !== "function") {
      throw new Error("dingo: wasm_exec.js loaded but did not define globalThis.Go");
    }
  }
  const go = new globalThis.Go();
  useTimers(go, createTimers());
  const { instance } = await instantiate(source, go.importObject);

  // go.run resolves only when the Go program exits, which it should never do.
  let exited = false;
  const run = go.run(instance).then(
    () => { exited = true; },
    (e) => { exited = true; throw e; },
  );
  run.catch(() => {}); // surfaced below instead

  // main() registers globalThis.dingo before it first blocks, i.e. before
  // go.run returns control here; the loop only guards against a slow start.
  for (let i = 0; i < 200 && !globalThis.dingo; i++) {
    if (exited) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!globalThis.dingo) {
    if (exited) await run; // rethrows the Go exit error, if any
    throw new Error(exited
      ? "dingo: Go program exited before registering globalThis.dingo"
      : "dingo: globalThis.dingo was not registered within 2s");
  }
  await globalThis.dingo.ready;
  return globalThis.dingo;
}

async function instantiate(source, imports) {
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    return WebAssembly.instantiate(source, imports);
  }
  const url = String(source);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`dingo: fetch ${url} failed: HTTP ${resp.status} ${resp.statusText}`);
  }
  const type = resp.headers.get("content-type") || "";
  if (WebAssembly.instantiateStreaming && type.split(";")[0].trim() === "application/wasm") {
    try {
      return await WebAssembly.instantiateStreaming(resp.clone(), imports);
    } catch (e) {
      // Fall through to the buffered path, which reports real compile errors.
    }
  }
  // Servers that send another MIME type (or none) make instantiateStreaming
  // throw; compiling from the bytes works regardless.
  return WebAssembly.instantiate(await resp.arrayBuffer(), imports);
}

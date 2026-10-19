// link.js — the page's one Bluetooth link to the hilux C6.
//
// One module owns everything about reaching the device: picking it
// (getDevices / requestDevice), connecting (and with that macOS's bonding),
// watching for its advertisements, reconnecting after a drop (a C6 reset
// after a firmware update included), and the one GATT operation queue. The
// CAN bridge (ble.js) and the firmware client (firmware.js) are consumers:
// they never call gatt.connect(), watchAdvertisements() or requestDevice();
// they ask the link for its services (fetched afresh on every link, see
// "Service Changed") and are told when the link goes and comes back.
//
// Why one owner: with the bridge and the firmware client each connecting
// and reconnecting the same device, after the C6's reset (2026-10-19, on the
// hardware) both reconnected at once: one's watchAdvertisements() was
// refused ("Pending watch advertisements operation"), its abort cancelled
// the other's ("AbortError: The Bluetooth operation was cancelled"), and
// Chrome's Web Bluetooth for the page stopped answering, getDevices() too,
// until a reload. One owner makes one attempt at a time, by construction.
//
// Service Changed: a hilux firmware whose GATT table differs from the last
// indicates Service Changed to bonded clients (hilux b3de8e3) and Chrome
// invalidates every service and characteristic object it handed out. So
// `service(uuid)` belongs to the current link (`generation`) and consumers
// fetch their characteristics again on every `up`.
//
// No DOM access: everything comes in through createLink({ bluetooth, log }).

export const DEVICE_NAME = 'hilux';
export const BRIDGE_SERVICE = 'd9e5a0c0-f7a1-4b6e-9c3d-2a8e1f0b5c4d';
export const KEYLESS_SERVICE = 'd9e5a0b0-f7a1-4b6e-9c3d-2a8e1f0b5c4d';
// The firmware update service (hilux/wireless-can/FIRMWARE.md; client: firmware.js).
export const FIRMWARE_SERVICE = 'd9e5a0d0-f7a1-4b6e-9c3d-2a8e1f0b5c4d';

/** requestDevice() options for every pick of the hilux C6: its name, and every service this page uses (Chrome grants only those named at the pick). */
export function requestOptions() {
  return { filters: [{ name: DEVICE_NAME }], optionalServices: [BRIDGE_SERVICE, KEYLESS_SERVICE, FIRMWARE_SERVICE] };
}
/**
 * Which requestOptions() this browser's grant was made with. Chrome has no
 * way to ask what a remembered device was granted, so the page remembers
 * (`grantStore`, the page's localStorage) the service list of its last pick;
 * a Connect click on a browser whose last pick predates it opens the chooser
 * by itself. Change it whenever requestOptions() gains a service.
 */
export const GRANT_VERSION = 'bridge+keyless+firmware';

export function errText(e) {
  if (!e) return 'unknown error';
  return (e.name && e.name !== 'Error' ? e.name + ': ' : '') + (e.message || String(e));
}

export function withTimeout(p, ms, what) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]);
}

export function linkError(message, code, hint) {
  const e = new Error(message);
  e.code = code;
  if (hint) e.hint = hint;
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stale pairing: this computer still holds a pairing the C6 no longer has
// (forgotten on the Kindle, or lost on the C6). macOS tries to encrypt with
// the old key as it connects, the C6 rejects it ("tried to resume a pairing
// this C6 does not hold" in its log), and macOS drops the link itself; it
// never re-pairs on its own. Chrome reports no reason for that (the
// CoreBluetooth error is not passed on, crbug 585897), so the symptom is what
// we map: the link drops while connecting, or gatt.connect() fails with
// "Connection failed for unknown reason." or, as Chrome on macOS reported it
// on the hardware (2026-10-03, 2026-10-19), NetworkError "Connection Error:
// Connection attempt failed." -- with no gattserverdisconnected event. That
// last one counts only once the C6 was seen advertising.
export const STALE_PAIRING = "if this keeps happening, this computer probably holds an old pairing with 'hilux': forget 'hilux' in macOS System Settings → Bluetooth, then PAIR on the Kindle (with the roles this computer needs: CAN bridge, Firmware) and connect again";
const STALE_HINT = "ask the person to forget 'hilux' in macOS System Settings → Bluetooth and PAIR again on the Kindle with the roles this computer needs";

/**
 * createLink({ bluetooth, log, ...options }) → link.
 *
 *   connect({ allowChooser, forceChooser })
 *       default        the remembered device only (getDevices); never a chooser (script calls)
 *       allowChooser   a real click: the remembered device, the chooser when there is none
 *       forceChooser   a real click on "Use another hilux…": always the chooser (a pick grants
 *                      the services named in requestOptions(); the link stays up if the
 *                      same device is picked)
 *     → { deviceName, deviceId, already }
 *   disconnect()       the person's: no reconnect until the next connect()
 *   release()          a consumer that was refused and is the only one using the link: drop it
 *                      (the C6 has three connections; the iPhone needs one to unlock)
 *   waitConnected(ms)  → bool: the link up within ms, reconnecting if it is down and was
 *                      not disconnected by the person (after a firmware update's reset)
 *   service(uuid)      the current link's primary service; SERVICE_NOT_GRANTED / NO_SERVICE
 *   gattOp(fn)         the one GATT queue (Chrome rejects a second operation while one runs,
 *                      whichever service it is on)
 *   onState(cb(state, lastError)), onUp(cb(generation)), onDown(cb(reason))
 *   use(name) / unuse(name)  consumers holding the link (release() keeps it while another does)
 *   isConnected(), state, generation, info()
 *
 * States: disconnected | connecting | connected | reconnecting | failed.
 *
 * Options (mostly for tests):
 *   connectTimeoutMs (15000)  gatt.connect() and service discovery ceiling
 *   advertTimeoutMs (12000)   how long to wait for an advertisement (watch start included)
 *   reconnectTries (3)        reconnect attempts after an unexpected drop, before `failed`
 *   reconnectDelayMs (1000)   backoff between attempts (x attempt number)
 */
export function createLink({
  bluetooth = globalThis.navigator?.bluetooth,
  grantStore = null,
  log = () => {},
  connectTimeoutMs = 15000,
  advertTimeoutMs = 12000,
  reconnectTries = 3,
  reconnectDelayMs = 1000,
} = {}) {
  const L = (level, msg) => { try { log(level, 'link: ' + msg); } catch { /* logging must never break transport */ } };

  let device = null;
  let server = null; // the current link's GATT server
  let generation = 0; // bumped on every link that comes up
  let services = new Map(); // uuid → Promise<service>, for the current generation
  let state = 'disconnected';
  let lastError = null;
  let userDisconnect = false;
  let connecting = null; // the one connect/reconnect in flight
  let droppedWhileConnecting = false;
  let reconnects = 0;
  const users = new Set();
  const stateListeners = new Set();
  const upListeners = new Set();
  const downListeners = new Set();

  function setState(s, err) {
    if (err !== undefined) lastError = err;
    if (s === state) return;
    state = s;
    L('info', `state → ${s}${err ? ' (' + err + ')' : ''}`);
    for (const cb of stateListeners) { try { cb(s, lastError); } catch { /* a listener bug must not break the link */ } }
  }

  let gattChain = Promise.resolve();
  function gattOp(fn) {
    const p = gattChain.then(fn, fn);
    gattChain = p.then(() => {}, () => {});
    return p;
  }

  function isConnected() { return state === 'connected' && !!server && !!device?.gatt?.connected; }

  function onDisconnected(ev) {
    if (ev?.target && device && ev.target !== device) return; // a device we have since replaced
    const was = state === 'connected';
    server = null;
    services = new Map();
    if (!was) { droppedWhileConnecting = true; return; } // a failed attempt: the attempt handles it
    if (userDisconnect) { setState('disconnected'); notifyDown('disconnected'); return; }
    L('warn', 'the link dropped');
    notifyDown('dropped');
    if (users.size === 0) { setState('disconnected', 'the link dropped'); return; }
    startReconnect();
  }

  function notifyDown(reason) {
    for (const cb of [...downListeners]) { try { cb(reason); } catch (e) { L('error', 'onDown listener threw: ' + errText(e)); } }
  }

  /**
   * Wait (up to ms) for one advertisement: after a page reload Chrome knows a
   * remembered device only once it has seen it advertise. The whole wait is
   * bounded, watchAdvertisements() included (Chrome has left it pending).
   */
  async function waitForAdvertisement(dev, ms) {
    if (typeof dev.watchAdvertisements !== 'function') throw new Error('this browser has no device.watchAdvertisements() (enable chrome://flags/#enable-web-bluetooth-new-permissions-backend)');
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    let handler;
    const seen = new Promise((resolve) => { handler = resolve; dev.addEventListener('advertisementreceived', handler, { once: true }); });
    const watching = dev.watchAdvertisements(ac ? { signal: ac.signal } : undefined);
    watching.catch(() => {}); // settles after the abort below, if at all
    try {
      await withTimeout(watching.then(() => seen), ms, `waiting for an advertisement from ${dev.name || dev.id} (is the C6 powered and in range?)`);
    } finally {
      dev.removeEventListener('advertisementreceived', handler);
      try { ac?.abort(); } catch { /* ignore */ }
    }
  }

  /** gatt.connect(); on "not in range" (after a reload) or when reconnecting, an advertisement first. */
  async function establish(dev, fromReconnect) {
    if (!dev.__linkListening) {
      dev.addEventListener('gattserverdisconnected', onDisconnected);
      dev.__linkListening = true;
    }
    droppedWhileConnecting = false;
    let srv;
    try {
      try {
        srv = await withTimeout(dev.gatt.connect(), connectTimeoutMs, 'gatt.connect()');
      } catch (e) {
        const t = errText(e);
        try { dev.gatt.disconnect(); } catch { /* ignore */ }
        // "Connection attempt failed" is also what an unpowered C6 gives; an
        // advertisement tells them apart (an advertising C6 that refuses the
        // link points at the pairing).
        if (!(/no longer in range|not in range|out of range|Connection attempt failed/i.test(t) || fromReconnect)) throw e;
        L('info', `direct connect failed (${t}); waiting for an advertisement`);
        await waitForAdvertisement(dev, advertTimeoutMs);
        L('info', 'advertisement seen; connecting');
        try {
          srv = await withTimeout(dev.gatt.connect(), connectTimeoutMs, 'gatt.connect()');
        } catch (e2) {
          try { dev.gatt.disconnect(); } catch { /* ignore */ }
          if (/Connection attempt failed/i.test(errText(e2))) e2.afterAdvert = true;
          throw e2;
        }
      }
      if (!dev.gatt.connected) throw new Error('GATT Server is disconnected.');
    } catch (e) {
      if (droppedWhileConnecting || e.afterAdvert || /failed for unknown reason/i.test(errText(e))) {
        throw linkError(`${errText(e)} (the link dropped while connecting; ${STALE_PAIRING})`, 'STALE_PAIRING_SUSPECTED', STALE_HINT);
      }
      throw e;
    }
    server = srv;
    services = new Map();
    generation++;
    setState('connected', null);
    for (const cb of [...upListeners]) { try { cb(generation); } catch (e) { L('error', 'onUp listener threw: ' + errText(e)); } }
  }

  async function requestDevice() {
    L('info', 'opening the Bluetooth chooser');
    const d = await bluetooth.requestDevice(requestOptions());
    try { grantStore?.set(GRANT_VERSION); } catch { /* storage may be blocked */ }
    return d;
  }

  async function connect({ allowChooser = false, forceChooser = false } = {}) {
    if (!bluetooth) throw linkError('Web Bluetooth is not available here (needs Chrome/Edge on a secure origin such as http://localhost:5173)', 'NO_BLUETOOTH');
    // A click (allowChooser) on a browser whose remembered hilux was picked
    // before this page asked for every service it uses: the chooser now, at
    // the start of the click while Chrome still allows it, instead of a
    // "pick it again" error later.
    if (allowChooser && !forceChooser && !isConnected() && grantStore && grantStore.get() !== GRANT_VERSION) forceChooser = true;
    let picked = null;
    if (forceChooser) {
      // The chooser first, while the click's activation lasts (~5 s).
      picked = await requestDevice();
      if (isConnected() && (picked === device || picked.id === device.id)) {
        device = picked;
        services = new Map(); // a pick may grant services the last one did not
        return { deviceName: device.name, deviceId: device.id, already: true };
      }
    }
    if (!forceChooser && isConnected()) return { deviceName: device.name, deviceId: device.id, already: true };
    if (connecting) { await connecting.catch(() => {}); if (isConnected() && !picked) return { deviceName: device.name, deviceId: device.id, already: true }; }
    userDisconnect = false;
    const run = (async () => {
      setState('connecting');
      try {
        let dev = picked;
        if (picked && device && device !== picked && device.gatt?.connected) { try { device.gatt.disconnect(); } catch { /* ignore */ } }
        if (!dev) dev = device;
        if (!dev && typeof bluetooth.getDevices === 'function') {
          const devs = await bluetooth.getDevices();
          dev = devs.find((d) => d.name === DEVICE_NAME) || null;
          L('info', `getDevices(): ${devs.length ? devs.map((d) => d.name || d.id).join(', ') : 'none permitted'}`);
        }
        if (!dev && allowChooser) dev = await requestDevice();
        if (!dev) throw linkError(`no remembered '${DEVICE_NAME}' device: a person must click the page's Connect button once (Chrome only opens the Bluetooth chooser from a real click)`, 'NEEDS_USER_GESTURE');
        device = dev;
        L('info', `connecting to ${dev.name || dev.id}`);
        await establish(dev, false);
        return { deviceName: dev.name, deviceId: dev.id, already: false };
      } catch (e) {
        setState('disconnected', errText(e));
        throw e;
      }
    })();
    connecting = run;
    try { return await run; } finally { if (connecting === run) connecting = null; }
  }

  function startReconnect() {
    if (connecting) return connecting;
    const run = (async () => {
      setState('reconnecting', 'link dropped');
      for (let attempt = 1; attempt <= reconnectTries; attempt++) {
        if (userDisconnect) return false;
        await sleep(reconnectDelayMs * attempt);
        if (userDisconnect || isConnected()) return isConnected();
        try {
          L('info', `reconnect attempt ${attempt}/${reconnectTries}`);
          await establish(device, true);
          reconnects++;
          L('info', `reconnected (attempt ${attempt})`);
          return true;
        } catch (e) {
          L('warn', `reconnect attempt ${attempt} failed: ${errText(e)}`);
          lastError = errText(e);
          if (e.code === 'STALE_PAIRING_SUSPECTED') { setState('failed', lastError); return false; }
          setState('reconnecting');
        }
      }
      setState('failed', `reconnect gave up after ${reconnectTries} attempts: ${lastError}`);
      return false;
    })();
    connecting = run.catch(() => false);
    run.finally(() => { if (connecting) connecting = null; });
    return run;
  }

  async function waitConnected(ms) {
    const until = Date.now() + ms;
    for (;;) {
      if (isConnected()) return true;
      if (userDisconnect || !device) return false;
      if (connecting) await Promise.race([connecting, sleep(Math.max(0, until - Date.now()))]);
      else if (state !== 'connected') await Promise.race([startReconnect(), sleep(Math.max(0, until - Date.now()))]);
      if (isConnected()) return true;
      if (Date.now() >= until) return false;
      await sleep(Math.min(reconnectDelayMs, Math.max(0, until - Date.now())));
    }
  }

  async function disconnect() {
    userDisconnect = true;
    const d = device;
    server = null;
    services = new Map();
    if (d?.gatt?.connected) d.gatt.disconnect();
    setState('disconnected');
    notifyDown('disconnected');
  }

  /** A refused consumer lets go: the link goes unless another consumer uses it. */
  function release(name) {
    users.delete(name);
    if (users.size === 0 && device?.gatt?.connected) {
      L('info', 'nobody uses the link: letting it go');
      userDisconnect = true;
      server = null;
      services = new Map();
      try { device.gatt.disconnect(); } catch { /* ignore */ }
      setState('disconnected');
    }
  }

  /** The current link's primary service `uuid` (fetched once per link). */
  function service(uuid, what = uuid) {
    if (!isConnected()) return Promise.reject(linkError(`${what}: not connected (state: ${state})`, 'NOT_CONNECTED'));
    let p = services.get(uuid);
    if (!p) {
      const srv = server;
      const dev = device;
      p = gattOp(() => withTimeout(srv.getPrimaryService(uuid), connectTimeoutMs, `getPrimaryService(${what})`)).catch((e) => {
        services.delete(uuid);
        const t = errText(e);
        if (/disconnected/i.test(t)) throw e; // the link dropped, not a missing service
        if (/SecurityError|not allowed to access/.test(t)) {
          // Next time a person clicks Connect, the chooser opens by itself.
          try { grantStore?.set(''); } catch { /* storage may be blocked */ }
          throw linkError(`Chrome has not granted this page the ${what} service on ${dev.name || dev.id} (it was picked before this page asked for it): a person must click Connect and pick hilux in Chrome's chooser`, 'SERVICE_NOT_GRANTED',
            "a person must click the page's Connect button: it opens Chrome's chooser to pick 'hilux' again (Chrome grants a service only on a pick)");
        }
        throw linkError(`connected to ${dev.name || dev.id} but it has no ${what} service ${uuid} (${t})`, 'NO_SERVICE');
      });
      services.set(uuid, p);
    }
    return p;
  }

  function info() {
    return {
      state,
      deviceName: device?.name ?? null,
      deviceId: device?.id ?? null,
      bluetoothAvailable: !!bluetooth,
      lastError,
      reconnects,
      generation,
      users: [...users],
    };
  }

  return {
    connect, disconnect, release, waitConnected, service, gattOp, isConnected, info,
    use: (name) => { users.add(name); },
    unuse: (name) => { users.delete(name); },
    onState: (cb) => { stateListeners.add(cb); return () => stateListeners.delete(cb); },
    onUp: (cb) => { upListeners.add(cb); return () => upListeners.delete(cb); },
    onDown: (cb) => { downListeners.add(cb); return () => downListeners.delete(cb); },
    get state() { return state; },
    get generation() { return generation; },
    get device() { return device; },
  };
}

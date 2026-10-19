// fake-firmware.mjs — a fake hilux C6 firmware service (hilux/wireless-can/
// FIRMWARE.md), attached to fake-bluetooth.mjs's FakeC6 as c6.firmware, and
// synthetic app images (c6_ota::image's format, as ota-client.js checks it).
//
// Modelled: Info / Begin / Commit / Abort on control, each answered once on
// status after the write; data in order from Ready's offset, Acks every
// min(1024, window / 2) and at the end, one SEQUENCE per gap, repeats ignored;
// an upload that outlives its connection (a Begin of the same image resumes
// it); BUSY for another connection's live upload; ON_TRIAL, UNAVAILABLE,
// NO_SPACE; at Commit the SHA-256 and the image check, then Rebooting, the
// reset (the link drops, the C6 is gone for bootMs), the update booting on
// trial and confirming after confirmMs, or rolling back (rollback: true);
// each boot indicates GATT Service Changed (serviceChangedOnBoot, default
// true: every object Chrome handed out before is invalid).
// Faults: dropAt (the link drops once that many bytes are in), commitError
// ({ code, detail }), refuse ('mac' | 'other': no Firmware role),
// hangOnTrial (the update on trial fails every control write as macOS
// reports a refusal; with rollback, it then goes back).

import { createHash } from 'node:crypto';
import { FIRMWARE_CONTROL, FIRMWARE_DATA, FIRMWARE_STATUS, FIRMWARE_SERVICE, REQUEST, ERROR, decodeRequest, decodeData, encodeStatus, hex } from '../firmware.js';
import { FakeCharacteristic, domErr, refusal } from './fake-bluetooth.mjs';

const sha = (b) => createHash('sha256').update(b).digest();

/** An app image of one n-byte segment (n a multiple of 4), its checksum and its appended digest. */
export function image(n, seed = 7) {
  const head = new Uint8Array(24);
  head[0] = 0xe9; head[1] = 1; head[12] = 13; head[23] = 1;
  const seg = new Uint8Array(8 + n);
  new DataView(seg.buffer).setUint32(4, n, true);
  let sum = 0xef;
  for (let i = 0; i < n; i++) { seg[8 + i] = (i * seed) & 0xff; sum ^= seg[8 + i]; }
  const body = [...head, ...seg];
  while (body.length % 16 !== 15) body.push(0);
  body.push(sum);
  return Uint8Array.from([...body, ...sha(Uint8Array.from(body))]);
}

export class FakeFirmwareBox {
  constructor({ c6, device, running = image(4000, 3), slot = 0, maxLen = 0x1e0000, mtu = 247, bootMs = 20, confirmMs = 30 } = {}) {
    this.c6 = c6; this.device = device;
    this.running = { sha: hex(running.subarray(running.length - 32)), slot, pending: false };
    this.maxLen = maxLen;
    this.chunk = Math.min(244, Math.floor((mtu - 7) / 4) * 4);
    this.window = Math.min(8 * this.chunk, 2048);
    this.ackEvery = Math.min(1024, this.window / 2);
    this.bootMs = bootMs; this.confirmMs = confirmMs;
    this.upload = null; // { len, sha, buf, got, acked, owner, told }
    this.serviceChangedOnBoot = true;
    this.unavailable = false; this.refuse = null; this.dropAt = null; this.commitError = null; this.rollback = false; this.busyOther = false;
    this.log = []; // requests seen, by tag (+ 'data')
    this.begins = 0; this.commits = 0; this.boots = 0;
    c6.firmware = this;
  }
  get offset() { return this.upload?.got ?? 0; }

  notify(m) { queueMicrotask(() => this.chars?.status._notify(encodeStatus(m))); }
  error(request, code, detail = 0) { this.notify({ tag: 'Error', request, code: ERROR[code], detail }); }
  info() { this.notify({ tag: 'Info', sha256: this.running.sha, slot: this.running.slot, pending: this.running.pending, maxLen: this.unavailable ? 0 : this.maxLen }); }

  control(server, buf) {
    if (this.refuse) throw refusal({ refuse: this.refuse });
    // ota-hang-test on the hardware: the update's executor hangs, and macOS
    // reports the failed write as it reports a refusal
    if (this.hangOnTrial && this.running.pending) throw refusal({ refuse: 'mac' });
    let r;
    try { r = decodeRequest(buf); } catch { this.error(buf[0] || 0, 'MALFORMED', buf.length); return; }
    this.log.push(r.tag);
    switch (r.tag) {
      case 'Info': this.info(); break;
      case 'Abort': if (!this.upload) this.error(REQUEST.ABORT, 'NO_UPLOAD'); else { this.upload = null; this.info(); } break;
      case 'Begin': this.begin(server, r); break;
      case 'Commit': this.commit(); break;
      default: break;
    }
  }

  begin(server, r) {
    this.begins++;
    if (this.unavailable) return this.error(REQUEST.BEGIN, 'UNAVAILABLE');
    if (this.running.pending) return this.error(REQUEST.BEGIN, 'ON_TRIAL');
    if (this.busyOther) return this.error(REQUEST.BEGIN, 'BUSY');
    if (r.len > this.maxLen) return this.error(REQUEST.BEGIN, 'NO_SPACE', this.maxLen);
    if (r.len < 33) return this.error(REQUEST.BEGIN, 'LENGTH', r.len);
    const u = this.upload;
    if (u && u.len === r.len && u.sha === r.sha256) { u.owner = server; u.told = false; u.acked = u.got; } else this.upload = { len: r.len, sha: r.sha256, buf: new Uint8Array(r.len), got: 0, acked: 0, owner: server, told: false };
    this.notify({ tag: 'Ready', offset: this.upload.got, chunk: this.chunk, window: this.window });
  }

  data(server, buf) {
    if (this.refuse) return; // a write command: no reply, dropped on the C6
    this.log.push('data');
    const u = this.upload;
    if (!u) return this.error(REQUEST.DATA, 'NO_UPLOAD');
    const { offset, bytes } = decodeData(buf);
    if (offset !== u.got) {
      if (offset > u.got && !u.told) { u.told = true; this.error(REQUEST.DATA, 'SEQUENCE', u.got); }
      return;
    }
    if (offset + bytes.length > u.len) return this.error(REQUEST.DATA, 'LENGTH', offset + bytes.length);
    u.told = false;
    u.buf.set(bytes, offset);
    u.got += bytes.length;
    if (u.got - u.acked >= this.ackEvery || u.got === u.len) { u.acked = u.got; this.notify({ tag: 'Ack', offset: u.got }); }
    if (this.dropAt !== null && u.got >= this.dropAt) { this.dropAt = null; setTimeout(() => this.device.dropLink(), 0); }
  }

  commit() {
    this.commits++;
    const u = this.upload;
    if (!u) return this.error(REQUEST.COMMIT, 'NO_UPLOAD');
    if (u.got < u.len) return this.error(REQUEST.COMMIT, 'LENGTH', u.got);
    if (hex(sha(u.buf.subarray(0, u.len - 32))) !== u.sha) return this.error(REQUEST.COMMIT, 'HASH');
    if (this.commitError) return this.error(REQUEST.COMMIT, this.commitError.code, this.commitError.detail ?? 0);
    if (u.buf[0] !== 0xe9) return this.error(REQUEST.COMMIT, 'IMAGE', 2);
    const from = this.running;
    this.upload = null;
    this.notify({ tag: 'Rebooting' });
    // the reset, 0.5 s on the C6
    setTimeout(() => this.reset({ sha: u.sha, slot: 1 - from.slot, pending: true }, from), 5);
  }

  reset(next, from) {
    this.device.powered = false;
    this.device.dropLink();
    setTimeout(() => {
      this.boots++;
      this.running = next;
      // hilux b3de8e3: a firmware whose GATT table changed indicates Service
      // Changed to bonded clients; Chrome's old objects are invalid from then on
      if (this.serviceChangedOnBoot) this.device.serviceChanged();
      this.device.powered = true;
      if (!next.pending) return;
      setTimeout(() => {
        if (this.rollback) { this.rollback = false; this.reset({ ...from, pending: false }, from); } // three boots without confirming, in one
        else this.running = { ...this.running, pending: false };
      }, this.confirmMs);
    }, this.bootMs);
  }

  makeService(server) {
    const box = this;
    const control = new FakeCharacteristic(server, FIRMWARE_CONTROL, { write(buf) { box.control(server, buf); } });
    const data = new FakeCharacteristic(server, FIRMWARE_DATA, { write(buf) { box.data(server, buf); } });
    const status = new FakeCharacteristic(server, FIRMWARE_STATUS, { subscribe() { if (box.refuse) throw refusal({ refuse: box.refuse }); } });
    this.chars = { control, data, status };
    const map = new Map([[FIRMWARE_CONTROL, control], [FIRMWARE_DATA, data], [FIRMWARE_STATUS, status]]);
    return {
      uuid: FIRMWARE_SERVICE,
      async getCharacteristic(u) { const c = map.get(u); if (!c) throw domErr('NotFoundError', 'No Characteristics matching UUID ' + u); return c; },
    };
  }
}

// Talks to the bundled eufy bridge over its WebSocket: login state, the device list, and camera
// events (motion, person, doorbell, battery). Reconnects on its own.
//
// Events:  'device-event' { serial, event, message }   'devices' [device]

import { EventEmitter } from 'node:events';

export const OFFLINE_AFTER_MS = 30000;   // logged out or disconnected this long counts as offline

// The bridge's device record, reduced to what the web page shows.
export function toDevice(d) {
  return {
    serial: d.sn, name: d.name, model: d.model, modelName: d.modelName,
    battery: d.decodedState?.battery?.level ?? null, error: d.error,
  };
}

export class BridgeClient extends EventEmitter {
  constructor({ url, log, WebSocketImpl = globalThis.WebSocket, now = Date.now }) {
    super();
    Object.assign(this, { url, log, WebSocketImpl, now });
    this.connected = false;
    this.auth = { state: 'unknown' };
    this.devices = [];
    this.troubleSince = now();   // when it last stopped being connected and logged in
    this.pending = new Map();    // request id -> resolve
    this.nextId = 100;
    this.backoff = 1000;
  }

  // null while all is well; otherwise why eufy events can't arrive: 'login' or 'connection'.
  // Short blips (a bridge restart) don't count.
  offline(now = this.now()) {
    if (this.connected && this.auth.state === 'ok') return null;
    if (now - this.troubleSince < OFFLINE_AFTER_MS) return null;
    return this.connected ? 'login' : 'connection';
  }

  // For the web page.
  status() {
    return {
      connected: this.connected, login: this.auth.state, method: this.auth.method ?? null,
      captcha: this.auth.state === 'require_captcha' ? this.auth.image ?? null : null,
    };
  }

  connect() {
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.setHealth({ connected: true });
      this.log('bridge connected');
    };
    ws.onmessage = (e) => {
      let message;
      try { message = JSON.parse(e.data); } catch { return; }
      this.handle(message);
    };
    ws.onclose = () => {
      this.setHealth({ connected: false });
      for (const [id, done] of this.pending) {
        done({ ok: false, error: 'bridge disconnected' });
        this.pending.delete(id);
      }
      this.log(`bridge disconnected, retry in ${this.backoff / 1000} s`);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
    ws.onerror = () => {};
  }

  // Sends a command and resolves with the bridge's answer (matched by id).
  request(message, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1 /* OPEN */) return reject(new Error('bridge not connected'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('bridge did not answer'));
      }, timeoutMs);
      this.pending.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      this.ws.send(JSON.stringify({ ...message, id }));
    });
  }

  // Login step from the web page: a 2FA code or a captcha.
  async submitLogin(message, timeoutMs = 60000) {
    const answer = await this.request(message, timeoutMs);
    if (answer.auth) this.setHealth({ auth: answer.auth });
    return answer;
  }

  async refreshDevices() {
    try {
      const answer = await this.request({ cmd: 'devices.list' });
      if (!answer.devices) return;
      this.devices = answer.devices.map(toDevice);
      this.emit('devices', this.devices);
    } catch (e) {
      this.log('devices.list failed:', e.message);
    }
  }

  handle(m) {
    if (m.id != null && this.pending.has(m.id)) {
      this.pending.get(m.id)(m);
      this.pending.delete(m.id);
    } else if (m.event === 'hello') {
      this.setHealth({ auth: m.auth ?? this.auth });
    } else if (m.event === 'ready') {
      this.refreshDevices();
    } else if (m.event === 'auth') {
      this.log('eufy login state:', m.state);
      this.setHealth({ auth: { state: m.state, method: m.method, image: m.image, retry: m.retry } });
    } else if (m.deviceSn) {
      this.emit('device-event', { serial: m.deviceSn, event: m.event, message: m });
    }
  }

  setHealth({ connected = this.connected, auth = this.auth }) {
    const wasOk = this.connected && this.auth.state === 'ok';
    Object.assign(this, { connected, auth });
    const ok = connected && auth.state === 'ok';
    if (wasOk && !ok) this.troubleSince = this.now();
    if (ok && !wasOk) this.refreshDevices();
  }
}

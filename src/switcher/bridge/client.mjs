// What the gateway needs from the eufy bridge: the login state, the device list, and camera events
// (motion, person, doorbell, battery). The connection itself is socket.mjs.
//
// Events:  'device-event' { serial, event, message }   'devices' [device]

import { eufyModeName } from '../eufy-mode.mjs';
import { EventEmitter } from 'node:events';
import { BridgeSocket } from './socket.mjs';

export const OFFLINE_AFTER_MS = 30000;   // logged out or disconnected this long counts as offline

// The bridge's device record, reduced to what the gateway uses. station: the device whose Eufy mode
// applies to this one (its HomeBase or chime, or itself); arming: it has Eufy modes (a station);
// eufyMode: its current one (eufy-mode.mjs). charging: the battery is charging (a cable or a solar
// panel, as the eufy app decodes it); solar: a solar panel gets light right now. Both null when the
// device doesn't report them.
export function toDevice(d) {
  const battery = d.decodedState?.battery ?? {};
  return {
    serial: d.sn, name: d.name, model: d.model, modelName: d.modelName,
    battery: battery.level ?? null, error: d.error,
    charging: typeof battery.charging === 'boolean' ? battery.charging : null,
    solar: Number.isFinite(battery.solarIntensity) ? battery.solarIntensity > 0 : null,
    station: d.station ?? d.sn, arming: (d.capabilities ?? []).includes('arming'),
    eufyMode: eufyModeName(d.state?.armingMode),
  };
}

export class BridgeClient extends EventEmitter {
  constructor({ url, log, WebSocketImpl, now = Date.now }) {
    super();
    Object.assign(this, { log, now });
    this.connected = false;
    this.auth = { state: 'unknown' };
    this.devices = [];
    this.troubleSince = now();   // when it last stopped being connected and logged in
    this.socket = new BridgeSocket({ url, log, WebSocketImpl });
    this.socket.on('open', () => this.setHealth({ connected: true }));
    this.socket.on('close', () => this.setHealth({ connected: false }));
    this.socket.on('message', (m) => this.handle(m));
  }

  connect() {
    this.socket.connect();
  }

  request(message, timeoutMs) {
    return this.socket.request(message, timeoutMs);
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

  // Unsolicited messages from the bridge.
  handle(m) {
    if (m.event === 'hello') {
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

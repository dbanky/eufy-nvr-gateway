import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient, OFFLINE_AFTER_MS, toDevice } from '../../../src/switcher/bridge/client.mjs';
import { FakeWebSocket } from './fake-websocket.mjs';

function connectedClient() {
  let now = 0;
  const client = new BridgeClient({ url: 'ws://bridge', log: () => {}, WebSocketImpl: FakeWebSocket, now: () => now });
  client.connect();
  FakeWebSocket.last.open();
  return { client, ws: FakeWebSocket.last, advance: (ms) => { now += ms; } };
}

describe('camera events', () => {
  test('are passed on with the camera serial', () => {
    const { client, ws } = connectedClient();
    const events = [];
    client.on('device-event', (e) => events.push(e));
    ws.receive({ event: 'personDetected', deviceSn: 'T81XXXXXXXXXXXXX' });
    assert.equal(events[0].serial, 'T81XXXXXXXXXXXXX');
    assert.equal(events[0].event, 'personDetected');
  });
});

describe('login state', () => {
  test('once logged in, the device list is fetched', () => {
    const { ws } = connectedClient();
    ws.receive({ event: 'auth', state: 'ok' });
    assert.equal(ws.sent.at(-1).cmd, 'devices.list');
  });

  test('a 2FA request is shown on the web page', () => {
    const { client, ws } = connectedClient();
    ws.receive({ event: 'auth', state: 'require_2fa', method: 'email' });
    assert.deepEqual(client.status(), { connected: true, login: 'require_2fa', method: 'email', captcha: null });
  });
});

describe('offline', () => {
  test('only after a problem lasted 30 s: a bridge restart is not "offline"', () => {
    const { client, ws, advance } = connectedClient();
    ws.receive({ event: 'auth', state: 'ok' });
    assert.equal(client.offline(), null);
    ws.receive({ event: 'auth', state: 'require_2fa' });
    advance(OFFLINE_AFTER_MS - 1);
    assert.equal(client.offline(), null);
    advance(2);
    assert.equal(client.offline(), 'login');
  });
});

test('device records are reduced to what the gateway uses', () => {
  const raw = { sn: 'T81XXXXXXXXXXXXX', name: 'Garden', model: 'T8170', modelName: 'SoloCam S340', decodedState: { battery: { level: 77 } } };
  assert.deepEqual(toDevice(raw), { serial: 'T81XXXXXXXXXXXXX', name: 'Garden', model: 'T8170', modelName: 'SoloCam S340', battery: 77, error: undefined,
    charging: null, solar: null,   // not reported
    station: 'T81XXXXXXXXXXXXX', arming: false, eufyMode: null });   // a bridge without the station patch: its own station
});

test('a battery that charges says so, and whether its solar panel gets light', () => {
  const raw = (battery) => toDevice({ sn: 'T81XXXXXXXXXXXXX', decodedState: { battery } });
  assert.deepEqual([raw({ level: 60, charging: true, solarIntensity: 35 })].map(({ charging, solar }) => ({ charging, solar })), [{ charging: true, solar: true }]);
  const night = raw({ level: 60, charging: false, solarIntensity: 0 });
  assert.equal(night.charging, false);
  assert.equal(night.solar, false);
  assert.equal(raw({ level: 60, charging: 'yes', solarIntensity: null }).charging, null, 'only a real yes or no counts');
  assert.equal(raw({ level: 60, solarIntensity: null }).solar, null);
});

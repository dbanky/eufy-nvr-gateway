import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeClient, OFFLINE_AFTER_MS, toDevice } from '../../src/switcher/bridge-client.mjs';

// Stands in for the WebSocket to the bridge: the test plays the bridge's side.
class FakeSocket {
  static last;
  constructor(url) {
    Object.assign(this, { url, readyState: 0, sent: [] });
    FakeSocket.last = this;
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.onopen(); }
  receive(message) { this.onmessage({ data: JSON.stringify(message) }); }
}

function connectedClient() {
  let now = 0;
  const client = new BridgeClient({ url: 'ws://bridge', log: () => {}, WebSocketImpl: FakeSocket, now: () => now });
  client.connect();
  FakeSocket.last.open();
  return { client, socket: FakeSocket.last, advance: (ms) => { now += ms; } };
}

describe('requests', () => {
  test('get the answer with the same id', async () => {
    const { client, socket } = connectedClient();
    const answer = client.request({ cmd: 'devices.list' });
    const { id } = socket.sent.at(-1);
    socket.receive({ id: id + 1, ok: true, note: 'someone else' });
    socket.receive({ id, ok: true, devices: [] });
    assert.deepEqual(await answer, { id, ok: true, devices: [] });
  });

  test('fail right away when the bridge is not connected', async () => {
    const client = new BridgeClient({ url: 'ws://bridge', log: () => {}, WebSocketImpl: FakeSocket });
    await assert.rejects(client.request({ cmd: 'x' }), /not connected/);
  });
});

describe('camera events', () => {
  test('are passed on with the camera serial', () => {
    const { client, socket } = connectedClient();
    const events = [];
    client.on('device-event', (e) => events.push(e));
    socket.receive({ event: 'personDetected', deviceSn: 'T81XXXXXXXXXXXXX' });
    assert.equal(events[0].serial, 'T81XXXXXXXXXXXXX');
    assert.equal(events[0].event, 'personDetected');
  });
});

describe('login state', () => {
  test('once logged in, the device list is fetched', () => {
    const { socket } = connectedClient();
    socket.receive({ event: 'auth', state: 'ok' });
    assert.equal(socket.sent.at(-1).cmd, 'devices.list');
  });

  test('a 2FA request is shown on the web page', () => {
    const { client, socket } = connectedClient();
    socket.receive({ event: 'auth', state: 'require_2fa', method: 'email' });
    assert.deepEqual(client.status(), { connected: true, login: 'require_2fa', method: 'email', captcha: null });
  });
});

describe('offline', () => {
  test('only after a problem lasted 30 s: a bridge restart is not "offline"', () => {
    const { client, socket, advance } = connectedClient();
    socket.receive({ event: 'auth', state: 'ok' });
    assert.equal(client.offline(), null);
    socket.receive({ event: 'auth', state: 'require_2fa' });
    advance(OFFLINE_AFTER_MS - 1);
    assert.equal(client.offline(), null);
    advance(2);
    assert.equal(client.offline(), 'login');
  });
});

test('device records are reduced to what the web page shows', () => {
  const raw = { sn: 'T81XXXXXXXXXXXXX', name: 'Garden', model: 'T8170', modelName: 'SoloCam S340', decodedState: { battery: { level: 77 } } };
  assert.deepEqual(toDevice(raw), { serial: 'T81XXXXXXXXXXXXX', name: 'Garden', model: 'T8170', modelName: 'SoloCam S340', battery: 77, error: undefined });
});

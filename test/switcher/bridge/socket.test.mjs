import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeSocket } from '../../../src/switcher/bridge/socket.mjs';
import { FakeWebSocket } from './fake-websocket.mjs';

function openSocket() {
  const socket = new BridgeSocket({ url: 'ws://bridge', log: () => {}, WebSocketImpl: FakeWebSocket });
  socket.connect();
  FakeWebSocket.last.open();
  return { socket, ws: FakeWebSocket.last };
}

describe('requests', () => {
  test('get the answer with the same id', async () => {
    const { socket, ws } = openSocket();
    const answer = socket.request({ cmd: 'devices.list' });
    const { id } = ws.sent.at(-1);
    ws.receive({ id: id + 1, ok: true, note: 'someone else' });
    ws.receive({ id, ok: true, devices: [] });
    assert.deepEqual(await answer, { id, ok: true, devices: [] });
  });

  test('fail right away when the bridge is not connected', async () => {
    const socket = new BridgeSocket({ url: 'ws://bridge', log: () => {}, WebSocketImpl: FakeWebSocket });
    await assert.rejects(socket.request({ cmd: 'x' }), /not connected/);
  });
});

test('messages that answer no request are passed on', () => {
  const { socket, ws } = openSocket();
  const messages = [];
  socket.on('message', (m) => messages.push(m));
  ws.receive({ event: 'ready' });
  assert.deepEqual(messages, [{ event: 'ready' }]);
});

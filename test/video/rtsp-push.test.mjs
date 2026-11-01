// Publishing into go2rtc: ANNOUNCE, SETUP per track, RECORD, then RTP interleaved on the same
// connection. A fake socket plays go2rtc.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RtspPush, MAX_BACKLOG_BYTES } from '../../src/video/rtsp-push.mjs';
import { RtspReader, formatMessage, header, requestLine } from '../../src/rtsp/messages.mjs';

const URL_ = 'rtsp://127.0.0.1:28554/garden';

// A socket that hands each request to `answer(request)`, which returns { status, headers } or null
// (no answer).
function fakeGo2rtc(answer = () => ({ status: 200 })) {
  const socket = Object.assign(new EventEmitter(), { written: [], frames: [], writableLength: 0, destroyed: false });
  const reader = new RtspReader();
  socket.setNoDelay = () => {};
  socket.destroy = () => { socket.destroyed = true; };
  socket.write = (bytes) => {
    for (const item of reader.push(bytes)) {
      if (item.frame) { socket.frames.push(item.frame); continue; }
      const request = { ...requestLine(item.message.startLine), headers: item.message.headers, body: item.message.body };
      socket.written.push(request);
      const reply = answer(request);
      if (!reply) continue;
      const startLine = `RTSP/1.0 ${reply.status} ${reply.status === 200 ? 'OK' : 'Refused'}`;
      const headers = [['CSeq', header(request.headers, 'cseq')], ...(reply.headers ?? [])];
      queueMicrotask(() => socket.emit('data', formatMessage({ startLine, headers })));
    }
    return true;
  };
  return socket;
}

function open({ tracks = 2, answer } = {}) {
  const socket = fakeGo2rtc(answer);
  let connectedTo = null;
  const push = new RtspPush({ url: URL_, sdp: 'v=0\r\n', tracks, connectImpl: (port, host) => { connectedTo = { port, host }; return socket; } });
  const events = [];
  push.on('ready', () => events.push('ready'));
  push.on('close', (reason) => events.push(`close: ${reason}`));
  socket.emit('connect');
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { push, socket, events, settled, connectedTo: () => connectedTo };
}

describe('the handshake with go2rtc', () => {
  test('ANNOUNCE with the SDP, a SETUP per track (interleaved 0-1, 2-3, record), then RECORD', async () => {
    const { socket, events, settled, connectedTo } = open({ answer: (r) => ({ status: 200, headers: r.method === 'SETUP' ? [['Session', 'S1;timeout=60']] : [] }) });
    await settled();
    assert.deepEqual(connectedTo(), { port: 28554, host: '127.0.0.1' });
    assert.deepEqual(socket.written.map((r) => r.method), ['ANNOUNCE', 'SETUP', 'SETUP', 'RECORD']);
    assert.equal(socket.written[0].body.toString(), 'v=0\r\n');
    assert.equal(header(socket.written[0].headers, 'content-type'), 'application/sdp');
    assert.equal(socket.written[1].uri, `${URL_}/trackID=0`);
    assert.match(header(socket.written[1].headers, 'transport'), /^RTP\/AVP\/TCP;unicast;interleaved=0-1;mode=record$/);
    assert.match(header(socket.written[2].headers, 'transport'), /interleaved=2-3/);
    assert.deepEqual(events, ['ready']);
  });

  test('the session id from the first SETUP goes on every request after it', async () => {
    const { socket, settled } = open({ answer: (r) => ({ status: 200, headers: r.method === 'SETUP' ? [['Session', 'S1;timeout=60']] : [] }) });
    await settled();
    assert.equal(header(socket.written[0].headers, 'session'), null);
    assert.equal(header(socket.written[2].headers, 'session'), 'S1');
    assert.equal(header(socket.written[3].headers, 'session'), 'S1');
  });

  test('one track: one SETUP', async () => {
    const { socket, settled } = open({ tracks: 1 });
    await settled();
    assert.deepEqual(socket.written.map((r) => r.method), ['ANNOUNCE', 'SETUP', 'RECORD']);
  });

  test('a refused request closes the connection, saying which and why', async () => {
    const { socket, events, settled } = open({ answer: (r) => ({ status: r.method === 'SETUP' ? 461 : 200 }) });
    await settled();
    assert.deepEqual(events, ['close: SETUP: 461 Refused']);
    assert.equal(socket.destroyed, true);
  });
});

describe('sending', () => {
  test('nothing goes out before RECORD is answered', () => {
    const { push, socket } = open({ answer: () => null });
    assert.equal(push.send(0, Buffer.from([1])), false);
    assert.equal(socket.frames.length, 0);
  });

  test('an RTP packet goes out interleaved on its track\'s channel (track n: channel 2n)', async () => {
    const { push, socket, settled } = open();
    await settled();
    assert.equal(push.send(1, Buffer.from([7, 8])), true);
    assert.deepEqual(socket.frames, [{ channel: 2, data: Buffer.from([7, 8]) }]);
  });

  test('go2rtc not reading (more than MAX_BACKLOG_BYTES waiting): closed, to be opened again', async () => {
    const { push, socket, events, settled } = open();
    await settled();
    socket.writableLength = MAX_BACKLOG_BYTES + 1;
    assert.equal(push.send(0, Buffer.from([1])), false);
    assert.match(events.at(-1), /^close: go2rtc took nothing for a while \(32 MB waiting\)$/);
  });
});

describe('the end', () => {
  test('\'close\' comes once, whatever ends it', async () => {
    const { push, socket, events, settled } = open();
    await settled();
    socket.emit('error', new Error('reset'));
    socket.emit('close');
    push.close('stopped');
    assert.deepEqual(events, ['ready', 'close: reset']);
    assert.equal(push.send(0, Buffer.from([1])), false);
  });
});

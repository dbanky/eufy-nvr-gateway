import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProxySession } from '../../src/rtsp/session.mjs';

test('UDP asked for but every port of the range is in use: 461, so the viewer uses TCP instead', async () => {
  const logs = [];
  const sent = [];
  const session = new ProxySession('ABC', {
    now: Date.now,
    log: (m) => logs.push(m),
    connectUpstream: () => { throw new Error('not reached'); },
    openUdp: async () => { throw new Error('all UDP ports 40000–40019 are in use'); },
  });
  session.attach({ write: (b) => sent.push(b.toString()), end() {}, destroy() {}, localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' });
  session.reply = (b) => sent.push(b.toString());
  await session.fromClient({ startLine: 'SETUP rtsp://x/garden/trackID=0 RTSP/1.0', headers: [['CSeq', '3'], ['Transport', 'RTP/AVP;unicast;client_port=5000-5001']], body: Buffer.alloc(0) });
  assert.match(sent.join(''), /^RTSP\/1\.0 461 Unsupported Transport/);
  assert.match(logs.join(' '), /told to use TCP/);
  session.close?.();
});

// go2rtc answers OPTIONS while playing, but never GET_PARAMETER, SET_PARAMETER or TEARDOWN: VLC's
// keep-alives went unanswered and it gave up after a few minutes. The front answers them itself.
function playingSession() {
  const sent = [], upstream = [];
  const session = new ProxySession('ABC', {
    now: Date.now,
    connectUpstream: () => ({ write: (b) => upstream.push(b.toString()), on() {}, destroy() { this.destroyed = true; } }),
    openUdp: async () => { throw new Error('not used'); },
  });
  session.reply = (b) => sent.push(b.toString());
  const ask = (method, cseq) => session.fromClient({ startLine: `${method} rtsp://x/garden RTSP/1.0`, headers: [['CSeq', String(cseq)], ['Session', 'ABC']], body: Buffer.alloc(0) });
  return { session, sent, upstream, ask };
}

for (const method of ['GET_PARAMETER', 'SET_PARAMETER']) {
  test(`${method} (a keep-alive) is answered by the front, with the session; go2rtc never sees it`, async () => {
    const { session, sent, upstream, ask } = playingSession();
    const before = session.lastActivity;
    await ask(method, 9);
    assert.match(sent.join(''), /^RTSP\/1\.0 200 OK\r\nCSeq: 9\r\nSession: ABC;timeout=60\r\n/);
    assert.equal(upstream.length, 0);
    assert.ok(session.lastActivity >= before);
    session.close();
  });
}

test('TEARDOWN is answered by the front and ends the session (and its go2rtc connection)', async () => {
  const { session, sent, upstream, ask } = playingSession();
  await ask('OPTIONS', 4);              // opens the go2rtc connection, as a real session would have
  await ask('TEARDOWN', 5);
  assert.match(sent.join(''), /RTSP\/1\.0 200 OK\r\nCSeq: 5\r\nSession: ABC\r\n/);
  assert.ok(!upstream.some((m) => m.startsWith('TEARDOWN')));
  assert.equal(session.closed, true);
  assert.equal(session.upstream.destroyed, true);
});

// go2rtc drops a viewer's connection after 60 s without hearing from it. A viewer on UDP sends its
// RTCP over UDP, so nothing reaches go2rtc: the front keeps that connection alive with OPTIONS.
test('while playing, the front sends go2rtc an OPTIONS when it has sent nothing for a while; the answer stays with the front', async () => {
  let now = 1_000_000;
  const sent = [], upstream = [];
  const session = new ProxySession('ABC', {
    now: () => now,
    connectUpstream: () => ({ write: (b) => upstream.push(b.toString()), on() {}, destroy() {} }),
    openUdp: async () => { throw new Error('not used'); },
  });
  session.reply = (b) => sent.push(b.toString());
  await session.fromClient({ startLine: 'PLAY rtsp://x/garden RTSP/1.0', headers: [['CSeq', '5'], ['Session', 'ABC']], body: Buffer.alloc(0) });
  session.fromUpstreamMessage({ startLine: 'RTSP/1.0 200 OK', headers: [['CSeq', '5'], ['Session', 'go2']], body: Buffer.alloc(0) });
  session.upstreamSession = 'go2';
  now += 10000; session.tick();
  assert.equal(upstream.length, 1, 'not yet');
  now += 15000; session.tick();
  assert.equal(upstream.length, 2);
  assert.match(upstream[1], /^OPTIONS rtsp:\/\/x\/garden RTSP\/1\.0\r\nCSeq: (\d+)\r\nSession: go2\r\n/);
  const cseq = /CSeq: (\d+)/.exec(upstream[1])[1];
  const before = sent.length;
  session.fromUpstreamMessage({ startLine: 'RTSP/1.0 200 OK', headers: [['CSeq', cseq]], body: Buffer.alloc(0) });
  assert.equal(sent.length, before, 'the client never sees the answer');
  now += 5000; session.tick();
  assert.equal(upstream.length, 2, 'only after another quiet stretch');
  session.close();
});

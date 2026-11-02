// One viewer's session, against a stand-in stream (the whole RTSP port is in server.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtspSession } from '../../src/rtsp/session.mjs';
import { RtspReader } from '../../src/rtsp/messages.mjs';

const SDP = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'
  + 'm=audio 0 RTP/AVP 97\r\na=rtpmap:97 MPEG4-GENERIC/16000/1\r\na=control:trackID=1\r\n';

function rig({ openUdp = async () => { throw new Error('not used'); } } = {}) {
  const logs = [];
  let deliver = null, ended = null;
  const hub = {
    source: (uri) => (uri.endsWith('/garden') ? {
      sdp: SDP,
      subscribe: (onPacket, onEnd) => { deliver = onPacket; ended = onEnd; return () => { deliver = null; }; },
    } : null),
  };
  const session = new RtspSession('ABC', { hub, now: Date.now, log: (m) => logs.push(m), openUdp });
  const written = [];
  const peer = { written, writableLength: 0, write(b) { written.push(b); }, end() { this.ended = true; }, destroy() {}, localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' };
  session.attach(peer);
  const ask = (method, uri, headers = []) => session.fromClient({ startLine: `${method} ${uri} RTSP/1.0`, headers: [['CSeq', '1'], ...headers], body: Buffer.alloc(0) });
  const answers = () => new RtspReader().push(Buffer.concat(written)).filter((i) => i.message).map((i) => i.message.startLine);
  const frames = () => new RtspReader().push(Buffer.concat(written)).filter((i) => i.frame).map((i) => i.frame);
  return { session, peer, ask, answers, frames, logs, deliver: (...a) => deliver(...a), end: () => ended(), subscribed: () => !!deliver };
}

const packet = (seq) => Object.assign(Buffer.alloc(20), { 0: 0x80, 1: 96 }).fill(seq, 2, 4);
const playing = async (r) => {
  await r.ask('SETUP', 'rtsp://x/garden/trackID=0', [['Transport', 'RTP/AVP/TCP;unicast;interleaved=0-1']]);
  await r.ask('PLAY', 'rtsp://x/garden');
};

test('UDP asked for but the camera\'s ports are taken: 461, so the viewer uses TCP instead', async () => {
  const r = rig({ openUdp: async () => { throw new Error('UDP port 40000 is in use by another program'); } });
  await r.ask('SETUP', 'rtsp://x/garden/trackID=0', [['Transport', 'RTP/AVP;unicast;client_port=5000-5001']]);
  assert.match(r.answers()[0], /^RTSP\/1\.0 461 Unsupported Transport/);
  assert.match(r.logs.join(' '), /told to use TCP/);
  r.session.close();
});

test('SETUP for a track the stream doesn\'t have: 404', async () => {
  const r = rig();
  await r.ask('SETUP', 'rtsp://x/garden/trackID=5', [['Transport', 'RTP/AVP/TCP;unicast;interleaved=0-1']]);
  assert.match(r.answers()[0], /^RTSP\/1\.0 404/);
  r.session.close();
});

test('a method it doesn\'t know: 501', async () => {
  const r = rig();
  await r.ask('RECORD', 'rtsp://x/garden');
  assert.match(r.answers()[0], /^RTSP\/1\.0 501/);
  r.session.close();
});

test('packets of the set-up track go out interleaved, the first with a sender report after it', async () => {
  const r = rig();
  await playing(r);
  r.deliver(0, packet(1), true);
  r.deliver(1, packet(2), true);   // the sound: the viewer didn't set it up
  assert.deepEqual(r.frames().map((f) => [f.channel, f.data[1]]), [[0, 96], [1, 200]]);
  r.session.close();
});

test('a viewer that can\'t keep up skips ahead to the next keyframe, then carries on', async () => {
  const r = rig();
  await playing(r);
  r.deliver(0, packet(1), true);
  const before = r.frames().length;
  r.peer.writableLength = 9 * 1024 * 1024;
  r.deliver(0, packet(2), false);   // dropped: too far behind
  r.peer.writableLength = 0;
  r.deliver(0, packet(3), false);   // still dropped: not a keyframe
  r.deliver(0, packet(4), true);
  const after = r.frames().slice(before).filter((f) => f.channel === 0);
  assert.deepEqual(after.map((f) => f.data[2]), [4]);
  r.session.close();
});

test('PAUSE stops the packets, PLAY starts them again; the stream ending closes the session', async () => {
  const r = rig();
  await playing(r);
  await r.ask('PAUSE', 'rtsp://x/garden');
  assert.equal(r.subscribed(), false);
  await r.ask('PLAY', 'rtsp://x/garden');
  assert.equal(r.subscribed(), true);
  r.end();
  assert.equal(r.session.closed, true);
  assert.equal(r.peer.ended, true, 'the viewer is let go, to come back');
});

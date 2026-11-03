// One viewer's RTSP session, against a stand-in stream and stand-in UDP ports (the whole RTSP port,
// with real sockets, is in server.test.mjs).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RtspSession, PUBLIC, TIMEOUT_S, REPORT_MS, MAX_CLIENT_BACKLOG } from '../../src/rtsp/session.mjs';
import { RtspReader, header } from '../../src/rtsp/messages.mjs';

const SDP = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=0\r\n'
  + 'm=audio 0 RTP/AVP 97\r\na=rtpmap:97 MPEG4-GENERIC/16000/1\r\na=control:trackID=1\r\n';
const URI = 'rtsp://192.168.1.10:8554/garden';
const TCP = 'RTP/AVP/TCP;unicast;interleaved=0-1';
const UDP = 'RTP/AVP;unicast;client_port=5000-5001';
const VIDEO = 0, SOUND = 1, KEYFRAME = true;

// A session with its viewer connected. The stream (garden only) is a stand-in the test speaks for.
function rig({ udpFails = false } = {}) {
  let now = 0;
  const logs = [], udpSent = [], udpClosed = [];
  let deliver = null, endStream = null;
  const hub = {
    source: (uri) => (uri.endsWith('/garden') ? {
      sdp: SDP,
      subscribe: (onPacket, onEnd) => {
        deliver = onPacket;
        endStream = onEnd;
        return () => { deliver = null; };
      },
    } : null),
  };
  const openUdp = async (address, { media }) => {
    if (udpFails) throw new Error('UDP port 40000 is in use by another program');
    const ports = media === 'audio' ? [40002, 40003] : [40000, 40001];
    const socket = (kind) => ({ send: (data, port, to) => udpSent.push({ kind, port, to, data }) });
    return { rtp: socket('rtp'), rtcp: socket('rtcp'), ports, onRtcp: () => {}, close: () => udpClosed.push(media) };
  };
  let closed = 0;
  const session = new RtspSession('ABC', { hub, openUdp, now: () => now, log: (m) => logs.push(m), onClose: () => closed++ });
  clearInterval(session.timer);   // the test runs tick() itself
  const peer = connection();
  session.attach(peer);

  const ask = async (method, uri = URI, headers = []) => {
    const before = peer.written.length;
    await session.fromClient({ startLine: `${method} ${uri} RTSP/1.0`, headers: [['CSeq', '7'], ...headers] });
    const [answer] = new RtspReader().push(Buffer.concat(peer.written.slice(before))).filter((i) => i.message);
    return answer?.message;
  };
  const setup = (track, transport = TCP) => ask('SETUP', `${URI}/trackID=${track}`, [['Transport', transport]]);
  const play = async () => { await setup(VIDEO); return ask('PLAY'); };
  const frames = () => new RtspReader().push(Buffer.concat(peer.written)).filter((i) => i.frame).map((i) => i.frame);
  return {
    session, peer, ask, setup, play, frames, logs, udpSent, udpClosed,
    send: (...a) => deliver(...a),
    subscribed: () => deliver != null,
    endStream: () => endStream(),
    later: (ms) => { now += ms; session.tick(); },
    closedCount: () => closed,
  };
}

function connection() {
  return {
    written: [], writableLength: 0, ended: false,
    localAddress: '192.168.1.10', remoteAddress: '::ffff:192.168.1.20',
    write(b) { this.written.push(b); }, end() { this.ended = true; }, destroy() {},
  };
}

const status = (answer) => Number(answer.startLine.split(' ')[1]);
// An RTP packet: payload type 96, numbered n.
const rtp = (n) => Object.assign(Buffer.alloc(20), { 0: 0x80, 1: 96, 3: n });
const RTP_PT = 96, SR = 200;

describe('OPTIONS', () => {
  test('lists every method, with the session id and its timeout', async () => {
    const answer = await rig().ask('OPTIONS');
    assert.equal(status(answer), 200);
    assert.equal(header(answer.headers, 'public'), PUBLIC);
    assert.equal(header(answer.headers, 'session'), `ABC;timeout=${TIMEOUT_S}`);
  });
});

describe('DESCRIBE', () => {
  test('the stream\'s SDP, with the stream\'s address as the base for the track controls', async () => {
    const answer = await rig().ask('DESCRIBE');
    assert.equal(status(answer), 200);
    assert.equal(header(answer.headers, 'content-type'), 'application/sdp');
    assert.equal(header(answer.headers, 'content-base'), `${URI}/`);
    assert.equal(answer.body.toString(), SDP);
  });

  test('a stream that doesn\'t exist: 404', async () => {
    assert.equal(status(await rig().ask('DESCRIBE', 'rtsp://192.168.1.10:8554/shed')), 404);
  });
});

describe('SETUP', () => {
  test('over TCP: the channels asked for, and the session', async () => {
    const answer = await rig().setup(VIDEO, 'RTP/AVP/TCP;unicast;interleaved=4-5');
    assert.equal(status(answer), 200);
    assert.match(header(answer.headers, 'transport'), /interleaved=4-5/);
    assert.equal(header(answer.headers, 'session'), `ABC;timeout=${TIMEOUT_S}`);
  });

  test('over TCP: a second track asking for channels already taken gets the next free pair', async () => {
    const r = rig();
    await r.setup(VIDEO, 'RTP/AVP/TCP;unicast;interleaved=0-1');
    const answer = await r.setup(SOUND, 'RTP/AVP/TCP;unicast;interleaved=0-1');
    assert.match(header(answer.headers, 'transport'), /interleaved=2-3/);
  });

  test('over UDP: the camera\'s fixed ports for the track (video and sound have their own)', async () => {
    const r = rig();
    assert.match(header((await r.setup(VIDEO, UDP)).headers, 'transport'), /client_port=5000-5001;server_port=40000-40001/);
    assert.match(header((await r.setup(SOUND, 'RTP/AVP;unicast;client_port=5002-5003')).headers, 'transport'), /server_port=40002-40003/);
  });

  test('over UDP, but the camera\'s ports are taken: 461, so the viewer uses TCP instead', async () => {
    const r = rig({ udpFails: true });
    assert.equal(status(await r.setup(VIDEO, UDP)), 461);
    assert.match(r.logs.join(' '), /in use by another program.*told to use TCP/);
  });

  test('a transport it can\'t do (multicast): 461', async () => {
    assert.equal(status(await rig().setup(VIDEO, 'RTP/AVP;multicast')), 461);
  });

  test('a track the stream doesn\'t have, or a stream that doesn\'t exist: 404', async () => {
    const r = rig();
    assert.equal(status(await r.setup(5)), 404);
    assert.equal(status(await r.ask('SETUP', 'rtsp://192.168.1.10:8554/shed/trackID=0', [['Transport', TCP]])), 404);
  });

  test('setting a track up again replaces its transport', async () => {
    const r = rig();
    await r.setup(VIDEO, UDP);
    await r.setup(VIDEO, TCP);
    assert.deepEqual(r.udpClosed, ['video']);
  });
});

describe('PLAY and PAUSE', () => {
  test('PLAY before any SETUP: 455', async () => {
    assert.equal(status(await rig().ask('PLAY')), 455);
  });

  test('PLAY subscribes to the stream and answers from the start (npt=0)', async () => {
    const r = rig();
    const answer = await r.play();
    assert.equal(status(answer), 200);
    assert.equal(header(answer.headers, 'range'), 'npt=0.000-');
    assert.equal(r.subscribed(), true);
  });

  test('PAUSE stops the packets; PLAY starts them again', async () => {
    const r = rig();
    await r.play();
    await r.ask('PAUSE');
    assert.equal(r.subscribed(), false);
    await r.ask('PLAY');
    assert.equal(r.subscribed(), true);
  });
});

describe('the packets', () => {
  test('a set-up track\'s packets go out on its channel, the first followed by a sender report', async () => {
    const r = rig();
    await r.play();
    r.send(VIDEO, rtp(1), KEYFRAME);
    r.send(VIDEO, rtp(2), false);
    assert.deepEqual(r.frames().map((f) => [f.channel, f.data[1]]), [[0, RTP_PT], [1, SR], [0, RTP_PT]]);
  });

  test('a track the viewer didn\'t set up isn\'t sent', async () => {
    const r = rig();
    await r.play();
    r.send(SOUND, rtp(1), false);
    assert.deepEqual(r.frames(), []);
  });

  test('over UDP: to the viewer\'s own ports, at its address', async () => {
    const r = rig();
    await r.setup(VIDEO, UDP);
    await r.ask('PLAY');
    r.send(VIDEO, rtp(1), KEYFRAME);
    assert.deepEqual(r.udpSent.map((p) => [p.kind, p.port, p.to]), [['rtp', 5000, '192.168.1.20'], ['rtcp', 5001, '192.168.1.20']]);
  });

  test('a viewer that can\'t keep up skips ahead to the next keyframe, then carries on', async () => {
    const r = rig();
    await r.play();
    r.send(VIDEO, rtp(1), KEYFRAME);
    const before = r.frames().length;
    r.peer.writableLength = MAX_CLIENT_BACKLOG + 1;
    r.send(VIDEO, rtp(2), false);   // dropped: too far behind
    r.peer.writableLength = 0;
    r.send(VIDEO, rtp(3), false);   // still dropped: not a keyframe
    r.send(SOUND, rtp(4), false);   // nor the sound: it would run ahead of the picture
    r.send(VIDEO, rtp(5), KEYFRAME);
    r.send(VIDEO, rtp(6), false);
    assert.deepEqual(r.frames().slice(before).filter((f) => f.channel === 0).map((f) => f.data[3]), [5, 6]);
  });

  test('every REPORT_MS while playing, a sender report for each track', async () => {
    const r = rig();
    await r.play();
    r.send(VIDEO, rtp(1), KEYFRAME);
    const reports = () => r.frames().filter((f) => f.channel === 1).length;
    const before = reports();
    r.later(REPORT_MS);
    assert.equal(reports(), before + 1);
  });
});

describe('keep-alives and the end of a session', () => {
  test('GET_PARAMETER and SET_PARAMETER keep it alive, and are answered', async () => {
    const r = rig();
    assert.equal(status(await r.ask('GET_PARAMETER')), 200);
    assert.equal(status(await r.ask('SET_PARAMETER')), 200);
  });

  test('a method it doesn\'t know: 501', async () => {
    assert.equal(status(await rig().ask('RECORD')), 501);
  });

  test('TEARDOWN answers, then ends the session and lets the connection go', async () => {
    const r = rig();
    await r.play();
    assert.equal(status(await r.ask('TEARDOWN')), 200);
    assert.equal(r.session.closed, true);
    assert.equal(r.subscribed(), false);
    assert.equal(r.peer.ended, true);
    assert.equal(r.closedCount(), 1);
  });

  test('the stream ending (a new codec) ends the session; the viewer comes back', async () => {
    const r = rig();
    await r.play();
    r.endStream();
    assert.equal(r.session.closed, true);
    assert.equal(r.peer.ended, true);
  });

  test('a session over TCP ends with its connection', async () => {
    const r = rig();
    await r.play();
    r.session.detach(r.peer);
    assert.equal(r.session.closed, true);
  });

  test('a session playing over UDP outlives its connection, until nothing is heard for TIMEOUT_S', async () => {
    const r = rig();
    await r.setup(VIDEO, UDP);
    await r.ask('PLAY');
    r.session.detach(r.peer);
    r.later(TIMEOUT_S * 1000);
    assert.equal(r.session.closed, false, 'the viewer may come back with its id');
    r.later(REPORT_MS);
    assert.equal(r.session.closed, true);
    assert.deepEqual(r.udpClosed, ['video']);
  });

  test('the viewer back on a new connection: the session carries on there', async () => {
    const r = rig();
    await r.setup(VIDEO, UDP);
    await r.ask('PLAY');
    r.session.detach(r.peer);
    const again = connection();
    r.session.attach(again);
    r.later(TIMEOUT_S * 1000 + REPORT_MS);
    assert.equal(r.session.closed, false, 'connected: no timeout');
    assert.equal(r.session.client, again);
  });

  test('a connection that isn\'t the session\'s ending changes nothing', async () => {
    const r = rig();
    await r.play();
    r.session.detach(connection());
    assert.equal(r.session.closed, false);
  });
});

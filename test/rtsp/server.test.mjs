import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { createRtspFront } from '../../src/rtsp/server.mjs';
import { RtspReader, formatMessage, header } from '../../src/rtsp/messages.mjs';
import { digestAnswer } from '../helpers/logins.mjs';

import { StreamHub } from '../../src/rtsp/stream-hub.mjs';
import { publishSdp } from '../../src/video/rtp.mjs';

// The gateway's own streams, with stand-in publishers: every 20 ms an RTP packet on each track,
// numbered; every 5th video packet starts a keyframe. garden has sound, front-door doesn't.
function rtp(ssrc, n) {
  const p = Buffer.alloc(40);
  p[0] = 0x80;
  p[1] = 96;
  p.writeUInt16BE(n & 0xffff, 2);
  p.writeUInt32BE(n * 6000, 4);
  p.writeUInt32BE(ssrc, 8);
  return p;
}

const hub = new StreamHub({ cameras: [{ name: 'garden', width: 1280, height: 720 }, { name: 'front-door', width: 1280, height: 720 }] });
const timers = [];
function startPublisher(name, audio) {
  const publication = hub.publish(name, { sdp: publishSdp({ codec: 'h264', params: {}, audio }), codec: 'h264' });
  let n = 0;
  timers.push(setInterval(() => {
    n++;
    publication.send(0, rtp(0x1000, n), n % 5 === 0);
    if (audio) publication.send(1, rtp(0x1001, n));
  }, 20));
  return publication;
}

const credentials = { username: 'protect', password: 'secret' };
let garden, front, port;
before(async () => {
  garden = startPublisher('garden', true);
  startPublisher('front-door', false);
  front = createRtspFront({ hub, credentials, udpPortOf: (name) => (name === 'garden' ? 41000 : null) });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  port = front.address().port;
});
after(() => {
  front.shutdown();
  timers.forEach(clearInterval);
});

// A small RTSP client: send(method, uri, headers) -> the answer; frames collects interleaved data.
function client({ write, onData }) {
  const reader = new RtspReader();
  const waiting = [];
  const frames = [];
  let cseq = 0;
  onData((chunk) => {
    for (const item of reader.push(chunk)) item.frame ? frames.push(item.frame) : waiting.shift()?.(item.message);
  });
  const send = (method, uri, headers = []) => new Promise((resolve) => {
    waiting.push(resolve);
    write(formatMessage({ startLine: `${method} ${uri} RTSP/1.0`, headers: [['CSeq', String(++cseq)], ...headers] }));
  });
  return { send, frames };
}

function tcpClient() {
  const socket = connect(port, '127.0.0.1');
  return { socket, ...client({ write: (b) => socket.write(b), onData: (fn) => socket.on('data', fn) }) };
}

// RTSP Digest, as clients compute it from a 401's challenge.
const digest = (challenge, method, uri, login = credentials) => digestAnswer(challenge, { ...login, method, uri });

async function login(c, uri) {
  const refused = await c.send('DESCRIBE', uri);
  assert.match(refused.startLine, /^RTSP\/1\.0 401/);
  const challenge = refused.headers.filter(([n]) => n === 'WWW-Authenticate').map(([, v]) => v).find((v) => v.startsWith('Digest'));
  return c.send('DESCRIBE', uri, [['Authorization', digest(challenge, 'DESCRIBE', uri)]]);
}

const URI = 'rtsp://127.0.0.1/garden';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('the RTSP front', () => {
  test('asks for the login (Digest or Basic); OPTIONS is open', async () => {
    const c = tcpClient();
    assert.match((await c.send('OPTIONS', URI)).startLine, /200/);
    const refused = await c.send('DESCRIBE', URI);
    assert.match(refused.startLine, /401 Unauthorized/);
    assert.deepEqual(refused.headers.filter(([n]) => n === 'WWW-Authenticate').map(([, v]) => v.split(' ')[0]), ['Digest', 'Basic']);
    const wrong = await c.send('DESCRIBE', URI, [['Authorization', 'Basic ' + Buffer.from('protect:nope').toString('base64')]]);
    assert.match(wrong.startLine, /401/);
    const basic = await c.send('DESCRIBE', URI, [['Authorization', 'Basic ' + Buffer.from('protect:secret').toString('base64')]]);
    assert.match(basic.startLine, /200/);
    c.socket.destroy();
  });

  test('RTSP over TCP: the stream, plus sender reports; one session id; sendonly', async () => {
    const c = tcpClient();
    const described = await login(c, URI);
    assert.equal(header(described.headers, 'content-type'), 'application/sdp');
    assert.equal(header(described.headers, 'content-base'), `${URI}/`);
    const sdp = described.body.toString();
    assert.match(sdp, /m=video 0 RTP\/AVP 96\r\na=rtpmap:96 H264\/90000\r\n[\s\S]*a=sendonly\r\na=control:trackID=0\r\n/);
    assert.match(sdp, /m=audio 0 RTP\/AVP 97\r\na=rtpmap:97 MPEG4-GENERIC\/16000\/1\r\n[\s\S]*a=control:trackID=1\r\n/);
    assert.doesNotMatch(sdp, /recvonly|127\.0\.0\.1/);
    const video = await c.send('SETUP', `${URI}/trackID=0`, [['Transport', 'RTP/AVP/TCP;unicast;interleaved=0-1']]);
    const session = header(video.headers, 'session');
    assert.match(session, /^[0-9A-F]{16};timeout=60$/);
    const audio = await c.send('SETUP', `${URI}/trackID=1`, [['Transport', 'RTP/AVP/TCP;unicast;interleaved=2-3'], ['Session', session.split(';')[0]]]);
    assert.equal(header(audio.headers, 'session'), session, 'the same id for the whole session');
    const play = await c.send('PLAY', URI, [['Session', session.split(';')[0]]]);
    assert.equal(header(play.headers, 'range'), 'npt=0.000-');
    await wait(250);
    const channels = new Set(c.frames.map((f) => f.channel));
    assert.ok(channels.has(0) && channels.has(2), 'RTP on both tracks');
    assert.equal(c.frames.find((f) => f.channel === 0).data.readUInt16BE(2) % 5, 0, 'the video starts at a keyframe');
    const reports = c.frames.filter((f) => f.channel === 1 || f.channel === 3);
    assert.ok(reports.length >= 2, 'a sender report per track at its first packet');
    assert.equal(reports[0].data[1], 200);
    assert.ok([0x1000, 0x1001].includes(reports[0].data.readUInt32BE(4)), 'about the track\'s SSRC');
    c.socket.destroy();
  });

  test('a stream that doesn\'t exist: 404', async () => {
    const c = tcpClient();
    assert.match((await login(c, 'rtsp://127.0.0.1/nobody')).startLine, /^RTSP\/1\.0 404/);
    c.socket.destroy();
  });

  test('?video: the video track only', async () => {
    const c = tcpClient();
    const sdp = (await login(c, `${URI}?video`)).body.toString();
    assert.match(sdp, /m=video/);
    assert.doesNotMatch(sdp, /m=audio/);
    c.socket.destroy();
  });

  test('PLAY before any SETUP: 455', async () => {
    const c = tcpClient();
    await login(c, URI);
    assert.match((await c.send('PLAY', URI)).startLine, /^RTSP\/1\.0 455/);
    c.socket.destroy();
  });

  test('RTP over UDP: packets go to the client\'s ports, sender reports to its RTCP port', async () => {
    const rtpSocket = createSocket('udp4'), rtcpSocket = createSocket('udp4');
    await new Promise((r) => rtpSocket.bind(0, '127.0.0.1', r));
    await new Promise((r) => rtcpSocket.bind(rtpSocket.address().port + 1, '127.0.0.1', r));
    const got = { rtp: 0, rtcp: [] };
    rtpSocket.on('message', () => got.rtp++);
    rtcpSocket.on('message', (m) => got.rtcp.push(m));
    const c = tcpClient();
    await login(c, URI);
    const clientPorts = `${rtpSocket.address().port}-${rtcpSocket.address().port}`;
    const setup = await c.send('SETUP', `${URI}/trackID=0`, [['Transport', `RTP/AVP;unicast;client_port=${clientPorts}`]]);
    const transport = header(setup.headers, 'transport');
    assert.match(transport, new RegExp(`^RTP/AVP;unicast;client_port=${clientPorts};server_port=(4\\d{4})-(4\\d{4})$`));
    const [, a, b] = /server_port=(\d+)-(\d+)/.exec(transport);
    assert.equal(Number(a) % 2, 0);
    assert.equal(Number(b), Number(a) + 1);
    await c.send('PLAY', URI, [['Session', header(setup.headers, 'session').split(';')[0]]]);
    await wait(250);
    assert.ok(got.rtp >= 5, `RTP over UDP (${got.rtp})`);
    assert.equal(got.rtcp[0]?.[1], 200, 'a sender report');
    assert.equal(c.frames.length, 0, 'nothing interleaved');
    c.socket.destroy();
    rtpSocket.close();
    rtcpSocket.close();
  });

  test('a playing UDP session outlives its RTSP connection and can be picked up again by its id', async () => {
    const rtpSocket = createSocket('udp4');
    await new Promise((r) => rtpSocket.bind(0, '127.0.0.1', r));
    let packets = 0;
    rtpSocket.on('message', () => packets++);
    const c = tcpClient();
    await login(c, URI);
    const p = rtpSocket.address().port;
    const setup = await c.send('SETUP', `${URI}/trackID=0`, [['Transport', `RTP/AVP;unicast;client_port=${p}-${p + 1}`]]);
    const id = header(setup.headers, 'session').split(';')[0];
    await c.send('PLAY', URI, [['Session', id]]);
    c.socket.destroy();
    await wait(150);
    const before = packets;
    await wait(150);
    assert.ok(packets > before, 'still streaming');
    const again = tcpClient();
    const auth = 'Basic ' + Buffer.from('protect:secret').toString('base64');
    assert.match((await again.send('GET_PARAMETER', URI, [['Session', id], ['Authorization', auth]])).startLine, /200/);
    const teardown = await again.send('TEARDOWN', URI, [['Session', id]]);
    assert.match(teardown.startLine, /200/);
    assert.match((await tcpClient().send('GET_PARAMETER', URI, [['Session', 'FFFFFFFFFFFFFFFF'], ['Authorization', auth]])).startLine, /454/);
    again.socket.destroy();
    rtpSocket.close();
  });

  test('VLC over UDP: its keep-alives are answered while playing; TEARDOWN ends it and its subscription', async () => {
    const rtpSocket = createSocket('udp4');
    await new Promise((r) => rtpSocket.bind(0, '127.0.0.1', r));
    const c = tcpClient();
    await login(c, URI);
    const p = rtpSocket.address().port;
    const setup = await c.send('SETUP', `${URI}/trackID=0`, [['Transport', `RTP/AVP;unicast;client_port=${p}-${p + 1}`]]);
    const session = [['Session', header(setup.headers, 'session').split(';')[0]]];
    const viewersBefore = garden.listenerCount('packet');
    await c.send('PLAY', URI, session);
    assert.equal(garden.listenerCount('packet'), viewersBefore + 1);
    for (const method of ['GET_PARAMETER', 'SET_PARAMETER', 'OPTIONS', 'GET_PARAMETER']) {
      const answer = await c.send(method, URI, session);
      assert.match(answer.startLine, /^RTSP\/1\.0 200/, method);
      assert.match(header(answer.headers, 'session'), /;timeout=60$/);
    }
    assert.match((await c.send('TEARDOWN', URI, session)).startLine, /^RTSP\/1\.0 200/);
    assert.equal(garden.listenerCount('packet'), viewersBefore, 'no longer subscribed');
    c.socket.destroy();
    rtpSocket.close();
  });

  test('when the camera\'s stream starts again (a new codec), its viewers are let go, to come back', async () => {
    const c = tcpClient();
    await login(c, 'rtsp://127.0.0.1/front-door');
    const setup = await c.send('SETUP', 'rtsp://127.0.0.1/front-door/trackID=0', [['Transport', 'RTP/AVP/TCP;unicast;interleaved=0-1']]);
    await c.send('PLAY', 'rtsp://127.0.0.1/front-door', [['Session', header(setup.headers, 'session').split(';')[0]]]);
    const closed = new Promise((r) => c.socket.on('close', r));
    startPublisher('front-door', false);   // replaces the stream
    await closed;
  });

  test('RTSP over HTTP: requests base64 in a POST, everything back on the GET', async () => {
    const cookie = 'tunnel' + Date.now();
    const get = connect(port, '127.0.0.1');
    get.write(`GET /garden HTTP/1.0\r\nx-sessioncookie: ${cookie}\r\nAccept: application/x-rtsp-tunnelled\r\n\r\n`);
    let httpHead = null;
    const onData = [];
    get.on('data', (chunk) => {
      if (!httpHead) {
        const text = chunk.toString('latin1');
        const end = text.indexOf('\r\n\r\n');
        httpHead = text.slice(0, end);
        chunk = chunk.subarray(end + 4);
      }
      if (chunk.length) onData.forEach((fn) => fn(chunk));
    });
    await wait(50);
    const post = connect(port, '127.0.0.1');
    post.write(`POST /garden HTTP/1.0\r\nx-sessioncookie: ${cookie}\r\nContent-Type: application/x-rtsp-tunnelled\r\nContent-Length: 32767\r\n\r\n`);
    const c = client({ write: (b) => post.write(b.toString('base64')), onData: (fn) => onData.push(fn) });
    const described = await login(c, URI);
    assert.match(httpHead, /^HTTP\/1\.0 200 OK/);
    assert.match(httpHead, /Content-Type: application\/x-rtsp-tunnelled/);
    assert.match(described.body.toString(), /m=video/);
    const setup = await c.send('SETUP', `${URI}/trackID=0`, [['Transport', 'RTP/AVP/TCP;unicast;interleaved=0-1']]);
    await c.send('PLAY', URI, [['Session', header(setup.headers, 'session').split(';')[0]]]);
    await wait(150);
    assert.ok(c.frames.some((f) => f.channel === 0), 'RTP on the GET connection');
    get.destroy();
    post.destroy();
  });

  test('a camera without UDP ports: viewers asking for UDP are told to use TCP (461)', async () => {
    const c = tcpClient();
    await login(c, URI.replace('garden', 'front-door'));
    const r = await c.send('SETUP', `${URI.replace('garden', 'front-door')}/trackID=0`, [['Transport', 'RTP/AVP;unicast;client_port=5000-5001']]);
    assert.match(r.startLine, /^RTSP\/1\.0 461/);
    c.socket.destroy();
  });

  test('a transport it can\'t do is refused (461)', async () => {
    const c = tcpClient();
    await login(c, URI);
    assert.match((await c.send('SETUP', `${URI}/trackID=0`, [['Transport', 'RTP/AVP;multicast']])).startLine, /^RTSP\/1\.0 461/);
    c.socket.destroy();
  });
});

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { createRtspFront } from '../../src/rtsp/server.mjs';
import { RtspReader, formatMessage, formatFrame, header } from '../../src/rtsp/messages.mjs';
import { digestAnswer } from '../helpers/logins.mjs';

// A stand-in for go2rtc: RTSP over TCP only, a new session id per SETUP, recvonly in the SDP, no
// RTCP; after PLAY it sends an RTP packet on every set-up track every 20 ms. Like the real one
// (1.9.15, measured), once playing it answers OPTIONS but never GET_PARAMETER, SET_PARAMETER or
// TEARDOWN: a stand-in that answered everything hid exactly that from these tests.
const SDP = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=go2rtc\r\nt=0 0\r\n'
  + 'm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=recvonly\r\na=control:trackID=0\r\n'
  + 'm=audio 0 RTP/AVP 97\r\na=rtpmap:97 MPEG4-GENERIC/16000\r\na=recvonly\r\na=control:trackID=1\r\n';
const seen = [];   // what go2rtc received: [method, headers]

function rtp(ssrc, n) {
  const p = Buffer.alloc(40);
  p[0] = 0x80;
  p[1] = 96;
  p.writeUInt16BE(n & 0xffff, 2);
  p.writeUInt32BE(n * 6000, 4);
  p.writeUInt32BE(ssrc, 8);
  return p;
}

const upstreamSockets = new Set();
function fakeGo2rtc() {
  let sessions = 0;
  return createServer((socket) => {
    upstreamSockets.add(socket);
    const reader = new RtspReader();
    const channels = [];
    let timer, playing = false;
    socket.on('data', (chunk) => {
      for (const { message } of reader.push(chunk)) {
        if (!message) continue;
        const [method] = message.startLine.split(' ');
        seen.push([method, message.headers]);
        const reply = (headers, body) => socket.write(formatMessage({ startLine: 'RTSP/1.0 200 OK', headers: [['CSeq', header(message.headers, 'cseq')], ...headers], body }));
        if (method === 'DESCRIBE') reply([['Content-Type', 'application/sdp']], Buffer.from(SDP));
        if (method === 'SETUP') {
          const transport = header(message.headers, 'transport');
          channels.push(Number(/interleaved=(\d+)/.exec(transport)[1]));
          reply([['Transport', transport], ['Session', `${++sessions};timeout=60`]]);
        }
        if (method === 'PLAY') {
          playing = true;
          reply([['Session', String(sessions)]]);
          let n = 0;
          timer = setInterval(() => { n++; channels.forEach((c, i) => socket.write(formatFrame(c, rtp(0x1000 + i, n)))); }, 20);
        }
        if (method === 'OPTIONS' || (!playing && ['GET_PARAMETER', 'SET_PARAMETER', 'TEARDOWN'].includes(method))) reply([]);
      }
    });
    socket.on('close', () => clearInterval(timer));
    socket.on('error', () => {});
  });
}

const credentials = { username: 'protect', password: 'secret' };
let upstream, front, port;
before(async () => {
  upstream = fakeGo2rtc();
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  front = createRtspFront({ upstream: { host: '127.0.0.1', port: upstream.address().port }, credentials, udpPortOf: (name) => (name === 'garden' ? 41000 : null) });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  port = front.address().port;
});
after(() => {
  front.shutdown();
  upstream.close();
  for (const socket of upstreamSockets) socket.destroy();
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

  test('RTSP over TCP: the stream as go2rtc sends it, plus sender reports; one session id; sendonly', async () => {
    const c = tcpClient();
    const described = await login(c, URI);
    assert.match(described.body.toString(), /a=sendonly\r\n/);
    assert.doesNotMatch(described.body.toString(), /recvonly/);
    const video = await c.send('SETUP', `${URI}/trackID=0`, [['Transport', 'RTP/AVP/TCP;unicast;interleaved=0-1']]);
    const session = header(video.headers, 'session');
    assert.match(session, /^[0-9A-F]{16};timeout=60$/);
    const audio = await c.send('SETUP', `${URI}/trackID=1`, [['Transport', 'RTP/AVP/TCP;unicast;interleaved=2-3'], ['Session', session.split(';')[0]]]);
    assert.equal(header(audio.headers, 'session'), session, 'the same id, although go2rtc gave a new one');
    assert.equal(header(seen.at(-1)[1], 'session'), '1', 'go2rtc got its own id back');
    await c.send('PLAY', URI, [['Session', session.split(';')[0]]]);
    await wait(200);
    const channels = new Set(c.frames.map((f) => f.channel));
    assert.ok(channels.has(0) && channels.has(2), 'RTP on both tracks');
    const reports = c.frames.filter((f) => f.channel === 1 || f.channel === 3);
    assert.ok(reports.length >= 2, 'a sender report per track at its first packet');
    assert.equal(reports[0].data[1], 200);
    assert.ok([0x1000, 0x1001].includes(reports[0].data.readUInt32BE(4)), 'about the track\'s SSRC');
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
    assert.match(header(seen.at(-1)[1], 'transport'), /^RTP\/AVP\/TCP;unicast;interleaved=0-1$/, 'go2rtc got an interleaved SETUP');
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

  test('VLC over UDP: its keep-alives are answered while playing, go2rtc never sees them; TEARDOWN ends it', async () => {
    const rtpSocket = createSocket('udp4');
    await new Promise((r) => rtpSocket.bind(0, '127.0.0.1', r));
    const c = tcpClient();
    await login(c, URI);
    const p = rtpSocket.address().port;
    const setup = await c.send('SETUP', `${URI}/trackID=0`, [['Transport', `RTP/AVP;unicast;client_port=${p}-${p + 1}`]]);
    const session = [['Session', header(setup.headers, 'session').split(';')[0]]];
    await c.send('PLAY', URI, session);
    const before = seen.length;
    for (const method of ['GET_PARAMETER', 'SET_PARAMETER', 'GET_PARAMETER']) {
      const answer = await c.send(method, URI, session);
      assert.match(answer.startLine, /^RTSP\/1\.0 200/, method);
      assert.match(header(answer.headers, 'session'), /;timeout=60$/);
    }
    assert.deepEqual(seen.slice(before).map(([m]) => m), [], 'none of them reached go2rtc');
    const upstreamBefore = upstreamSockets.size && [...upstreamSockets].filter((s) => !s.destroyed).length;
    assert.match((await c.send('TEARDOWN', URI, session)).startLine, /^RTSP\/1\.0 200/);
    await wait(50);
    assert.equal([...upstreamSockets].filter((s) => !s.destroyed).length, upstreamBefore - 1, 'its go2rtc connection closed');
    c.socket.destroy();
    rtpSocket.close();
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

  test('the camera of a SETUP, from its path (variants and queries included)', async () => {
    const { cameraOf } = await import('../../src/rtsp/server.mjs');
    assert.equal(cameraOf('rtsp://192.168.1.10:8554/garden/trackID=0'), 'garden');
    assert.equal(cameraOf('rtsp://192.168.1.10:8554/garden~mjpeg~g711/trackID=1'), 'garden');
    assert.equal(cameraOf('rtsp://192.168.1.10:8554/garden?video/trackID=0'), 'garden');
  });

  test('a camera\'s UDP port pair is shared by all its viewers, and closed with the last one', async () => {
    const { UdpPorts } = await import('../../src/rtsp/server.mjs');
    const udp = new UdpPorts();
    const [a, b] = await Promise.all([udp.lease('127.0.0.1', 42100), udp.lease('127.0.0.1', 42100)]);
    assert.equal(a.rtp, b.rtp, 'the same socket: no new port per viewer');
    assert.deepEqual(a.ports, [42100, 42101]);
    a.close();
    assert.equal(udp.pairs.size, 1, 'still in use by the other viewer');
    b.close();
    assert.equal(udp.pairs.size, 0);
    const other = createSocket('udp4');
    await new Promise((r) => other.bind(42102, '127.0.0.1', r));
    await assert.rejects(udp.lease('127.0.0.1', 42102), /UDP port 42102 is in use by another program/);
    other.close();
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

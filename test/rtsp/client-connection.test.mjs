// One client connection: the login, then each request to its session. Sessions are fakes here; the
// whole RTSP port (with stand-in publishers) is in server.test.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ClientConnection } from '../../src/rtsp/client-connection.mjs';
import { formatMessage, formatFrame } from '../../src/rtsp/messages.mjs';

// A login that accepts "Authorization: good".
const auth = {
  allows: (req) => req.headers.authorization === 'good',
  challenges: () => ['Digest realm="x", nonce="n"', 'Basic realm="x"'],
};

function fakeSession(id) {
  return {
    id, closed: false, client: null, requests: [], frames: [],
    attach(peer) { this.client = peer; },
    detach(peer) { if (this.client === peer) this.client = null; },
    async fromClient(message) { this.requests.push(message.startLine.split(' ')[0]); },
    fromClientFrame(frame) { this.frames.push(frame); },
  };
}

function setup({ withAuth = true } = {}) {
  const sessions = new Map();
  let n = 0;
  const registry = {
    create() { const s = fakeSession(`S${++n}`); sessions.set(s.id, s); return s; },
    get: (id) => sessions.get(id),
  };
  const peer = () => ({ written: [], destroyed: false, remoteAddress: '192.168.1.20', write(b) { this.written.push(b.toString()); }, destroy() { this.destroyed = true; } });
  const connect = (p = peer()) => ({ peer: p, conn: new ClientConnection(p, { sessions: registry, auth: withAuth ? auth : null, log: () => {} }) });
  const ask = async ({ conn }, method, headers = []) => {
    conn.push(formatMessage({ startLine: `${method} rtsp://x/garden RTSP/1.0`, headers: [['CSeq', '1'], ...headers] }));
    await conn.queue;
  };
  return { sessions, connect, ask };
}
const last = ({ peer }) => peer.written.at(-1) ?? '';

describe('the login', () => {
  test('OPTIONS is open; anything else first gets a 401 with the challenges', async () => {
    const { connect, ask } = setup();
    const c = connect();
    await ask(c, 'OPTIONS');
    assert.match(last(c), /^RTSP\/1\.0 200 OK\r\nCSeq: 1\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER, SET_PARAMETER/);
    await ask(c, 'DESCRIBE');
    assert.match(last(c), /^RTSP\/1\.0 401 Unauthorized/);
    assert.match(last(c), /WWW-Authenticate: Digest realm="x", nonce="n"\r\nWWW-Authenticate: Basic realm="x"/);
  });

  test('once a request has logged in, the connection stays logged in', async () => {
    const { connect, ask, sessions } = setup();
    const c = connect();
    await ask(c, 'DESCRIBE', [['Authorization', 'good']]);
    await ask(c, 'SETUP');
    assert.deepEqual(sessions.get('S1').requests, ['DESCRIBE', 'SETUP']);
  });

  test('a wrong login is refused and nothing reaches a session', async () => {
    const { connect, ask, sessions } = setup();
    const c = connect();
    await ask(c, 'DESCRIBE', [['Authorization', 'bad']]);
    assert.match(last(c), /^RTSP\/1\.0 401/);
    assert.equal(sessions.size, 0);
  });

  test('without a login configured, everything goes through', async () => {
    const { connect, ask, sessions } = setup({ withAuth: false });
    await ask(connect(), 'DESCRIBE');
    assert.deepEqual(sessions.get('S1').requests, ['DESCRIBE']);
  });
});

describe('sessions', () => {
  test('requests without a Session header go to the connection\'s own session, made on first use', async () => {
    const { connect, ask, sessions } = setup({ withAuth: false });
    const c = connect();
    await ask(c, 'DESCRIBE');
    await ask(c, 'SETUP');
    assert.equal(sessions.size, 1);
    assert.equal(sessions.get('S1').client, c.peer);
  });

  test('a request naming an unknown session: 454', async () => {
    const { connect, ask } = setup({ withAuth: false });
    const c = connect();
    await ask(c, 'GET_PARAMETER', [['Session', 'FFFF']]);
    assert.match(last(c), /^RTSP\/1\.0 454 Session Not Found/);
  });

  test('a session can be picked up from another connection by its id (allowed with UDP)', async () => {
    const { connect, ask, sessions } = setup({ withAuth: false });
    const first = connect();
    await ask(first, 'SETUP');
    const second = connect();
    await ask(second, 'PLAY', [['Session', 'S1;timeout=60']]);
    assert.equal(sessions.get('S1').client, second.peer, 'answers now go to the new connection');
    assert.deepEqual(sessions.get('S1').requests, ['SETUP', 'PLAY']);
  });

  test('OPTIONS with a Session header goes to that session (a keep-alive)', async () => {
    const { connect, ask, sessions } = setup({ withAuth: false });
    const c = connect();
    await ask(c, 'SETUP');
    await ask(c, 'OPTIONS', [['Session', 'S1']]);
    assert.deepEqual(sessions.get('S1').requests, ['SETUP', 'OPTIONS']);
  });

  test('interleaved data from the client goes to its session', async () => {
    const { connect, ask, sessions } = setup({ withAuth: false });
    const c = connect();
    await ask(c, 'SETUP');
    c.conn.push(formatFrame(1, Buffer.from([0x80, 201])));
    await c.conn.queue;
    assert.equal(sessions.get('S1').frames.length, 1);
  });

  test('the connection ending detaches its session', async () => {
    const { connect, ask, sessions } = setup({ withAuth: false });
    const c = connect();
    await ask(c, 'SETUP');
    c.conn.end();
    assert.equal(sessions.get('S1').client, null);
  });
});

test('bytes that aren\'t RTSP close the connection', () => {
  const { connect } = setup();
  const c = connect();
  c.conn.push(Buffer.from('X'.repeat(70000)));
  assert.equal(c.peer.destroyed, true);
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHttpAuth } from '../../src/onvif/http-auth.mjs';

const credentials = { username: 'protect', password: 'secret' };
const md5 = (s) => createHash('md5').update(s).digest('hex');
const request = (authorization, method = 'GET') => ({ method, headers: authorization ? { authorization } : {} });

// What an ONVIF client does with the Digest challenge (RFC 7616, qop=auth).
function digestAnswer(challenge, { username = 'protect', password = 'secret', uri = '/onvif/snapshot.jpg', method = 'GET' } = {}) {
  const nonce = /nonce="([^"]+)"/.exec(challenge)[1], realm = /realm="([^"]+)"/.exec(challenge)[1];
  const ha1 = md5(`${username}:${realm}:${password}`), ha2 = md5(`${method}:${uri}`), nc = '00000001', cnonce = 'abc';
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
  return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
}

describe('the ONVIF snapshot login', () => {
  test('without an ONVIF login, the snapshot is open', () => {
    assert.equal(createHttpAuth(null).allows(request()), true);
  });

  test('offers Digest first, Basic as a fallback', () => {
    const [digest, basic] = createHttpAuth(credentials).challenges();
    assert.match(digest, /^Digest realm="eufy-nvr-gateway", nonce="[0-9a-f]+\.[0-9a-f]+", algorithm=MD5, qop="auth"$/);
    assert.equal(basic, 'Basic realm="eufy-nvr-gateway"');
  });

  test('a correct Digest answer is let in; a wrong password or user is not', () => {
    const auth = createHttpAuth(credentials);
    const [challenge] = auth.challenges();
    assert.equal(auth.allows(request(digestAnswer(challenge))), true);
    assert.equal(auth.allows(request(digestAnswer(challenge, { password: 'nope' }))), false);
    assert.equal(auth.allows(request(digestAnswer(challenge, { username: 'admin' }))), false);
  });

  test('VLC (live555): reads realm and nonce with a fixed pattern, answers without qop (RFC 2069)', () => {
    const auth = createHttpAuth(credentials);
    const [challenge] = auth.challenges();
    const parsed = /^Digest realm="([^"]+)", nonce="([^"]+)"/.exec(challenge);   // live555's sscanf pattern
    assert.ok(parsed, 'live555 must find realm and nonce right after "Digest"');
    const [, realm, nonce] = parsed, uri = 'rtsp://192.168.1.10:8554/garden';
    const response = md5(`${md5(`protect:${realm}:secret`)}:${nonce}:${md5(`DESCRIBE:${uri}`)}`);
    const answer = `Digest username="protect", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
    assert.equal(auth.allows(request(answer, 'DESCRIBE')), true);
  });

  test('a nonce it didn\'t make, or an old one, is refused', () => {
    let now = 1_000_000;
    const auth = createHttpAuth(credentials, { now: () => now });
    const [challenge] = auth.challenges();
    const forged = challenge.replace(/nonce="[^"]+"/, 'nonce="f4240.0000"');
    assert.equal(auth.allows(request(digestAnswer(forged))), false);
    now += 6 * 60 * 1000;
    assert.equal(auth.allows(request(digestAnswer(challenge))), false);
  });

  test('Basic works too', () => {
    const auth = createHttpAuth(credentials);
    assert.equal(auth.allows(request('Basic ' + Buffer.from('protect:secret').toString('base64'))), true);
    assert.equal(auth.allows(request('Basic ' + Buffer.from('protect:nope').toString('base64'))), false);
    assert.equal(auth.allows(request()), false);
  });
});

// What clients compute to log in, shared by the RTSP and ONVIF tests.
import { createHash } from 'node:crypto';

export const md5 = (s) => createHash('md5').update(s).digest('hex');

const field = (challenge, name) => new RegExp(`${name}="([^"]*)"`).exec(challenge)?.[1];

// HTTP/RTSP Digest from a challenge. Without qop as RTSP clients (live555/VLC, ffmpeg) send it
// (RFC 2069); with qop=auth as most HTTP clients do (RFC 7616).
export function digestAnswer(challenge, { username = 'protect', password = 'secret', method = 'GET', uri, qop = false }) {
  const realm = field(challenge, 'realm'), nonce = field(challenge, 'nonce');
  const ha1 = md5(`${username}:${realm}:${password}`), ha2 = md5(`${method}:${uri}`);
  if (!qop) {
    return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${md5(`${ha1}:${nonce}:${ha2}`)}"`;
  }
  const nc = '00000001', cnonce = 'abc';
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`);
  return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
}

// WS-Security UsernameToken PasswordDigest (ONVIF): base64(sha1(nonce + created + password)).
export const passwordDigest = (nonce, created, password) =>
  createHash('sha1').update(Buffer.concat([Buffer.from(nonce), Buffer.from(created), Buffer.from(password)])).digest('base64');

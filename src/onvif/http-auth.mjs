// The login for the ONVIF snapshot (a plain HTTP GET, so no WS-UsernameToken): HTTP Digest, as
// ONVIF clients use for snapshots, or Basic. Nonces are signed, not stored, and valid for 5 minutes.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const REALM = 'eufy-nvr-gateway';
const NONCE_MS = 5 * 60 * 1000;
const md5 = (s) => createHash('md5').update(s).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// credentials: { username, password } or null (then everything is allowed).
export function createHttpAuth(credentials, { now = Date.now, secret = randomBytes(32) } = {}) {
  const sign = (t) => createHmac('sha256', secret).update(String(t)).digest('hex').slice(0, 32);
  const nonce = () => { const t = now(); return `${t.toString(16)}.${sign(t)}`; };
  const freshNonce = (n) => {
    const [hex, signature] = String(n).split('.');
    const t = parseInt(hex, 16);
    return !!signature && same(signature, sign(t)) && now() - t >= 0 && now() - t < NONCE_MS;
  };

  // 'ok', 'wrong' (a wrong login), or 'stale' (a nonce from us that has expired: not a guess).
  function digest(header, method) {
    const p = Object.fromEntries([...header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1], m[2] ?? m[3]]));
    if (!p.uri || !p.response || p.realm !== REALM) return 'wrong';
    if (!freshNonce(p.nonce)) return 'stale';
    const ha1 = md5(`${credentials.username}:${REALM}:${credentials.password}`);
    const ha2 = md5(`${method}:${p.uri}`);
    const expected = p.qop ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
    const user = same(p.username ?? '', credentials.username);
    const pass = same(expected, p.response);   // both compared, whatever the first says
    return user && pass ? 'ok' : 'wrong';
  }

  function basic(value) {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon <= 0) return 'wrong';
    const user = same(decoded.slice(0, colon), credentials.username);
    const pass = same(decoded.slice(colon + 1), credentials.password);
    return user && pass ? 'ok' : 'wrong';
  }

  // 'ok' | 'none' (no login sent) | 'stale' (an expired nonce) | 'wrong' (a wrong login: counts as a guess)
  function check(req) {
    if (!credentials) return 'ok';
    const header = req.headers.authorization ?? '';
    if (/^Digest\s/i.test(header)) return digest(header.slice(7), req.method);
    if (/^Basic\s/i.test(header)) return basic(header.slice(6).trim());
    return 'none';
  }

  return {
    check,
    allows: (req) => check(req) === 'ok',
    // The challenges for a 401: Digest first (preferred), Basic as a fallback.
    // realm and nonce first, in that order: VLC (live555) reads the challenge with a fixed pattern,
    // `Digest realm="…", nonce="…"`, and keeps asking for the password if anything sits in between.
    challenges: () => [`Digest realm="${REALM}", nonce="${nonce()}", algorithm=MD5, qop="auth"`, `Basic realm="${REALM}"`],
  };
}

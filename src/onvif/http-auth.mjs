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

  function digestOk(header, method) {
    const p = Object.fromEntries([...header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1], m[2] ?? m[3]]));
    if (p.username !== credentials.username || p.realm !== REALM || !freshNonce(p.nonce) || !p.uri || !p.response) return false;
    const ha1 = md5(`${credentials.username}:${REALM}:${credentials.password}`);
    const ha2 = md5(`${method}:${p.uri}`);
    const expected = p.qop ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
    return same(expected, p.response);
  }

  function basicOk(value) {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return colon > 0 && same(decoded.slice(0, colon), credentials.username) && same(decoded.slice(colon + 1), credentials.password);
  }

  return {
    allows(req) {
      if (!credentials) return true;
      const header = req.headers.authorization ?? '';
      if (/^Digest\s/i.test(header)) return digestOk(header.slice(7), req.method);
      if (/^Basic\s/i.test(header)) return basicOk(header.slice(6).trim());
      return false;
    },
    // The challenges for a 401: Digest first (preferred), Basic as a fallback.
    challenges: () => [`Digest realm="${REALM}", qop="auth", algorithm=MD5, nonce="${nonce()}"`, `Basic realm="${REALM}"`],
  };
}

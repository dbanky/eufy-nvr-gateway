// The web page's optional login ("web": { "username", "password" } in config.json).
//
// Browsers sign in on signin.html and get a session cookie; scripts and NVRs that fetch snapshots
// can send HTTP Basic instead. Sessions are signed, not stored: the key comes from the login itself,
// so they survive restarts, and changing the password signs everybody out.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'gateway_session';
const MAX_AGE_S = 30 * 24 * 3600;

const digest = (value) => createHash('sha256').update(String(value)).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));   // constant time, any length

// credentials: { username, password } or null (no login: returns null).
// secure: the page is served over HTTPS, so the cookie is never sent over plain HTTP.
export function createAuth(credentials, { now = Date.now, secure = false } = {}) {
  if (!credentials) return null;
  const key = digest(`eufy-nvr-gateway session\0${credentials.username}\0${credentials.password}`);
  const sign = (expires) => createHmac('sha256', key).update(String(expires)).digest('base64url');

  const matches = (username, password) => {
    const user = same(username ?? '', credentials.username);
    const pass = same(password ?? '', credentials.password);   // both compared, whatever the first says
    return user && pass;
  };

  const validToken = (token) => {
    const [expires, signature] = String(token ?? '').split('.');
    return Number(expires) > now() && !!signature && same(signature, sign(expires));
  };

  return {
    matches,
    // A new session, as a Set-Cookie header value.
    sessionCookie() {
      const expires = now() + MAX_AGE_S * 1000;
      return `${COOKIE}=${expires}.${sign(expires)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`;
    },
    // How this request is signed in: 'session' (cookie), 'login' (the right HTTP Basic login),
    // 'wrong' (a wrong one: counts as a guess) or 'none'.
    check(req) {
      if (validToken(cookies(req)[COOKIE])) return 'session';
      const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? '');
      if (!basic) return 'none';
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      return colon > 0 && matches(decoded.slice(0, colon), decoded.slice(colon + 1)) ? 'login' : 'wrong';
    },
    // Is this request signed in (session cookie) or does it carry the login (HTTP Basic)?
    allows(req) {
      const how = this.check(req);
      return how === 'session' || how === 'login';
    },
  };
}

// The stream login ("rtsp" in config.json), which NVRs and the Homebridge plugin already have, as
// HTTP Basic on the API. It may only do what such a client needs (server.mjs: clientRoute).
// credentials: { username, password } or null (then null: no stream login).
export function createClientLogin(credentials) {
  if (!credentials) return null;
  return {
    matches(req) {
      const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? '');
      if (!basic) return false;
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon <= 0) return false;
      const user = same(decoded.slice(0, colon), credentials.username);
      const pass = same(decoded.slice(colon + 1), credentials.password);   // both compared, whatever the first says
      return user && pass;
    },
  };
}

export const signedOutCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

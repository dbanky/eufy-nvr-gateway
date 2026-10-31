// The ONVIF login: WS-Security UsernameToken with a password digest, which is what UniFi Protect
// sends. digest = Base64(SHA-1(nonce + created + password)).

import { createHash, timingSafeEqual } from 'node:crypto';
import { valueOf } from './xml.mjs';

export const MAX_AGE_MS = 5 * 60000;   // tolerated clock difference and replay window

// null if the request may proceed, otherwise why not. credentials: { username, password } or null.
export function checkUsernameToken(xml, credentials, now = Date.now()) {
  if (!credentials) return null;
  const username = valueOf(xml, 'Username');
  const digest = valueOf(xml, 'Password');
  const nonce = valueOf(xml, 'Nonce');
  const created = valueOf(xml, 'Created');
  if (!username || !digest || !nonce || !created) return 'no credentials';
  if (Math.abs(now - Date.parse(created)) > MAX_AGE_MS) return 'credentials too old (or the clocks differ by more than 5 minutes)';
  const expected = createHash('sha1')
    .update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(credentials.password)]))
    .digest();
  const given = Buffer.from(digest, 'base64');
  const ok = username === credentials.username && given.length === expected.length && timingSafeEqual(given, expected);
  return ok ? null : 'wrong user name or password';
}

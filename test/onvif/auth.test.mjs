import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkUsernameToken } from '../../src/onvif/auth.mjs';

// What a client (UniFi Protect) puts in the SOAP header: WS-Security UsernameToken, PasswordDigest.
function token({ username = 'protect', password = 'secret', created = '2026-10-31T12:00:00Z', nonce = 'n0nce' } = {}) {
  const digest = createHash('sha1').update(Buffer.concat([Buffer.from(nonce), Buffer.from(created), Buffer.from(password)])).digest('base64');
  return `<s:Header><wsse:Security><wsse:UsernameToken><wsse:Username>${username}</wsse:Username>
    <wsse:Password Type="...#PasswordDigest">${digest}</wsse:Password>
    <wsse:Nonce EncodingType="...#Base64Binary">${Buffer.from(nonce).toString('base64')}</wsse:Nonce>
    <wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security></s:Header>`;
}
const credentials = { username: 'protect', password: 'secret' };
const now = Date.parse('2026-10-31T12:00:30Z');

describe('logging in to the ONVIF camera', () => {
  test('the right user and password digest are accepted', () => {
    assert.equal(checkUsernameToken(token(), credentials, now), null);
  });

  test('a wrong password is refused', () => {
    assert.match(checkUsernameToken(token({ password: 'nope' }), credentials, now), /wrong user name or password/);
  });

  test('a wrong user is refused', () => {
    assert.match(checkUsernameToken(token({ username: 'eve' }), credentials, now), /wrong user name or password/);
  });

  test('no token at all is refused', () => {
    assert.match(checkUsernameToken('<s:Header/>', credentials, now), /no credentials/);
  });

  test('an old token is refused (replayed); a few minutes of clock difference are fine', () => {
    assert.equal(checkUsernameToken(token({ created: '2026-10-31T11:57:00Z' }), credentials, now), null);
    assert.match(checkUsernameToken(token({ created: '2026-10-31T11:40:00Z' }), credentials, now), /too old/);
  });

  test('without configured credentials, everyone is let in', () => {
    assert.equal(checkUsernameToken('<s:Header/>', null, now), null);
  });
});

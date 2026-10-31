import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, cookies, COOKIE } from '../../../src/switcher/web/auth.mjs';

const login = { username: 'admin', password: 'correct horse' };
const request = (headers = {}) => ({ headers });
const sessionOf = (setCookie) => /gateway_session=([^;]+)/.exec(setCookie)[1];
const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

describe('the web page login', () => {
  test('without "web" in config.json there is none', () => {
    assert.equal(createAuth(null), null);
  });

  test('only the configured username and password match', () => {
    const auth = createAuth(login);
    assert.equal(auth.matches('admin', 'correct horse'), true);
    assert.equal(auth.matches('admin', 'wrong'), false);
    assert.equal(auth.matches('root', 'correct horse'), false);
    assert.equal(auth.matches(undefined, undefined), false);
  });

  test('signing in gives a session cookie that the browser keeps for 30 days, out of reach of scripts', () => {
    const cookie = createAuth(login).sessionCookie();
    assert.match(cookie, /^gateway_session=\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
  });

  test('a session cookie lets requests in until it expires', () => {
    let now = 0;
    const auth = createAuth(login, { now: () => now });
    const token = sessionOf(auth.sessionCookie());
    assert.equal(auth.allows(request({ cookie: `${COOKIE}=${token}` })), true);
    now += 31 * 24 * 3600 * 1000;
    assert.equal(auth.allows(request({ cookie: `${COOKIE}=${token}` })), false);
  });

  test('a forged or altered session is refused', () => {
    const auth = createAuth(login);
    const [expires, signature] = sessionOf(auth.sessionCookie()).split('.');
    assert.equal(auth.allows(request({ cookie: `${COOKIE}=${Number(expires) + 1}.${signature}` })), false);
    assert.equal(auth.allows(request({ cookie: `${COOKIE}=9999999999999.forged` })), false);
    assert.equal(auth.allows(request()), false);
  });

  test('sessions survive a restart, and a new password signs everybody out', () => {
    const token = sessionOf(createAuth(login).sessionCookie());
    assert.equal(createAuth(login).allows(request({ cookie: `${COOKIE}=${token}` })), true, 'same login, new process');
    assert.equal(createAuth({ ...login, password: 'new' }).allows(request({ cookie: `${COOKIE}=${token}` })), false);
  });

  test('scripts and NVRs can send the login as HTTP Basic instead', () => {
    const auth = createAuth(login);
    assert.equal(auth.allows(request({ authorization: basic('admin', 'correct horse') })), true);
    assert.equal(auth.allows(request({ authorization: basic('admin', 'nope') })), false);
    assert.equal(auth.allows(request({ authorization: 'Basic not-base64' })), false);
  });

  test('a password with a colon still works over HTTP Basic', () => {
    const auth = createAuth({ username: 'admin', password: 'a:b' });
    assert.equal(auth.allows(request({ authorization: basic('admin', 'a:b') })), true);
  });
});

test('cookies are read from the Cookie header', () => {
  assert.deepEqual(cookies(request({ cookie: 'a=1; gateway_session=2.x ; b=' })), { a: '1', gateway_session: '2.x', b: '' });
  assert.deepEqual(cookies(request()), {});
});

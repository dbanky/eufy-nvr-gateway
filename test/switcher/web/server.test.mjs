import { test, describe, before, after } from 'node:test';
import { get } from 'node:http';
import assert from 'node:assert/strict';
import { createWebServer, cameraRoute } from '../../../src/switcher/web/server.mjs';
import { createAuth } from '../../../src/switcher/web/auth.mjs';
import { withTheme } from '../../../src/switcher/web/http.mjs';

// Fakes that record what the API asked them to do.
const calls = [];
const garden = {
  name: 'garden', serial: 'T81XXXXXXXXXXXXX',
  status: () => ({ name: 'garden', state: 'IDLE' }),
  trigger: (kind) => calls.push(['trigger', kind]),
  stop: (why) => calls.push(['stop', why]),
};
const bridge = {
  status: () => ({ connected: true, login: 'ok' }),
  devices: [{ serial: 'T81XXXXXXXXXXXXX' }, { serial: 'T82XXXXXXXXXXXXX' }],
  submitLogin: async (message) => { calls.push(['login', message]); return { ok: true }; },
};

let server, base;
before(async () => {
  server = createWebServer({ cameras: [garden], bridge, rtspPort: 8554, snapshot: async () => Buffer.from('jpeg'),
    gateway: () => ({ version: '0.4.0' }), onvif: (name) => (name === 'garden' ? { address: '192.168.1.51' } : null) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

describe('the API', () => {
  test('status: the eufy login, the RTSP port, the gateway and every camera with its ONVIF side', async () => {
    const body = await (await fetch(`${base}/api/status`)).json();
    assert.deepEqual(body, { bridge: { connected: true, login: 'ok' }, rtspPort: 8554, rtsp: { enabled: true, login: false },
      gateway: { version: '0.4.0', login: false, theme: 'auto' },
      cameras: [{ name: 'garden', state: 'IDLE', onvif: { address: '192.168.1.51' } }] });
  });

  test('health: always open, for Docker\'s health check', async () => {
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true });
  });

  test('without a login configured, everyone is signed in', async () => {
    assert.deepEqual(await (await fetch(`${base}/api/session`)).json(), { login: false, signedIn: true });
  });

  test('devices: marks the ones already configured as cameras', async () => {
    const body = await (await fetch(`${base}/api/devices`)).json();
    assert.deepEqual(body.map((d) => d.configured), [true, false]);
  });

  test('"Go live" wakes the camera, "Stop" ends the session', async () => {
    calls.length = 0;
    await fetch(`${base}/api/cameras/garden/live`, { method: 'POST' });
    await fetch(`${base}/api/cameras/garden/idle`, { method: 'POST' });
    assert.deepEqual(calls, [['trigger', 'manual'], ['stop', 'manual']]);
  });

  test('a 2FA code is passed to the bridge', async () => {
    calls.length = 0;
    const res = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ code: '123456' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [['login', { cmd: 'auth.submit', code: '123456' }]]);
  });

  test('a login request without a code or captcha is refused', async () => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 400);
  });

  test('snapshots are JPEGs that are never cached', async () => {
    const res = await fetch(`${base}/api/cameras/garden/snapshot.jpg`);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('unknown cameras and paths: 404', async () => {
    assert.equal((await fetch(`${base}/api/cameras/nope/live`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/nothing`)).status, 404);
  });
});

describe('the web page', () => {
  test('is served as static files', async () => {
    assert.match(await (await fetch(`${base}/`)).text(), /<title>Eufy NVR Gateway<\/title>/);
    for (const file of ['app.js', 'camera-tile.js', 'connection.js', 'devices.js', 'icons.js', 'escape.js', 'login.js',
      'gateway.js', 'onvif-info.js', 'update.js', 'theme.js', 'theme-toggle.js', 'signin.js']) {
      assert.equal((await fetch(`${base}/${file}`)).headers.get('content-type'), 'text/javascript; charset=utf-8', file);
    }
    assert.equal((await fetch(`${base}/style.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
  });

  test('only files of the page: nothing else on disk can be read', async () => {
    assert.equal((await fetch(`${base}/server.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/..%2fserver.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/fonts/..%2f..%2fpackage.json`)).status, 404);
  });
});

test('older camera URLs without /api/cameras still work', () => {
  assert.deepEqual(cameraRoute('/api/cameras/garden/live'), ['garden', 'live']);
  assert.deepEqual(cameraRoute('/garden/snapshot.jpg'), ['garden', 'snapshot.jpg']);
});

describe('with a login ("web" in config.json)', () => {
  let locked, url;
  const signIn = (username, password) => fetch(`${url}/api/signin`, { method: 'POST', body: JSON.stringify({ username, password }) });
  const browser = { 'sec-fetch-mode': 'cors' };

  before(async () => {
    locked = createWebServer({ cameras: [garden], bridge, rtspPort: 8554, snapshot: async () => Buffer.from('jpeg'),
      auth: createAuth({ username: 'admin', password: 'secret' }) });
    await new Promise((resolve) => locked.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${locked.address().port}`;
  });
  after(() => locked.close());

  test('the page leads to the sign-in page, whose own files are open', async () => {
    const res = await fetch(`${url}/`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'signin.html');
    for (const file of ['signin.html', 'signin.js', 'style.css', 'theme.js', 'theme-toggle.js', 'icons.js']) {
      assert.equal((await fetch(`${url}/${file}`)).status, 200, file);
    }
    assert.equal((await fetch(`${url}/app.js`)).status, 401);
  });

  test('the API, snapshots and older URLs need the login', async () => {
    for (const path of ['/api/status', '/api/devices', '/api/cameras/garden/snapshot.jpg', '/status', '/garden/snapshot.jpg']) {
      assert.equal((await fetch(url + path, { headers: browser })).status, 401, path);
    }
    assert.equal((await fetch(`${url}/api/cameras/garden/live`, { method: 'POST', headers: browser })).status, 401);
    assert.equal((await fetch(`${url}/api/health`)).status, 200, 'the health check stays open');
  });

  test('browsers get no Basic challenge (no login dialog); other clients do', async () => {
    assert.equal((await fetch(`${url}/api/status`, { headers: browser })).headers.get('www-authenticate'), null);
    // Node's fetch sends Sec-Fetch-Mode like a browser; curl and NVRs send none, like a plain request.
    const plain = await new Promise((resolve) => get(`${url}/api/status`, (res) => { res.resume(); resolve(res); }));
    assert.equal(plain.statusCode, 401);
    assert.match(plain.headers['www-authenticate'], /^Basic realm="Eufy NVR Gateway"/);
  });

  test('a wrong password is refused, after a pause', async () => {
    const started = Date.now();
    const res = await signIn('admin', 'nope');
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.ok(Date.now() - started >= 900);
  });

  test('signing in gives a session for the page and the API; signing out ends it', async () => {
    const res = await signIn('admin', 'secret');
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    const status = await (await fetch(`${url}/api/status`, { headers: { cookie } })).json();
    assert.equal(status.gateway.login, true);
    assert.deepEqual(await (await fetch(`${url}/api/session`, { headers: { cookie } })).json(), { login: true, signedIn: true });
    const out = await fetch(`${url}/api/signout`, { method: 'POST', headers: { cookie } });
    assert.match(out.headers.get('set-cookie'), /gateway_session=; .*Max-Age=0/);
  });

  test('scripts can use HTTP Basic', async () => {
    const authorization = 'Basic ' + Buffer.from('admin:secret').toString('base64');
    assert.equal((await fetch(`${url}/api/cameras/garden/snapshot.jpg`, { headers: { authorization } })).status, 200);
  });
});

test('a theme set in config.json is written into the pages, which then show no switch', () => {
  const html = '<!doctype html>\n<html lang="en">\n<head>';
  assert.match(withTheme(html, 'light'), /<html lang="en" data-theme="light" data-theme-fixed>/);
  assert.equal(withTheme(html, 'auto'), html);
});

test('with HTTPS, the session cookie is never sent over plain HTTP', () => {
  assert.match(createAuth({ username: 'a', password: 'b' }, { secure: true }).sessionCookie(), /; Secure$/);
  assert.doesNotMatch(createAuth({ username: 'a', password: 'b' }).sessionCookie(), /Secure/);
});

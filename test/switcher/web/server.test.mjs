import { test, describe, before, after } from 'node:test';
import { get, request } from 'node:http';
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
    assert.deepEqual(body, { bridge: { connected: true, login: 'ok' }, rtspPort: 8554, rtsp: { login: false },
      gateway: { version: '0.4.0', login: false, theme: 'auto', streamLoginForApi: false },
      cameras: [{ name: 'garden', state: 'IDLE', model: null, onvif: { address: '192.168.1.51' }, eufyMode: null }] });
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
      'gateway.js', 'onvif-info.js', 'update.js', 'theme.js', 'theme-toggle.js', 'signin.js', 'tiles.js']) {
      assert.equal((await fetch(`${base}/${file}`)).headers.get('content-type'), 'text/javascript; charset=utf-8', file);
    }
    for (const file of ['style.css', 'tiles.css']) assert.equal((await fetch(`${base}/${file}`)).headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal((await fetch(`${base}/logo.svg`)).headers.get('content-type'), 'image/svg+xml');
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
    for (const file of ['signin.html', 'signin.js', 'style.css', 'theme.js', 'theme-toggle.js', 'icons.js', 'logo.svg']) {
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

// A request with any headers, Host included (fetch can't set Host).
function raw(base, path, { method = 'GET', headers = {}, body } = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('security', () => {
  const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  let open, openUrl, locked, lockedUrl, guard, logged;

  before(async () => {
    const { createLoginGuard } = await import('../../../src/security/login-guard.mjs');
    guard = createLoginGuard({ maxFailures: 3 });
    logged = [];
    const common = { cameras: [garden], bridge, rtspPort: 8554, snapshot: async () => Buffer.from('jpeg'), log: (m) => logged.push(m) };
    open = createWebServer({ ...common, allowedHosts: ['nvr.example.com'] });
    locked = createWebServer({ ...common, auth: createAuth({ username: 'admin', password: 'secret' }), guard });
    for (const s of [open, locked]) await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
    openUrl = `http://127.0.0.1:${open.address().port}`;
    lockedUrl = `http://127.0.0.1:${locked.address().port}`;
  });
  after(() => { open.close(); locked.close(); });

  test('with a login, every API route (discovery included) is refused without it, and nothing happens', async () => {
    calls.length = 0;
    const routes = [['GET', '/api/status'], ['GET', '/status'], ['GET', '/api/devices'], ['GET', '/api/cameras/garden/snapshot.jpg'],
      ['GET', '/garden/snapshot.jpg'], ['POST', '/api/cameras/garden/live'], ['POST', '/api/cameras/garden/idle'], ['POST', '/garden/live'],
      ['POST', '/api/login'], ['POST', '/api/login/retrigger'], ['GET', '/app.js'], ['GET', '/tiles.js']];
    for (const [method, path] of routes) {
      const res = await raw(lockedUrl, path, { method });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    assert.equal((await raw(lockedUrl, '/')).status, 302);
    assert.deepEqual(calls, []);
  });

  test('a browser POST from another website is refused, even when signed in; the page itself and scripts are not', async () => {
    calls.length = 0;
    const login = { authorization: basic('admin', 'secret') };
    assert.equal((await raw(lockedUrl, '/api/cameras/garden/live', { method: 'POST', headers: { ...login, 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await raw(openUrl, '/api/cameras/garden/live', { method: 'POST', headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await raw(openUrl, '/api/login', { method: 'POST', headers: { origin: 'null' } })).status, 403);
    assert.deepEqual(calls, []);

    assert.equal((await raw(lockedUrl, '/api/cameras/garden/live', { method: 'POST', headers: { ...login, 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal((await raw(lockedUrl, '/api/cameras/garden/live', { method: 'POST', headers: login })).status, 200);   // the Homebridge plugin, curl
    const sameHost = new URL(openUrl).host;
    assert.equal((await raw(openUrl, '/api/cameras/garden/live', { method: 'POST', headers: { origin: `http://${sameHost}` } })).status, 200);
    assert.deepEqual(calls, [['trigger', 'manual'], ['trigger', 'manual'], ['trigger', 'manual']]);
  });

  test('without a login, only addresses and local names are answered (no DNS rebinding)', async () => {
    for (const host of ['192.168.1.10:8099', '[fd00::10]:8099', 'nas.local:8099', 'diskstation:8099', 'gateway.home.arpa', 'nvr.example.com', 'localhost:8099']) {
      assert.equal((await raw(openUrl, '/api/status', { headers: { host } })).status, 200, host);
    }
    const refused = await raw(openUrl, '/api/status', { headers: { host: 'rebind.attacker.example:8099' } });
    assert.equal(refused.status, 403);
    assert.match(refused.text, /web.allowedHosts/);
    assert.equal((await raw(openUrl, '/api/health', { headers: { host: 'rebind.attacker.example' } })).status, 200);   // Docker's check
    assert.equal(logged.filter((m) => m.includes('rebind.attacker.example')).length, 1);
  });

  test('with a login, any host name works (a reverse proxy, say): it can\'t sign in for a rebinding site', async () => {
    assert.equal((await raw(lockedUrl, '/api/status', { headers: { host: 'nvr.mydomain.example', authorization: basic('admin', 'secret') } })).status, 200);
  });

  test('every answer forbids framing and type sniffing', async () => {
    const res = await raw(openUrl, '/');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['content-security-policy'], "frame-ancestors 'none'");
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  test('guessing the login over HTTP Basic or the sign-in page gets the address blocked; a session keeps working', async () => {
    const session = (await raw(lockedUrl, '/api/signin', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'secret' }) })).headers['set-cookie'][0].split(';')[0];
    for (let i = 0; i < 2; i++) assert.equal((await raw(lockedUrl, '/api/status', { headers: { authorization: basic('admin', `guess${i}`) } })).status, 401);
    assert.equal((await raw(lockedUrl, '/api/signin', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'guess' }) })).status, 401);
    assert.equal(guard.blocked('127.0.0.1'), true);

    const right = await raw(lockedUrl, '/api/status', { headers: { authorization: basic('admin', 'secret') } });
    assert.equal(right.status, 429);
    assert.ok(Number(right.headers['retry-after']) > 0);
    assert.match((await raw(lockedUrl, '/api/signin', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'secret' }) })).text, /Too many wrong logins/);
    assert.equal((await raw(lockedUrl, '/api/status', { headers: { cookie: session } })).status, 200);
  });
});

describe('the stream login on the API (for NVRs and the Homebridge plugin)', () => {
  const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  let server, url, guard;
  before(async () => {
    const { createLoginGuard } = await import('../../../src/security/login-guard.mjs');
    const { createClientLogin } = await import('../../../src/switcher/web/auth.mjs');
    guard = createLoginGuard({ maxFailures: 3 });
    const devices = { ...bridge, devices: [{ serial: 'T81XXXXXXXXXXXXX', model: 'T8170', modelName: 'SoloCam S340' }] };
    server = createWebServer({ cameras: [garden], bridge: devices, rtspPort: 8554, snapshot: async () => Buffer.from('jpeg'), guard,
      auth: createAuth({ username: 'admin', password: 'secret' }), clientLogin: createClientLogin({ username: 'nvr', password: 'stream' }) });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  const stream = { authorization: basic('nvr', 'stream') };

  test('reads the cameras (with their model), fetches snapshots, wakes a camera and lets it sleep', async () => {
    calls.length = 0;
    const status = await (await fetch(`${url}/api/status`, { headers: stream })).json();
    assert.equal(status.cameras[0].model, 'SoloCam S340');
    assert.equal(status.gateway.streamLoginForApi, true);
    assert.equal((await fetch(`${url}/api/cameras/garden/snapshot.jpg`, { headers: stream })).status, 200);
    assert.equal((await fetch(`${url}/garden/snapshot.jpg`, { headers: stream })).status, 200);
    assert.equal((await fetch(`${url}/api/cameras/garden/live`, { method: 'POST', headers: stream })).status, 200);
    assert.equal((await fetch(`${url}/api/cameras/garden/idle`, { method: 'POST', headers: stream })).status, 200);
    assert.deepEqual(calls, [['trigger', 'manual'], ['stop', 'manual']]);
  });

  test('can\'t do what only the web login may: the eufy login, its 2FA, the device list, the page', async () => {
    calls.length = 0;
    for (const [method, path] of [['GET', '/api/devices'], ['POST', '/api/login'], ['POST', '/api/login/retrigger'], ['GET', '/app.js'], ['GET', '/api/cameras/shed/snapshot.jpg']]) {
      const res = await fetch(`${url}${path}`, { method, headers: stream });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.match((await res.json()).error, /use the web login/);
    }
    assert.deepEqual(calls, []);
    assert.equal(guard.blocked('127.0.0.1'), false);   // the right stream login is never a wrong password
  });

  test('the web login still opens everything', async () => {
    assert.equal((await fetch(`${url}/api/devices`, { headers: { authorization: basic('admin', 'secret') } })).status, 200);
  });

  test('a wrong stream login counts as a wrong login', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`${url}/api/status`, { headers: { authorization: basic('nvr', `guess${i}`) } })).status, 401);
    assert.equal(guard.blocked('127.0.0.1'), true);
    assert.equal((await fetch(`${url}/api/status`, { headers: stream })).status, 429);
  });
});

test('the stream login opens only the client routes', async () => {
  const { clientRoute } = await import('../../../src/switcher/web/server.mjs');
  const byName = new Map([['garden', {}]]);
  assert.equal(clientRoute('GET', '/api/status', byName), true);
  assert.equal(clientRoute('GET', '/status', byName), true);
  assert.equal(clientRoute('POST', '/api/cameras/garden/live', byName), true);
  assert.equal(clientRoute('POST', '/garden/idle', byName), true);
  assert.equal(clientRoute('GET', '/api/cameras/garden/snapshot.jpg', byName), true);
  assert.equal(clientRoute('GET', '/api/cameras/garden/eufy-mode', byName), true);
  assert.equal(clientRoute('POST', '/garden/eufy-mode', byName), true);
  assert.equal(clientRoute('GET', '/api/cameras/garden/live', byName), false);
  assert.equal(clientRoute('POST', '/api/cameras/garden/live/extra', byName), false);
  assert.equal(clientRoute('POST', '/api/login', byName), false);
  assert.equal(clientRoute('GET', '/api/devices', byName), false);
  assert.equal(clientRoute('GET', '/api/cameras/shed/snapshot.jpg', byName), false);
});

describe('a camera\'s Eufy mode (Home, Away, Disarmed, …)', () => {
  const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  let server, url, sent, answer;
  const stations = {
    ...bridge,
    devices: [
      { serial: 'T81XXXXXXXXXXXXX', name: 'Garden', station: 'T81XXXXXXXXXXXXX', arming: true, eufyMode: 'home' },
    ],
    request: async (message) => { sent.push(message); return answer; },
    refreshDevices: () => {},
  };
  before(async () => {
    const { createClientLogin } = await import('../../../src/switcher/web/auth.mjs');
    server = createWebServer({ cameras: [garden], bridge: stations, rtspPort: 8554, snapshot: async () => Buffer.from('jpeg'),
      auth: createAuth({ username: 'admin', password: 'secret' }), clientLogin: createClientLogin({ username: 'nvr', password: 'stream' }) });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  const stream = { authorization: basic('nvr', 'stream') };
  const set = (mode) => fetch(`${url}/api/cameras/garden/eufy-mode`, { method: 'POST', headers: stream, body: JSON.stringify({ mode }) });

  test('is read with the stream login, and shown in the status', async () => {
    const mode = await (await fetch(`${url}/api/cameras/garden/eufy-mode`, { headers: stream })).json();
    assert.equal(mode.mode, 'home');
    assert.equal(mode.label, 'Home');
    assert.deepEqual(mode.station, { serial: 'T81XXXXXXXXXXXXX', name: 'Garden' });
    assert.equal(mode.shared, false);
    assert.ok(mode.modes.includes('disarmed'));
    const status = await (await fetch(`${url}/api/status`, { headers: stream })).json();
    assert.equal(status.cameras[0].eufyMode.mode, 'home');
  });

  test('is switched through the SDK, on the camera\'s station', async () => {
    sent = []; answer = { ok: true };
    const res = await set('disarmed');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).mode, 'disarmed');
    assert.deepEqual(sent, [{ cmd: 'device.set', sn: 'T81XXXXXXXXXXXXX', name: 'armingMode', value: 'disarmed' }]);
  });

  test('an unknown mode is refused before eufy is asked', async () => {
    sent = [];
    const res = await set('party');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /must be one of "away", "home"/);
    assert.deepEqual(sent, []);
  });

  test('says when eufy refuses', async () => {
    answer = { ok: false, error: 'station offline' };
    const res = await set('away');
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'garden: station offline');
  });
});

describe('waking a camera says who asked', () => {
  let server, url;
  const asked = [];
  const camera = { ...garden, trigger: (kind, by) => asked.push([kind, by]) };
  before(async () => {
    server = createWebServer({ cameras: [camera], bridge, rtspPort: 8554, snapshot: async () => Buffer.from('jpeg') });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('HomeKit (the plugin says so), the web page (a browser), or the API (anything else)', async () => {
    await fetch(`${url}/api/cameras/garden/live`, { method: 'POST', body: JSON.stringify({ by: 'homekit' }) });
    await raw(url, '/api/cameras/garden/live', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } });
    await fetch(`${url}/api/cameras/garden/live`, { method: 'POST' });
    await fetch(`${url}/garden/live`, { method: 'POST', body: JSON.stringify({ by: 'somebody' }) });
    assert.deepEqual(asked, [['manual', 'homekit'], ['manual', 'web'], ['manual', 'api'], ['manual', 'api']]);
  });
});

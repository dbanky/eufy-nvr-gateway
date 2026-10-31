import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWebServer, cameraRoute } from '../../src/switcher/web/server.mjs';

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
  server = createWebServer({ cameras: [garden], bridge, rtspPort: 8554, snapshot: async () => Buffer.from('jpeg') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

describe('the API', () => {
  test('status: the login state, the RTSP port and every camera', async () => {
    const body = await (await fetch(`${base}/api/status`)).json();
    assert.deepEqual(body, { bridge: { connected: true, login: 'ok' }, rtspPort: 8554, cameras: [{ name: 'garden', state: 'IDLE' }] });
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
    for (const file of ['app.js', 'views.js', 'icons.js']) {
      assert.equal((await fetch(`${base}/${file}`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    }
  });
});

test('older camera URLs without /api/cameras still work', () => {
  assert.deepEqual(cameraRoute('/api/cameras/garden/live'), ['garden', 'live']);
  assert.deepEqual(cameraRoute('/garden/snapshot.jpg'), ['garden', 'snapshot.jpg']);
});

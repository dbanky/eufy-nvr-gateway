import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSettings, validateCameras } from '../../src/gateway/config.mjs';
import { openToTheLan, configWarnings } from '../../src/gateway/access.mjs';

const login = { EUFY_EMAIL: 'you@example.com', EUFY_PASSWORD: 'secret' };
const camera = { name: 'garden', serial: 'T81XXXXXXXXXXXXX', width: 2880, height: 1616 };

describe('ONVIF (for NVRs such as UniFi Protect)', () => {
  const onvifCamera = (onvif) => ({ ...camera, onvif });

  test('a camera is published when it has its own address', () => {
    const [cam] = validateCameras({ cameras: [onvifCamera({ address: '192.168.1.51' })] });
    assert.equal(cam.onvif.address, '192.168.1.51');
  });

  test('the address must be an IPv4 address; port and MAC are checked when given', () => {
    assert.throws(() => validateCameras({ cameras: [onvifCamera({})] }), /"onvif.address"/);
    assert.throws(() => validateCameras({ cameras: [onvifCamera({ address: 'camera.local' })] }), /"onvif.address"/);
    assert.throws(() => validateCameras({ cameras: [onvifCamera({ address: '192.168.1.51', port: 70000 })] }), /"onvif.port"/);
    assert.throws(() => validateCameras({ cameras: [onvifCamera({ address: '192.168.1.51', mac: 'nope' })] }), /"onvif.mac"/);
  });

  test('two cameras can\'t share an address and port', () => {
    const second = { ...camera, name: 'front-door', onvif: { address: '192.168.1.51' } };
    assert.throws(() => validateCameras({ cameras: [onvifCamera({ address: '192.168.1.51' }), second] }), /same ONVIF address/);
  });

  test('the login NVRs use comes from config.json, and is optional', () => {
    assert.deepEqual(resolveSettings({ onvif: { username: 'protect', password: 'secret' } }, login).onvif,
      { username: 'protect', password: 'secret' });
    assert.equal(resolveSettings({}, login).onvif, null);
    assert.throws(() => resolveSettings({ onvif: { username: 'protect' } }, login), /"onvif.password"/);
  });
});

describe('the web page', () => {
  test('defaults: no login, the theme follows the system, plain HTTP', () => {
    assert.deepEqual(resolveSettings({}, login).web, { login: null, theme: 'auto', https: false, certFile: null, keyFile: null });
  });

  test('the login is optional; when set, both username and password', () => {
    assert.deepEqual(resolveSettings({ web: { username: 'admin', password: 'secret' } }, login).web.login, { username: 'admin', password: 'secret' });
    assert.throws(() => resolveSettings({ web: { username: 'admin' } }, login), /"web.password" is missing/);
    assert.throws(() => resolveSettings({ web: { password: 'secret' } }, login), /"web.username" is missing/);
  });

  test('the theme can be fixed to light or dark', () => {
    assert.equal(resolveSettings({ web: { theme: 'light' } }, login).web.theme, 'light');
    assert.throws(() => resolveSettings({ web: { theme: 'blue' } }, login), /"web.theme" must be "auto", "light", "dark"/);
  });

  test('HTTPS is optional, with an own certificate or a generated one', () => {
    assert.equal(resolveSettings({ web: { https: true } }, login).web.https, true);
    assert.deepEqual(resolveSettings({ web: { https: true, certFile: '/data/c.pem', keyFile: '/data/k.pem' } }, login).web,
      { login: null, theme: 'auto', https: true, certFile: '/data/c.pem', keyFile: '/data/k.pem' });
    assert.throws(() => resolveSettings({ web: { https: 'yes' } }, login), /"web.https" must be true or false/);
    assert.throws(() => resolveSettings({ web: { https: true, certFile: '/data/c.pem' } }, login), /go together/);
  });
});

describe('the RTSP streams', () => {
  test('on the network without a login by default; a login is optional', () => {
    assert.deepEqual(resolveSettings({}, login).rtsp, { enabled: true, login: null });
    assert.deepEqual(resolveSettings({ rtsp: { username: 'nvr', password: 'secret' } }, login).rtsp, { enabled: true, login: { username: 'nvr', password: 'secret' } });
    assert.throws(() => resolveSettings({ rtsp: { username: 'nvr' } }, login), /"rtsp.password" is missing/);
  });

  test('can be kept off the network, unless ONVIF cameras need them', () => {
    assert.equal(resolveSettings({ rtsp: { enabled: false } }, login).rtsp.enabled, false);
    assert.throws(() => resolveSettings({ rtsp: { enabled: false }, cameras: [{ ...camera, onvif: { address: '192.168.1.51' } }] }, login),
      /"rtsp.enabled" is false, but ONVIF cameras/);
  });
});

describe('what is open to the LAN (logged at startup)', () => {
  const everything = { web: { username: 'a', password: 'b', https: true }, rtsp: { username: 'c', password: 'd' },
    onvif: { username: 'c', password: 'd' }, cameras: [{ ...camera, onvif: { address: '192.168.1.51' } }] };

  test('nothing, when every part asks for a login and the page is HTTPS', () => {
    assert.deepEqual(openToTheLan(resolveSettings(everything, login)), []);
  });

  test('names every open part and the setting that closes it', () => {
    const open = openToTheLan(resolveSettings({ cameras: [{ ...camera, onvif: { address: '192.168.1.51' } }] }, login));
    assert.equal(open.length, 3);
    assert.match(open.join('\n'), /web page and API without login[\s\S]*RTSP streams without login[\s\S]*ONVIF cameras without login/);
    assert.match(openToTheLan(resolveSettings({ ...everything, web: { username: 'a', password: 'b' } }, login))[0], /plain HTTP/);
    assert.deepEqual(openToTheLan(resolveSettings({ rtsp: { enabled: false }, web: everything.web }, login)), [], 'RTSP off is closed');
  });

  test('warns when the RTSP login differs from the ONVIF one (Protect uses the ONVIF login for the stream)', () => {
    assert.deepEqual(configWarnings(resolveSettings(everything, login)), []);
    const differs = resolveSettings({ ...everything, rtsp: { username: 'x', password: 'y' } }, login);
    assert.match(configWarnings(differs)[0], /RTSP login differs from the ONVIF login/);
  });
});

test('the update check is on unless "checkForUpdates" is false', () => {
  assert.equal(resolveSettings({}, login).checkForUpdates, true);
  assert.equal(resolveSettings({ checkForUpdates: false }, login).checkForUpdates, false);
});

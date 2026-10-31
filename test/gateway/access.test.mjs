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

  test('ONVIF uses the RTSP login: one login for the streams', () => {
    const settings = resolveSettings({ rtsp: { username: 'protect', password: 'secret' } }, login);
    assert.deepEqual(settings.onvif, { username: 'protect', password: 'secret' });
    assert.equal(settings.onvif, settings.rtsp.login);
    assert.equal(resolveSettings({}, login).onvif, null);
  });

  test('the old place of the login ("onvif", v0.4.0-beta.1) still works, with a note to move it', () => {
    const settings = resolveSettings({ onvif: { username: 'protect', password: 'secret' } }, login);
    assert.deepEqual(settings.rtsp.login, { username: 'protect', password: 'secret' }, 'it locks RTSP too');
    assert.deepEqual(settings.onvif, settings.rtsp.login);
    assert.match(configWarnings(settings)[0], /now "rtsp.username"/);
    assert.throws(() => resolveSettings({ onvif: { username: 'protect' } }, login), /"onvif.password"/);
  });

  test('two different logins are refused: they could never work together', () => {
    const both = (onvif) => resolveSettings({ rtsp: { username: 'protect', password: 'secret' }, onvif }, login);
    assert.throws(() => both({ username: 'protect', password: 'other' }), /one login covers RTSP and ONVIF/);
    assert.deepEqual(both({ username: 'protect', password: 'secret' }).onvif, { username: 'protect', password: 'secret' });
  });
});

test('a camera\'s "audio" is true or false, also through "defaults"', () => {
  assert.equal(validateCameras({ cameras: [{ ...camera, audio: true }] })[0].audio, true);
  assert.equal(validateCameras({ defaults: { audio: true }, cameras: [camera] })[0].audio, true);
  assert.throws(() => validateCameras({ cameras: [{ ...camera, audio: 'yes' }] }), /"audio" must be true or false/);
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
    assert.deepEqual(resolveSettings({}, login).rtsp, { login: null, oldKeys: false });
    assert.deepEqual(resolveSettings({ rtsp: { username: 'nvr', password: 'secret' } }, login).rtsp.login, { username: 'nvr', password: 'secret' });
    assert.throws(() => resolveSettings({ rtsp: { username: 'nvr' } }, login), /"rtsp.password" is missing/);
  });

  test('are always on: an old "rtsp.enabled": false is refused with what to do instead', () => {
    assert.throws(() => resolveSettings({ rtsp: { enabled: false } }, login), /"rtsp.enabled" is gone: the RTSP streams are always on\. Remove it, and set "rtsp.username"/);
    assert.deepEqual(resolveSettings({ rtsp: { enabled: true } }, login).rtsp.login, null, '"enabled": true changes nothing');
  });
});

describe('what is open to the LAN (logged at startup)', () => {
  const everything = { web: { username: 'a', password: 'b', https: true }, rtsp: { username: 'c', password: 'd' },
    cameras: [{ ...camera, onvif: { address: '192.168.1.51' } }] };

  test('nothing, when every part asks for a login and the page is HTTPS', () => {
    assert.deepEqual(openToTheLan(resolveSettings(everything, login)), []);
  });

  test('names every open part and the setting that closes it', () => {
    const open = openToTheLan(resolveSettings({ cameras: [{ ...camera, onvif: { address: '192.168.1.51' } }] }, login));
    assert.equal(open.length, 2);
    assert.match(open.join('\n'), /web page and API without login[\s\S]*RTSP streams and ONVIF cameras without login/);
    assert.match(openToTheLan(resolveSettings({}, login))[1], /RTSP streams without login \(set "rtsp.username" \/ "rtsp.password"\)/);
    assert.match(openToTheLan(resolveSettings({ ...everything, web: { username: 'a', password: 'b' } }, login))[0], /plain HTTP/);
  });
});

test('the update check is on unless "checkForUpdates" is false', () => {
  assert.equal(resolveSettings({}, login).checkForUpdates, true);
  assert.equal(resolveSettings({ checkForUpdates: false }, login).checkForUpdates, false);
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSettings, validateCameras } from '../../src/gateway/config.mjs';

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

describe('the web page login', () => {
  test('is optional; when set, both username and password', () => {
    assert.equal(resolveSettings({}, login).web, null);
    assert.deepEqual(resolveSettings({ web: { username: 'admin', password: 'secret' } }, login).web, { username: 'admin', password: 'secret' });
    assert.throws(() => resolveSettings({ web: { username: 'admin' } }, login), /"web.password" is missing/);
    assert.throws(() => resolveSettings({ web: { password: 'secret' } }, login), /"web.username" is missing/);
  });
});

test('the update check is on unless "checkForUpdates" is false', () => {
  assert.equal(resolveSettings({}, login).checkForUpdates, true);
  assert.equal(resolveSettings({ checkForUpdates: false }, login).checkForUpdates, false);
});

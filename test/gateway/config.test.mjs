import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { configPath, resolveSettings, validateCameras, DEFAULT_PORTS } from '../../src/gateway/config.mjs';

const login = { EUFY_EMAIL: 'you@example.com', EUFY_PASSWORD: 'secret' };
const camera = { name: 'garden', serial: 'T81XXXXXXXXXXXXX', width: 2880, height: 1616 };

describe('where config.json is read from', () => {
  test('the data folder, so a single folder mapping is enough', () => {
    assert.equal(configPath({}, '/data', () => false), '/data/config.json');
  });

  test('a mounted /config/config.json wins (older setups)', () => {
    assert.equal(configPath({}, '/data', (p) => p === '/config/config.json'), '/config/config.json');
  });

  test('CONFIG_FILE overrides both', () => {
    assert.equal(configPath({ CONFIG_FILE: '/elsewhere.json' }, '/data', () => true), '/elsewhere.json');
  });
});

describe('settings', () => {
  test('the eufy login is required, from the environment or config.json', () => {
    assert.throws(() => resolveSettings({}, {}), /EUFY_EMAIL and EUFY_PASSWORD/);
    assert.equal(resolveSettings({ eufy: { email: 'a@example.com', password: 'x' } }, {}).eufy.email, 'a@example.com');
  });

  test('environment variables win over config.json', () => {
    const settings = resolveSettings({ eufy: { email: 'file@example.com', password: 'x', country: 'DE' } }, { ...login, EUFY_COUNTRY: 'HU' });
    assert.deepEqual(settings.eufy, { email: 'you@example.com', password: 'secret', country: 'HU' });
  });

  test('the country defaults to GB', () => {
    assert.equal(resolveSettings({}, login).eufy.country, 'GB');
  });

  test('ports: defaults, overridden per key in config.json, WEB_PORT for the web page', () => {
    assert.deepEqual(resolveSettings({}, login).ports, DEFAULT_PORTS);
    assert.equal(resolveSettings({ ports: { rtsp: 9554 } }, login).ports.rtsp, 9554);
    assert.equal(resolveSettings({}, { ...login, WEB_PORT: '9099' }).ports.web, 9099);
  });

  test('"motionInPicture" is true or false; "motionInPictureMaxMs" a positive number of ms', () => {
    const cam = (name, extra = {}) => ({ name, serial: 'T81XXXXXXXXXXXXX', width: 640, height: 480, ...extra });
    assert.equal(validateCameras({ cameras: [cam('front-door', { motionInPicture: false, motionInPictureMaxMs: 60000 })] })[0].motionInPicture, false);
    assert.throws(() => validateCameras({ cameras: [cam('front-door', { motionInPicture: 'yes' })] }), /"motionInPicture" must be true or false/);
    assert.throws(() => validateCameras({ cameras: [cam('front-door', { motionInPictureMaxMs: -1 })] }), /"motionInPictureMaxMs" must be/);
  });

  test('each camera has four fixed UDP ports, "udpPort" and the next three: 40000, 40004, … unless set', () => {
    const cam = (name, extra = {}) => ({ name, serial: 'T81XXXXXXXXXXXXX', width: 640, height: 480, ...extra });
    assert.deepEqual(validateCameras({ cameras: [cam('front-door'), cam('garden')] }).map((c) => c.udpPort), [40000, 40004]);
    assert.deepEqual(validateCameras({ cameras: [cam('front-door', { udpPort: 41000 }), cam('garden')] }).map((c) => c.udpPort), [41000, 40004]);
    assert.throws(() => validateCameras({ cameras: [cam('front-door', { udpPort: 40001 })] }), /"udpPort" must be an even port/);
    assert.throws(() => validateCameras({ cameras: [cam('front-door', { udpPort: 80 })] }), /"udpPort" must be an even port/);
    assert.throws(() => validateCameras({ cameras: [cam('front-door', { udpPort: 40002 }), cam('garden')] }),
      /cameras "front-door" and "garden" share UDP port 40004/);
  });

  test('the time zone comes from TZ, then config.json, then UTC', () => {
    assert.equal(resolveSettings({ timezone: 'Europe/London' }, { ...login, TZ: 'UTC' }).timeZone, 'UTC');
    assert.equal(resolveSettings({ timezone: 'Europe/London' }, login).timeZone, 'Europe/London');
    assert.equal(resolveSettings({}, login).timeZone, 'UTC');
  });
});

describe('cameras', () => {
  test('no cameras is fine: the first start is for logging in', () => {
    assert.deepEqual(validateCameras({}), []);
  });

  test('defaults apply to every camera unless the camera sets the key itself', () => {
    const [cam] = validateCameras({ defaults: { fps: 10, holdMs: 5000 }, cameras: [{ ...camera, fps: 15 }] });
    assert.equal(cam.fps, 15);
    assert.equal(cam.holdMs, 5000);
  });

  test('"sn" is accepted as an older name for "serial"', () => {
    const [cam] = validateCameras({ cameras: [{ name: 'garden', sn: 'T81XXXXXXXXXXXXX', width: 1, height: 1 }] });
    assert.equal(cam.serial, 'T81XXXXXXXXXXXXX');
  });

  test('the name becomes the RTSP path, so only letters, digits, - and _', () => {
    assert.throws(() => validateCameras({ cameras: [{ ...camera, name: 'front door' }] }), /"name" must be letters/);
  });

  test('serial, width and height are required', () => {
    assert.throws(() => validateCameras({ cameras: [{ ...camera, serial: undefined }] }), /"serial" is missing/);
    assert.throws(() => validateCameras({ cameras: [{ ...camera, height: undefined }] }), /"width" and "height"/);
  });

  test('names must be unique', () => {
    assert.throws(() => validateCameras({ cameras: [camera, camera] }), /unique/);
  });
});

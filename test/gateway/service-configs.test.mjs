import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { go2rtcYaml, switcherConfig, bridgeEnv } from '../../src/gateway/service-configs.mjs';

const settings = {
  eufy: { email: 'you@example.com', password: 'secret', country: 'GB' },
  ports: { web: 8099, rtsp: 8554, bridge: 3000 },
  timeZone: 'Europe/London',
  cameras: [{ name: 'garden' }, { name: 'front-door' }],
  bridgeEnv: {},
};

describe('go2rtc', () => {
  test('serves one RTSP stream per camera', () => {
    const yaml = go2rtcYaml(settings);
    assert.match(yaml, /rtsp:\n {2}listen: ":8554"/);
    assert.match(yaml, /streams:\n {2}"garden":\n {2}"front-door":/);
  });

  test('opens nothing but RTSP: web UI/API, WebRTC, SRTP and RTMP stay closed', () => {
    const yaml = go2rtcYaml(settings);
    for (const module of ['api', 'webrtc', 'srtp', 'rtmp']) assert.match(yaml, new RegExp(`${module}:\\n {2}listen: ""`));
  });

  test('an empty stream list is still valid YAML', () => {
    assert.match(go2rtcYaml({ ...settings, cameras: [] }), /streams: \{\}/);
  });
});

describe('eufy bridge', () => {
  const env = bridgeEnv(settings, '/data', {});

  test('listens on localhost only, on the configured port', () => {
    assert.equal(env.BRIDGE_HOST, '127.0.0.1');
    assert.equal(env.BRIDGE_PORT, '3000');
    assert.equal(bridgeEnv({ ...settings, ports: { ...settings.ports, bridge: 3100 } }, '/data', {}).BRIDGE_PORT, '3100');
  });

  test('its own go2rtc is off: only the switcher may open camera streams', () => {
    assert.equal(env.GO2RTC_ENABLE, '0');
  });

  test("the SDK's 45 s battery cut-off is lifted to 24 h: the switcher ends sessions itself", () => {
    assert.equal(env.STREAM_BATTERY_BUDGET_MS, '86400000');
  });

  test('keeps its login session in the data folder', () => {
    assert.equal(env.EUFY_SESSION, '/data/bridge/.eufy-session.json');
  });
});

describe('switcher', () => {
  test('gets the ONVIF login, if there is one', () => {
    assert.deepEqual(switcherConfig({ ...settings, onvif: { username: 'protect', password: 'secret' } }, '/data').onvif,
      { username: 'protect', password: 'secret' });
  });

  test('gets the web page login and the update check setting', () => {
    const config = switcherConfig({ ...settings, web: { username: 'admin', password: 'secret' }, checkForUpdates: false }, '/data');
    assert.deepEqual(config.web, { username: 'admin', password: 'secret' });
    assert.equal(config.checkForUpdates, false);
    assert.equal(switcherConfig(settings, '/data').checkForUpdates, true);
  });

  test('reaches the bridge and go2rtc on localhost', () => {
    const config = switcherConfig(settings, '/data');
    assert.equal(config.bridgeWs, 'ws://127.0.0.1:3000/ws');
    assert.equal(config.output, 'rtsp://127.0.0.1:8554/{name}');
    assert.equal(config.dataDir, '/data/switcher');
  });
});

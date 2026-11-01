import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { go2rtcYaml, switcherConfig, bridgeEnv, streamVariants } from '../../src/gateway/service-configs.mjs';

const settings = {
  eufy: { email: 'you@example.com', password: 'secret', country: 'GB' },
  ports: { web: 8099, rtsp: 8554, bridge: 3000, go2rtc: 28554 },
  timeZone: 'Europe/London',
  cameras: [{ name: 'garden' }, { name: 'front-door' }],
  bridgeEnv: {},
};

describe('go2rtc', () => {
  test('serves one RTSP stream per camera on localhost only: NVRs go through the RTSP front', () => {
    const yaml = go2rtcYaml(settings);
    assert.match(yaml, /rtsp:\n {2}listen: "127\.0\.0\.1:28554"/);
    assert.match(yaml, /streams:\n {2}"garden":\n/);
    assert.match(yaml, /\n {2}"front-door":\n/);
  });

  test('has no login of its own: the front checks it, and only localhost reaches go2rtc', () => {
    const yaml = go2rtcYaml({ ...settings, rtsp: { login: { username: 'nvr', password: 'secret' } } });
    assert.doesNotMatch(yaml, /username|password|secret/);
  });

  test('variants ONVIF clients may pick: MJPEG (RTP-ready JPEG) and, with sound, G711', () => {
    const yaml = go2rtcYaml({ ...settings, cameras: [{ name: 'garden', width: 2880, height: 1616, audio: true }] });
    assert.match(yaml, /"garden~mjpeg": "ffmpeg:garden#video=mjpeg#width=640#height=360#raw=-huffman default -force_duplicated_matrix 1 -q:v 5#audio=copy"/);
    assert.match(yaml, /"garden~g711": "ffmpeg:garden#video=copy#audio=pcmu"/);
    assert.match(yaml, /"garden~mjpeg~g711": "ffmpeg:garden#video=mjpeg/);
  });

  test('a camera without sound gets only the MJPEG variant', () => {
    assert.deepEqual(Object.keys(streamVariants({ name: 'garden', width: 1600, height: 1200 })), ['garden~mjpeg']);
    assert.match(streamVariants({ name: 'garden', width: 1600, height: 1200 })['garden~mjpeg'], /#height=480#/);
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

  test('gets the web page login, theme and HTTPS files, and the update check setting', () => {
    const web = { login: { username: 'admin', password: 'secret' }, theme: 'light', https: true, certFile: null, keyFile: null };
    const config = switcherConfig({ ...settings, web, checkForUpdates: false }, '/data');
    assert.deepEqual(config.web, { login: { username: 'admin', password: 'secret' }, theme: 'light',
      tls: { cert: '/data/web/cert.pem', key: '/data/web/key.pem' } });
    assert.equal(config.checkForUpdates, false);
    assert.equal(switcherConfig(settings, '/data').web.tls, null);
    assert.equal(switcherConfig(settings, '/data').checkForUpdates, true);
  });

  test('own certificate files are used as they are', () => {
    const web = { login: null, theme: 'auto', https: true, certFile: '/data/mine.pem', keyFile: '/data/mine.key' };
    assert.deepEqual(switcherConfig({ ...settings, web }, '/data').web.tls, { cert: '/data/mine.pem', key: '/data/mine.key' });
  });

  test('knows whether RTSP is on and needs a login, never its password', () => {
    const config = switcherConfig({ ...settings, rtsp: { login: { username: 'nvr', password: 'secret' } } }, '/data');
    assert.deepEqual(config.rtsp, { login: true });
  });

  test('reaches the bridge and go2rtc on localhost; NVRs use the RTSP port', () => {
    const config = switcherConfig(settings, '/data');
    assert.equal(config.bridgeWs, 'ws://127.0.0.1:3000/ws');
    assert.equal(config.output, 'rtsp://127.0.0.1:28554/{name}');
    assert.equal(config.go2rtcPort, 28554);
    assert.equal(config.rtspPort, 8554);
    assert.equal(config.dataDir, '/data/switcher');
  });
});

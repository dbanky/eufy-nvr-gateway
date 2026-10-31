import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceUuid, onvifDevice, onvifStatus, DEFAULT_PORT } from '../../src/onvif/index.mjs';
import { MotionEvents } from '../../src/onvif/events.mjs';

const camera = { name: 'garden', serial: 'T81XXXXXXXXXXXXX', model: null, width: 2880, height: 1616, fps: 15, bitrateKbps: 6600,
  onvif: { address: '192.168.1.51' }, deps: { feed: { codec: 'hevc' } } };

test('each camera has a stable UUID, so an NVR recognises it after a restart', () => {
  assert.equal(deviceUuid('T81XXXXXXXXXXXXX'), deviceUuid('T81XXXXXXXXXXXXX'));
  assert.notEqual(deviceUuid('T81XXXXXXXXXXXXX'), deviceUuid('T82XXXXXXXXXXXXX'));
  assert.match(deviceUuid('T81XXXXXXXXXXXXX'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("the ONVIF device points at the camera's own address and the gateway's RTSP stream", () => {
  const device = onvifDevice(camera, { rtspPort: 8554, version: '0.3.0' });
  assert.equal(device.port, DEFAULT_PORT);
  assert.equal(device.rtspUrl, 'rtsp://192.168.1.51:8554/garden');
});

test("the snapshot is on the camera's ONVIF port, so a login on the web page doesn't hide it from NVRs", () => {
  assert.equal(onvifDevice(camera, { rtspPort: 8554, version: '0.3.0' }).snapshotUrl, 'http://192.168.1.51:8000/onvif/snapshot.jpg');
});

test('the status for the web page: where, what NVRs discover, whether one talks to it; never the password', () => {
  const device = onvifDevice({ ...camera, model: 'T8170', onvif: { address: '192.168.1.51', mac: '02:00:00:00:00:01' } }, { rtspPort: 8554, version: '0.3.0' });
  const status = onvifStatus({ device, events: new MotionEvents({ baseUrl: 'http://x' }), contact: { at: 10000, from: '192.168.1.1', op: 'PullMessages' },
    discovery: { listening: true, error: null }, credentials: { username: 'protect', password: 'secret' }, now: 14000 });
  assert.equal(status.deviceService, 'http://192.168.1.51:8000/onvif/device_service');
  assert.equal(status.mac, '02:00:00:00:00:01');
  assert.equal(status.login, true);
  assert.deepEqual(status.discovery, { listening: true, error: null, uuid: `urn:uuid:${deviceUuid(camera.serial)}`, name: 'garden', hardware: 'T8170' });
  assert.deepEqual(status.lastContact, { secondsAgo: 4, from: '192.168.1.1', op: 'PullMessages' });
  assert.equal(status.subscriptions, 0);
  assert.doesNotMatch(JSON.stringify(status), /secret/);
});

test('no NVR has asked yet: no last contact', () => {
  const device = onvifDevice(camera, { rtspPort: 8554, version: '0.3.0' });
  const status = onvifStatus({ device, events: new MotionEvents({ baseUrl: 'http://x' }), contact: {}, discovery: { listening: false, error: null }, credentials: null });
  assert.equal(status.lastContact, null);
  assert.equal(status.login, false);
});

test('model and codec are read live: the model arrives from eufy later, the codec can change', () => {
  const device = onvifDevice(camera, { rtspPort: 8554, version: '0.3.0' });
  assert.equal(device.model, 'eufy camera');
  camera.model = 'T8170';
  assert.equal(device.model, 'T8170');
  assert.equal(device.codec(), 'hevc');
});

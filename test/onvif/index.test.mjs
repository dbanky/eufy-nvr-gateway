import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceUuid, onvifDevice, DEFAULT_PORT } from '../../src/onvif/index.mjs';

const camera = { name: 'garden', serial: 'T81XXXXXXXXXXXXX', model: null, width: 2880, height: 1616, fps: 15, bitrateKbps: 6600,
  onvif: { address: '192.168.1.51' }, deps: { feed: { codec: 'hevc' } } };

test('each camera has a stable UUID, so an NVR recognises it after a restart', () => {
  assert.equal(deviceUuid('T81XXXXXXXXXXXXX'), deviceUuid('T81XXXXXXXXXXXXX'));
  assert.notEqual(deviceUuid('T81XXXXXXXXXXXXX'), deviceUuid('T82XXXXXXXXXXXXX'));
  assert.match(deviceUuid('T81XXXXXXXXXXXXX'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("the ONVIF device points at the camera's own address, the gateway's RTSP stream and snapshot", () => {
  const device = onvifDevice(camera, { rtspPort: 8554, webPort: 8099, version: '0.3.0' });
  assert.equal(device.port, DEFAULT_PORT);
  assert.equal(device.rtspUrl, 'rtsp://192.168.1.51:8554/garden');
  assert.equal(device.snapshotUrl, 'http://192.168.1.51:8099/api/cameras/garden/snapshot.jpg');
});

test('model and codec are read live: the model arrives from eufy later, the codec can change', () => {
  const device = onvifDevice(camera, { rtspPort: 8554, webPort: 8099, version: '0.3.0' });
  assert.equal(device.model, 'eufy camera');
  camera.model = 'T8170';
  assert.equal(device.model, 'T8170');
  assert.equal(device.codec(), 'hevc');
});

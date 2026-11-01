import { DeviceSettings } from '../../src/onvif/device-settings.mjs';
import { MediaModel } from '../../src/onvif/media-model.mjs';
import { MotionEvents } from '../../src/onvif/events.mjs';

// One camera as the ONVIF services see it.
export const device = (over = {}) => ({
  name: 'garden', serial: 'T81XXXXXXXXXXXXX', manufacturer: 'eufy', model: 'T8170', firmware: '0.3.0',
  uuid: '5f0c2a2e-0000-4000-8000-000000000001', mac: '02:00:00:00:00:01',
  address: '192.168.1.51', port: 8000, rtspPort: 8554,
  rtspUrl: 'rtsp://192.168.1.51:8554/garden', snapshotUrl: 'http://192.168.1.51:8000/onvif/snapshot.jpg',
  width: 2880, height: 1616, fps: 15, bitrateKbps: 6600, codec: () => 'h264', audio: () => false,
  ...over,
});

// The state of one ONVIF camera: what camera-server.mjs routes requests to.
export function onvifCamera(over = {}, { now = Date.now } = {}) {
  const d = device(over);
  return { device: d, settings: new DeviceSettings(d, now), model: new MediaModel(d), events: new MotionEvents({ baseUrl: 'http://192.168.1.51:8000', now }) };
}

// A SOAP body for an operation (the services only look at element names, any prefix).
export const body = (op, inner = '') => `<s:Body><${op}>${inner}</${op}></s:Body>`;

// One camera as the ONVIF services see it.
export const device = (over = {}) => ({
  name: 'garden', serial: 'T81XXXXXXXXXXXXX', manufacturer: 'eufy', model: 'T8170', firmware: '0.3.0',
  uuid: '5f0c2a2e-0000-4000-8000-000000000001', mac: '02:00:00:00:00:01',
  address: '192.168.1.51', port: 8000,
  rtspUrl: 'rtsp://192.168.1.51:8554/garden', snapshotUrl: 'http://192.168.1.51:8099/api/cameras/garden/snapshot.jpg',
  width: 2880, height: 1616, fps: 15, bitrateKbps: 6600, codec: () => 'h264',
  ...over,
});

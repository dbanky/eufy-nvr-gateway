// Bridge events -> cameras: detections wake them, battery levels, charging and models are kept up to date.

import { stationFor } from './eufy-mode.mjs';

export function connectBridgeEvents(bridge, cameras, log) {
  const bySerial = new Map(cameras.map((c) => [c.serial, c]));

  bridge.on('device-event', ({ serial, event, message }) => {
    // A station switched its Eufy mode (from here, the eufy app or its schedule): read the list again,
    // for every station, also a HomeBase or chime that is no camera.
    if (event === 'armingModeChanged') return bridge.refreshDevices();
    const camera = bySerial.get(serial);
    if (!camera) return;
    if (event === 'batteryLevel') camera.battery = Number(message.to);
    else if (event === 'propertyChanged') noteProperty(camera, message);
    else if (camera.triggers.includes(event)) camera.trigger(event);
    else if (event === 'streamState') log(camera.name, `bridge stream ${message.active ? 'open' : 'closed'}`);
  });

  bridge.on('devices', (devices) => {
    // Each camera's Eufy mode (its station's), for its picture: Disarmed instead of Sleeping.
    for (const camera of cameras) {
      const mode = stationFor(camera.serial, devices)?.eufyMode ?? null;
      if (camera.noteEufyMode) camera.noteEufyMode(mode);
      else camera.eufyMode = mode;
    }
    for (const d of devices) {
      const camera = bySerial.get(d.serial);
      if (!camera) continue;
      camera.model = d.model ?? camera.model;
      if (d.battery != null) camera.battery = d.battery;
      if (d.charging != null) camera.charging = d.charging;
      if (d.solar != null) camera.solar = d.solar;
    }
    const list = devices.map((d) => `${d.name ?? '?'} [${d.serial}]${bySerial.has(d.serial) ? '' : ' (not configured)'}`);
    log('devices:', list.join(', ') || 'none');
  });
}

// A camera's own property changes (the eufy SDK announces them as they arrive): a charger plugged in
// or out, or sunlight on its solar panel, shows at once rather than at the next device list.
function noteProperty(camera, { property, value }) {
  if (property === 'charging' && typeof value === 'boolean') camera.charging = value;
  else if (property === 'solarIntensity' && Number.isFinite(Number(value))) camera.solar = Number(value) > 0;
}

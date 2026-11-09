// Bridge events -> cameras: detections wake them, battery levels and models are kept up to date.

export function connectBridgeEvents(bridge, cameras, log) {
  const bySerial = new Map(cameras.map((c) => [c.serial, c]));

  bridge.on('device-event', ({ serial, event, message }) => {
    // A station switched its eufy mode (from here, the eufy app or its schedule): read the list again,
    // for every station, also a HomeBase or chime that is no camera.
    if (event === 'armingModeChanged') return bridge.refreshDevices();
    const camera = bySerial.get(serial);
    if (!camera) return;
    if (event === 'batteryLevel') camera.battery = Number(message.to);
    else if (camera.triggers.includes(event)) camera.trigger(event);
    else if (event === 'streamState') log(camera.name, `bridge stream ${message.active ? 'open' : 'closed'}`);
  });

  bridge.on('devices', (devices) => {
    for (const d of devices) {
      const camera = bySerial.get(d.serial);
      if (!camera) continue;
      camera.model = d.model ?? camera.model;
      if (d.battery != null) camera.battery = d.battery;
    }
    const list = devices.map((d) => `${d.name ?? '?'} [${d.serial}]${bySerial.has(d.serial) ? '' : ' (not configured)'}`);
    log('devices:', list.join(', ') || 'none');
  });
}

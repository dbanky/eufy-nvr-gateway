// ONVIF for the gateway's cameras, so NVRs that only take ONVIF cameras (UniFi Protect) can adopt
// them. Each camera with an `onvif` section gets its own ONVIF device on its own address: device
// and media services pointing at the gateway's existing RTSP stream (nothing extra is encoded),
// motion events while the camera is waking up or live. NVRs add the cameras by IP (UniFi Protect:
// advanced adoption); there is no WS-Discovery, which didn't work with Protect in practice.

import { createHash } from 'node:crypto';
import { createCameraServer } from './camera-server.mjs';
import { MotionEvents } from './events.mjs';
import { baseUrl } from './device.mjs';
import { explainNetworkError } from './network.mjs';

export const DEFAULT_PORT = 8000;
const RETRY_MS = 30_000;

// A stable UUID per camera (from its serial), so an NVR recognises it after a restart.
export function deviceUuid(serial) {
  const h = createHash('sha1').update(`eufy-nvr-gateway:${serial}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 + (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// The ONVIF view of one camera. Model and codec are read live: both can change at runtime.
export function onvifDevice(camera, { rtspPort, version }) {
  const { address, port = DEFAULT_PORT, mac = null } = camera.onvif;
  const device = {
    name: camera.name, serial: camera.serial, manufacturer: 'eufy', firmware: version,
    get model() { return camera.model ?? 'eufy camera'; },
    uuid: deviceUuid(camera.serial), mac, address, port,
    rtspUrl: `rtsp://${address}:${rtspPort}/${camera.name}`,
    width: camera.width, height: camera.height, fps: camera.fps, bitrateKbps: camera.bitrateKbps,
    codec: () => camera.deps.feed.codec,
    audio: () => !!camera.publisher?.audio,   // the stream has an AAC track
  };
  // On the ONVIF port, not the web page's: it stays reachable when the web page has a login.
  device.snapshotUrl = `${baseUrl(device)}/onvif/snapshot.jpg`;
  return device;
}

// What the web page shows about a published camera: where it is, how it introduces itself to NVRs,
// who talks to it. listening: { on, error } of the camera's ONVIF server.
export function onvifStatus({ device, events, contact, listening = { on: true, error: null }, credentials, now = Date.now() }) {
  events.expire();
  return {
    address: device.address, port: device.port, mac: device.mac,
    deviceService: `${baseUrl(device)}/onvif/device_service`,
    listening: listening.on, error: listening.error,
    login: !!credentials,
    identity: { uuid: `urn:uuid:${device.uuid}`, name: device.name, hardware: device.model },
    subscriptions: events.subscriptions.size,
    lastContact: contact.at ? { secondsAgo: Math.max(0, Math.round((now - contact.at) / 1000)), from: contact.from, op: contact.op } : null,
  };
}

// Listens on the camera's own address and port. If that fails (the machine doesn't have the address
// yet, the port is taken), it says why in plain words and tries again every retryMs.
// Returns { on, error }, kept up to date for the web page.
export function keepListening(server, device, log, retryMs = RETRY_MS) {
  const state = { on: false, error: null };
  const listen = () => server.listen(device.port, device.address);
  server.on('listening', () => {
    Object.assign(state, { on: true, error: null });
    log(`ONVIF device on ${baseUrl(device)}/onvif/device_service`);
  });
  server.on('error', (e) => {
    const why = explainNetworkError(e, { address: device.address, port: device.port });
    if (why !== state.error) log(`ONVIF device not on the network: ${why}. Trying again every ${Math.round(retryMs / 1000)} s.`);
    Object.assign(state, { on: false, error: why });
    setTimeout(listen, retryMs).unref?.();
  });
  listen();
  return state;
}

// cameras: [Camera]; only those with an `onvif` section are published. snapshot(camera) -> jpeg.
// Returns status(name) -> onvifStatus or null (camera not published).
export function startOnvif({ cameras, credentials, rtspPort, version, snapshot, log }) {
  const published = cameras.filter((c) => c.onvif?.address);
  if (!published.length) return () => null;
  if (!credentials) log('ONVIF: no "rtsp.username"/"rtsp.password" in config.json: anyone on the LAN can use the ONVIF cameras');
  const entries = published.map((camera) => {
    const device = onvifDevice(camera, { rtspPort, version });
    const events = new MotionEvents({ baseUrl: baseUrl(device) });
    const contact = {};
    const server = createCameraServer({ device, events, credentials, log, contact, snapshot: () => snapshot(camera) });
    const listening = keepListening(server, device, (...m) => log(camera.name, ...m));
    // motion = the camera is waking up or live
    setInterval(() => events.setMotion(camera.state !== 'IDLE'), 500).unref();
    return { device, events, contact, listening };
  });
  const byName = new Map(entries.map((e) => [e.device.name, e]));
  return (name) => {
    const entry = byName.get(name);
    return entry ? onvifStatus({ ...entry, credentials }) : null;
  };
}

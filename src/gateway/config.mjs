// Reads the user's config.json and environment, and turns them into validated settings.
// Everything here is pure except reading the file, so the rules are easy to test.

import { readFileSync, existsSync } from 'node:fs';
import { webSettings, rtspSettings } from './access.mjs';

// web and rtsp face the LAN; the bridge listens on 127.0.0.1 only (with host networking that is the
// host's 127.0.0.1: main.mjs moves to the next port if another program has it). An old
// "ports.go2rtc" is ignored: the gateway serves its streams itself.
export const DEFAULT_PORTS = { web: 8099, rtsp: 8554, bridge: 3000 };

// RTP over UDP goes out from four fixed ports per camera (video RTP/RTCP, sound RTP/RTCP), shared by
// all its viewers: cameras[].udpPort is the first. Unset: 40000 for the first camera, 40004 for the
// second, and so on.
export const FIRST_UDP_PORT = 40000;
export const UDP_PORTS_PER_CAMERA = 4;
const CAMERA_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;   // becomes the RTSP path
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const MAC = /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/;

// config.json lives in the data folder, so one folder mapping is enough. A mounted
// /config/config.json (older setups) still wins; CONFIG_FILE overrides both.
export function configPath(env, dataDir, exists = existsSync) {
  if (env.CONFIG_FILE) return env.CONFIG_FILE;
  return exists('/config/config.json') ? '/config/config.json' : `${dataDir}/config.json`;
}

// The parsed file, or {} when there is none yet (first start: log in, then add cameras).
export function readConfigFile(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}

// Environment variables win over config.json. Throws a message meant for the user.
export function resolveSettings(cfg, env) {
  const eufy = {
    email: env.EUFY_EMAIL || cfg.eufy?.email,
    password: env.EUFY_PASSWORD || cfg.eufy?.password,
    country: env.EUFY_COUNTRY || cfg.eufy?.country || 'GB',
  };
  if (!eufy.email || !eufy.password) {
    throw new Error('set EUFY_EMAIL and EUFY_PASSWORD (or "eufy" in config.json). Use a separate eufy account that the cameras are shared with.');
  }
  const ports = { ...DEFAULT_PORTS, ...cfg.ports };
  if (env.WEB_PORT) ports.web = Number(env.WEB_PORT);   // also used by the Docker health check
  const settings = {
    eufy,
    ports,
    timeZone: env.TZ || cfg.timezone || 'UTC',
    cameras: validateCameras(cfg),
    bridgeEnv: cfg.bridge?.env ?? {},
    web: webSettings(cfg.web),
    rtsp: rtspSettings(cfg.rtsp, cfg.onvif),
    checkForUpdates: cfg.checkForUpdates !== false,
  };
  settings.onvif = settings.rtsp.login;   // one login for the streams: ONVIF uses the RTSP one
  return settings;
}

// A camera's ONVIF section: its own IPv4 address on the LAN (one per camera), an optional port and MAC.
function validateOnvif(cam) {
  const { address, port = 8000, mac } = cam.onvif;
  if (!address || !IPV4.test(address)) throw new Error(`camera "${cam.name}": "onvif.address" must be the camera's own IPv4 address on your LAN`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`camera "${cam.name}": "onvif.port" must be a port number`);
  if (mac != null && !MAC.test(mac)) throw new Error(`camera "${cam.name}": "onvif.mac" must look like 02:00:00:00:00:01`);
  return `${address}:${port}`;
}

// Each camera with `defaults` merged in; `sn` is accepted as an old name for `serial`.
export function validateCameras(cfg) {
  const cameras = (cfg.cameras ?? []).map((c, i) => {
    const name = c.name, serial = c.serial ?? c.sn;
    if (!name || !CAMERA_NAME.test(name)) throw new Error(`camera #${i + 1}: "name" must be letters, digits, - or _ (it becomes the RTSP path)`);
    if (!serial) throw new Error(`camera "${name}": "serial" is missing (see the device list on the web page)`);
    if (!c.width || !c.height) throw new Error(`camera "${name}": set "width" and "height" to the camera's native live resolution`);
    const cam = { ...cfg.defaults, ...c, name, serial };
    for (const key of ['audio', 'motionInPicture']) {
      if (cam[key] != null && typeof cam[key] !== 'boolean') throw new Error(`camera "${name}": "${key}" must be true or false`);
    }
    if (cam.motionInPictureMaxMs != null && !(Number.isFinite(cam.motionInPictureMaxMs) && cam.motionInPictureMaxMs > 0)) {
      throw new Error(`camera "${name}": "motionInPictureMaxMs" must be a number of milliseconds above 0 (e.g. 300000 for 5 minutes)`);
    }
    cam.udpPort ??= FIRST_UDP_PORT + UDP_PORTS_PER_CAMERA * i;
    if (!Number.isInteger(cam.udpPort) || cam.udpPort % 2 || cam.udpPort < 1024 || cam.udpPort > 65532) {
      throw new Error(`camera "${name}": "udpPort" must be an even port number between 1024 and 65532 (it uses that one and the next three)`);
    }
    return cam;
  });
  const taken = new Map();
  for (const cam of cameras) {
    for (let p = cam.udpPort; p < cam.udpPort + UDP_PORTS_PER_CAMERA; p++) {
      if (taken.has(p)) throw new Error(`cameras "${taken.get(p)}" and "${cam.name}" share UDP port ${p}: each camera uses "udpPort" and the next three`);
      taken.set(p, cam.name);
    }
  }
  if (new Set(cameras.map((c) => c.name)).size !== cameras.length) throw new Error('camera names must be unique');
  const endpoints = cameras.filter((c) => c.onvif).map(validateOnvif);
  if (new Set(endpoints).size !== endpoints.length) throw new Error('two cameras have the same ONVIF address and port');
  return cameras;
}

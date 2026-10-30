// Reads the user's config.json and environment, and turns them into validated settings.
// Everything here is pure except reading the file, so the rules are easy to test.

import { readFileSync, existsSync } from 'node:fs';

export const DEFAULT_PORTS = { web: 8099, rtsp: 8554, bridge: 3000 };
const CAMERA_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;   // becomes the RTSP path

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
  return {
    eufy,
    ports,
    timeZone: env.TZ || cfg.timezone || 'UTC',
    cameras: validateCameras(cfg),
    bridgeEnv: cfg.bridge?.env ?? {},
  };
}

// Each camera with `defaults` merged in; `sn` is accepted as an old name for `serial`.
export function validateCameras(cfg) {
  const cameras = (cfg.cameras ?? []).map((c, i) => {
    const name = c.name, serial = c.serial ?? c.sn;
    if (!name || !CAMERA_NAME.test(name)) throw new Error(`camera #${i + 1}: "name" must be letters, digits, - or _ (it becomes the RTSP path)`);
    if (!serial) throw new Error(`camera "${name}": "serial" is missing (see the device list on the web page)`);
    if (!c.width || !c.height) throw new Error(`camera "${name}": set "width" and "height" to the camera's native live resolution`);
    return { ...cfg.defaults, ...c, name, serial };
  });
  if (new Set(cameras.map((c) => c.name)).size !== cameras.length) throw new Error('camera names must be unique');
  return cameras;
}

// The web page and the JSON API. Meant for the LAN: never expose it to the internet. With "web" in
// config.json it asks for a login (see auth.mjs); without, anyone on the LAN can use it.
//
//   GET  /                                  the web page (static/); signin.html when a login is needed
//   GET  /api/health                        { ok: true }, always open (Docker's health check)
//   GET  /api/session                       { login: bool, signedIn: bool }, always open
//   POST /api/signin                        { "username", "password" } -> session cookie
//   POST /api/signout                       ends the session
//   GET  /api/status                        login state, every camera's state, the gateway's version
//   GET  /api/devices                       devices on the eufy account
//   POST /api/login                         { "code": "123456" } or { "captcha": "AB3D" } (eufy's 2FA)
//   POST /api/login/retrigger               ask eufy for a new code
//   GET  /api/cameras/<name>/snapshot.jpg   what the stream shows right now
//   POST /api/cameras/<name>/live           wake the camera
//   POST /api/cameras/<name>/idle           end the live session
//   GET  /api/cameras/<name>/eufy-mode      its Eufy mode (Home, Away, Disarmed, …) and station
//   POST /api/cameras/<name>/eufy-mode      { "mode": "home" } switches it (eufy-mode.mjs)
// The camera routes also answer without the /api/cameras prefix, and /status without /api (older URLs).

import { createServer } from 'node:http';
import { serveStatic, sendJson, readJson, forward } from './http.mjs';
import { signIn, signOut, refuse, tooManyLogins } from './signin-routes.mjs';
import { noGuard } from '../../security/login-guard.mjs';
import { crossSite, allowedHost, hostName } from '../../security/web-requests.mjs';
import { eufyModeOf, setEufyMode, EUFY_MODE_NAMES } from '../eufy-mode.mjs';

// On every answer: the page may not be shown inside another site (so no one can trick a click on
// its buttons), types are not guessed, and no address of it leaks to other sites.
const SECURITY_HEADERS = [
  ['x-frame-options', 'DENY'],
  ['content-security-policy', "frame-ancestors 'none'"],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'no-referrer'],
];

// cameras: [Camera]   bridge: BridgeClient   snapshot(camera) -> Promise<jpeg Buffer>
// auth: createAuth(...) or null   gateway() -> { version, update }   onvif(name) -> ONVIF status or null
// rtsp: { login } (whether one is required)   theme: 'auto' | 'light' | 'dark'
// guard: the login guard shared with RTSP and ONVIF   allowedHosts: "web.allowedHosts" (see
// security/web-requests.mjs; only used without a login)   log(...)
// clientLogin: createClientLogin(the stream login) or null: with a web login, the stream login also
// opens the client routes (clientRoute), so NVRs and Homebridge never need the web page's login.
export const createWebServer = (options) => createServer(webHandler(options));

export function webHandler({ cameras, bridge, rtspPort, snapshot, auth = null, gateway = () => ({}), onvif = () => null,
  rtsp = { login: false }, theme = 'auto', guard = noGuard, allowedHosts = [], log = () => {}, clientLogin = null }) {
  const byName = new Map(cameras.map((c) => [c.name, c]));
  const configured = new Set(cameras.map((c) => c.serial));
  const page = { theme };

  const refusedHosts = new Set();   // logged once each

  return async (req, res) => {
    for (const [name, value] of SECURITY_HEADERS) res.setHeader(name, value);
    const path = req.url.split('?')[0];
    const route = `${req.method} ${path}`;
    if (route === 'GET /api/health') return sendJson(res, 200, { ok: true });
    if (!auth && !allowedHost(req.headers.host, allowedHosts)) {
      const name = hostName(req.headers.host);
      if (!refusedHosts.has(name)) {
        refusedHosts.add(name);
        log(`Security: refused web requests for "${name}": without a web login the page only answers to its IP address or a local name. Set "web.username"/"web.password", or add "${name}" to "web.allowedHosts".`);
      }
      return sendJson(res, 403, { error: `"${name}" is not an address of this gateway: set a web login, or add it to "web.allowedHosts"` });
    }
    if (crossSite(req)) return sendJson(res, 403, { error: 'refused: the request comes from another website' });
    if (route === 'GET /api/session') return sendJson(res, 200, { login: !!auth, signedIn: !auth || auth.allows(req) });
    if (route === 'POST /api/signin') return signIn(req, res, auth, guard);
    if (route === 'POST /api/signout') return signOut(res);
    if (auth) {
      let how = auth.check(req);
      if (how === 'wrong' && clientLogin?.matches(req)) {
        // The right stream login: never a wrong password, but only for the client routes.
        if (!clientRoute(req.method, path, byName)) {
          return sendJson(res, 403, { error: 'the stream login can read the cameras, fetch snapshots and wake them; for this, use the web login' });
        }
        how = 'client';
      }
      if (how === 'login' || how === 'client' || how === 'wrong') {
        const address = req.socket.remoteAddress;
        if (guard.blocked(address)) return tooManyLogins(res, guard.retryAfterS(address));
        if (how === 'wrong') guard.failed(address, 'web page (HTTP Basic)');
      }
      if (how !== 'session' && how !== 'login' && how !== 'client') return refuse(req, res, path, page);
    }

    if (req.method === 'GET' && serveStatic(res, path, page)) return;
    if (route === 'GET /api/status' || route === 'GET /status') {
      return sendJson(res, 200, {
        bridge: bridge.status(), rtspPort, rtsp, gateway: { ...gateway(), login: !!auth, theme, streamLoginForApi: !!(auth && clientLogin) },
        cameras: cameras.map((c) => ({
          ...c.status(), model: modelOf(bridge.devices, c.serial), onvif: onvif(c.name), eufyMode: eufyModeOf(c.serial, bridge.devices),
        })),
      });
    }
    if (route === 'GET /api/devices') {
      return sendJson(res, 200, bridge.devices.map((d) => ({ ...d, configured: configured.has(d.serial) })));
    }
    if (route === 'POST /api/login') {
      const message = loginMessage(await readJson(req));
      if (!message) return sendJson(res, 400, { ok: false, error: 'send { "code": "123456" } or { "captcha": "AB3D" }' });
      return forward(res, () => bridge.submitLogin(message));
    }
    if (route === 'POST /api/login/retrigger') return forward(res, () => bridge.submitLogin({ cmd: 'auth.retrigger' }));

    const [name, action] = cameraRoute(path);
    const camera = byName.get(name);
    if (camera) return cameraAction(req, res, camera, action, { snapshot, bridge, log });
    sendJson(res, 404, { error: 'not found' });
  };
}

// What the stream login may do on the API: read the cameras (GET /api/status), fetch a snapshot, wake
// a camera or let it sleep, read or switch its Eufy mode (so HomeKit can), in both URL forms. Not the eufy login, its 2FA, or the account's device
// list. byName: the configured cameras by name.
export function clientRoute(method, path, byName) {
  if (method === 'GET' && (path === '/api/status' || path === '/status')) return true;
  const [name, action, ...more] = cameraRoute(path);
  if (more.length || !byName.has(name)) return false;
  return (method === 'GET' && action === 'snapshot.jpg') || (method === 'POST' && (action === 'live' || action === 'idle'))
    || ((method === 'GET' || method === 'POST') && action === 'eufy-mode');
}

// The camera's model from the eufy account ("SoloCam S340"), or null while the device list is unknown.
const modelOf = (devices, serial) => {
  const device = devices.find((d) => d.serial === serial);
  return device?.modelName || device?.model || null;
};

// "/api/cameras/garden/live" and "/garden/live" -> ["garden", "live"]
export function cameraRoute(path) {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return parts[0] === 'api' && parts[1] === 'cameras' ? parts.slice(2) : parts;
}

const loginMessage = (body) => (body.captcha ? { cmd: 'auth.submit', captcha: String(body.captcha) }
  : body.code ? { cmd: 'auth.submit', code: String(body.code) } : null);

async function cameraAction(req, res, camera, action, { snapshot, bridge, log }) {
  // The camera's Eufy mode (eufy-mode.mjs): read it, or switch it with { "mode": "home" }.
  if (action === 'eufy-mode' && req.method === 'GET') {
    return sendJson(res, 200, { ...(eufyModeOf(camera.serial, bridge.devices) ?? { mode: null }), modes: EUFY_MODE_NAMES });
  }
  if (action === 'eufy-mode' && req.method === 'POST') {
    const { mode } = await readJson(req);
    try {
      await setEufyMode({ bridge, serial: camera.serial, mode, log, name: camera.name });
      camera.eufyMode = mode;   // its picture follows at once (Disarmed instead of Sleeping)
      camera.refresh?.();
    } catch (e) {
      const unknownMode = !EUFY_MODE_NAMES.includes(mode);
      return sendJson(res, unknownMode ? 400 : 502, { error: `${camera.name}: ${e.message}` });
    }
    return sendJson(res, 200, { ...eufyModeOf(camera.serial, bridge.devices), modes: EUFY_MODE_NAMES });
  }
  if (req.method === 'GET' && action === 'snapshot.jpg') {
    try {
      const jpg = await snapshot(camera);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpg.length, 'cache-control': 'no-store' });
      return res.end(jpg);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }
  if (req.method === 'POST' && action === 'live') {
    camera.trigger('manual');
    return sendJson(res, 200, camera.status());
  }
  if (req.method === 'POST' && action === 'idle') {
    camera.stop('manual');
    return sendJson(res, 200, camera.status());
  }
  sendJson(res, 404, { error: 'not found' });
}

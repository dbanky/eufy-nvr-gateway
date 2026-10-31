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
// The camera routes also answer without the /api/cameras prefix, and /status without /api (older URLs).

import { createServer } from 'node:http';
import { serveStatic, sendJson, readJson, forward } from './http.mjs';
import { signIn, signOut, refuse } from './signin-routes.mjs';

// cameras: [Camera]   bridge: BridgeClient   snapshot(camera) -> Promise<jpeg Buffer>
// auth: createAuth(...) or null   gateway() -> { version, update }   onvif(name) -> ONVIF status or null
// rtsp: { login } (whether one is required)   theme: 'auto' | 'light' | 'dark'
export const createWebServer = (options) => createServer(webHandler(options));

export function webHandler({ cameras, bridge, rtspPort, snapshot, auth = null, gateway = () => ({}), onvif = () => null,
  rtsp = { login: false }, theme = 'auto' }) {
  const byName = new Map(cameras.map((c) => [c.name, c]));
  const configured = new Set(cameras.map((c) => c.serial));
  const page = { theme };

  return async (req, res) => {
    const path = req.url.split('?')[0];
    const route = `${req.method} ${path}`;
    if (route === 'GET /api/health') return sendJson(res, 200, { ok: true });
    if (route === 'GET /api/session') return sendJson(res, 200, { login: !!auth, signedIn: !auth || auth.allows(req) });
    if (route === 'POST /api/signin') return signIn(req, res, auth);
    if (route === 'POST /api/signout') return signOut(res);
    if (auth && !auth.allows(req)) return refuse(req, res, path, page);

    if (req.method === 'GET' && serveStatic(res, path, page)) return;
    if (route === 'GET /api/status' || route === 'GET /status') {
      return sendJson(res, 200, {
        bridge: bridge.status(), rtspPort, rtsp, gateway: { ...gateway(), login: !!auth, theme },
        cameras: cameras.map((c) => ({ ...c.status(), onvif: onvif(c.name) })),
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
    if (camera) return cameraAction(req, res, camera, action, snapshot);
    sendJson(res, 404, { error: 'not found' });
  };
}

// "/api/cameras/garden/live" and "/garden/live" -> ["garden", "live"]
export function cameraRoute(path) {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return parts[0] === 'api' && parts[1] === 'cameras' ? parts.slice(2) : parts;
}

const loginMessage = (body) => (body.captcha ? { cmd: 'auth.submit', captcha: String(body.captcha) }
  : body.code ? { cmd: 'auth.submit', code: String(body.code) } : null);

async function cameraAction(req, res, camera, action, snapshot) {
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

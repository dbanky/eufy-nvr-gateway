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
import { signedOutCookie } from './auth.mjs';

// What the sign-in page needs before anyone is signed in.
const OPEN_FILES = /^\/(signin\.html|signin\.js|theme\.js|theme-toggle\.js|icons\.js|style\.css|fonts\/[^/]+)$/;
const FAILED_SIGNIN_DELAY_MS = 1000;   // slows down guessing

// cameras: [Camera]   bridge: BridgeClient   snapshot(camera) -> Promise<jpeg Buffer>
// auth: createAuth(...) or null   gateway() -> { version, update }   onvif(name) -> ONVIF status or null
export function createWebServer({ cameras, bridge, rtspPort, snapshot, auth = null, gateway = () => ({}), onvif = () => null }) {
  const byName = new Map(cameras.map((c) => [c.name, c]));
  const configured = new Set(cameras.map((c) => c.serial));

  return createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    const route = `${req.method} ${path}`;
    if (route === 'GET /api/health') return sendJson(res, 200, { ok: true });
    if (route === 'GET /api/session') return sendJson(res, 200, { login: !!auth, signedIn: !auth || auth.allows(req) });
    if (route === 'POST /api/signin') return signIn(req, res, auth);
    if (route === 'POST /api/signout') {
      res.setHeader('set-cookie', signedOutCookie);
      return sendJson(res, 200, { ok: true });
    }
    if (auth && !auth.allows(req)) return refuse(req, res, path);

    if (req.method === 'GET' && serveStatic(res, path)) return;
    if (route === 'GET /api/status' || route === 'GET /status') {
      return sendJson(res, 200, {
        bridge: bridge.status(), rtspPort, gateway: { ...gateway(), login: !!auth },
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
  });
}

async function signIn(req, res, auth) {
  if (!auth) return sendJson(res, 200, { ok: true });   // nothing to sign in to
  const { username, password } = await readJson(req);
  if (!auth.matches(username, password)) {
    await new Promise((resolve) => setTimeout(resolve, FAILED_SIGNIN_DELAY_MS));
    return sendJson(res, 401, { ok: false, error: 'Wrong username or password.' });
  }
  res.setHeader('set-cookie', auth.sessionCookie());
  sendJson(res, 200, { ok: true });
}

// Not signed in: the sign-in page's own files are open, pages lead to it, everything else is 401.
// Browsers (they send Sec-Fetch-Mode) get no Basic challenge, so they never show a login dialog;
// other clients (curl, NVRs fetching snapshots) do, so they can answer it.
function refuse(req, res, path) {
  if (req.method === 'GET' && OPEN_FILES.test(path) && serveStatic(res, path)) return;
  if (req.method === 'GET' && (path === '/' || path.endsWith('.html'))) {
    res.writeHead(302, { location: 'signin.html' });
    return res.end();
  }
  if (!req.headers['sec-fetch-mode']) res.setHeader('www-authenticate', 'Basic realm="Eufy NVR Gateway", charset="UTF-8"');
  sendJson(res, 401, { error: 'sign in first' });
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

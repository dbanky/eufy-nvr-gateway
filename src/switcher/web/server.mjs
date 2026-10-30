// The web page and the JSON API. LAN only, no authentication: never expose it to the internet.
//
//   GET  /                                  the web page (static/)
//   GET  /api/status                        login state and every camera's state
//   GET  /api/devices                       devices on the eufy account
//   POST /api/login                         { "code": "123456" } or { "captcha": "AB3D" }
//   POST /api/login/retrigger               ask eufy for a new code
//   GET  /api/cameras/<name>/snapshot.jpg   what the stream shows right now
//   POST /api/cameras/<name>/live           wake the camera
//   POST /api/cameras/<name>/idle           end the live session
// The camera routes also answer without the /api/cameras prefix, and /status without /api (older URLs).

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
const readStatic = (file) => readFileSync(new URL(`./static/${file}`, import.meta.url));

// cameras: [Camera]   bridge: BridgeClient   snapshot(camera) -> Promise<jpeg Buffer>
export function createWebServer({ cameras, bridge, rtspPort, snapshot }) {
  const byName = new Map(cameras.map((c) => [c.name, c]));
  const configured = new Set(cameras.map((c) => c.serial));

  return createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body, null, 1));
    };
    const route = `${req.method} ${path}`;

    if (req.method === 'GET' && STATIC[path]) {
      const [file, type] = STATIC[path];
      res.writeHead(200, { 'content-type': type });
      return res.end(readStatic(file));
    }
    if (route === 'GET /api/status' || route === 'GET /status') {
      return send(200, { bridge: bridge.status(), rtspPort, cameras: cameras.map((c) => c.status()) });
    }
    if (route === 'GET /api/devices') {
      return send(200, bridge.devices.map((d) => ({ ...d, configured: configured.has(d.serial) })));
    }
    if (route === 'POST /api/login') {
      const body = await readJson(req);
      const message = body.captcha ? { cmd: 'auth.submit', captcha: String(body.captcha) }
        : body.code ? { cmd: 'auth.submit', code: String(body.code) } : null;
      if (!message) return send(400, { ok: false, error: 'send { "code": "123456" } or { "captcha": "AB3D" }' });
      return forward(send, () => bridge.submitLogin(message));
    }
    if (route === 'POST /api/login/retrigger') return forward(send, () => bridge.submitLogin({ cmd: 'auth.retrigger' }));

    const [name, action] = cameraRoute(path);
    const camera = byName.get(name);
    if (!camera) return send(404, { error: 'not found' });
    if (req.method === 'GET' && action === 'snapshot.jpg') {
      try {
        const jpg = await snapshot(camera);
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpg.length, 'cache-control': 'no-store' });
        return res.end(jpg);
      } catch (e) {
        return send(500, { error: e.message });
      }
    }
    if (req.method === 'POST' && action === 'live') {
      camera.trigger('manual');
      return send(200, camera.status());
    }
    if (req.method === 'POST' && action === 'idle') {
      camera.stop('manual');
      return send(200, camera.status());
    }
    send(404, { error: 'not found' });
  });
}

// "/api/cameras/garden/live" and "/garden/live" -> ["garden", "live"]
export function cameraRoute(path) {
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return parts[0] === 'api' && parts[1] === 'cameras' ? parts.slice(2) : parts;
}

// A bridge call answered as JSON: 200 if eufy accepted it, 400 if not, 502 if the bridge failed.
async function forward(send, call) {
  try {
    const answer = await call();
    send(answer.ok ? 200 : 400, answer);
  } catch (e) {
    send(502, { ok: false, error: e.message });
  }
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

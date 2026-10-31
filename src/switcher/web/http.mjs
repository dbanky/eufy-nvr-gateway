// Small HTTP helpers for the web server: JSON in and out, and the static files of the web page.

import { readFileSync } from 'node:fs';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/icons.js': ['icons.js', 'text/javascript; charset=utf-8'],
  '/views.js': ['views.js', 'text/javascript; charset=utf-8'],
};

// Serves a file of the web page; false if `path` isn't one.
export function serveStatic(res, path) {
  if (!STATIC[path]) return false;
  const [file, type] = STATIC[path];
  res.writeHead(200, { 'content-type': type });
  res.end(readFileSync(new URL(`./static/${file}`, import.meta.url)));
  return true;
}

export function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 1));
}

// The request body as JSON ({} if empty or not JSON). Bodies over 100 kB are cut off.
export function readJson(req) {
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

// A bridge call answered as JSON: 200 if eufy accepted it, 400 if not, 502 if the bridge failed.
export async function forward(res, call) {
  try {
    const answer = await call();
    sendJson(res, answer.ok ? 200 : 400, answer);
  } catch (e) {
    sendJson(res, 502, { ok: false, error: e.message });
  }
}

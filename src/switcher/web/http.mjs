// Small HTTP helpers for the web server: JSON in and out, and the static files of the web page.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STATIC_DIR = fileURLToPath(new URL('./static/', import.meta.url));
const FONTS_DIR = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));   // built into the image
const TYPES = { html: 'text/html', css: 'text/css', js: 'text/javascript', ttf: 'font/ttf' };

// The file a request path names, or null: "/" is the page; otherwise only plain names of the page's
// own files (and its fonts), so nothing else on disk can be reached.
export function staticFile(path) {
  if (path === '/') return STATIC_DIR + 'index.html';
  let match = /^\/([a-z0-9-]+\.(?:html|css|js))$/.exec(path);
  if (match) return STATIC_DIR + match[1];
  match = /^\/fonts\/(Inter-[A-Za-z]+\.ttf)$/.exec(path);
  return match ? FONTS_DIR + match[1] : null;
}

// Serves a file of the web page; false if `path` isn't one.
export function serveStatic(res, path) {
  const file = staticFile(path);
  if (!file || !existsSync(file)) return false;
  const type = TYPES[file.split('.').pop()];
  res.writeHead(200, { 'content-type': type.startsWith('font/') ? type : `${type}; charset=utf-8`, 'cache-control': 'no-cache' });
  res.end(readFileSync(file));
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

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import { listenWeb } from '../../../src/switcher/web/listen.mjs';
import { ensureCertificate } from '../../../src/gateway/certificate.mjs';

let openssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); } catch { openssl = false; }

let server, port;
before(async () => {
  if (!openssl) return;
  const dir = mkdtempSync(join(tmpdir(), 'web-'));
  const tls = { cert: join(dir, 'cert.pem'), key: join(dir, 'key.pem') };
  ensureCertificate(tls);
  server = await new Promise((resolve) => {
    const s = listenWeb((req, res) => res.end(`hello ${req.url}`), { port: 0, tls }, () => resolve(s));
  });
  port = server.address().port;
});
after(() => server?.close());

const get = (request, path, options = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, rejectUnauthorized: false, headers: { host: `nas:${port}` }, ...options }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.end();
});

test('with HTTPS, the page answers over TLS', { skip: !openssl }, async () => {
  const res = await get(httpsRequest, '/api/status');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'hello /api/status');
});

test('plain HTTP on the same port is sent to https://, path kept', { skip: !openssl }, async () => {
  const res = await get(httpRequest, '/cams?x=1');
  assert.equal(res.status, 308);
  assert.equal(res.headers.location, `https://nas:${port}/cams?x=1`);
});

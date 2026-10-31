import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { subjectAltNames, opensslArgs, ensureCertificate } from '../../src/gateway/certificate.mjs';

const interfaces = { lo: [{ family: 'IPv4', address: '127.0.0.1' }], eth0: [{ family: 'IPv4', address: '192.168.1.10' }, { family: 'IPv6', address: 'fe80::1' }] };

test('the certificate names the host, localhost and every IPv4 address of the host', () => {
  assert.equal(subjectAltNames(interfaces, 'nas'), 'DNS:nas,DNS:localhost,IP:127.0.0.1,IP:192.168.1.10');
});

test('a self-signed EC certificate valid for ten years, with those names', () => {
  const args = opensslArgs('/data/web/cert.pem', '/data/web/key.pem', 'DNS:nas');
  assert.deepEqual(args.slice(0, 2), ['req', '-x509']);
  assert.ok(args.includes('ec_paramgen_curve:prime256v1'));
  assert.equal(args[args.indexOf('-days') + 1], '3650');
  assert.equal(args[args.indexOf('-addext') + 1], 'subjectAltName=DNS:nas');
});

test('is made once: existing files (also your own) are kept', () => {
  const runs = [];
  const run = (...a) => runs.push(a);
  assert.equal(ensureCertificate({ cert: '/x/c.pem', key: '/x/k.pem' }, { run, exists: () => true }), false);
  assert.equal(runs.length, 0);
});

test('openssl really makes a usable certificate and key', { skip: !hasOpenssl() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cert-'));
  const files = { cert: join(dir, 'web', 'cert.pem'), key: join(dir, 'web', 'key.pem') };
  assert.equal(ensureCertificate(files), true);
  assert.ok(existsSync(files.key));
  assert.match(readFileSync(files.cert, 'utf8'), /BEGIN CERTIFICATE/);
});

function hasOpenssl() {
  try { execFileSync('openssl', ['version'], { stdio: 'pipe' }); return true; } catch { return false; }
}

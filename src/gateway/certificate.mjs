// A self-signed HTTPS certificate for the web page, made once with openssl when "web.https" is on
// and no own certificate is given. Browsers warn about it once (it isn't signed by an authority you
// trust); traffic is encrypted all the same. Replace it with your own via "web.certFile"/"web.keyFile".

import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { networkInterfaces, hostname } from 'node:os';

// The names a browser may use for the gateway: host name, localhost and the host's IPv4 addresses
// (host networking: these are the NAS's own addresses).
export function subjectAltNames(interfaces = networkInterfaces(), host = hostname()) {
  const ips = Object.values(interfaces).flat().filter((i) => i && i.family === 'IPv4').map((i) => i.address);
  const dns = [...new Set([host, 'localhost'].filter(Boolean))];
  return [...dns.map((d) => `DNS:${d}`), ...[...new Set(['127.0.0.1', ...ips])].map((ip) => `IP:${ip}`)].join(',');
}

export function opensslArgs(cert, key, altNames) {
  return ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-sha256',
    '-days', '3650', '-subj', '/CN=Eufy NVR Gateway', '-addext', `subjectAltName=${altNames}`,
    '-keyout', key, '-out', cert];
}

// Makes the certificate unless both files exist. Returns true if it made one.
export function ensureCertificate({ cert, key }, { run = execFileSync, exists = existsSync } = {}) {
  if (exists(cert) && exists(key)) return false;
  mkdirSync(cert.slice(0, cert.lastIndexOf('/')) || '.', { recursive: true });
  run('openssl', opensslArgs(cert, key, subjectAltNames()), { stdio: 'pipe' });
  return true;
}

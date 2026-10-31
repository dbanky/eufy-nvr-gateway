// Docker's health check: is the web page answering? Reads the generated switcher config for the
// port and whether it is HTTPS (a self-signed certificate is fine here).

import { readFileSync } from 'node:fs';
import { request as http } from 'node:http';
import { request as https } from 'node:https';

let config = {};
try { config = JSON.parse(readFileSync(`${process.env.DATA_DIR || '/data'}/switcher/config.json`, 'utf8')); } catch { /* defaults */ }
const port = config.webPort ?? (Number(process.env.WEB_PORT) || 8099);
const request = config.web?.tls ? https : http;

const req = request({ host: '127.0.0.1', port, path: '/api/health', rejectUnauthorized: false, timeout: 4000 }, (res) => {
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('error', () => process.exit(1));
req.on('timeout', () => process.exit(1));
req.end();

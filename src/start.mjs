// Container entrypoint: reads /data/config.json (+ environment), writes the configs for the
// bundled services, then runs and supervises them:
//   bridge    eufy cloud login, events and on-demand P2P video   (ha-eufy-sdk-bridge, localhost only)
//   go2rtc    serves the always-on RTSP streams to NVRs
//   switcher  frozen frame while idle, live video on events     (this project)

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const DATA = process.env.DATA_DIR || '/data';
// config.json lives in the data folder, so one folder mapping is enough. A mounted
// /config/config.json (older setups) still wins.
const CONFIG_FILE = process.env.CONFIG_FILE || (existsSync('/config/config.json') ? '/config/config.json' : `${DATA}/config.json`);
const log = (...a) => console.log(new Date().toISOString(), '[start]', ...a);
const die = (msg) => { log('ERROR:', msg); process.exit(1); };

// ---------- configuration ----------
let cfg = {};
if (existsSync(CONFIG_FILE)) {
  try { cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { die(`${CONFIG_FILE} is not valid JSON: ${e.message}`); }
} else log(`${CONFIG_FILE} not found: starting without cameras (log in on the web page, then create it and restart).`);

const env = process.env;
const eufy = {
  email: env.EUFY_EMAIL || cfg.eufy?.email,
  password: env.EUFY_PASSWORD || cfg.eufy?.password,
  country: env.EUFY_COUNTRY || cfg.eufy?.country || 'GB',
};
if (!eufy.email || !eufy.password) die('set EUFY_EMAIL and EUFY_PASSWORD (or "eufy" in config.json). Use a separate eufy account that the cameras are shared with.');

const ports = { web: 8099, rtsp: 8554, go2rtcApi: 1984, webrtc: 8555, bridge: 3000, ...cfg.ports };
if (env.WEB_PORT) ports.web = Number(env.WEB_PORT);   // also used by the Docker healthcheck
const timeZone = env.TZ || cfg.timezone || 'UTC';

const cameras = (cfg.cameras ?? []).map((c, i) => {
  const name = c.name, serial = c.serial ?? c.sn;
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) die(`camera #${i + 1}: "name" must be letters, digits, - or _ (it becomes the RTSP path)`);
  if (!serial) die(`camera "${name}": "serial" is missing (see the device list on the web UI)`);
  if (!c.width || !c.height) die(`camera "${name}": set "width" and "height" to the camera's native live resolution`);
  return { ...cfg.defaults, ...c, name, serial };
});
if (new Set(cameras.map((c) => c.name)).size !== cameras.length) die('camera names must be unique');

for (const d of ['bridge', 'go2rtc', 'switcher']) mkdirSync(`${DATA}/${d}`, { recursive: true });

// ---------- go2rtc: one empty stream per camera, fed by the switcher ----------
const q = JSON.stringify;   // JSON strings are valid YAML scalars
writeFileSync(`${DATA}/go2rtc/go2rtc.yaml`, [
  '# Generated at container start. Edit config.json instead.',
  `api:\n  listen: ${q(':' + ports.go2rtcApi)}`,
  `rtsp:\n  listen: ${q(':' + ports.rtsp)}`,
  `webrtc:\n  listen: ${q(':' + ports.webrtc)}`,
  'log:\n  level: warn',
  'streams:' + (cameras.length ? '' : ' {}'),
  ...cameras.map((c) => `  ${q(c.name)}:`),
  '',
].join('\n'));

// ---------- switcher ----------
writeFileSync(`${DATA}/switcher/config.json`, JSON.stringify({
  bridgeWs: `ws://127.0.0.1:${ports.bridge}/ws`,
  bridgeHttp: `http://127.0.0.1:${ports.bridge}`,
  output: `rtsp://127.0.0.1:${ports.rtsp}/{name}`,
  rtspPort: ports.rtsp, webPort: ports.web, dataDir: `${DATA}/switcher`, timeZone,
  cameras,
}, null, 2));

// ---------- supervise ----------
const services = [
  { name: 'bridge', cmd: 'node', args: ['/opt/bridge/server.mjs'], cwd: `${DATA}/bridge`, env: {
    EUFY_EMAIL: eufy.email, EUFY_PASSWORD: eufy.password, EUFY_COUNTRY: eufy.country,
    BRIDGE_HOST: cfg.bridge?.listen ?? '127.0.0.1', BRIDGE_PORT: String(ports.bridge),
    GO2RTC_ENABLE: '0', GO2RTC_CONFIG: `${DATA}/bridge/go2rtc.yaml`, EUFY_SESSION: `${DATA}/bridge/.eufy-session.json`,
    // The switcher ends every session itself; the bridge's own 45 s battery cut-off would only interrupt it.
    STREAM_BATTERY_BUDGET_MS: env.STREAM_BATTERY_BUDGET_MS ?? '86400000',
    ...cfg.bridge?.env } },
  { name: 'go2rtc', cmd: '/usr/local/bin/go2rtc', args: ['-config', `${DATA}/go2rtc/go2rtc.yaml`], cwd: `${DATA}/go2rtc` },
  { name: 'switcher', waitFor: [ports.rtsp, ports.bridge], cmd: 'node', args: ['/app/src/switcher.mjs', `${DATA}/switcher/config.json`], cwd: '/app', env: { TZ: timeZone } },
];

const children = new Map();
let stopping = false;

function run(s, delay = 1000) {
  const started = Date.now();
  const p = spawn(s.cmd, s.args, { cwd: s.cwd, env: { ...env, ...s.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.set(s.name, p);
  const prefix = (stream, out) => {
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n'); rest = lines.pop();
      for (const l of lines) if (l.trim()) out.write(`[${s.name}] ${l}\n`);
    });
  };
  prefix(p.stdout, process.stdout); prefix(p.stderr, process.stderr);
  p.on('error', (e) => log(`${s.name} failed to start: ${e.message}`));
  p.on('exit', (code, signal) => {
    children.delete(s.name);
    if (stopping) return;
    const next = Date.now() - started > 60000 ? 1000 : Math.min(delay * 2, 30000);   // back off on crash loops
    log(`${s.name} exited (${signal ?? code}), restarting in ${next / 1000} s`);
    setTimeout(() => run(s, next), next);
  });
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  log('stopping…');
  for (const p of children.values()) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 5000).unref();
  const wait = setInterval(() => { if (!children.size) { clearInterval(wait); process.exit(0); } }, 100);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

log(`${cameras.length} camera(s): ${cameras.map((c) => `${c.name} ${c.width}x${c.height}`).join(', ') || 'none'}`);
log(`web UI :${ports.web}, RTSP :${ports.rtsp}, go2rtc :${ports.go2rtcApi}`);
// Resolve once something listens on 127.0.0.1:port (or after timeoutMs, so a broken service can't block the rest).
function portOpen(port, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve) => (function attempt() {
    const sock = connect(port, '127.0.0.1', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => (Date.now() > until ? resolve(false) : setTimeout(attempt, 250)));
  })());
}

for (const s of services) {
  if (s.waitFor) for (const port of s.waitFor) if (!(await portOpen(port))) log(`port ${port} still closed, starting ${s.name} anyway`);
  run(s);
}

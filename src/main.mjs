// Container entrypoint. Reads config.json (+ environment), writes the configs for the bundled
// services, then runs and supervises them:
//   bridge    eufy cloud login, events and on-demand P2P video   (ha-eufy-sdk-bridge)
//   go2rtc    serves the always-on RTSP streams to NVRs
//   switcher  sleeping picture while idle, live video on events (src/switcher)

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { configPath, readConfigFile, resolveSettings } from './gateway/config.mjs';
import { openToTheLan, configWarnings } from './gateway/access.mjs';
import { ensureCertificate } from './gateway/certificate.mjs';
import { onvifNetworkProblem } from './onvif/network.mjs';
import { go2rtcYaml, switcherConfig, bridgeEnv } from './gateway/service-configs.mjs';
import { Supervisor } from './gateway/supervisor.mjs';
import { waitForPort } from './gateway/wait-for-port.mjs';

const DATA = process.env.DATA_DIR || '/data';
const log = (...a) => console.log(new Date().toISOString(), '[start]', ...a);
const die = (message) => {
  log('ERROR:', message);
  process.exit(1);
};

const file = configPath(process.env, DATA);
let settings;
try {
  if (!existsSync(file)) log(`${file} not found: starting without cameras (log in on the web page, then create it and restart).`);
  settings = resolveSettings(readConfigFile(file), process.env);
} catch (e) {
  die(e.message);
}

for (const dir of ['bridge', 'go2rtc', 'switcher']) mkdirSync(`${DATA}/${dir}`, { recursive: true });
writeFileSync(`${DATA}/go2rtc/go2rtc.yaml`, go2rtcYaml(settings));
const generated = switcherConfig(settings, DATA);
writeFileSync(`${DATA}/switcher/config.json`, JSON.stringify(generated, null, 2));

if (generated.web.tls && !settings.web.certFile) {
  try {
    if (ensureCertificate(generated.web.tls)) log(`HTTPS: made a self-signed certificate in ${DATA}/web/ (browsers warn about it once)`);
  } catch (e) {
    die(`HTTPS: can't make a certificate: ${e.message}`);
  }
}
for (const warning of configWarnings(settings)) log('Note:', warning);
const onvifProblem = onvifNetworkProblem(settings.cameras.filter((c) => c.onvif).map((c) => c.onvif.address));
if (onvifProblem) {   // loud: ONVIF silently not working is the most common setup mistake
  const rule = '!'.repeat(72);
  log(rule);
  log(`WARNING: ${onvifProblem}.`);
  log(rule);
}
const open = openToTheLan(settings);
if (open.length) log(`Open to anyone on your LAN: ${open.join('; ')}.`);
else log('Every web page, API, stream and ONVIF camera asks for a login.');

const { ports, cameras, timeZone } = settings;
const services = [
  { name: 'bridge', cmd: 'node', args: ['/opt/bridge/server.mjs'], cwd: `${DATA}/bridge`, env: bridgeEnv(settings, DATA, process.env) },
  { name: 'go2rtc', cmd: '/usr/local/bin/go2rtc', args: ['-config', `${DATA}/go2rtc/go2rtc.yaml`], cwd: `${DATA}/go2rtc` },
  { name: 'switcher', waitFor: [ports.go2rtc, ports.bridge], cmd: 'node',
    args: [new URL('./switcher/main.mjs', import.meta.url).pathname, `${DATA}/switcher/config.json`], cwd: '/app', env: { TZ: timeZone } },
];

const supervisor = new Supervisor({ log });
process.on('SIGTERM', () => supervisor.shutdown());
process.on('SIGINT', () => supervisor.shutdown());

log(`${cameras.length} camera(s): ${cameras.map((c) => `${c.name} ${c.width}x${c.height}`).join(', ') || 'none'}`);
log(`web page ${settings.web.https ? 'https' : 'http'} :${ports.web}, RTSP :${ports.rtsp}`);
for (const service of services) {
  for (const port of service.waitFor ?? []) {
    if (!(await waitForPort(port))) log(`port ${port} still closed, starting ${service.name} anyway`);
  }
  supervisor.run(service);
}

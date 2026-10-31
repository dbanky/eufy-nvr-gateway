// The switcher process: one never-ending stream per camera (sleeping picture ⇄ live video), the
// bridge connection for events, and the web page. Started by src/main.mjs with the generated
// /data/switcher/config.json as its argument.

import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeClient } from './bridge/client.mjs';
import { connectBridgeEvents } from './bridge-events.mjs';
import { createCamera } from './create-camera.mjs';
import { createSnapshots } from './snapshots.mjs';
import { createTimeFormat } from './time-format.mjs';
import { loadInitialPicture } from './initial-picture.mjs';
import { webHandler } from './web/server.mjs';
import { listenWeb } from './web/listen.mjs';
import { createAuth } from './web/auth.mjs';
import { createUpdateCheck } from './updates.mjs';
import { encodeJpeg } from '../video/ffmpeg.mjs';
import { startOnvif } from '../onvif/index.mjs';
import { onvifNetworkProblem } from '../onvif/network.mjs';

const config = JSON.parse(readFileSync(process.argv[2] ?? '/data/switcher/config.json', 'utf8'));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const time = createTimeFormat(config.timeZone ?? process.env.TZ ?? 'UTC');
const tmpDir = mkdtempSync(join(tmpdir(), 'switcher-'));
const bridge = new BridgeClient({ url: config.bridgeWs, log });
const cameras = (config.cameras ?? []).map((settings) => createCamera(settings, { config, bridge, log, time, tmpDir }));
connectBridgeEvents(bridge, cameras, log);

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const rtspPort = config.rtspPort ?? 8554;
const snapshot = createSnapshots(encodeJpeg);
const updates = createUpdateCheck({ current: version, enabled: config.checkForUpdates !== false, log });
updates.start();

// ONVIF devices for cameras with an `onvif` section (NVRs such as UniFi Protect adopt only ONVIF).
const onvifProblem = onvifNetworkProblem(cameras.filter((c) => c.onvif?.address).map((c) => c.onvif.address));   // bridge network
const onvif = startOnvif({ cameras, credentials: config.onvif ?? null, rtspPort, version, snapshot, log });

const webPort = config.webPort ?? 8099;
const web = config.web ?? {};
const auth = createAuth(web.login ?? null, { secure: !!web.tls });
const handler = webHandler({ cameras, bridge, rtspPort, snapshot, auth, onvif, rtsp: config.rtsp, theme: web.theme,
  gateway: () => ({ version, update: updates.status(), onvifProblem }) });
listenWeb(handler, { port: webPort, tls: web.tls ?? null },
  () => log(`web page on ${web.tls ? 'https' : 'http'} :${webPort}${auth ? ', login required' : ', no login'}`));

if (!cameras.length) log('No cameras configured yet: log in on the web page, then add cameras from the device list to config.json.');
for (const camera of cameras) {
  const initial = await loadInitialPicture({ cam: camera, dataDir: config.dataDir, tmpDir, bridgeHttp: config.bridgeHttp });
  Object.assign(camera, { picture: initial.picture, pictureFromEvent: initial.fromEvent, lastLiveAt: initial.takenAt });
  camera.publisher.start();
  camera.refresh();
}
bridge.connect();

setInterval(() => cameras.forEach((c) => c.check()), 1000);
// Labels follow battery, login state and the date ("since yesterday …"); rendered only on change.
setInterval(() => cameras.forEach((c) => c.refresh()), 5000);
// Close live feeds on the way out, so no camera stays awake.
process.on('SIGTERM', () => {
  for (const c of cameras) {
    c.liveFeed?.stop();
    c.closeWhenShown?.stop();
  }
  process.exit(0);
});

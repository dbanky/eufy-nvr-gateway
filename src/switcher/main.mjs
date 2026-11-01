// The switcher process: one never-ending stream per camera (sleeping picture ⇄ live video), the
// bridge connection for events, and the web page. Started by src/main.mjs with the generated
// /data/switcher/config.json as its argument.

import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeClient } from './bridge/client.mjs';
import { connectBridgeEvents } from './bridge-events.mjs';
import { createCamera } from './create-camera.mjs';
import { silentFrame } from '../audio/silence.mjs';
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
import { createRtspFront } from '../rtsp/server.mjs';

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

// The RTSP port NVRs connect to, in front of go2rtc: the login, RTP over UDP, RTSP over HTTP and
// RTCP sender reports (what ONVIF requires and go2rtc lacks).
const udpPortOf = (name) => cameras.find((c) => c.name === name)?.udpPort ?? null;
const rtspFront = createRtspFront({ upstream: { host: '127.0.0.1', port: config.go2rtcPort ?? 28554 }, credentials: config.onvif ?? null, log, udpPortOf });
rtspFront.on('error', (e) => log(`RTSP port ${rtspPort}: ${e.message}`));
rtspFront.listen(rtspPort, () => {
  log(`RTSP streams on :${rtspPort}${config.onvif ? ', login required' : ', no login'} (TCP, UDP, HTTP tunnel)`);
  for (const c of cameras) if (c.udpPort) log(c.name, `RTP over UDP from UDP ports ${c.udpPort}–${c.udpPort + 3}, shared by all viewers`);
});

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
  if (camera.publisher.audio) {
    try {
      camera.publisher.audio.silence = await silentFrame();
    } catch (e) {
      log(camera.name, `audio off: ${e.message}`);
      camera.publisher.audio = null;
      delete camera.deps.openLiveAudio;
    }
  }
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

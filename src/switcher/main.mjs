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
import { createWebServer } from './web/server.mjs';
import { encodeJpeg } from '../video/ffmpeg.mjs';

const config = JSON.parse(readFileSync(process.argv[2] ?? '/data/switcher/config.json', 'utf8'));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const time = createTimeFormat(config.timeZone ?? process.env.TZ ?? 'UTC');
const tmpDir = mkdtempSync(join(tmpdir(), 'switcher-'));
const bridge = new BridgeClient({ url: config.bridgeWs, log });
const cameras = (config.cameras ?? []).map((settings) => createCamera(settings, { config, bridge, log, time, tmpDir }));
connectBridgeEvents(bridge, cameras, log);

const webPort = config.webPort ?? 8099;
createWebServer({ cameras, bridge, rtspPort: config.rtspPort ?? 8554, snapshot: createSnapshots(encodeJpeg) })
  .listen(webPort, () => log(`web page on :${webPort}`));

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

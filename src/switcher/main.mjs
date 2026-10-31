// The switcher process: one never-ending stream per camera (sleeping picture ⇄ live video), the
// bridge connection for events, and the web page. Started by src/main.mjs with the generated
// /data/switcher/config.json as its argument.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Camera } from './camera.mjs';
import { BridgeClient } from './bridge-client.mjs';
import { createTimeFormat } from './time-format.mjs';
import { loadInitialPicture, lastFrameFile } from './initial-picture.mjs';
import { loadCodec, saveCodec } from './codec-memory.mjs';
import { createWebServer } from './web/server.mjs';
import { Feed } from '../video/feed.mjs';
import { Publisher } from '../video/publisher.mjs';
import { LiveEncoder } from '../video/live-encoder.mjs';
import { openLiveDecoder } from '../video/live-decoder.mjs';
import { openPassthrough } from '../video/passthrough.mjs';
import { encodeJpeg } from '../video/ffmpeg.mjs';
import { renderStateLoop } from '../overlay/index.mjs';

const config = JSON.parse(readFileSync(process.argv[2] ?? '/data/switcher/config.json', 'utf8'));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const time = createTimeFormat(config.timeZone ?? process.env.TZ ?? 'UTC');
const tmpDir = mkdtempSync(join(tmpdir(), 'switcher-'));
const bridge = new BridgeClient({ url: config.bridgeWs, log });

const cameras = (config.cameras ?? []).map((settings) => {
  const feed = new Feed({ maxLiveBacklog: (settings.fps ?? 15) * 2 });
  const camera = new Camera(settings, {
    log, time, feed,
    now: Date.now,
    offline: () => bridge.offline(),
    renderLoop: ({ cam, picture, view, codec }) => renderStateLoop({ cam, picture, view, codec, tmpDir }),
    openLiveFeed: ({ cam, onFrame, onCodec, onClose }) =>
      openLiveDecoder({ cam, url: streamUrl(cam), onFrame, onCodec, onClose, log }),
    openPassthrough: ({ cam, codec, onFrame, onPicture, onClose }) =>
      openPassthrough({ cam, url: streamUrl(cam), codec, onFrame, onPicture, onClose, log }),
    createEncoder: ({ cam, getFrame, onFrame }) => new LiveEncoder({ cam, getFrame, onFrame, log }),
    saveLastFrame: (cam, picture) => saveLastFrame(cam, picture)
      .catch((e) => log(cam.name, 'saving last frame failed:', e.message)),
    saveCodec: (cam, codec) => saveCodec(config.dataDir, cam, codec),
  });
  camera.codec = loadCodec(config.dataDir, camera);
  feed.codec = camera.streamCodec();   // the publisher starts in the right format
  camera.publisher = new Publisher({ name: camera.name, fps: camera.fps, output: config.output.replace('{name}', camera.name), feed, log });
  return camera;
});
const bySerial = new Map(cameras.map((c) => [c.serial, c]));

function streamUrl(cam) {
  return `${config.bridgeHttp}/stream/${cam.serial}`;
}

// The last live picture, kept for after a restart: a raw frame (converted) or a JPEG (passed through).
async function saveLastFrame(cam, picture) {
  const file = lastFrameFile(config.dataDir, cam);
  if (picture.jpeg) writeFileSync(file, picture.jpeg);
  else await encodeJpeg(cam, picture.raw, file);
}

// Bridge events -> cameras
bridge.on('device-event', ({ serial, event, message }) => {
  const camera = bySerial.get(serial);
  if (!camera) return;
  if (event === 'batteryLevel') camera.battery = Number(message.to);
  else if (camera.triggers.includes(event)) camera.trigger(event);
  else if (event === 'streamState') log(camera.name, `bridge stream ${message.active ? 'open' : 'closed'}`);
});
bridge.on('devices', (devices) => {
  for (const d of devices) {
    const camera = bySerial.get(d.serial);
    if (!camera) continue;
    camera.model = d.model ?? camera.model;
    if (d.battery != null) camera.battery = d.battery;
  }
  log('devices:', devices.map((d) => `${d.name ?? '?'} [${d.serial}]${bySerial.has(d.serial) ? '' : ' (not configured)'}`).join(', ') || 'none');
});

// Snapshots are cached for 2 s per picture: the web page polls them.
const snapshots = new Map();
function snapshot(camera) {
  if (camera.state === 'LIVE' && camera.liveJpeg) return Promise.resolve(camera.liveJpeg);   // passing through
  const cached = snapshots.get(camera);
  if (cached?.frame === camera.frame && Date.now() - cached.at < 2000) return cached.jpg;
  const jpg = camera.frame ? encodeJpeg(camera, camera.frame) : Promise.reject(new Error('no picture yet'));
  snapshots.set(camera, { frame: camera.frame, at: Date.now(), jpg });
  jpg.catch(() => snapshots.delete(camera));
  return jpg;
}

createWebServer({ cameras, bridge, rtspPort: config.rtspPort ?? 8554, snapshot })
  .listen(config.webPort ?? 8099, () => log(`web page on :${config.webPort ?? 8099}`));

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
  cameras.forEach((c) => {
    c.liveFeed?.stop();
    c.closeWhenShown?.stop();
  });
  process.exit(0);
});

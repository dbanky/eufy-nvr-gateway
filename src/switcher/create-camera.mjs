// Builds one camera with everything it needs: its stream (Feed + Publisher), and the real
// implementations of the side effects that camera.mjs keeps abstract.

import { writeFileSync } from 'node:fs';
import { Camera } from './camera/camera.mjs';
import { lastFrameFile } from './initial-picture.mjs';
import { loadCodec, saveCodec } from './codec-memory.mjs';
import { Feed } from '../video/feed.mjs';
import { Publisher } from '../video/publisher.mjs';
import { LiveEncoder } from '../video/live-encoder.mjs';
import { openLiveDecoder } from '../video/live-decoder.mjs';
import { openPassthrough } from '../video/passthrough.mjs';
import { encodeJpeg } from '../video/ffmpeg.mjs';
import { renderStateLoop } from '../overlay/index.mjs';

export function createCamera(settings, { config, bridge, log, time, tmpDir }) {
  const streamUrl = (cam) => `${config.bridgeHttp}/stream/${cam.serial}`;
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
    saveLastFrame: (cam, picture) => saveLastFrame(cam, picture, config.dataDir)
      .catch((e) => log(cam.name, 'saving last frame failed:', e.message)),
    saveCodec: (cam, codec) => saveCodec(config.dataDir, cam, codec),
  });
  camera.codec = loadCodec(config.dataDir, camera);
  feed.codec = camera.streamCodec();   // the publisher starts in the right format
  camera.publisher = new Publisher({ name: camera.name, fps: camera.fps, output: config.output.replace('{name}', camera.name), feed, log });
  return camera;
}

// The last live picture, kept for after a restart: a raw frame (converted) or a JPEG (passed through).
async function saveLastFrame(cam, picture, dataDir) {
  const file = lastFrameFile(dataDir, cam);
  if (picture.jpeg) writeFileSync(file, picture.jpeg);
  else await encodeJpeg(cam, picture.raw, file);
}

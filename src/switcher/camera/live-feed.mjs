// A camera's live video during a session: its own H.264/H.265 passed through (the default), or
// converted (decoded, then encoded as H.264) with `transcode: true` or while its codec is unknown. Opening the feed wakes the camera; closing
// it lets the camera sleep.

import { shouldReconnect } from '../policy.mjs';

// Pass through only when the stream already runs in the camera's codec: codecs are never mixed.
export function chooseLiveMode(cam) {
  return !cam.transcode && cam.codec && cam.deps.feed.codec === cam.codec ? 'passthrough' : 'transcode';
}

export function openLiveFeed(cam) {
  const onClose = (code) => onFeedClosed(cam, code);
  cam.liveFeed = cam.liveMode === 'passthrough'
    ? cam.deps.openPassthrough({
      cam, codec: cam.codec, onClose,
      onFrame: (frame) => onPassedThroughFrame(cam, frame),
      onPicture: (jpeg) => { cam.liveJpeg = jpeg; },
    })
    : cam.deps.openLiveFeed({
      cam, onClose,
      onFrame: (frame) => onConvertedFrame(cam, frame),
      onCodec: (codec) => cam.learnCodec(codec),
    });
}

// Converting: a decoded raw picture. The first one starts the live encoder.
function onConvertedFrame(cam, frame) {
  cam.frame = frame;
  cam.lastLiveAt = cam.deps.now();
  if (cam.state !== 'WAKING') return;
  cam.goLive();
  cam.deps.feed.armLive();
  cam.encoder.start();
}

// Passing through: one of the camera's own encoded frames. Live starts at its first keyframe.
function onPassedThroughFrame(cam, frame) {
  cam.lastLiveAt = cam.deps.now();
  if (cam.state === 'WAKING') cam.deps.feed.armLive();
  cam.deps.feed.pushLive(frame);
  if (cam.state === 'WAKING' && cam.deps.feed.mode === 'live') cam.goLive();
}

// The session is over: keep its last picture for the sleeping picture, and let the camera sleep.
// A pass-through feed is all that's on air, so it stays until the sleeping loop is ready (a
// converted session keeps its encoder running instead).
export function endLiveFeed(cam) {
  const passedThrough = cam.liveMode === 'passthrough';
  const last = passedThrough ? cam.liveJpeg && { jpeg: cam.liveJpeg } : cam.liveStart && { raw: cam.frame };
  if (cam.liveStart && last) {
    cam.picture = last;
    cam.pictureFromEvent = false;
    cam.deps.saveLastFrame(cam, last);
  }
  if (passedThrough && cam.liveStart) cam.closeWhenShown = cam.liveFeed;
  else cam.liveFeed?.stop();
  cam.liveFeed = null;
}

function onFeedClosed(cam, code) {
  cam.liveFeed = null;
  if (cam.liveMode === 'passthrough' && !cam.liveStart && cam.state === 'WAKING') {
    cam.deps.log(cam.name, `pass-through failed (${code}), converting this session`);
    cam.liveMode = 'transcode';
    return openLiveFeed(cam);
  }
  if (shouldReconnect(cam, cam.deps.now())) {
    cam.reconnects++;
    cam.deps.log(cam.name, `feed closed (${code}) mid-event, reconnect ${cam.reconnects}/${cam.maxReconnects}`);
    setTimeout(() => cam.state !== 'IDLE' && !cam.liveFeed && openLiveFeed(cam), 2000);
    return;
  }
  cam.deps.log(cam.name, `feed closed (${code})`);
  cam.stop('feed closed');
}

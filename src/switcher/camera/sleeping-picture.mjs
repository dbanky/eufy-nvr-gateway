// What a camera's stream shows when it isn't live: the picture for its current state (sleeping,
// waking up, offline, …), rendered once into a loop and put on air.

import { viewKey } from '../labels.mjs';

// Renders and shows the loop for the camera's current state, if that changed. Cheap otherwise, so
// it is called often (every few seconds, and on every state change).
export async function showCurrentState(cam) {
  if (cam.state === 'LIVE') return;
  const view = cam.view(), codec = cam.streamCodec(), key = `${viewKey(view)}|${codec}`;
  if (key === cam.shownKey) return;
  cam.shownKey = key;
  const id = ++cam.renderId;
  try {
    const { still, frames } = await cam.deps.renderLoop({ cam, picture: cam.picture, view, codec });
    if (id !== cam.renderId) return;   // something newer took over while rendering
    cam.frame = still;
    cam.liveJpeg = null;
    cam.deps.feed.showLoop(frames, codec);
  } catch (e) {
    cam.deps.log(cam.name, 'render failed:', e.message);
    if (id === cam.renderId) cam.shownKey = '';   // try again on the next refresh
  }
  if (id === cam.renderId) endPreviousSession(cam);
}

// Live video arrived: a picture still being rendered is no longer wanted.
export function cancelRendering(cam) {
  cam.renderId++;
  cam.shownKey = 'live';
}

// A session that just ended stays on air until its sleeping picture is shown: then its encoder
// (converting) or the camera's feed (passing through) can go.
function endPreviousSession(cam) {
  cam.encoder.stop();
  cam.closeWhenShown?.stop();
  cam.closeWhenShown = null;
}

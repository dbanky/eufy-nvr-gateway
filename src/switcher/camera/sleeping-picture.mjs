// What a camera's stream shows when it isn't live: the picture for its current state (sleeping,
// waking up, offline, …), rendered once into a loop and put on air.
//
// "Waking up" is prepared in advance, while the camera sleeps: rendering it only when a trigger
// arrives is too slow (an H.265 loop on a small NAS takes longer than the camera takes to wake), so
// it would never be seen. The prepared one says "Connecting to the camera"; the one with the reason
// ("Person detected · 18:40") replaces it if there is time.

import { viewKey } from '../labels.mjs';

const PREPARED_WAKING = { kind: 'waking', title: 'Waking up', detail: 'Connecting to the camera' };

// Renders and shows the loop for the camera's current state, if that changed. Cheap otherwise, so
// it is called often (every few seconds, and on every state change).
export async function showCurrentState(cam) {
  if (cam.state === 'LIVE') return;
  const view = cam.view(), codec = cam.streamCodec(), key = `${viewKey(view)}|${codec}`;
  if (key === cam.shownKey) return;
  cam.shownKey = key;
  const id = ++cam.renderId;
  if (view.kind === 'waking') showPreparedWaking(cam, codec);
  try {
    const { still, frames } = await cam.deps.renderLoop({ cam, picture: cam.picture, view, codec });
    if (id !== cam.renderId) return;   // something newer took over while rendering
    show(cam, still, frames, codec);
  } catch (e) {
    cam.deps.log(cam.name, 'render failed:', e.message);
    if (id === cam.renderId) cam.shownKey = '';   // try again on the next refresh
  }
  if (id !== cam.renderId) return;
  endPreviousSession(cam);
  if (view.kind !== 'waking') prepareWaking(cam, codec);
}

// Live video arrived: a picture still being rendered is no longer wanted.
export function cancelRendering(cam) {
  cam.renderId++;
  cam.shownKey = 'live';
}

function show(cam, still, frames, codec) {
  cam.frame = still;
  cam.liveJpeg = null;
  cam.deps.feed.showLoop(frames, codec);
}

// The prepared "Waking up" fits only the picture and codec it was rendered for.
const fits = (prepared, cam, codec) => prepared && prepared.picture === cam.picture && prepared.codec === codec;

function showPreparedWaking(cam, codec) {
  if (fits(cam.preparedWaking, cam, codec)) show(cam, cam.preparedWaking.still, cam.preparedWaking.frames, codec);
}

// Renders "Waking up" for the current sleeping picture in the background, once per picture.
async function prepareWaking(cam, codec) {
  if (fits(cam.preparedWaking, cam, codec) || fits(cam.preparingWaking, cam, codec)) return;
  const job = { picture: cam.picture, codec };
  cam.preparingWaking = job;
  try {
    const { still, frames } = await cam.deps.renderLoop({ cam, picture: job.picture, view: PREPARED_WAKING, codec });
    cam.preparedWaking = { ...job, still, frames };
  } catch (e) {
    cam.deps.log(cam.name, 'preparing "Waking up" failed:', e.message);
  } finally {
    if (cam.preparingWaking === job) cam.preparingWaking = null;
  }
}

// A session that just ended stays on air until its sleeping picture is shown: then its encoder
// (converting) or the camera's feed (passing through) can go.
function endPreviousSession(cam) {
  cam.encoder.stop();
  cam.closeWhenShown?.stop();
  cam.closeWhenShown = null;
}

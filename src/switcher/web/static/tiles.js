// The camera tiles on the page: built once per camera list and then patched in place, so pictures
// don't flicker and an opened "Stream details" stays open; pictures refreshed by state; the tiles'
// buttons (wake, stop, copy).
//
// Pictures are downloaded in the background and swapped in only once complete, so a tile never shows
// a broken image: until the first one arrives it keeps its placeholder, and a failed or slow refresh
// keeps the last picture. One download feeds both the picture and its blurred backdrop.

import { tileHtml, tileStatusHtml, tileDetailsHtml, snapshotUrl } from './camera-tile.js';

const $ = (id) => document.getElementById(id);
const where = (status) => ({ host: location.hostname, rtspPort: status.rtspPort, rtsp: status.rtsp });

let builtFor = '';
let cameras = [];

export function showCameras(status) {
  cameras = status.cameras;
  $('noCams').hidden = status.cameras.length > 0;
  const names = status.cameras.map((c) => c.name).join();
  if (names !== builtFor) {
    builtFor = names;
    $('cams').innerHTML = status.cameras.map((c) => tileHtml(c, where(status))).join('');
    for (const c of status.cameras) loadPicture(c);
  }
  for (const c of status.cameras) {
    const tile = $('cam-' + c.name);
    tile.dataset.kind = c.display.kind;
    tile.querySelector('[data-part="status"]').innerHTML = tileStatusHtml(c);
    const details = tile.querySelector('[data-part="details"]');
    if (!details.contains(document.activeElement)) details.innerHTML = tileDetailsHtml(c, where(status));
  }
}

const loading = new Set();   // camera names with a download under way
const shownUrls = new Map(); // camera name -> object URL on screen

async function loadPicture(camera) {
  if (loading.has(camera.name)) return;
  loading.add(camera.name);
  try {
    const res = await fetch(snapshotUrl(camera));
    if (!res.ok) return;   // not ready yet: tried again on the next tick
    const url = URL.createObjectURL(await res.blob());
    const tile = $('cam-' + camera.name);
    if (!tile) return URL.revokeObjectURL(url);
    const [backdrop, picture] = tile.querySelectorAll('.tile-media img');
    const shown = await new Promise((resolve) => {
      picture.onload = () => resolve(true);
      picture.onerror = () => resolve(false);
      picture.src = backdrop.src = url;
    });
    if (!shown) return URL.revokeObjectURL(url);
    tile.dataset.picture = 'shown';
    const old = shownUrls.get(camera.name);
    shownUrls.set(camera.name, url);
    if (old) URL.revokeObjectURL(old);
  } catch {
    // offline for a moment: keep what is shown
  } finally {
    loading.delete(camera.name);
  }
}

// Live pictures change every keyframe, sleeping ones rarely: every 2 s and every 10 s. A tile still
// waiting for its first picture asks every 2 s.
let tick = 0;
function refreshSnapshots() {
  tick++;
  for (const c of cameras) {
    const live = c.state === 'LIVE' || c.state === 'WAKING';
    const waiting = $('cam-' + c.name)?.dataset.picture !== 'shown';
    if (live || waiting || tick % 5 === 0) loadPicture(c);
  }
}

// onAction: called after wake or stop, to refresh the page.
export function bindTiles(onAction) {
  $('cams').addEventListener('click', async (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.dataset.copy) return copy(button);
    const name = button.closest('.tile').id.slice('cam-'.length);
    button.disabled = true;
    await fetch('api/cameras/' + encodeURIComponent(name) + '/' + button.dataset.act, { method: 'POST' });
    onAction();
  });
  setInterval(refreshSnapshots, 2000);
}

// Over plain http on the LAN the clipboard API is often unavailable: select and copy instead.
async function copy(button) {
  const input = button.parentElement.querySelector('input');
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  button.classList.add('done');
  setTimeout(() => button.classList.remove('done'), 1500);
}

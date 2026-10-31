// The camera tiles on the page: built once per camera list and then patched in place, so pictures
// don't flicker and an opened "Stream details" stays open; pictures refreshed by state; the tiles'
// buttons (wake, stop, copy).

import { tileHtml, tileStatusHtml, tileDetailsHtml } from './camera-tile.js';

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
  }
  for (const c of status.cameras) {
    const tile = $('cam-' + c.name);
    tile.dataset.kind = c.display.kind;
    tile.querySelector('[data-part="status"]').innerHTML = tileStatusHtml(c);
    const details = tile.querySelector('[data-part="details"]');
    if (!details.contains(document.activeElement)) details.innerHTML = tileDetailsHtml(c, where(status));
  }
}

// Live pictures change every keyframe, sleeping ones rarely: every 2 s and every 10 s.
let tick = 0;
function refreshSnapshots() {
  tick++;
  for (const c of cameras) {
    const live = c.state === 'LIVE' || c.state === 'WAKING';
    if (!live && tick % 5) continue;
    const t = 't=' + Date.now();
    for (const img of $('cam-' + c.name)?.querySelectorAll('img') ?? []) img.src = img.src.replace(/t=\d+/, t);
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

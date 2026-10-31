// The gateway's web page: polls /api/status every 3 s and keeps the page in step with it. Tiles are
// built once per camera list and then patched in place, so pictures don't flicker and an opened
// "Stream details" stays open. Plain JavaScript modules, no build step.

import { tileHtml, tileStatusHtml, tileDetailsHtml } from './camera-tile.js';
import { connectionHtml } from './connection.js';
import { devicesSummary, devicesRowsHtml } from './devices.js';
import { showLogin, bindLogin } from './login.js';
import { showGateway } from './update.js';
import { bindThemeToggle } from './theme-toggle.js';
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);
// A 401 means the session ended (or the login changed): back to the sign-in page.
const getJson = async (url, options) => {
  const res = await fetch(url, options);
  if (res.status === 401) {
    location.replace('signin.html');
    throw new Error('signed out');
  }
  return res.json();
};
const where = (status) => ({ host: location.hostname, rtspPort: status.rtspPort, rtsp: status.rtsp });

let builtFor = '';
let cameras = [];

async function refresh() {
  let status;
  try {
    status = await getJson('api/status');
  } catch {
    $('connection').innerHTML = connectionHtml({ connected: false });
    return;
  }
  cameras = status.cameras;
  $('connection').innerHTML = connectionHtml(status.bridge);
  showLogin(status.bridge);
  showGateway(status.gateway ?? {});
  $('signout').hidden = !status.gateway?.login;
  showCameras(status);
  if (status.bridge.connected && status.bridge.login === 'ok') showDevices(await getJson('api/devices'), status);
}

function showCameras(status) {
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

function showDevices(devices, status) {
  $('devicesSummary').textContent = devicesSummary(devices);
  $('devices').innerHTML = devicesRowsHtml(devices);
  if (!status.cameras.length && !$('devicesPanel').dataset.touched) $('devicesPanel').open = true;   // first setup
}

// Live pictures change every keyframe, sleeping ones rarely: refresh them accordingly.
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

// One handler for every tile button: wake, stop, copy.
$('cams').addEventListener('click', async (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  if (button.dataset.copy) return copy(button);
  const name = button.closest('.tile').id.slice('cam-'.length);
  button.disabled = true;
  await fetch('api/cameras/' + encodeURIComponent(name) + '/' + button.dataset.act, { method: 'POST' });
  refresh();
});

// The page is served over plain http on the LAN, where the clipboard API is often unavailable.
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

$('devicesPanel').addEventListener('toggle', () => { $('devicesPanel').dataset.touched = '1'; });

$('signout').innerHTML = icon('signout');
$('signout').addEventListener('click', async () => {
  await fetch('api/signout', { method: 'POST' });
  location.replace('signin.html');
});
$('brandMark').innerHTML = icon('asleep');
bindThemeToggle($('theme'));
bindLogin(refresh);
refresh();
setInterval(refresh, 3000);
setInterval(refreshSnapshots, 2000);

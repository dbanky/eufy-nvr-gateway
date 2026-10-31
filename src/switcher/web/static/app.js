// The gateway's web page: polls /api/status every 3 s and keeps the page in step with it. Tiles are
// built once per camera list and then patched in place, so pictures don't flicker and an opened
// "Stream details" stays open. Plain JavaScript modules, no build step.

import { tileHtml, tileStatusHtml, tileDetailsHtml } from './camera-tile.js';
import { connectionHtml } from './connection.js';
import { devicesSummary, devicesRowsHtml } from './devices.js';

const $ = (id) => document.getElementById(id);
const getJson = async (url, options) => (await fetch(url, options)).json();
const where = (status) => ({ host: location.hostname, rtspPort: status.rtspPort });

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

function showLogin(bridge) {
  const needsInput = bridge.login === 'require_2fa' || bridge.login === 'require_captcha';
  $('login').hidden = !needsInput;
  if (!needsInput) return;
  const captcha = bridge.login === 'require_captcha';
  $('loginText').textContent = captcha ? 'Type the characters shown in the picture.'
    : 'eufy sent a verification code (usually by e-mail' + (bridge.method ? ': ' + bridge.method : '') + '). Enter it here.';
  $('captcha').hidden = !bridge.captcha;
  if (bridge.captcha) $('captcha').src = bridge.captcha;
  $('code').dataset.kind = captcha ? 'captcha' : 'code';
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
    const img = $('cam-' + c.name)?.querySelector('img');
    if (img) img.src = img.src.replace(/t=\d+/, 't=' + Date.now());
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

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = { [$('code').dataset.kind || 'code']: $('code').value.trim() };
  $('loginMsg').textContent = 'Checking…';
  const answer = await getJson('api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  $('loginMsg').textContent = answer.ok ? 'Accepted.' : (answer.error || 'Not accepted, try again.');
  $('code').value = '';
  refresh();
};
$('retrigger').onclick = async () => {
  $('loginMsg').textContent = 'Requesting a new code…';
  const answer = await getJson('api/login/retrigger', { method: 'POST' });
  $('loginMsg').textContent = answer.ok ? 'Requested.' : (answer.error || 'Failed.');
  refresh();
};

refresh();
setInterval(refresh, 3000);
setInterval(refreshSnapshots, 2000);

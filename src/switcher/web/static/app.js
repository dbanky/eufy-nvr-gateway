// The gateway's web page: eufy login (2FA / captcha), camera states, stream URLs and the devices
// on the account. Polls /api/status every 3 s. Plain JavaScript modules, no build step.

import { $, showBridge, showCameras, showDevices } from './views.js';

const getJson = async (url, options) => (await fetch(url, options)).json();
const cameraAction = (name, action) =>
  fetch('api/cameras/' + encodeURIComponent(name) + '/' + action, { method: 'POST' }).then(refresh);

async function refresh() {
  let status;
  try {
    status = await getJson('api/status');
  } catch {
    $('bridge').textContent = 'Gateway not reachable.';
    return;
  }
  const loggedIn = showBridge(status.bridge);
  showCameras(status.cameras, status.rtspPort, cameraAction);
  if (loggedIn) showDevices(await getJson('api/devices'));
}

function refreshSnapshots() {
  for (const img of document.querySelectorAll('.cam img')) img.src = img.src.replace(/t=\d+/, 't=' + Date.now());
}

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
setInterval(refreshSnapshots, 10000);

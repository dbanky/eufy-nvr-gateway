// The gateway's web page: polls /api/status every 3 s and keeps the page in step with it.
// Plain JavaScript modules, no build step. The tiles: tiles.js; the eufy login card: login.js;
// version and updates: update.js.

import { connectionHtml } from './connection.js';
import { devicesSummary, devicesRowsHtml } from './devices.js';
import { showLogin, bindLogin } from './login.js';
import { showGateway } from './update.js';
import { showCameras, bindTiles } from './tiles.js';
import { bindThemeToggle } from './theme-toggle.js';
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);
const signInPage = () => location.replace('signin.html');

// A 401 means the session ended (or the login changed): back to the sign-in page.
async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 401) {
    signInPage();
    throw new Error('signed out');
  }
  return res.json();
}

async function refresh() {
  let status;
  try {
    status = await getJson('api/status');
  } catch {
    $('connection').innerHTML = connectionHtml({ connected: false });
    return;
  }
  $('connection').innerHTML = connectionHtml(status.bridge);
  showLogin(status.bridge);
  showGateway(status.gateway ?? {});
  $('signout').hidden = !status.gateway?.login;
  showCameras(status);
  if (status.bridge.connected && status.bridge.login === 'ok') showDevices(await getJson('api/devices').catch(() => []), status);
}

function showDevices(devices, status) {
  $('devicesSummary').textContent = devicesSummary(devices);
  $('devices').innerHTML = devicesRowsHtml(devices);
  if (!status.cameras.length && !$('devicesPanel').dataset.touched) $('devicesPanel').open = true;   // first setup
}

$('devicesPanel').addEventListener('toggle', () => { $('devicesPanel').dataset.touched = '1'; });
$('signout').innerHTML = icon('signout');
$('signout').addEventListener('click', async () => {
  await fetch('api/signout', { method: 'POST' });
  signInPage();
});
$('brandMark').innerHTML = icon('asleep');
bindThemeToggle($('theme'));
bindLogin(refresh);
bindTiles(refresh);
refresh();
setInterval(refresh, 3000);

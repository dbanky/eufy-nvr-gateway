// Draws the page from /api/status and /api/devices: login state, camera cards, device table.

import { icon } from './icons.js';

export const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Returns true once logged in to eufy.
export function showBridge(bridge) {
  const ok = bridge.connected && bridge.login === 'ok';
  $('bridge').innerHTML = bridge.connected
    ? 'eufy login: <span class="' + (ok ? 'ok' : 'bad') + '">' + esc(bridge.login) + '</span>'
    : '<span class="bad">eufy bridge starting…</span>';

  const needsInput = bridge.login === 'require_2fa' || bridge.login === 'require_captcha';
  $('login').hidden = !needsInput;
  if (!needsInput) return ok;
  const captcha = bridge.login === 'require_captcha';
  $('loginText').textContent = captcha ? 'Type the characters shown in the picture.'
    : 'eufy sent a verification code (usually by e-mail' + (bridge.method ? ': ' + bridge.method : '') + '). Enter it here.';
  $('captcha').hidden = !bridge.captcha;
  if (bridge.captcha) $('captcha').src = bridge.captcha;
  $('code').dataset.kind = captcha ? 'captcha' : 'code';
  return ok;
}

// Camera cards are built once per camera list; their state is updated on every call.
// onAction(name, 'live' | 'idle') runs the card's buttons.
let cardsFor = '';
export function showCameras(cameras, rtspPort, onAction) {
  $('noCams').hidden = cameras.length > 0;
  const names = cameras.map((c) => c.name).join();
  if (names !== cardsFor) {
    cardsFor = names;
    $('cams').innerHTML = cameras.map((c) => cameraCard(c, rtspPort)).join('');
    for (const c of cameras) {
      for (const button of $('cam-' + c.name).querySelectorAll('button')) button.onclick = () => onAction(c.name, button.dataset.act);
    }
  }
  for (const c of cameras) {
    const card = $('cam-' + c.name);
    const badge = card.querySelector('.badge');
    badge.innerHTML = icon(c.display.kind) + esc(c.display.title);
    badge.className = 'badge ' + c.display.kind;
    card.querySelector('.info').textContent = [c.display.detail, c.resolution, c.battery != null ? c.battery + '% battery' : null]
      .filter(Boolean).join(' · ');
  }
}

function cameraCard(c, rtspPort) {
  return '<div class="card cam" id="cam-' + esc(c.name) + '">'
    + '<img alt="' + esc(c.name) + '" src="api/cameras/' + encodeURIComponent(c.name) + '/snapshot.jpg?t=' + Date.now() + '">'
    + '<div class="row"><strong>' + esc(c.name) + '</strong><span class="badge"></span><span class="muted info"></span></div>'
    + '<div class="row"><code>rtsp://' + esc(location.hostname) + ':' + rtspPort + '/' + esc(c.name) + '</code></div>'
    + '<div class="row"><button data-act="live">Go live</button><button data-act="idle">Stop</button></div></div>';
}

export function showDevices(devices) {
  $('devices').innerHTML = devices.length
    ? devices.map((d) => '<tr><td>' + esc(d.name) + '</td><td><code>' + esc(d.serial) + '</code></td><td>'
      + esc([d.model, d.modelName].filter(Boolean).join(' ')) + '</td><td>' + (d.battery != null ? d.battery + '%' : '')
      + '</td><td>' + (d.configured ? '✓' : '') + '</td></tr>').join('')
    : '<tr><td colspan="5" class="muted">No devices found.</td></tr>';
}

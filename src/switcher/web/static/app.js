// The gateway's web page: eufy login (2FA / captcha), camera states, stream URLs and the devices
// on the account. Polls /api/status every 3 s. Plain JavaScript, no build step.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const getJson = async (url, options) => (await fetch(url, options)).json();

// The same state icons as the stream overlay (24x24 stroke paths).
const ICONS = {
  asleep: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  waking: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
  live: '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
  lowbattery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2"/><path d="M5.5 10v4"/>',
  nowake: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4.5"/><path d="M12 17.2h.01"/>',
  offline: '<path d="M3 3l18 18"/><path d="M8.5 6.6A6 6 0 0 1 17.6 10a4.2 4.2 0 0 1 3 5.6"/><path d="M17 18H7a4.5 4.5 0 0 1-1.6-8.7"/>',
  nopicture: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/><path d="M3 3l18 18"/>',
};
const icon = (kind) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'
  + ' stroke-linejoin="round" aria-hidden="true">' + (ICONS[kind] || '') + '</svg>';

function showBridge(bridge) {
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

// Camera cards are built once per camera list; their state is updated on every poll.
let cardsFor = '';
function showCameras(cameras, rtspPort) {
  $('noCams').hidden = cameras.length > 0;
  const names = cameras.map((c) => c.name).join();
  if (names !== cardsFor) {
    cardsFor = names;
    $('cams').innerHTML = cameras.map((c) => cameraCard(c, rtspPort)).join('');
    for (const c of cameras) {
      for (const button of $('cam-' + c.name).querySelectorAll('button')) {
        button.onclick = () => fetch('api/cameras/' + encodeURIComponent(c.name) + '/' + button.dataset.act, { method: 'POST' }).then(refresh);
      }
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

function showDevices(devices) {
  $('devices').innerHTML = devices.length
    ? devices.map((d) => '<tr><td>' + esc(d.name) + '</td><td><code>' + esc(d.serial) + '</code></td><td>'
      + esc([d.model, d.modelName].filter(Boolean).join(' ')) + '</td><td>' + (d.battery != null ? d.battery + '%' : '')
      + '</td><td>' + (d.configured ? '✓' : '') + '</td></tr>').join('')
    : '<tr><td colspan="5" class="muted">No devices found.</td></tr>';
}

async function refresh() {
  let status;
  try {
    status = await getJson('api/status');
  } catch {
    $('bridge').textContent = 'Gateway not reachable.';
    return;
  }
  const loggedIn = showBridge(status.bridge);
  showCameras(status.cameras, status.rtspPort);
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

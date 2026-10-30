// The gateway's single web page: eufy login (2FA / captcha), camera status, stream URLs and
// the account's device list (to copy serials into config.json). Plain HTML + fetch, no build step.

export function renderPage({ rtspPort }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>eufy NVR gateway</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1c1f24; --muted:#667085; --line:#e3e6ea; --accent:#2563eb;
          --ok:#16794a; --warn:#b54708; --live:#c01048; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111317; --card:#1a1d23; --text:#e8eaed; --muted:#9aa3af;
          --line:#2b2f37; --accent:#6ea0ff; --ok:#4ade80; --warn:#fbbf24; --live:#fb7185; } }
  * { box-sizing:border-box } body { margin:0; font:15px/1.45 system-ui,sans-serif; background:var(--bg); color:var(--text) }
  main { max-width:1100px; margin:0 auto; padding:20px 16px 48px }
  h1 { font-size:20px; margin:0 0 4px } h2 { font-size:16px; margin:28px 0 10px } .muted { color:var(--muted) }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px }
  .grid { display:grid; gap:14px; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)) }
  .cam img { width:100%; aspect-ratio:16/9; object-fit:contain; background:#000; border-radius:6px; display:block }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px }
  .badge { font-size:12px; font-weight:600; padding:2px 8px; border-radius:99px; border:1px solid currentColor }
  .IDLE { color:var(--muted) } .WAKING { color:var(--warn) } .LIVE { color:var(--live) } .ok { color:var(--ok) } .bad { color:var(--warn) }
  code { font:13px ui-monospace,monospace; background:var(--bg); padding:2px 6px; border-radius:4px; word-break:break-all }
  button, input { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--text) }
  button { cursor:pointer } button.primary { background:var(--accent); border-color:var(--accent); color:#fff }
  table { width:100%; border-collapse:collapse } td, th { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line) }
  .scroll { overflow-x:auto } [hidden] { display:none !important }
</style></head>
<body><main>
  <h1>eufy NVR gateway</h1>
  <div class="muted" id="bridge">Connecting…</div>

  <section id="login" class="card" style="margin-top:16px" hidden>
    <strong>eufy login needs your attention</strong>
    <p class="muted" id="loginText"></p>
    <img id="captcha" alt="captcha" hidden style="max-width:240px;background:#fff;border-radius:6px">
    <form id="loginForm" class="row">
      <input id="code" autocomplete="one-time-code" placeholder="code" required>
      <button class="primary">Submit</button>
      <button type="button" id="retrigger">Send a new code</button>
    </form>
    <p id="loginMsg" class="muted"></p>
  </section>

  <h2>Cameras</h2>
  <div id="cams" class="grid"></div>
  <p id="noCams" class="muted" hidden>No cameras configured yet. Add them to <code>config.json</code> from the device list below, then restart the container.</p>

  <h2>Devices on the eufy account</h2>
  <div class="card scroll"><table><thead><tr><th>Name</th><th>Serial</th><th>Model</th><th>Battery</th><th>Configured</th></tr></thead>
  <tbody id="devices"><tr><td colspan="5" class="muted">Available after login.</td></tr></tbody></table></div>
</main>
<script>
const rtspPort = ${JSON.stringify(rtspPort)};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
let shown = '';

async function refresh() {
  let s; try { s = await (await fetch('api/status')).json(); } catch { $('bridge').textContent = 'Gateway not reachable.'; return; }
  const b = s.bridge, ok = b.connected && b.login === 'ok';
  $('bridge').innerHTML = b.connected ? 'eufy login: <span class="' + (ok ? 'ok' : 'bad') + '">' + esc(b.login) + '</span>' : '<span class="bad">eufy bridge starting…</span>';

  const needs = b.login === 'require_2fa' || b.login === 'require_captcha';
  $('login').hidden = !needs;
  if (needs) {
    $('loginText').textContent = b.login === 'require_captcha' ? 'Type the characters shown in the picture.'
      : 'eufy sent a verification code (usually by e-mail' + (b.method ? ': ' + b.method : '') + '). Enter it here.';
    $('captcha').hidden = !b.captcha; if (b.captcha) $('captcha').src = b.captcha;
    $('code').dataset.kind = b.login === 'require_captcha' ? 'captcha' : 'code';
  }

  $('noCams').hidden = s.cameras.length > 0;
  const key = s.cameras.map((c) => c.name).join();
  if (key !== shown) {
    shown = key;
    $('cams').innerHTML = s.cameras.map((c) => '<div class="card cam" id="cam-' + esc(c.name) + '">' +
      '<img alt="' + esc(c.name) + '" src="api/cameras/' + encodeURIComponent(c.name) + '/snapshot.jpg?t=' + Date.now() + '">' +
      '<div class="row"><strong>' + esc(c.name) + '</strong><span class="badge"></span><span class="muted info"></span></div>' +
      '<div class="row"><code>rtsp://' + esc(location.hostname) + ':' + rtspPort + '/' + esc(c.name) + '</code></div>' +
      '<div class="row"><button data-act="live">Go live</button><button data-act="idle">Stop</button></div></div>').join('');
    for (const c of s.cameras) for (const btn of $('cam-' + c.name).querySelectorAll('button'))
      btn.onclick = () => fetch('api/cameras/' + encodeURIComponent(c.name) + '/' + btn.dataset.act, { method: 'POST' }).then(refresh);
  }
  for (const c of s.cameras) {
    const el = $('cam-' + c.name); if (!el) continue;
    const badge = el.querySelector('.badge'); badge.textContent = c.state; badge.className = 'badge ' + c.state;
    el.querySelector('.info').textContent = [c.resolution, c.battery != null ? c.battery + '% battery' : null,
      c.liveUntil ? 'live until ' + c.liveUntil : c.lastSeen ? 'last seen ' + c.lastSeen : null].filter(Boolean).join(' · ');
  }

  if (ok) {
    const d = await (await fetch('api/devices')).json();
    $('devices').innerHTML = d.length ? d.map((x) => '<tr><td>' + esc(x.name) + '</td><td><code>' + esc(x.serial) + '</code></td><td>' +
      esc([x.model, x.modelName].filter(Boolean).join(' ')) + '</td><td>' + (x.battery != null ? x.battery + '%' : '') + '</td><td>' +
      (x.configured ? '✓' : '') + '</td></tr>').join('') : '<tr><td colspan="5" class="muted">No devices found.</td></tr>';
  }
}

function refreshImages() {
  for (const img of document.querySelectorAll('.cam img')) img.src = img.src.replace(/t=\\d+/, 't=' + Date.now());
}

$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = { [$('code').dataset.kind || 'code']: $('code').value.trim() };
  $('loginMsg').textContent = 'Checking…';
  const r = await (await fetch('api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  $('loginMsg').textContent = r.ok ? 'Accepted.' : (r.error || 'Not accepted, try again.');
  $('code').value = ''; refresh();
};
$('retrigger').onclick = async () => {
  $('loginMsg').textContent = 'Requesting a new code…';
  const r = await (await fetch('api/login/retrigger', { method: 'POST' })).json();
  $('loginMsg').textContent = r.ok ? 'Requested.' : (r.error || 'Failed.'); refresh();
};

refresh(); setInterval(refresh, 3000); setInterval(refreshImages, 10000);
</script></body></html>`;
}

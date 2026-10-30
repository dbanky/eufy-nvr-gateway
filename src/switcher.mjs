// Switcher: one never-ending H.264 stream per camera, for NVRs that hold streams open 24/7.
// Idle  -> the frozen last frame (blurred, "LAST SEEN" label), camera asleep.
// Event -> wake the camera via the bridge's /stream/<serial>, show live video,
//          then freeze the last frame again after the hold time.
// No dependencies: Node 22+ (global WebSocket/fetch) and ffmpeg.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPage } from './web.mjs';

const cfg = JSON.parse(readFileSync(process.argv[2] ?? '/data/switcher/config.json', 'utf8'));
const D = {
  bridgeWs: 'ws://127.0.0.1:3000/ws',
  bridgeHttp: 'http://127.0.0.1:3000',
  output: 'rtsp://127.0.0.1:8554/{name}',
  webPort: 8099,
  dataDir: '/data/switcher',
  ffmpeg: 'ffmpeg',
  fontFile: '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  timeZone: process.env.TZ || 'UTC',
  ...cfg,
};
const CAM_DEFAULTS = {
  width: 1920, height: 1080, fps: 15, bitrateKbps: 4000,   // set to the camera's native size: no downscaling
  triggers: ['motion', 'personDetected', 'vehicleDetected', 'petDetection', 'strangerDetected', 'doorbellPress'],
  holdMs: 120000,            // keep live this long after the last trigger
  ringHoldMs: 120000,        // ...and this long after a doorbell press
  maxLiveMs: 120000,         // hard cap per session, counted from the first live frame
  firstFrameTimeoutMs: 60000,// give up if the camera hasn't sent a frame by then
  restartGapMs: 15000,       // min pause between sessions (doorbell press ignores it)
  maxReconnects: 2,          // re-open if the bridge cuts the feed mid-event
  minBatteryPct: 15,         // below this only doorbell press / manual go live
  idleBlur: 10,              // blur of the frozen picture, in pixels at 1080p (0 = sharp)
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZone: D.timeZone, hour12: false });
const tmp = mkdtempSync(join(tmpdir(), 'switcher-'));

// Run ffmpeg once and collect stdout (for still-image work).
function ffOnce(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(D.ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args]);
    const out = []; let err = '';
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${err.trim()}`))));
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? null);
  });
}

class Camera {
  constructor(c) {
    Object.assign(this, CAM_DEFAULTS, c);
    this.serial = c.serial ?? c.sn;
    this.frameSize = this.width * this.height * 3 / 2;          // yuv420p
    this.rawIn = ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${this.width}x${this.height}`];
    this.fit = `scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease,` +
      `pad=${this.width}:${this.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
    this.frame = Buffer.alloc(this.frameSize, 0); this.frame.fill(128, this.width * this.height); // black
    this.lastLive = null; this.lastLiveAt = 0;
    this.state = 'IDLE';           // IDLE | WAKING | LIVE
    this.deadline = 0; this.sessionStart = 0; this.liveStart = 0; this.lastStop = 0;
    this.reconnects = 0; this.decoder = null; this.pending = [];
    this.battery = null;
    this.jpg = join(D.dataDir, `last-${this.name}.jpg`);
  }

  // ---------- idle picture ----------
  async still(source, label) {
    const args = source.raw ? [...this.rawIn, '-i', 'pipe:0'] : ['-i', source.file];
    let vf = this.fit;
    if (this.idleBlur > 0) vf += `,gblur=sigma=${(this.idleBlur * this.height / 1080).toFixed(1)}`;   // label stays sharp
    if (label && existsSync(D.fontFile)) {
      const tf = join(tmp, `${this.name}-label.txt`);
      writeFileSync(tf, label);
      vf += `,drawtext=fontfile=${D.fontFile}:textfile=${tf}:fontsize=${Math.round(this.height / 24)}` +
        ':fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8:x=16:y=h-th-24';
    }
    const buf = await ffOnce([...args, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'], source.raw);
    if (buf.length < this.frameSize) throw new Error('short frame from ffmpeg');
    return buf.subarray(0, this.frameSize);
  }

  // Show a still only if nothing better (live video) has taken over meanwhile.
  async show(source, label, whileState) {
    const f = await this.still(source, label);
    if (this.state === whileState) this.frame = f;
  }

  async initStill() {
    try {
      if (existsSync(this.jpg)) return await this.show({ file: this.jpg }, 'LAST SEEN (before restart)', 'IDLE');
      const r = await fetch(`${D.bridgeHttp}/snapshot/${this.serial}?mode=stored`);   // stored: never wakes the camera
      if (r.ok) {
        const f = join(tmp, `${this.name}-snap.jpg`);
        writeFileSync(f, Buffer.from(await r.arrayBuffer()));
        await this.show({ file: f }, 'LAST EVENT IMAGE', 'IDLE');
      }
    } catch (e) { log(this.name, 'initial still failed:', e.message); }
  }

  async freeze() {
    if (!this.lastLive) return;
    try {
      await this.show({ raw: this.lastLive }, `LAST SEEN ${clock(this.lastLiveAt)}`, 'IDLE');
      await ffOnce([...this.rawIn, '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', '-y', this.jpg], this.lastLive);
    } catch (e) { log(this.name, 'freeze failed:', e.message); }
  }

  // ---------- encoder: never stops ----------
  startEncoder() {
    const out = D.output.replace('{name}', this.name);
    const fmt = out.startsWith('rtsp://') ? ['-f', 'rtsp', '-rtsp_transport', 'tcp'] : ['-f', 'mpegts'];
    // Frames carry wall-clock timestamps and ffmpeg repeats the last one to a constant
    // frame rate, so we only write a frame when the picture changes (plus a heartbeat).
    const p = spawn(D.ffmpeg, ['-hide_banner', '-loglevel', 'error',
      '-use_wallclock_as_timestamps', '1', ...this.rawIn, '-i', 'pipe:0',
      '-fps_mode', 'cfr', '-r', String(this.fps),
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      // Keyframe every 4 s. qpmin stops x264 from endlessly "refining" a frozen
      // picture (static idle frame: ~1.6 Mbit/s without it, ~0.2-0.5 Mbit/s with it).
      '-bf', '0', '-g', String(this.fps * 4), '-keyint_min', String(this.fps * 4), '-sc_threshold', '0',
      '-crf', '20', '-x264-params', 'qpmin=19',   // SSIM ~0.997 vs. the camera's own stream
      '-maxrate', `${this.bitrateKbps}k`, '-bufsize', `${this.bitrateKbps * 2}k`,
      ...fmt, out]);
    p.stderr.on('data', (c) => log(this.name, 'encoder:', String(c).trim()));
    p.stdin.on('error', () => {});
    p.on('error', (e) => log(this.name, 'encoder error:', e.message));
    p.on('close', (code) => {
      log(this.name, `encoder exited (${code}), restarting in 2 s`);
      clearInterval(this.tick);
      setTimeout(() => this.startEncoder(), 2000);
    });
    // Write on change; while frozen, one frame per second is enough (raw 3K frames are 7 MB each).
    let written = null, lastWrite = 0, blocked = false;
    p.stdin.on('drain', () => { blocked = false; });
    this.tick = setInterval(() => {
      const now = Date.now();
      if (blocked || (this.frame === written && now - lastWrite < 1000)) return;
      blocked = !p.stdin.write(this.frame);
      written = this.frame; lastWrite = now;
    }, Math.round(1000 / this.fps / 2));
    log(this.name, `encoder → ${out} (${this.width}x${this.height} @ ${this.fps} fps)`);
  }

  // ---------- triggers ----------
  trigger(kind) {
    const now = Date.now();
    const vip = kind === 'doorbellPress' || kind === 'manual';
    const hold = kind === 'doorbellPress' ? this.ringHoldMs : this.holdMs;

    if (this.state !== 'IDLE') {                               // already awake: just extend
      this.deadline = Math.max(this.deadline, now + hold);
      return log(this.name, `${kind}: extended until ${clock(this.deadline)}`);
    }
    if (!vip) {
      if (this.battery != null && this.battery < this.minBatteryPct) return log(this.name, `${kind}: ignored, battery ${this.battery}%`);
      if (now - this.lastStop < this.restartGapMs) return log(this.name, `${kind}: ignored, restart gap`);
    }
    this.deadline = now + hold; this.sessionStart = now; this.reconnects = 0;
    log(this.name, `${kind}: waking camera (hold until ${clock(this.deadline)})`);
    this.state = 'WAKING';
    this.lastLive && this.show({ raw: this.lastLive }, 'CONNECTING…', 'WAKING').catch(() => {});
    this.openDecoder();
  }

  openDecoder() {
    this.pending = []; let have = 0;
    const p = spawn(D.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer',
      '-i', `${D.bridgeHttp}/stream/${this.serial}`, '-an', '-vf', this.fit, '-f', 'rawvideo', 'pipe:1']);
    this.decoder = p;
    p.stdout.on('data', (c) => {
      if (this.decoder !== p) return;                          // stopped: ignore buffered leftovers
      this.pending.push(c); have += c.length;
      if (have < this.frameSize) return;
      const all = Buffer.concat(this.pending);
      const n = Math.floor(all.length / this.frameSize);
      const f = Buffer.from(all.subarray((n - 1) * this.frameSize, n * this.frameSize));   // newest whole frame
      const rest = all.subarray(n * this.frameSize);
      this.pending = rest.length ? [Buffer.from(rest)] : []; have = rest.length;
      this.frame = f; this.lastLive = f; this.lastLiveAt = Date.now();
      if (this.state === 'WAKING') {
        this.state = 'LIVE'; this.liveStart = Date.now();
        this.deadline = Math.max(this.deadline, this.liveStart + this.holdMs);   // hold counts from first frame, not from wake-up
        log(this.name, `live after ${((this.liveStart - this.sessionStart) / 1000).toFixed(1)} s`);
      }
    });
    // H.265 streams start mid-GOP: ffmpeg complains until the first keyframe. Keep the log readable.
    let errLines = 0;
    p.stderr.on('data', (c) => {
      if (++errLines <= 3) log(this.name, 'decoder:', String(c).trim().split('\n')[0].slice(0, 200));
      else if (errLines === 4) log(this.name, 'decoder: (further messages suppressed this session)');
    });
    p.on('error', (e) => log(this.name, 'decoder error:', e.message));
    p.on('close', (code) => {
      if (this.decoder !== p) return;                          // we stopped it on purpose
      this.decoder = null;
      if (Date.now() < this.deadline && this.reconnects < this.maxReconnects) {
        this.reconnects++;
        log(this.name, `feed closed (${code}) mid-event, reconnect ${this.reconnects}/${this.maxReconnects}`);
        return setTimeout(() => this.state !== 'IDLE' && !this.decoder && this.openDecoder(), 2000);
      }
      log(this.name, `feed closed (${code})`);
      this.stop('feed closed');
    });
  }

  stop(why) {
    if (this.state === 'IDLE') return;
    const p = this.decoder; this.decoder = null;
    if (p) p.kill('SIGTERM');                                  // closing /stream/<serial> lets the camera sleep
    const secs = (Date.now() - this.sessionStart) / 1000;
    this.lastStop = Date.now(); this.state = 'IDLE';
    log(this.name, `stopped (${why}) after ${secs.toFixed(0)} s`);
    this.freeze();
  }

  check() {
    const now = Date.now();
    if (this.state === 'WAKING' && now - this.sessionStart > this.firstFrameTimeoutMs) this.stop('no video from camera');
    else if (this.state !== 'IDLE' && now > this.deadline) this.stop('hold time over');
    else if (this.state === 'LIVE' && now - this.liveStart > this.maxLiveMs) this.stop('max live time');
  }

  // JPEG of whatever the NVR currently sees (frozen or live), cached briefly.
  snapshot() {
    if (this.jpgCache && this.jpgCache.frame === this.frame && Date.now() - this.jpgCache.at < 2000) return this.jpgCache.jpg;
    const frame = this.frame;
    const jpg = ffOnce([...this.rawIn, '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', 'pipe:1'], frame);
    this.jpgCache = { frame, at: Date.now(), jpg };
    jpg.catch(() => { this.jpgCache = null; });
    return jpg;
  }

  status() {
    return { name: this.name, serial: this.serial, state: this.state, battery: this.battery,
      resolution: `${this.width}x${this.height}`, rtsp: `/${this.name}`,
      liveUntil: this.state === 'IDLE' ? null : clock(this.deadline),
      lastSeen: this.lastLiveAt ? clock(this.lastLiveAt) : null };
  }
}

const cams = (D.cameras ?? []).map((c) => new Camera(c));
const bySerial = new Map(cams.map((c) => [c.serial, c]));

// ---------- bridge: events, login state, device list ----------
const bridge = { connected: false, auth: { state: 'unknown' }, devices: [] };
let ws = null, nextId = 100, backoff = 1000;
const pending = new Map();

function request(msg, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('bridge not connected'));
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('bridge did not answer')); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ ...msg, id }));
  });
}

async function refreshDevices() {
  try {
    const m = await request({ cmd: 'devices.list' });
    if (!m.devices) return;
    bridge.devices = m.devices.map((d) => ({ serial: d.sn, name: d.name, model: d.model, modelName: d.modelName,
      battery: d.decodedState?.battery?.level ?? null, configured: bySerial.has(d.sn), error: d.error }));
    for (const d of bridge.devices) { const c = bySerial.get(d.serial); if (c && d.battery != null) c.battery = d.battery; }
    log('devices:', bridge.devices.map((d) => `${d.name ?? '?'} [${d.serial}]${d.configured ? '' : ' (not configured)'}`).join(', ') || 'none');
  } catch (e) { log('devices.list failed:', e.message); }
}

function connect() {
  ws = new WebSocket(D.bridgeWs);
  ws.onopen = () => { backoff = 1000; bridge.connected = true; log('bridge connected'); };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.event === 'hello') { bridge.auth = m.auth ?? bridge.auth; if (bridge.auth.state === 'ok') refreshDevices(); return; }
    if (m.event === 'ready') return refreshDevices();
    if (m.event === 'auth') {
      bridge.auth = { state: m.state, method: m.method, image: m.image, retry: m.retry };
      log('eufy login state:', m.state);
      if (m.state === 'ok') refreshDevices();
      return;
    }
    const c = bySerial.get(m.deviceSn); if (!c) return;
    if (m.event === 'batteryLevel') c.battery = Number(m.to);
    else if (c.triggers.includes(m.event)) c.trigger(m.event);
    else if (m.event === 'streamState') log(c.name, `bridge stream ${m.active ? 'open' : 'closed'}`);
  };
  ws.onclose = () => {
    bridge.connected = false;
    for (const [id, done] of pending) { done({ ok: false, error: 'bridge disconnected' }); pending.delete(id); }
    log(`bridge disconnected, retry in ${backoff / 1000} s`);
    setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000);
  };
  ws.onerror = () => {};
}

// ---------- web UI + API (LAN only, no authentication: never expose it to the internet) ----------
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

createServer(async (req, res) => {
  const path = req.url.split('?')[0];
  const parts = path.split('/').filter(Boolean);
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body, null, 1)); };
  const status = () => ({ bridge: { connected: bridge.connected, login: bridge.auth.state, method: bridge.auth.method ?? null,
    captcha: bridge.auth.state === 'require_captcha' ? bridge.auth.image ?? null : null }, cameras: cams.map((c) => c.status()) });

  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(renderPage({ rtspPort: D.rtspPort ?? 8554 }));
  }
  if (req.method === 'GET' && (path === '/api/status' || path === '/status')) return send(200, status());
  if (req.method === 'GET' && path === '/api/devices') return send(200, bridge.devices);
  if (req.method === 'POST' && path === '/api/login') {
    const b = await readBody(req);
    const msg = b.captcha ? { cmd: 'auth.submit', captcha: String(b.captcha) } : b.code ? { cmd: 'auth.submit', code: String(b.code) } : null;
    if (!msg) return send(400, { ok: false, error: 'send { "code": "123456" } or { "captcha": "AB3D" }' });
    try { const r = await request(msg, 60000); if (r.auth) bridge.auth = r.auth; return send(r.ok ? 200 : 400, r); }
    catch (e) { return send(502, { ok: false, error: e.message }); }
  }
  if (req.method === 'POST' && path === '/api/login/retrigger') {
    try { const r = await request({ cmd: 'auth.retrigger' }, 60000); if (r.auth) bridge.auth = r.auth; return send(r.ok ? 200 : 400, r); }
    catch (e) { return send(502, { ok: false, error: e.message }); }
  }

  // Per camera: /<name>/snapshot.jpg, POST /<name>/live, POST /<name>/idle (also under /api/cameras/<name>/...)
  const [name, action] = parts[0] === 'api' && parts[1] === 'cameras' ? parts.slice(2) : parts;
  const c = cams.find((x) => x.name === name);
  if (c && req.method === 'GET' && action === 'snapshot.jpg') {
    return c.snapshot().then((jpg) => { res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpg.length, 'cache-control': 'no-store' }); res.end(jpg); },
      (e) => send(500, { error: e.message }));
  }
  if (c && req.method === 'POST' && action === 'live') { c.trigger('manual'); return send(200, c.status()); }
  if (c && req.method === 'POST' && action === 'idle') { c.stop('manual'); return send(200, c.status()); }
  send(404, { error: 'not found' });
}).listen(D.webPort, () => log(`web UI on :${D.webPort}`));

if (!cams.length) log('No cameras configured yet: log in on the web UI, then add cameras from the device list to config.json.');
for (const c of cams) { await c.initStill(); c.startEncoder(); }
setInterval(() => cams.forEach((c) => c.check()), 1000);
connect();
process.on('SIGTERM', () => { cams.forEach((c) => c.decoder?.kill('SIGTERM')); process.exit(0); });

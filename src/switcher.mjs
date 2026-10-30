// Switcher: one never-ending H.264 stream per camera, for NVRs that hold streams open 24/7.
// Asleep -> a still of the last frame (blurred, dimmed, moon and "Sleeping since …" label),
//           encoded once into a short loop that is replayed without re-encoding.
// Event  -> wake the camera via the bridge's /stream/<serial>, encode live video, then fall
//           asleep again after the hold time.
// Both feed one "-c copy" publisher, spliced at keyframes, so the NVR sees a single stream.
// No dependencies: Node 22+ (global WebSocket/fetch) and ffmpeg.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPage } from './web.mjs';
import { ffmpeg, renderStill, encodeLoop, x264Args, splitter, isIdr } from './render.mjs';

const cfg = JSON.parse(readFileSync(process.argv[2] ?? '/data/switcher/config.json', 'utf8'));
const D = {
  bridgeWs: 'ws://127.0.0.1:3000/ws',
  bridgeHttp: 'http://127.0.0.1:3000',
  output: 'rtsp://127.0.0.1:8554/{name}',
  webPort: 8099,
  dataDir: '/data/switcher',
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
};
const OFFLINE_AFTER_MS = 30000;   // bridge down or logged out this long -> "Offline" (not on short blips)

const log = (...a) => console.log(new Date().toISOString(), ...a);
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZone: D.timeZone, hour12: false });
const tmp = mkdtempSync(join(tmpdir(), 'switcher-'));

// ---------- label copy ----------
const hm = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZone: D.timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
const dayOf = (t) => { const [y, m, d] = new Date(t).toLocaleDateString('en-CA', { timeZone: D.timeZone }).split('-'); return Date.UTC(y, m - 1, d) / 864e5; };
// "since 18:33", "since yesterday 22:10", "since Mon 22:10", "since 12 Oct"
function since(t) {
  const days = dayOf(Date.now()) - dayOf(t);
  if (days <= 0) return `since ${hm(t)}`;
  if (days === 1) return `since yesterday ${hm(t)}`;
  if (days < 7) return `since ${new Date(t).toLocaleDateString('en-GB', { timeZone: D.timeZone, weekday: 'short' })} ${hm(t)}`;
  return `since ${new Date(t).toLocaleDateString('en-GB', { timeZone: D.timeZone, day: 'numeric', month: 'short' })}`;
}
const REASONS = { motion: 'Motion detected', personDetected: 'Person detected', vehicleDetected: 'Vehicle detected',
  petDetection: 'Pet detected', strangerDetected: 'Stranger detected', doorbellPress: 'Doorbell pressed', manual: 'Requested on the web page' };

class Camera {
  constructor(c) {
    Object.assign(this, CAM_DEFAULTS, c);
    this.serial = c.serial ?? c.sn;
    this.frameSize = this.width * this.height * 3 / 2;          // yuv420p
    this.rawIn = ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${this.width}x${this.height}`];
    this.fit = `scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease,` +
      `pad=${this.width}:${this.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
    this.frame = Buffer.alloc(this.frameSize, 0); this.frame.fill(128, this.width * this.height);   // what the stream shows (snapshots)
    this.base = null;              // picture behind the sleeping overlay: { raw } | { file }
    this.baseFromEvent = false;    // base is eufy's stored event image, time unknown
    this.lastLive = null; this.lastLiveAt = 0;
    this.state = 'IDLE';           // IDLE | WAKING | LIVE
    this.deadline = 0; this.sessionStart = 0; this.liveStart = 0; this.lastStop = 0;
    this.reconnects = 0; this.decoder = null; this.pending = [];
    this.battery = null; this.model = null;
    this.wakeReason = null; this.wakeAt = 0; this.failedAt = 0;
    // output side
    this.loop = null; this.loopIdx = 0;     // H.264 frames of the current still, replayed forever
    this.mode = 'loop';                     // loop | live: what the publisher is fed
    this.liveQ = []; this.encoder = null;   // live encoder and its pending output frames
    this.shown = ''; this.gen = 0;          // key of the state on screen / being rendered
    this.jpg = join(D.dataDir, `last-${this.name}.jpg`);
  }

  // ---------- what the stream should show ----------
  view() {
    if (this.state === 'LIVE') return { kind: 'live', title: 'Live', detail: `until ${hm(this.deadline)}` };
    if (this.state === 'WAKING') return { kind: 'waking', title: 'Waking up', detail: `${REASONS[this.wakeReason] ?? 'Waking'} · ${hm(this.wakeAt)}` };
    const from = this.baseFromEvent || !this.lastLiveAt ? 'the last event' : hm(this.lastLiveAt);
    if (bridge.offlineSince && Date.now() - bridge.offlineSince > OFFLINE_AFTER_MS)
      return { kind: 'offline', title: 'Offline', detail: bridge.connected ? 'eufy login needed · see web page' : 'Reconnecting to eufy' };
    if (!this.base) return { kind: 'nopicture', title: 'No picture yet', detail: 'Appears after the first event' };
    if (this.failedAt) return { kind: 'nowake', title: 'Didn’t wake up', detail: `${hm(this.failedAt)} · picture from ${from}` };
    if (this.battery != null && this.battery < this.minBatteryPct)
      return { kind: 'lowbattery', title: `Sleeping · battery ${this.battery} %`,
        detail: /^T82/.test(this.model ?? '') ? 'Wakes only for the doorbell' : 'Wakes only on request' };
    return { kind: 'asleep', title: 'Sleeping', detail: this.baseFromEvent || !this.lastLiveAt ? 'picture from the last event' : since(this.lastLiveAt) };
  }

  // Render the current state's still and loop if it changed. Cheap to call often.
  async refresh() {
    if (this.state === 'LIVE') return;
    const v = this.view(), key = `${v.kind}|${v.title}|${v.detail}`;
    if (key === this.shown) return;
    this.shown = key;
    const gen = ++this.gen;
    try {
      const still = await renderStill({ w: this.width, h: this.height, base: this.base, view: v, tmp, name: this.name });
      const loop = await encodeLoop({ cam: this, still, spin: v.kind === 'waking', tmp });
      if (gen !== this.gen) return;                            // something newer took over meanwhile
      this.frame = still; this.loop = loop; this.loopIdx = 0; this.mode = 'loop';
      this.stopEncoder();
    } catch (e) {
      log(this.name, 'render failed:', e.message);
      if (gen === this.gen) this.shown = '';                   // retry on the next refresh
    }
  }

  async initStill() {
    try {
      if (existsSync(this.jpg)) {                              // last frame from before a restart
        this.base = { file: this.jpg }; this.lastLiveAt = statSync(this.jpg).mtimeMs;
      } else {
        const r = await fetch(`${D.bridgeHttp}/snapshot/${this.serial}?mode=stored`);   // stored: never wakes the camera
        if (r.ok) {
          const f = join(tmp, `${this.name}-snap.jpg`);
          writeFileSync(f, Buffer.from(await r.arrayBuffer()));
          this.base = { file: f }; this.baseFromEvent = true;
        }
      }
    } catch (e) { log(this.name, 'initial still failed:', e.message); }
  }

  // ---------- publisher: the one never-ending stream into go2rtc ----------
  // A "-c copy" ffmpeg fed whole H.264 frames at exactly fps: the still loop while asleep (no
  // encoding at all), the live encoder's frames while live. Switches happen at keyframes.
  startPublisher() {
    const out = D.output.replace('{name}', this.name);
    const fmt = out.startsWith('rtsp://') ? ['-f', 'rtsp', '-rtsp_transport', 'tcp'] : ['-f', 'mpegts'];
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-framerate', String(this.fps), '-i', 'pipe:0',
      '-c', 'copy', '-bsf:v', `setts=ts=N/(${this.fps}*TB)`, ...fmt, out]);
    p.stderr.on('data', (c) => log(this.name, 'publisher:', String(c).trim()));
    p.stdin.on('error', () => {});
    p.on('error', (e) => log(this.name, 'publisher error:', e.message));
    let blocked = false;
    p.stdin.on('drain', () => { blocked = false; });
    const start = Date.now(); let written = 0, needIdr = true;   // a fresh publisher must start on a keyframe
    const tick = setInterval(() => {
      let due = Math.floor((Date.now() - start) * this.fps / 1000) + 1;
      if (due - written > this.fps * 2) written = due - 1;      // fell behind (busy CPU): don't burst, just continue
      while (written < due && !blocked) {
        let f;
        if (this.mode === 'live') {
          f = this.liveQ.shift();
          if (!f) break;
          if (needIdr && !isIdr(f)) continue;                  // dropped: wait for the encoder's next keyframe
        } else if (this.loop) {
          if (needIdr) this.loopIdx = 0;                       // a loop starts with a keyframe
          f = this.loop[this.loopIdx]; this.loopIdx = (this.loopIdx + 1) % this.loop.length;
        } else break;
        needIdr = false;
        blocked = !p.stdin.write(f); written++;
      }
    }, 20);
    p.on('close', (code) => {
      clearInterval(tick);
      log(this.name, `publisher exited (${code}), restarting in 2 s`);
      setTimeout(() => this.startPublisher(), 2000);
    });
    log(this.name, `stream → ${out} (${this.width}x${this.height} @ ${this.fps} fps)`);
  }

  // ---------- live encoder: runs only while live ----------
  startEncoder() {
    if (this.encoder) return;
    // Frames carry wall-clock timestamps and ffmpeg repeats the last one to a constant frame
    // rate, so a frame is only written when the picture changes (plus a heartbeat).
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-use_wallclock_as_timestamps', '1', ...this.rawIn, '-i', 'pipe:0',
      '-fps_mode', 'cfr', '-r', String(this.fps), ...x264Args(this), 'pipe:1']);
    this.encoder = p;
    p.stdout.on('data', splitter((f) => {
      if (this.encoder !== p) return;
      if (this.mode !== 'live') {                              // switch over at the first keyframe
        if (this.state !== 'LIVE' || !isIdr(f)) return;
        this.mode = 'live'; this.liveQ = [];
      }
      this.liveQ.push(f);
      if (this.liveQ.length > this.fps * 2) this.liveQ.splice(0, this.liveQ.length - this.fps);   // never build up delay
    }));
    p.stderr.on('data', (c) => log(this.name, 'encoder:', String(c).trim()));
    p.stdin.on('error', () => {});
    p.on('error', (e) => log(this.name, 'encoder error:', e.message));
    p.on('close', () => { if (this.encoder === p) { this.encoder = null; clearInterval(tick); } });
    let written = null, lastWrite = 0, blocked = false;
    p.stdin.on('drain', () => { blocked = false; });
    const tick = setInterval(() => {
      const now = Date.now();
      if (this.encoder !== p) return clearInterval(tick);
      if (blocked || (this.frame === written && now - lastWrite < 1000)) return;
      blocked = !p.stdin.write(this.frame);
      written = this.frame; lastWrite = now;
    }, Math.round(1000 / this.fps / 2));
  }

  stopEncoder() {
    const p = this.encoder; if (!p) return;
    this.encoder = null; this.liveQ = [];
    p.stdin.end(); p.kill('SIGTERM');
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
    this.deadline = now + hold; this.sessionStart = now; this.liveStart = 0; this.reconnects = 0;
    this.wakeReason = kind; this.wakeAt = now;
    log(this.name, `${kind}: waking camera (hold until ${clock(this.deadline)})`);
    this.state = 'WAKING';
    this.refresh();
    this.openDecoder();
  }

  openDecoder() {
    this.pending = []; let have = 0;
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer',
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
        this.state = 'LIVE'; this.liveStart = Date.now(); this.failedAt = 0;
        this.gen++; this.shown = 'live';                       // drop any still render in progress
        this.deadline = Math.max(this.deadline, this.liveStart + this.holdMs);   // hold counts from first frame, not from wake-up
        log(this.name, `live after ${((this.liveStart - this.sessionStart) / 1000).toFixed(1)} s`);
        this.startEncoder();
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
    if (!this.liveStart) this.failedAt = Date.now();           // never got a picture: "Didn't wake up"
    this.lastStop = Date.now(); this.state = 'IDLE';
    log(this.name, `stopped (${why}) after ${secs.toFixed(0)} s`);
    if (this.liveStart && this.lastLive) {
      this.base = { raw: this.lastLive }; this.baseFromEvent = false;
      ffmpeg([...this.rawIn, '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', '-y', this.jpg], this.lastLive)
        .catch((e) => log(this.name, 'saving last frame failed:', e.message));
    }
    // The live encoder keeps the last picture on air until the sleeping loop is ready.
    this.refresh();
  }

  check() {
    const now = Date.now();
    if (this.state === 'WAKING' && now - this.sessionStart > this.firstFrameTimeoutMs) this.stop('no video from camera');
    else if (this.state !== 'IDLE' && now > this.deadline) this.stop('hold time over');
    else if (this.state === 'LIVE' && now - this.liveStart > this.maxLiveMs) this.stop('max live time');
  }

  // JPEG of whatever the NVR currently sees (still or live), cached briefly.
  snapshot() {
    if (this.jpgCache && this.jpgCache.frame === this.frame && Date.now() - this.jpgCache.at < 2000) return this.jpgCache.jpg;
    const frame = this.frame;
    const jpg = ffmpeg([...this.rawIn, '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', 'pipe:1'], frame);
    this.jpgCache = { frame, at: Date.now(), jpg };
    jpg.catch(() => { this.jpgCache = null; });
    return jpg;
  }

  status() {
    const v = this.view();
    return { name: this.name, serial: this.serial, state: this.state, battery: this.battery,
      resolution: `${this.width}x${this.height}`, rtsp: `/${this.name}`,
      display: { kind: v.kind, title: v.title, detail: v.detail },
      liveUntil: this.state === 'IDLE' ? null : clock(this.deadline),
      lastSeen: this.lastLiveAt ? clock(this.lastLiveAt) : null };
  }
}

const cams = (D.cameras ?? []).map((c) => new Camera(c));
const bySerial = new Map(cams.map((c) => [c.serial, c]));

// ---------- bridge: events, login state, device list ----------
// offlineSince: when the bridge was last seen disconnected or logged out (null while fine)
const bridge = { connected: false, auth: { state: 'unknown' }, devices: [], offlineSince: Date.now() };
function bridgeHealth() {
  const ok = bridge.connected && bridge.auth.state === 'ok';
  if (ok) bridge.offlineSince = null; else bridge.offlineSince ??= Date.now();
}
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
    for (const d of bridge.devices) {
      const c = bySerial.get(d.serial); if (!c) continue;
      c.model = d.model ?? c.model;
      if (d.battery != null) c.battery = d.battery;
    }
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
for (const c of cams) { await c.initStill(); c.startPublisher(); c.refresh(); }
setInterval(() => cams.forEach((c) => c.check()), 1000);
// Labels follow battery, login state and the date ("since yesterday …"); re-rendered only on change.
setInterval(() => { bridgeHealth(); cams.forEach((c) => c.refresh()); }, 5000);
connect();
process.on('SIGTERM', () => { cams.forEach((c) => c.decoder?.kill('SIGTERM')); process.exit(0); });

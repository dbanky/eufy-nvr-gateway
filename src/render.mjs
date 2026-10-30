// Picture side of the switcher: draws the overlay for a state (blurred, dimmed picture, centre
// mark, label) into one still frame, encodes stills into short H.264 loops, and splits H.264
// streams into frames. Design: blur 10 px at 1080p, -22 % brightness, -60 % saturation,
// vignette; label bottom left; sizes are fractions of the frame height.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url));
const FONT = { title: join(ASSETS, 'fonts/Inter-SemiBold.ttf'), detail: join(ASSETS, 'fonts/Inter-Regular.ttf') };
const icon = (name) => join(ASSETS, `icons/${name}.png`);
export const LOOP_SECONDS = 8;   // two 4 s GOPs: consecutive IDRs differ, and the 1 s spinner loops seamlessly

// Accent colour and centre icon per state.
const STYLE = {
  asleep: { accent: [169, 184, 255], icon: 'moon' },
  waking: { accent: [255, 196, 71], icon: 'bolt' },
  lowbattery: { accent: [255, 169, 77], icon: 'battery' },
  nowake: { accent: [255, 138, 128], icon: 'alert' },
  offline: { accent: [180, 188, 200], icon: 'offline' },
  nopicture: { accent: [140, 149, 164], icon: 'nopicture' },
};

// ---------- text widths (the label pill is sized to its text) ----------
// Minimal TrueType reader: cmap (format 12 or 4) + hmtx advances. Kerning is ignored, which is
// within the label's padding.
function loadFont(file) {
  const b = readFileSync(file), t = {};
  for (let i = 0; i < b.readUInt16BE(4); i++) t[b.toString('latin1', 12 + i * 16, 16 + i * 16)] = b.readUInt32BE(20 + i * 16);
  const upem = b.readUInt16BE(t.head + 18), nhm = b.readUInt16BE(t.hhea + 34);
  let f12 = 0, f4 = 0;
  for (let i = 0; i < b.readUInt16BE(t.cmap + 2); i++) {
    const off = t.cmap + b.readUInt32BE(t.cmap + 8 + i * 8), fmt = b.readUInt16BE(off);
    if (fmt === 12) f12 = off; else if (fmt === 4 && b.readUInt16BE(t.cmap + 4 + i * 8) === 3) f4 = off;
  }
  const glyph = (cp) => {
    if (f12) {
      for (let g = 0, n = b.readUInt32BE(f12 + 12); g < n; g++) {
        const o = f12 + 16 + g * 12, start = b.readUInt32BE(o), end = b.readUInt32BE(o + 4);
        if (cp >= start && cp <= end) return b.readUInt32BE(o + 8) + cp - start;
      }
      return 0;
    }
    const seg2 = b.readUInt16BE(f4 + 6), ends = f4 + 14, starts = ends + seg2 + 2, deltas = starts + seg2, ros = deltas + seg2;
    for (let i = 0; i < seg2; i += 2) {
      if (cp > b.readUInt16BE(ends + i)) continue;
      const start = b.readUInt16BE(starts + i), delta = b.readUInt16BE(deltas + i), ro = b.readUInt16BE(ros + i);
      if (cp < start) return 0;
      if (!ro) return (cp + delta) & 0xffff;
      const g = b.readUInt16BE(ros + i + ro + 2 * (cp - start));
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };
  return (text, size) => [...text].reduce((w, ch) => w + b.readUInt16BE(t.hmtx + 4 * Math.min(glyph(ch.codePointAt(0)), nhm - 1)), 0) * size / upem;
}
let measure;
const textWidth = (kind, text, size) => (measure ??= { title: loadFont(FONT.title), detail: loadFont(FONT.detail) })[kind](text, size);

// ---------- overlay shapes, drawn by hand into an RGBA layer (anti-aliased) ----------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function blend(px, i, [r, g, b], a) {
  if (a <= 0) return;
  const da = px[i + 3] / 255, oa = a + da * (1 - a);
  px[i] = (r * a + px[i] * da * (1 - a)) / oa;
  px[i + 1] = (g * a + px[i + 1] * da * (1 - a)) / oa;
  px[i + 2] = (b * a + px[i + 2] * da * (1 - a)) / oa;
  px[i + 3] = oa * 255;
}
// A capsule (pill or circle): fill plus hairline border. sdf < 0 inside.
function capsule(px, w, h, x, y, cw, ch, fill, fillA, border, borderA, bw) {
  const r = ch / 2, ax = x + r, bx = x + cw - r, cy = y + r;
  for (let py = Math.max(0, Math.floor(y - 1)); py < Math.min(h, Math.ceil(y + ch + 1)); py++) {
    for (let qx = Math.max(0, Math.floor(x - 1)); qx < Math.min(w, Math.ceil(x + cw + 1)); qx++) {
      const fx = qx + 0.5, fy = py + 0.5, nx = fx < ax ? ax : fx > bx ? bx : fx;
      const sd = Math.hypot(fx - nx, fy - cy) - r, i = (py * w + qx) * 4;
      blend(px, i, fill, fillA * clamp01(0.5 - sd));
      if (borderA) blend(px, i, border, borderA * (clamp01(0.5 - sd) - clamp01(0.5 - sd - bw)));
    }
  }
}

// Run ffmpeg once and collect stdout.
export function ffmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
    const out = []; let err = '';
    p.stdout.on('data', (c) => out.push(c));
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${err.trim().slice(0, 300)}`))));
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? null);
  });
}

// One finished still frame (raw yuv420p, w x h) for a state.
// base: { raw: Buffer } | { file: path } | null;  view: { kind, title, detail }
export async function renderStill({ w, h, base, view, tmp, name }) {
  const u = h / 100, style = STYLE[view.kind] ?? STYLE.asleep, noPic = view.kind === 'nopicture';
  const layer = Buffer.alloc(w * h * 4);
  const icons = [];   // { png, size, x, y, rgb, alpha }
  const texts = [];   // { kind, text, size, color, x, y }

  // Centre mark: dark disc with the state icon (and the spinner track while waking).
  const disc = 22 * u, cx = w / 2, cy = h / 2 - (noPic ? 8 * u : 0);
  capsule(layer, w, h, cx - disc / 2, cy - disc / 2, disc, disc, [10, 12, 16], 0.38, [255, 255, 255], 0.18, Math.max(1, 0.1 * u));
  if (view.kind === 'waking') icons.push({ png: icon('ring-track'), size: disc * 0.88, cx, cy, rgb: [255, 255, 255], alpha: 1 });
  const centreRgb = view.kind === 'waking' ? style.accent : noPic ? style.accent : [255, 255, 255];
  icons.push({ png: icon(style.icon), size: 10 * u, cx, cy, rgb: centreRgb, alpha: view.kind === 'waking' || noPic ? 1 : 0.86 });

  const titleSize = 3.1 * u, detailSize = 2.5 * u, gapS = 0.6 * u;
  if (noPic) {
    texts.push({ kind: 'title', text: view.title, size: titleSize, color: 'E6E9EF', x: 'center', y: h / 2 + 7 * u });
    texts.push({ kind: 'detail', text: view.detail, size: detailSize, color: '9AA2B1', x: 'center', y: h / 2 + 7 * u + titleSize * 1.1 + gapS });
  } else {
    // Label: capsule bottom left with an icon chip, a title and a detail line.
    const margin = 3.5 * u, padY = 1.6 * u, padR = 2.8 * u, chip = 5.6 * u, gap = 1.8 * u;
    const block = titleSize * 1.1 + gapS + detailSize * 1.1, content = Math.max(chip, block), ph = content + 2 * padY;
    const textW = Math.max(textWidth('title', view.title, titleSize), textWidth('detail', view.detail, detailSize));
    const pw = padY + chip + gap + textW + padR, px = margin, py = h - margin - ph;
    capsule(layer, w, h, px, py, pw, ph, [14, 16, 20], 0.62, [255, 255, 255], 0.12, Math.max(1, 0.1 * u));
    capsule(layer, w, h, px + padY, py + (ph - chip) / 2, chip, chip, style.accent, 0.2, null, 0, 0);
    icons.push({ png: icon(style.icon), size: chip * 0.56, cx: px + padY + chip / 2, cy: py + ph / 2, rgb: style.accent, alpha: 1 });
    const tx = px + padY + chip + gap, ty = py + padY + (content - block) / 2;
    texts.push({ kind: 'title', text: view.title, size: titleSize, color: 'F4F6FA', x: tx, y: ty });
    texts.push({ kind: 'detail', text: view.detail, size: detailSize, color: 'C3C9D3', x: tx, y: ty + titleSize * 1.1 + gapS });
  }

  const layerFile = join(tmp, `${name}-layer.rgba`);
  writeFileSync(layerFile, layer);
  const inputs = base?.raw ? ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${w}x${h}`, '-i', 'pipe:0']
    : base?.file ? ['-i', base.file]
    : ['-f', 'lavfi', '-i', `color=c=0x15171C:s=${w}x${h}:d=1`];
  inputs.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', layerFile);
  for (const ic of icons) inputs.push('-i', ic.png);

  const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
  const treat = base ? `,gblur=sigma=${(10 * h / 1080).toFixed(1)},lutyuv=y=val*0.78:u=128+(val-128)*0.4:v=128+(val-128)*0.4,vignette=PI/5` : '';
  const graph = [`[0:v]${fit}${treat}[b]`, '[b][1:v]overlay=0:0:format=auto[c0]'];
  let cur = '[c0]';
  icons.forEach((ic, k) => {
    const s = Math.round(ic.size / 2) * 2;
    graph.push(`[${k + 2}:v]scale=${s}:${s},format=rgba,lutrgb=r=${ic.rgb[0]}:g=${ic.rgb[1]}:b=${ic.rgb[2]}:a=val*${ic.alpha}[i${k}]`);
    graph.push(`${cur}[i${k}]overlay=${Math.round(ic.cx - s / 2)}:${Math.round(ic.cy - s / 2)}:format=auto[c${k + 1}]`);
    cur = `[c${k + 1}]`;
  });
  const draw = texts.map((t, k) => {
    const f = join(tmp, `${name}-text${k}.txt`);
    writeFileSync(f, t.text);
    const x = t.x === 'center' ? '(w-text_w)/2' : Math.round(t.x);
    return `drawtext=fontfile=${FONT[t.kind]}:textfile=${f}:expansion=none:fontsize=${t.size.toFixed(1)}:fontcolor=0x${t.color}:x=${x}:y=${Math.round(t.y)}:y_align=font`;
  });
  graph.push(`${cur}${draw.join(',')},format=yuv420p[out]`);

  const buf = await ffmpeg([...inputs, '-filter_complex', graph.join(';'), '-map', '[out]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'], base?.raw);
  const size = w * h * 3 / 2;
  if (buf.length < size) throw new Error('short frame from ffmpeg');
  return buf.subarray(0, size);
}

// H.264 settings shared by the live encoder and the still loops: identical parameter sets let
// the publisher splice them into one stream. AUDs mark frame boundaries.
export function x264Args(cam) {
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-bf', '0', '-g', String(cam.fps * 4), '-keyint_min', String(cam.fps * 4), '-sc_threshold', '0',
    // qpmin stops x264 from endlessly "refining" a still picture; SSIM ~0.997 vs. the camera's own stream.
    '-crf', '20', '-x264-params', 'qpmin=19:aud=1:repeat-headers=1',
    '-maxrate', `${cam.bitrateKbps}k`, '-bufsize', `${cam.bitrateKbps * 2}k`, '-f', 'h264'];
}

// Encode a still into LOOP_SECONDS of H.264 frames, once; the publisher then repeats them for free.
// spin: overlay the rotating amber arc of the waking state (one turn per second).
export async function encodeLoop({ cam, still, spin, tmp }) {
  const { width: w, height: h, fps } = cam;
  const file = join(tmp, `${cam.name}-still.yuv`);
  writeFileSync(file, still);
  const args = ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${w}x${h}`, '-framerate', String(fps), '-stream_loop', '-1', '-i', file];
  if (spin) {
    const s = Math.round(22 * h / 100 * 0.88 / 2) * 2;
    args.push('-loop', '1', '-framerate', String(fps), '-i', icon('ring-arc'), '-filter_complex',
      `[1:v]scale=${s}:${s},format=rgba,lutrgb=r=255:g=196:b=71,rotate=a=2*PI*t:c=none:ow=iw:oh=ih[s];` +
      `[0:v][s]overlay=${Math.round(w / 2 - s / 2)}:${Math.round(h / 2 - s / 2)}:format=auto,format=yuv420p[v]`, '-map', '[v]');
  }
  args.push('-frames:v', String(fps * LOOP_SECONDS), ...x264Args(cam), 'pipe:1');
  const frames = [];
  const split = splitter((au) => frames.push(au));
  split(await ffmpeg(args));
  split.flush();
  return frames;
}

// Split an Annex B H.264 stream into access units at AUD NAL units.
export function splitter(onFrame) {
  let buf = Buffer.alloc(0), scanned = 0, first = -1;
  const fn = (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (let i = Math.max(scanned, 0); i + 3 < buf.length; i++) {
      if (buf[i] !== 0 || buf[i + 1] !== 0 || buf[i + 2] !== 1 || (buf[i + 3] & 0x1f) !== 9) continue;
      const start = i > 0 && buf[i - 1] === 0 ? i - 1 : i;
      if (first >= 0) onFrame(Buffer.from(buf.subarray(first, start)));
      first = start;
    }
    scanned = Math.max(0, buf.length - 3);
    if (first > 0) { buf = buf.subarray(first); scanned -= first; first = 0; }
  };
  fn.flush = () => { if (first >= 0 && buf.length > first) onFrame(Buffer.from(buf.subarray(first))); buf = Buffer.alloc(0); first = -1; scanned = 0; };
  return fn;
}

export function isIdr(au) {
  for (let i = 0; i + 3 < au.length; i++) if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 0x1f) === 5) return true;
  return false;
}

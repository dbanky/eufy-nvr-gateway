// Opens a camera's live feed (the bridge's /stream/<serial>, which wakes the camera) and decodes it
// to raw frames of the camera's configured size. Closing it lets the camera sleep within ~0.1 s.

import { spawnFfmpeg, fitFilter, frameSize } from './ffmpeg.mjs';

// Turns a byte stream of raw frames into whole frames. When several arrive at once only the newest
// matters: the stream should show "now", not catch up.
export class RawFrameAssembler {
  constructor(size) {
    this.size = size;
    this.pending = [];
    this.have = 0;
  }

  // Returns the newest complete frame in what arrived so far, or null.
  push(chunk) {
    this.pending.push(chunk);
    this.have += chunk.length;
    if (this.have < this.size) return null;
    const all = Buffer.concat(this.pending);
    const whole = Math.floor(all.length / this.size);
    const newest = Buffer.from(all.subarray((whole - 1) * this.size, whole * this.size));
    const rest = all.subarray(whole * this.size);
    this.pending = rest.length ? [Buffer.from(rest)] : [];
    this.have = rest.length;
    return newest;
  }
}

// onFrame(rawFrame) for every decoded picture; onClose(code) once, unless stop() was called.
export function openLiveDecoder({ cam, url, onFrame, onClose, log }) {
  const child = spawnFfmpeg(['-fflags', 'nobuffer', '-i', url, '-an', '-vf', fitFilter(cam), '-f', 'rawvideo', 'pipe:1']);
  const assembler = new RawFrameAssembler(frameSize(cam));
  let stopped = false;
  child.stdout.on('data', (c) => {
    if (stopped) return;   // buffered leftovers after stop()
    const frame = assembler.push(c);
    if (frame) onFrame(frame);
  });
  // H.265 streams start mid-GOP: ffmpeg complains until the first keyframe. Keep the log readable.
  let errLines = 0;
  child.stderr.on('data', (c) => {
    if (++errLines <= 3) log(cam.name, 'decoder:', String(c).trim().split('\n')[0].slice(0, 200));
    else if (errLines === 4) log(cam.name, 'decoder: (further messages suppressed this session)');
  });
  child.on('error', (e) => log(cam.name, 'decoder error:', e.message));
  child.on('close', (code) => { if (!stopped) onClose(code); });
  return {
    stop() {
      stopped = true;
      child.kill('SIGTERM');
    },
  };
}

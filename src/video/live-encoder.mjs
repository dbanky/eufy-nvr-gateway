// Encodes live video while a camera is awake. It takes raw frames (getFrame() always returns the
// newest picture) and hands encoded frames to onFrame.

import { spawnFfmpeg, rawInput } from './ffmpeg.mjs';
import { encoderArgs } from './encoder-settings.mjs';
import { FrameSplitter } from './annexb.mjs';

// Raw 3K frames are 7 MB: only write one when the picture changed, plus one per second so the
// encoder keeps producing frames. ffmpeg repeats the last frame to a constant frame rate.
export const HEARTBEAT_MS = 1000;
export const shouldWrite = ({ frame, lastWritten, lastWriteAt, now }) =>
  frame !== lastWritten || now - lastWriteAt >= HEARTBEAT_MS;

export class LiveEncoder {
  constructor({ cam, getFrame, onFrame, log }) {
    Object.assign(this, { cam, getFrame, onFrame, log });
    this.child = null;
  }

  get running() {
    return !!this.child;
  }

  start() {
    if (this.child) return;
    const { cam } = this;
    const child = spawnFfmpeg(['-use_wallclock_as_timestamps', '1', ...rawInput(cam), '-i', 'pipe:0',
      '-fps_mode', 'cfr', '-r', String(cam.fps), ...encoderArgs(cam), 'pipe:1']);
    this.child = child;
    const splitter = new FrameSplitter((f) => this.child === child && this.onFrame(f));
    child.stdout.on('data', (c) => splitter.push(c));
    child.stderr.on('data', (c) => this.log(cam.name, 'encoder:', String(c).trim()));
    child.on('error', (e) => this.log(cam.name, 'encoder error:', e.message));

    let lastWritten = null, lastWriteAt = 0, blocked = false;
    child.stdin.on('drain', () => { blocked = false; });
    const tick = setInterval(() => {
      const frame = this.getFrame(), now = Date.now();
      if (blocked || !shouldWrite({ frame, lastWritten, lastWriteAt, now })) return;
      blocked = !child.stdin.write(frame);
      lastWritten = frame;
      lastWriteAt = now;
    }, Math.round(1000 / cam.fps / 2));
    child.on('close', () => {
      clearInterval(tick);
      if (this.child === child) this.child = null;
    });
  }

  stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.stdin.end();
    child.kill('SIGTERM');
  }
}

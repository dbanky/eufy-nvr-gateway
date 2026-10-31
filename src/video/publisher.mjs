// The one never-ending stream per camera: an "ffmpeg -c copy" that sends whatever the Feed hands
// it to go2rtc, at exactly `fps` frames per second. It never encodes anything itself.

import { spawnFfmpeg } from './ffmpeg.mjs';

// How many frames should have been sent `elapsedMs` after the start (the first one at once).
export const framesDue = (elapsedMs, fps) => Math.floor(elapsedMs * fps / 1000) + 1;

// After a stall (busy CPU), don't burst out everything that was missed: just carry on.
export const MAX_CATCH_UP_SECONDS = 2;

// Raw H.264/H.265 has no timestamps: the frames are numbered at the fixed rate instead.
export function publisherArgs({ fps, codec, output }) {
  const format = output.startsWith('rtsp://') ? ['-f', 'rtsp', '-rtsp_transport', 'tcp'] : ['-f', 'mpegts'];
  return ['-f', codec, '-framerate', String(fps), '-i', 'pipe:0', '-c', 'copy', '-bsf:v', `setts=ts=N/(${fps}*TB)`, ...format, output];
}

export class Publisher {
  constructor({ name, fps, output, feed, log }) {
    Object.assign(this, { name, fps, output, feed, log });
    // A new codec (the camera's own H.265 passed through) needs a new ffmpeg: restart.
    feed.on('codec', (codec) => {
      this.log(this.name, `stream codec now ${codec}, restarting the stream`);
      this.child?.kill('SIGTERM');
    });
  }

  start() {
    const child = spawnFfmpeg(publisherArgs({ fps: this.fps, codec: this.feed.codec, output: this.output }));
    this.child = child;
    child.stderr.on('data', (c) => this.log(this.name, 'publisher:', String(c).trim()));
    child.on('error', (e) => this.log(this.name, 'publisher error:', e.message));

    const startedAt = Date.now();
    let sent = 0, needKeyframe = true, blocked = false;
    child.stdin.on('drain', () => { blocked = false; });
    const tick = setInterval(() => {
      const due = framesDue(Date.now() - startedAt, this.fps);
      if (due - sent > this.fps * MAX_CATCH_UP_SECONDS) sent = due - 1;
      while (sent < due && !blocked) {
        const frame = this.feed.next({ fromKeyframe: needKeyframe });
        if (!frame) break;
        needKeyframe = false;
        blocked = !child.stdin.write(frame);
        sent++;
      }
    }, 20);

    child.on('close', (code) => {
      clearInterval(tick);
      this.log(this.name, `publisher exited (${code}), restarting in 2 s`);
      setTimeout(() => this.start(), 2000);
    });
    this.log(this.name, `stream → ${this.output} (${this.feed.codec} @ ${this.fps} fps)`);
  }
}

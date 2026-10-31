// Passes a camera's own video (H.264 or H.265) through instead of decoding and re-encoding it: for
// cameras with `transcode: false`. Opening the feed wakes the camera, closing it lets it sleep.
//
// One ffmpeg, two outputs:
//   pipe:1  the camera's stream, copied, split into frames for the Feed
//   pipe:3  JPEGs of its keyframes only (cheap: everything else is skipped by the decoder), for
//           snapshots and for the sleeping picture after the session

import { spawn } from 'node:child_process';
import { fitFilter } from './ffmpeg.mjs';
import { FrameSplitter } from './annexb.mjs';

export function passthroughArgs({ cam, url, codec }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-skip_frame', 'nokey', '-i', url, '-an',
    // Exactly one delimiter per frame, in front: the camera's own delimiters are removed first (a
    // second one would split every frame in two), then parameter sets go in front of every keyframe,
    // then one delimiter in front of every frame. So every keyframe carries its parameter sets and
    // the stream can be switched at any keyframe.
    '-map', '0:v', '-c:v', 'copy',
    '-bsf:v', `${codec}_metadata=aud=remove,dump_extra=freq=keyframe,${codec}_metadata=aud=insert`, '-f', codec, 'pipe:1',
    // passthrough: one JPEG per keyframe; otherwise ffmpeg repeats it to a constant 15 per second
    '-map', '0:v', '-vf', fitFilter(cam), '-c:v', 'mjpeg', '-q:v', '3', '-fps_mode', 'passthrough', '-f', 'image2pipe', 'pipe:3',
  ];
}

// Splits a stream of JPEGs (each from FF D8 to FF D9) into pictures.
export class JpegSplitter {
  constructor(onPicture) {
    this.onPicture = onPicture;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const start = this.buf.indexOf(Buffer.from([0xff, 0xd8]));
      const end = start < 0 ? -1 : this.buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) return;
      this.onPicture(Buffer.from(this.buf.subarray(start, end + 2)));
      this.buf = this.buf.subarray(end + 2);
    }
  }
}

// onFrame(encodedFrame), onPicture(jpeg), onClose(code) — onClose once, unless stop() was called.
export function openPassthrough({ cam, url, codec, onFrame, onPicture, onClose, log }) {
  const child = spawn('ffmpeg', passthroughArgs({ cam, url, codec }), { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  let stopped = false;
  const frames = new FrameSplitter((f) => !stopped && onFrame(f), codec);
  const pictures = new JpegSplitter((p) => !stopped && onPicture(p));
  child.stdout.on('data', (c) => frames.push(c));
  child.stdio[3].on('data', (c) => pictures.push(c));
  let errLines = 0;
  child.stderr.on('data', (c) => {
    if (++errLines <= 3) log(cam.name, 'pass-through:', String(c).trim().split('\n')[0].slice(0, 200));
  });
  child.on('error', (e) => log(cam.name, 'pass-through error:', e.message));
  child.on('close', (code) => { if (!stopped) onClose(code); });
  return {
    stop() {
      stopped = true;
      child.kill('SIGTERM');
    },
  };
}

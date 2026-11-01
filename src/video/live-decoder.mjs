// Opens a camera's live feed (the bridge's /stream/<serial>, which wakes the camera) and decodes it
// to raw frames of the camera's configured size, for the live encoder. Closing it lets the camera
// sleep within ~0.1 s. It also reports which codec the camera sends, for passing it through next time.

import { spawnFfmpeg, fitFilter, frameSize } from './ffmpeg.mjs';
import { FixedSizeSplitter } from './fixed-size.mjs';

// The camera's codec from ffmpeg's description of the input: 'h264', 'hevc', or null.
export function codecFromLog(line) {
  const match = /Stream #\d+:\d+.*: Video: (h264|hevc)\b/.exec(line);
  return match ? match[1] : null;
}

const worthLogging = (line) => /error|invalid|fail|could not|missing/i.test(line);

// Turns a byte stream of raw frames into whole frames. When several arrive at once only the newest
// matters: the stream should show "now", not catch up.
export class RawFrameAssembler {
  constructor(size) {
    this.splitter = new FixedSizeSplitter(size);
  }

  // Returns the newest complete frame in what arrived so far, or null.
  push(chunk) {
    return this.splitter.push(chunk).at(-1) ?? null;
  }
}

// onFrame(rawFrame) for every decoded picture; onCodec('h264' | 'hevc') once the input is known;
// onClose(code) once, unless stop() was called.
export function openLiveDecoder({ cam, url, onFrame, onCodec = () => {}, onClose, log }) {
  const child = spawnFfmpeg(['-fflags', 'nobuffer', '-i', url, '-an', '-vf', fitFilter(cam), '-f', 'rawvideo', 'pipe:1'],
    { logLevel: 'info' });
  const assembler = new RawFrameAssembler(frameSize(cam));
  let stopped = false;
  child.stdout.on('data', (c) => {
    if (stopped) return;   // buffered leftovers after stop()
    const frame = assembler.push(c);
    if (frame) onFrame(frame);
  });
  // H.265 streams start mid-GOP: ffmpeg complains until the first keyframe. Keep the log readable.
  let errLines = 0, codecKnown = false;
  child.stderr.on('data', (c) => {
    for (const line of String(c).split('\n')) {
      const codec = !codecKnown && codecFromLog(line);
      if (codec) {
        codecKnown = true;
        onCodec(codec);
      } else if (worthLogging(line) && ++errLines <= 3) {
        log(cam.name, 'decoder:', line.trim().slice(0, 200));
      } else if (errLines === 4) {
        errLines++;
        log(cam.name, 'decoder: (further messages suppressed this session)');
      }
    }
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

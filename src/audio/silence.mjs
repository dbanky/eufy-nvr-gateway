// One silent AAC frame in the stream's format (AAC-LC, 16 kHz, mono), made once with ffmpeg. The
// stream repeats it while a camera sleeps: an AAC frame of silence decodes the same wherever it sits.

import { runFfmpeg } from '../video/ffmpeg.mjs';
import { AdtsSplitter, STREAM_FORMAT, fitsStream } from './adts.mjs';

let made = null;

export function silentFrame() {
  made ??= runFfmpeg(['-f', 'lavfi', '-i', `anullsrc=r=${STREAM_FORMAT.sampleRate}:cl=mono`, '-t', '1',
    '-c:a', 'aac', '-b:a', '24k', '-f', 'adts', 'pipe:1'])
    .then((adts) => {
      const frames = [];
      new AdtsSplitter((f) => frames.push(f)).push(adts);
      // One from the middle: the first frames carry the encoder's start-up, the last its flush.
      const frame = frames[Math.floor(frames.length / 2)];
      if (!frame || !fitsStream(frame)) throw new Error('ffmpeg made no usable silent AAC frame');
      return frame;
    });
  return made;
}

// Encodes a still frame into a few seconds of H.264, once. The Feed then repeats those frames for
// as long as the camera sleeps, so a sleeping camera costs no encoding at all.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFfmpeg, rawInput, tint } from '../video/ffmpeg.mjs';
import { encoderArgs } from '../video/encoder-settings.mjs';
import { FrameSplitter } from '../video/annexb.mjs';
import { iconFile } from './assets.mjs';
import { SPINNER_TURN_SECONDS } from './design.mjs';

// The 1 s spinner turn fits exactly, so the loop is seamless; with an even number of keyframes,
// the last and the first one still differ (as H.264 requires of consecutive keyframes).
export const LOOP_SECONDS = 8;
// A keyframe every second: a viewer that joins while the camera sleeps waits at most 1 s.
export const LOOP_KEYFRAME_SECONDS = 1;

// spinner (waking): { name, size, cx, cy, rgb } — an arc drawn on top, one turn per second.
// codec: the stream's codec ('h264', or 'hevc' for a camera passed through as H.265).
export function loopCommand({ cam, stillFile, spinner, codec = 'h264' }) {
  const args = [...rawInput(cam), '-framerate', String(cam.fps), '-stream_loop', '-1', '-i', stillFile];
  if (spinner) {
    const size = Math.round(spinner.size / 2) * 2;
    const x = Math.round(spinner.cx - size / 2), y = Math.round(spinner.cy - size / 2);
    args.push('-loop', '1', '-framerate', String(cam.fps), '-i', iconFile(spinner.name), '-filter_complex',
      `[1:v]scale=${size}:${size},format=rgba,${tint(spinner.rgb)},rotate=a=2*PI*t/${SPINNER_TURN_SECONDS}:c=none:ow=iw:oh=ih[arc];` +
      `[0:v][arc]overlay=${x}:${y}:format=auto,format=yuv420p[v]`, '-map', '[v]');
  }
  args.push('-frames:v', String(cam.fps * LOOP_SECONDS), ...encoderArgs(cam, codec, { keyframeSeconds: LOOP_KEYFRAME_SECONDS }), 'pipe:1');
  return args;
}

// Returns the loop's encoded frames, the first one a keyframe.
export async function encodeStillLoop({ cam, still, spinner, codec = 'h264', tmpDir }) {
  const stillFile = join(tmpDir, `${cam.name}-still.yuv`);
  writeFileSync(stillFile, still);
  const frames = [];
  const splitter = new FrameSplitter((f) => frames.push(f), codec);
  splitter.push(await runFfmpeg(loopCommand({ cam, stillFile, spinner, codec })));
  splitter.flush();
  return frames;
}

// With `transcode: true`, the sleeping loop (still-loop.mjs) and the live encoder (live-encoder.mjs)
// are two different ffmpeg runs, with different keyframe intervals. Their H.264 parameter sets
// (SPS/PPS) must still be byte for byte the same: UniFi Protect keeps the first ones it sees and
// decodes everything after with them, so any difference breaks its recordings. Runs only where
// ffmpeg is installed (e.g. inside the image: CI has no ffmpeg and skips it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { encoderArgs } from '../../src/video/encoder-settings.mjs';
import { LOOP_KEYFRAME_SECONDS } from '../../src/overlay/still-loop.mjs';
import { runFfmpeg } from '../../src/video/ffmpeg.mjs';
import { FrameSplitter } from '../../src/video/annexb.mjs';
import { parameterSets } from '../../src/video/rtp.mjs';

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

async function firstKeyframeParameters(cam, keyframeSeconds, source) {
  const frames = [];
  const splitter = new FrameSplitter((f) => frames.push(f), 'h264');
  splitter.push(await runFfmpeg(['-f', 'lavfi', '-i', `${source}=size=${cam.width}x${cam.height}:rate=${cam.fps}`,
    '-frames:v', String(cam.fps * 2), ...encoderArgs(cam, 'h264', { keyframeSeconds }), 'pipe:1']));
  splitter.flush();
  return parameterSets(frames[0], 'h264');
}

test('the sleeping loop and converted live video have identical H.264 parameter sets',
  { skip: haveFfmpeg ? false : 'ffmpeg is not installed here', timeout: 120000 }, async () => {
    for (const cam of [{ width: 2048, height: 1536, fps: 15, bitrateKbps: 4400 }, { width: 2880, height: 1616, fps: 15, bitrateKbps: 6600 }]) {
      const loop = await firstKeyframeParameters(cam, LOOP_KEYFRAME_SECONDS, 'testsrc');
      const live = await firstKeyframeParameters(cam, 4, 'testsrc2');
      assert.ok(loop.sps && loop.pps, 'the loop carries its parameter sets');
      assert.deepEqual(live, loop, `${cam.width}x${cam.height}`);
    }
  });

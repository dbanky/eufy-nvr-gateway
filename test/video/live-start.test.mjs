// How soon a woken camera's picture comes out of the gateway's two readers of its stream (the live
// decoder for `transcode: true`, the passthrough copy otherwise). Each gets the camera stream's
// first keyframe and the pictures after it, and the stream then stays open, as a live one does.
// The picture must come out from that first keyframe. With `-fflags nobuffer` ffmpeg threw it away
// and waited for the next one: 4 s later on eufy cameras, and never here. Runs only where ffmpeg is
// installed (e.g. inside the image: CI has no ffmpeg and skips it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { runFfmpeg, LIVE_INPUT } from '../../src/video/ffmpeg.mjs';
import { liveDecoderArgs, codecFromLog } from '../../src/video/live-decoder.mjs';
import { passthroughArgs } from '../../src/video/passthrough.mjs';

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = haveFfmpeg ? false : 'ffmpeg is not installed here';
const cam = { name: 'garden', width: 640, height: 360 };
const WAIT_MS = 5000;

// One second of a camera-like stream: 15 fps, a keyframe every 4 s, so only the first one is in it.
const cameraStream = (codec) => runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=15', '-frames:v', '15',
  ...(codec === 'hevc' ? ['-c:v', 'libx265', '-x265-params', 'keyint=60:bframes=0:log-level=error'] : ['-c:v', 'libx264', '-g', '60', '-bf', '0']),
  '-f', codec, 'pipe:1']);

// Feeds `input` and keeps stdin open; resolves with the stderr text once `output` (stdio index) has
// sent something, or null after WAIT_MS.
function firstOutput(args, input, output) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-nostats', ...args], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    let stderr = '';
    const done = (result) => { clearTimeout(timer); child.kill('SIGKILL'); resolve(result); };
    const timer = setTimeout(() => done(null), WAIT_MS);
    child.stderr.on('data', (c) => { stderr += c; });
    for (const [i, pipe] of child.stdio.entries()) if (i > 0 && i !== 2) pipe.on('data', () => i === output && done(stderr));
    child.stdin.on('error', () => {});
    child.stdin.write(input);
  });
}

for (const codec of ['h264', 'hevc']) {
  test(`${codec}: the live decoder's first picture comes from the stream's first keyframe`, { skip, timeout: 60000 }, async () => {
    const stderr = await firstOutput(liveDecoderArgs({ cam, url: 'pipe:0' }), await cameraStream(codec), 1);
    assert.ok(stderr != null, `no picture within ${WAIT_MS} ms`);
    assert.equal(stderr.split('\n').map(codecFromLog).find(Boolean), codec, 'the codec is still recognised with the small probe');
  });

  test(`${codec}: passthrough copies from the stream's first keyframe`, { skip, timeout: 60000 }, async () => {
    const stderr = await firstOutput(passthroughArgs({ cam, url: 'pipe:0', codec }), await cameraStream(codec), 1);
    assert.ok(stderr != null, `nothing copied within ${WAIT_MS} ms`);
  });
}

test('the old input option really did lose the first keyframe (what this file guards against)', { skip, timeout: 60000 }, async () => {
  const args = liveDecoderArgs({ cam, url: 'pipe:0' });
  const old = ['-fflags', 'nobuffer', ...args.slice(LIVE_INPUT.length)];
  assert.equal(await firstOutput(old, await cameraStream('h264'), 1), null);
});

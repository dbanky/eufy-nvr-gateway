// The ffmpeg helpers every encoder and decoder builds on. The pure ones are tested everywhere; the
// ones that run ffmpeg only where it is installed (in the image, in CI).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rawInput, frameSize, fitFilter, tint, runFfmpeg, encodeJpeg } from '../../src/video/ffmpeg.mjs';

const cam = { width: 2048, height: 1536 };
const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('raw pictures (yuv420p)', () => {
  test('one picture is 1.5 bytes per pixel: full brightness, quarter-size colour twice', () => {
    assert.equal(frameSize(cam), 2048 * 1536 * 1.5);
    assert.equal(frameSize({ width: 64, height: 36 }), 3456);
  });

  test('the input arguments name the format and the camera\'s size', () => {
    assert.deepEqual(rawInput(cam), ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '2048x1536']);
  });
});

describe('the fit filter', () => {
  test('scales into the camera\'s size keeping the aspect ratio, pads the rest, centred', () => {
    assert.equal(fitFilter(cam),
      'scale=2048:1536:force_original_aspect_ratio=decrease,pad=2048:1536:(ow-iw)/2:(oh-ih)/2,format=yuv420p');
  });
});

describe('icon colours', () => {
  test('white made the given colour, opacity scaled', () => {
    assert.equal(tint([255, 196, 71]), 'lutrgb=r=255:g=196:b=71:a=val*1');
    assert.equal(tint([10, 20, 30], 0.5), 'lutrgb=r=10:g=20:b=30:a=val*0.5');
  });
});

describe('running ffmpeg', { skip: haveFfmpeg ? false : 'ffmpeg is not installed here' }, () => {
  test('resolves with what ffmpeg wrote', async () => {
    const out = await runFfmpeg([...rawInput({ width: 16, height: 16 }), '-i', 'pipe:0', '-f', 'rawvideo', 'pipe:1'], Buffer.alloc(384, 128));
    assert.equal(out.length, 384);
  });

  test('a failure rejects with ffmpeg\'s exit code and message', async () => {
    await assert.rejects(runFfmpeg(['-i', '/nonexistent/x.mp4', '-f', 'null', '-']), { message: /^ffmpeg \d+: [\s\S]*nonexistent/ });
  });

  test('a raw picture becomes a JPEG', async () => {
    const jpeg = await encodeJpeg({ width: 16, height: 16 }, Buffer.alloc(384, 128));
    assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
  });
});

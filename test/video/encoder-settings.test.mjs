import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encoderArgs } from '../../src/video/encoder-settings.mjs';

describe('encoder settings (H.264: live video and sleeping loops)', () => {
  const args = encoderArgs({ fps: 15, bitrateKbps: 6000 });
  const value = (flag) => args[args.indexOf(flag) + 1];

  test('a keyframe every 4 s: where an NVR can join and where the stream can switch', () => {
    assert.equal(value('-g'), '60');
    assert.equal(value('-keyint_min'), '60');
  });

  test('frame delimiters are on, so the output can be split into frames', () => {
    assert.match(value('-x264-params'), /aud=1/);
  });

  test('a cheaper motion search (diamond, subpixel level 1): ~30 % less encoder CPU', () => {
    assert.match(value('-x264-params'), /me=dia/);
    assert.match(value('-x264-params'), /subme=1/);
  });

  test('the bitrate limit follows the camera setting', () => {
    assert.equal(value('-maxrate'), '6000k');
  });

  test('the sleeping loop asks for a keyframe every second: a viewer joins (and the loop takes over) sooner', () => {
    const loop = encoderArgs({ fps: 15, bitrateKbps: 6000 }, 'h264', { keyframeSeconds: 1 });
    assert.equal(loop[loop.indexOf('-g') + 1], '15');
    assert.equal(loop[loop.indexOf('-keyint_min') + 1], '15');
  });

  test('one slice per picture: UniFi Protect\'s live view takes each slice for a frame and stalls', () => {
    assert.match(value('-x264-params'), /sliced-threads=0/, 'zerolatency would slice every picture by thread');
  });
});

describe('encoder settings (H.265: sleeping loops of a camera passed through as H.265)', () => {
  const args = encoderArgs({ fps: 15, bitrateKbps: 6000 }, 'hevc');
  const params = args[args.indexOf('-x265-params') + 1];

  test('x265, fast enough for a still picture', () => {
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx265');
    assert.equal(args[args.indexOf('-preset') + 1], 'ultrafast');
  });

  test('the same structure as a camera stream: keyframe every 4 s, closed GOPs, no B-frames', () => {
    assert.match(params, /keyint=60:min-keyint=60/);
    assert.match(params, /open-gop=0/);
    assert.match(params, /bframes=0/);
  });

  test('the sleeping loop: a keyframe every second', () => {
    const loop = encoderArgs({ fps: 15, bitrateKbps: 6000 }, 'hevc', { keyframeSeconds: 1 });
    assert.match(loop[loop.indexOf('-x265-params') + 1], /keyint=15:min-keyint=15/);
  });

  test('frame delimiters and parameter sets on every keyframe, so it can be spliced', () => {
    assert.match(params, /aud=1/);
    assert.match(params, /repeat-headers=1/);
  });

  test('raw H.265 output', () => {
    assert.equal(args.at(-1), 'hevc');
  });
});

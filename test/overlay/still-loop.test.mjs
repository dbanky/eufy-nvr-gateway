import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loopCommand, LOOP_SECONDS } from '../../src/overlay/still-loop.mjs';

describe('the loop', () => {
  const cam = { name: 'garden', width: 1920, height: 1080, fps: 15, bitrateKbps: 4000 };
  const value = (args, flag) => args[args.indexOf(flag) + 1];

  test(`is ${LOOP_SECONDS} s long`, () => {
    assert.equal(value(loopCommand({ cam, stillFile: '/tmp/x.yuv' }), '-frames:v'), String(15 * LOOP_SECONDS));
  });

  test('has a keyframe every second (H.264 and H.265): a new viewer sees the picture within a second', () => {
    assert.equal(value(loopCommand({ cam, stillFile: '/tmp/x.yuv' }), '-g'), '15');
    assert.match(value(loopCommand({ cam, stillFile: '/tmp/x.yuv', codec: 'hevc' }), '-x265-params'), /keyint=15:/);
  });

  test('is H.264, or H.265 when the camera\'s own H.265 is passed through', () => {
    assert.ok(loopCommand({ cam, stillFile: '/tmp/x.yuv' }).includes('libx264'));
    assert.ok(loopCommand({ cam, stillFile: '/tmp/x.yuv', codec: 'hevc' }).includes('libx265'));
  });

  test('while waking, a spinner turns on top of the still', () => {
    const spinner = { name: 'ring-arc', size: 200, cx: 960, cy: 540, rgb: [255, 196, 71] };
    assert.match(value(loopCommand({ cam, stillFile: '/tmp/x.yuv', spinner }), '-filter_complex'), /rotate=a=2\*PI\*t/);
  });
});

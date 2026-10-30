import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rasterize, capsuleDistance } from '../../src/overlay/raster.mjs';
import { pictureFilter, stillCommand } from '../../src/overlay/render-still.mjs';
import { loopCommand, LOOP_SECONDS } from '../../src/overlay/still-loop.mjs';

describe('drawing shapes', () => {
  const alphaAt = (px, width, x, y) => px[(y * width + x) * 4 + 3];

  test('a capsule is opaque inside, transparent outside, soft on its edge', () => {
    const px = rasterize(40, 20, [{ x: 0, y: 0, w: 40, h: 20, fill: [0, 0, 0], fillAlpha: 1 }]);
    assert.equal(alphaAt(px, 40, 20, 10), 255);   // centre
    assert.equal(alphaAt(px, 40, 0, 0), 0);       // corner, outside the rounded end
  });

  test('the distance is negative inside the shape', () => {
    const pill = { x: 0, y: 0, w: 40, h: 20 };
    assert.ok(capsuleDistance(pill, 20, 10) < 0);
    assert.ok(capsuleDistance(pill, 0, 0) > 0);
  });
});

describe('the sleeping look', () => {
  test('a blur of 10 px at 1080p, scaled with the frame height', () => {
    assert.match(pictureFilter({ height: 1080 }), /gblur=sigma=10\.0/);
    assert.match(pictureFilter({ height: 1620 }), /gblur=sigma=15\.0/);
  });

  test('dimmed and desaturated', () => {
    assert.match(pictureFilter({ height: 1080 }), /y=val\*0\.78/);
  });
});

describe('the ffmpeg command for a still', () => {
  const cam = { name: 'garden', width: 1920, height: 1080 };
  const layout = { icons: [], texts: [] };
  const command = (base) => stillCommand({ cam, base, layout, shapesFile: '/tmp/s.rgba', textFile: () => '/tmp/t.txt' });

  test('the last live frame is piped in raw', () => {
    const raw = Buffer.alloc(1);
    const { args, input } = command({ raw });
    assert.equal(input, raw);
    assert.ok(args.includes('pipe:0'));
  });

  test('with no picture: a plain dark background, nothing to blur', () => {
    const { args } = command(null);
    assert.ok(args.some((a) => a.startsWith('color=c=0x15171C')));
    assert.ok(!args.join(' ').includes('gblur'));
  });
});

describe('the loop', () => {
  const cam = { name: 'garden', width: 1920, height: 1080, fps: 15, bitrateKbps: 4000 };
  const value = (args, flag) => args[args.indexOf(flag) + 1];

  test(`is ${LOOP_SECONDS} s long: two keyframe intervals`, () => {
    assert.equal(value(loopCommand({ cam, stillFile: '/tmp/x.yuv' }), '-frames:v'), String(15 * LOOP_SECONDS));
  });

  test('while waking, a spinner turns on top of the still', () => {
    const spinner = { name: 'ring-arc', size: 200, cx: 960, cy: 540, rgb: [255, 196, 71] };
    assert.match(value(loopCommand({ cam, stillFile: '/tmp/x.yuv', spinner }), '-filter_complex'), /rotate=a=2\*PI\*t/);
  });
});

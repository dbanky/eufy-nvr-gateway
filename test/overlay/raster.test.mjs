import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rasterize, capsuleDistance } from '../../src/overlay/raster.mjs';

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

// Motion seen in the live picture itself: tiny grey thumbnails of consecutive keyframes compared.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { THUMB_WIDTH, THUMB_HEIGHT, changedShare, pictureMoved, thumbnailFromLuma, ThumbnailSplitter } from '../../src/switcher/picture-motion.mjs';

const CELLS = THUMB_WIDTH * THUMB_HEIGHT;
const flat = (v) => Buffer.alloc(CELLS, v);
// A thumbnail with a "person": a block of cells brighter than the rest.
const withBlock = (base, { x = 10, y = 6, w = 6, h = 10, v = 200 } = {}) => {
  const t = Buffer.from(base);
  for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) t[r * THUMB_WIDTH + c] = v;
  return t;
};

describe('a moving picture', () => {
  test('the same picture again: nothing moved', () => {
    assert.equal(changedShare(flat(90), flat(90)), 0);
    assert.equal(pictureMoved(flat(90), flat(90)), false);
  });

  test('the camera\'s exposure changing the whole picture a little is not motion', () => {
    assert.equal(pictureMoved(flat(90), flat(110)), false);
  });

  test('sensor noise (a few levels per cell) is not motion', () => {
    const noisy = Buffer.from(flat(90).map((v, i) => v + ((i * 7) % 9) - 4));
    assert.equal(pictureMoved(flat(90), noisy), false);
  });

  test('someone walking through (a part of the picture changes) is motion', () => {
    const before = withBlock(flat(80), { x: 4 }), after = withBlock(flat(80), { x: 14 });
    assert.ok(changedShare(before, after) > 0.05);
    assert.equal(pictureMoved(before, after), true);
  });

  test('a tiny change (one or two cells) is not enough', () => {
    assert.equal(pictureMoved(flat(80), withBlock(flat(80), { w: 1, h: 2 })), false);
  });

  test('no earlier picture, or pictures of another size: nothing to compare', () => {
    assert.equal(pictureMoved(null, flat(80)), false);
    assert.equal(pictureMoved(Buffer.alloc(10), flat(80)), false);
  });
});

describe('a thumbnail from a raw picture (when converting)', () => {
  test('averages the brightness (Y plane) into 32×24 cells', () => {
    const width = 64, height = 48;
    const yuv = Buffer.alloc(width * height * 1.5, 128);
    for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) yuv[r * width + c] = c < width / 2 ? 0 : 200;
    const t = thumbnailFromLuma(yuv, width, height);
    assert.equal(t.length, CELLS);
    assert.equal(t[0], 0);
    assert.equal(t[THUMB_WIDTH - 1], 200);
  });
});

test('thumbnails from the decoder come out whole, however the bytes arrive', () => {
  const got = [];
  const splitter = new ThumbnailSplitter((t) => got.push(t));
  const two = Buffer.concat([Buffer.alloc(CELLS, 1), Buffer.alloc(CELLS, 2)]);
  splitter.push(two.subarray(0, 100));
  splitter.push(two.subarray(100));
  assert.deepEqual(got.map((t) => [t.length, t[0]]), [[CELLS, 1], [CELLS, 2]]);
});

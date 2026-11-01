import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FixedSizeSplitter } from '../../src/video/fixed-size.mjs';

test('pieces of one size, however the bytes arrive', () => {
  const splitter = new FixedSizeSplitter(3);
  assert.deepEqual(splitter.push(Buffer.from([1, 2])), []);
  assert.deepEqual(splitter.push(Buffer.from([3, 4, 5, 6, 7])).map((p) => [...p]), [[1, 2, 3], [4, 5, 6]]);
  assert.deepEqual(splitter.push(Buffer.from([8, 9])).map((p) => [...p]), [[7, 8, 9]]);
});

test('a piece is its own copy: the chunk it came from can be reused', () => {
  const splitter = new FixedSizeSplitter(2);
  const chunk = Buffer.from([1, 2]);
  const [piece] = splitter.push(chunk);
  chunk.fill(0);
  assert.deepEqual([...piece], [1, 2]);
});

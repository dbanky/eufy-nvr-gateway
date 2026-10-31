import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldWrite, HEARTBEAT_MS } from '../../src/video/live-encoder.mjs';

describe('feeding the live encoder', () => {
  const frame = Buffer.alloc(1), other = Buffer.alloc(1);

  test('a new picture is written at once', () => {
    assert.equal(shouldWrite({ frame: other, lastWritten: frame, lastWriteAt: 1000, now: 1001 }), true);
  });

  test('the same picture only once per heartbeat (raw 3K frames are 7 MB)', () => {
    assert.equal(shouldWrite({ frame, lastWritten: frame, lastWriteAt: 1000, now: 1000 + HEARTBEAT_MS - 1 }), false);
    assert.equal(shouldWrite({ frame, lastWritten: frame, lastWriteAt: 1000, now: 1000 + HEARTBEAT_MS }), true);
  });
});

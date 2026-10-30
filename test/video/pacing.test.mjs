import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { framesDue } from '../../src/video/publisher.mjs';
import { shouldWrite, HEARTBEAT_MS } from '../../src/video/live-encoder.mjs';
import { RawFrameAssembler } from '../../src/video/live-decoder.mjs';
import { x264Args } from '../../src/video/x264.mjs';

describe('the publisher sends at exactly the frame rate', () => {
  test('the first frame at once, then one every 1/fps second', () => {
    assert.equal(framesDue(0, 15), 1);
    assert.equal(framesDue(66, 15), 1);
    assert.equal(framesDue(67, 15), 2);
    assert.equal(framesDue(60000, 15), 901);
  });
});

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

describe('decoded live frames', () => {
  test('are only handed out whole', () => {
    const assembler = new RawFrameAssembler(4);
    assert.equal(assembler.push(Buffer.from([1, 2, 3])), null);
    assert.deepEqual([...assembler.push(Buffer.from([4, 5]))], [1, 2, 3, 4]);
  });

  test('when several arrive at once, only the newest counts: the stream shows "now"', () => {
    const assembler = new RawFrameAssembler(2);
    assert.deepEqual([...assembler.push(Buffer.from([1, 1, 2, 2, 3]))], [2, 2]);
    assert.deepEqual([...assembler.push(Buffer.from([3]))], [3, 3]);
  });
});

describe('encoder settings', () => {
  const args = x264Args({ fps: 15, bitrateKbps: 6000 });
  const value = (flag) => args[args.indexOf(flag) + 1];

  test('a keyframe every 4 s: where an NVR can join and where the stream can switch', () => {
    assert.equal(value('-g'), '60');
    assert.equal(value('-keyint_min'), '60');
  });

  test('frame delimiters are on, so the output can be split into frames', () => {
    assert.match(value('-x264-params'), /aud=1/);
  });

  test('the bitrate limit follows the camera setting', () => {
    assert.equal(value('-maxrate'), '6000k');
  });
});

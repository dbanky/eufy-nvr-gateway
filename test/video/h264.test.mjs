import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FrameSplitter, isKeyframe } from '../../src/video/h264.mjs';
import { keyframe, deltaFrame, tagOf } from '../helpers/h264.mjs';

describe('splitting an encoder\'s output into frames', () => {
  const split = (chunks) => {
    const frames = [];
    const splitter = new FrameSplitter((f) => frames.push(f));
    for (const chunk of chunks) splitter.push(chunk);
    splitter.flush();
    return frames;
  };

  test('each frame starts at an access unit delimiter', () => {
    const frames = split([Buffer.concat([keyframe(1), deltaFrame(2), deltaFrame(3)])]);
    assert.deepEqual(frames.map(tagOf), [1, 2, 3]);
  });

  test('frames split across chunks arrive whole', () => {
    const stream = Buffer.concat([keyframe(1), deltaFrame(2)]);
    const frames = split([stream.subarray(0, 5), stream.subarray(5, 13), stream.subarray(13)]);
    assert.deepEqual(frames, [keyframe(1), deltaFrame(2)]);
  });

  test('a frame is only handed out once the next one starts, or the stream ends', () => {
    const frames = [];
    const splitter = new FrameSplitter((f) => frames.push(f));
    splitter.push(keyframe(1));
    assert.equal(frames.length, 0);
    splitter.flush();
    assert.equal(frames.length, 1);
  });
});

test('a keyframe (IDR) is where a stream may be joined or switched', () => {
  assert.equal(isKeyframe(keyframe()), true);
  assert.equal(isKeyframe(deltaFrame()), false);
});

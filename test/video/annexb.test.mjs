import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FrameSplitter, isKeyframe } from '../../src/video/annexb.mjs';
import { keyframe, deltaFrame, hevcKeyframe, hevcDeltaFrame, tagOf } from '../helpers/h264.mjs';

const split = (chunks, codec) => {
  const frames = [];
  const splitter = new FrameSplitter((f) => frames.push(f), codec);
  for (const chunk of chunks) splitter.push(chunk);
  splitter.flush();
  return frames;
};

describe("splitting an encoder's output into frames", () => {
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

  test('a "frame" without a picture (only a delimiter or parameter sets) joins the next one', () => {
    const emptyDelimiter = Buffer.from([0, 0, 0, 1, 0x09, 0xf0]);
    const frames = split([Buffer.concat([emptyDelimiter, keyframe(1), emptyDelimiter, deltaFrame(2)])]);
    assert.deepEqual(frames.map(tagOf), [1, 2], 'two pictures, two frames');
    const delimiters = (f) => f.toString('hex').split('00000109').length - 1;
    assert.deepEqual(frames.map(delimiters), [1, 1], 'and still one delimiter each');
  });

  test('H.265 streams too (the camera\'s own video, when conversion is off)', () => {
    const frames = split([Buffer.concat([hevcKeyframe(1), hevcDeltaFrame(2), hevcDeltaFrame(3)])], 'hevc');
    assert.deepEqual(frames.map(tagOf), [1, 2, 3]);
  });
});

describe('a keyframe is where a stream may be joined or switched', () => {
  test('H.264: an IDR slice', () => {
    assert.equal(isKeyframe(keyframe()), true);
    assert.equal(isKeyframe(deltaFrame()), false);
  });

  test('H.265: an IRAP picture (IDR, CRA, BLA)', () => {
    assert.equal(isKeyframe(hevcKeyframe(), 'hevc'), true);
    assert.equal(isKeyframe(hevcDeltaFrame(), 'hevc'), false);
  });
});

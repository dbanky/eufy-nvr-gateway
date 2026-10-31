import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Feed } from '../../../src/video/feed.mjs';
import { loop, take } from './frames.mjs';
import { hevcDeltaFrame, hevcKeyframe, keyframe } from '../../helpers/h264.mjs';

describe('the codec of the stream', () => {
  test('is H.264 until a loop in another codec is shown', () => {
    const feed = new Feed();
    assert.equal(feed.codec, 'h264');
    feed.showLoop([hevcKeyframe(1)], 'hevc');
    assert.equal(feed.codec, 'hevc');
  });

  test('a change is announced: the publisher must restart with the new format', () => {
    const feed = new Feed();
    const changes = [];
    feed.on('codec', (c) => changes.push(c));
    feed.showLoop(loop);
    feed.showLoop([hevcKeyframe(1)], 'hevc');
    feed.showLoop([hevcKeyframe(2)], 'hevc');
    assert.deepEqual(changes, ['hevc']);
  });

  test('H.265 live video switches at an H.265 keyframe', () => {
    const feed = new Feed();
    feed.showLoop([hevcKeyframe(1)], 'hevc');
    feed.armLive();
    feed.pushLive(hevcDeltaFrame(2));
    assert.equal(feed.mode, 'loop');
    feed.pushLive(hevcKeyframe(3));
    assert.equal(feed.mode, 'live');
  });
});

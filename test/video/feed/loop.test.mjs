import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Feed } from '../../../src/video/feed.mjs';
import { loop, take } from './frames.mjs';
import { deltaFrame, keyframe } from '../../helpers/h264.mjs';

describe('while the camera sleeps', () => {
  test('the loop repeats forever', () => {
    const feed = new Feed();
    feed.showLoop(loop);
    assert.deepEqual(take(feed, 7), [1, 2, 3, 1, 2, 3, 1]);
  });

  test('a new loop starts from its first frame (a keyframe) right away', () => {
    const feed = new Feed();
    feed.showLoop(loop);
    take(feed, 2);
    feed.showLoop([keyframe(7), deltaFrame(8)]);
    assert.deepEqual(take(feed, 3), [7, 8, 7]);
  });

  test('before anything is rendered there is nothing to send', () => {
    assert.equal(new Feed().next(), undefined);
  });
});

describe('a receiver that needs a clean start (a restarted publisher)', () => {
  test('gets the loop from its keyframe', () => {
    const feed = new Feed();
    feed.showLoop(loop);
    take(feed, 2);
    assert.deepEqual(take(feed, 1, { fromKeyframe: true }), [1]);
  });

  test('gets live from the next keyframe, skipping frames before it', () => {
    const feed = new Feed();
    feed.armLive();
    feed.pushLive(keyframe(1));
    feed.next();
    feed.pushLive(deltaFrame(2));
    feed.pushLive(keyframe(3));
    assert.deepEqual(take(feed, 1, { fromKeyframe: true }), [3]);
  });
});

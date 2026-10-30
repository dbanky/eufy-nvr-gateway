import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Feed } from '../../src/video/feed.mjs';
import { keyframe, deltaFrame, tagOf } from '../helpers/h264.mjs';

const loop = [keyframe(1), deltaFrame(2), deltaFrame(3)];
const take = (feed, n, options) => Array.from({ length: n }, () => feed.next(options)).map((f) => f && tagOf(f));

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

describe('going live', () => {
  test('live frames are ignored until live is armed', () => {
    const feed = new Feed();
    feed.showLoop(loop);
    feed.pushLive(keyframe(10));
    assert.equal(feed.mode, 'loop');
  });

  test('once armed, the switch happens at the first live keyframe — never mid-picture', () => {
    const feed = new Feed();
    feed.showLoop(loop);
    feed.armLive();
    feed.pushLive(deltaFrame(9));      // can't start a picture with this
    assert.equal(feed.mode, 'loop');
    feed.pushLive(keyframe(10));
    feed.pushLive(deltaFrame(11));
    assert.equal(feed.mode, 'live');
    assert.deepEqual(take(feed, 3), [10, 11, undefined]);   // waits for the encoder rather than repeating
  });

  test('back to a loop ends live', () => {
    const feed = new Feed();
    feed.armLive();
    feed.pushLive(keyframe(10));
    feed.showLoop(loop);
    feed.pushLive(keyframe(12));
    assert.deepEqual(take(feed, 1), [1]);
  });

  test('a backlog is cut short rather than adding delay', () => {
    const feed = new Feed({ maxLiveBacklog: 4 });
    feed.armLive();
    for (let i = 0; i < 6; i++) feed.pushLive(keyframe(i));
    assert.ok(feed.liveQueue.length <= 4);
    assert.equal(tagOf(feed.liveQueue.at(-1)), 5, 'the newest frame is kept');
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

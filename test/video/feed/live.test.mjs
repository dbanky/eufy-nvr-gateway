import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Feed } from '../../../src/video/feed.mjs';
import { loop, take } from './frames.mjs';
import { deltaFrame, keyframe, tagOf } from '../../helpers/h264.mjs';

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

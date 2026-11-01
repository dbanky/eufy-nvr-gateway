// The live feed's edges: reconnecting mid-session, and what a pass-through session leaves behind.
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setup, livePicture } from './world.mjs';
import { keyframe } from '../../helpers/h264.mjs';
import { THUMB_WIDTH, THUMB_HEIGHT } from '../../../src/switcher/picture-motion.mjs';

function passingThrough(settings = {}) {
  const { cam, world } = setup({ holdMs: 30000, ...settings });
  cam.codec = 'h264';
  world.feed.showLoop([keyframe()], 'h264');
  return { cam, world };
}

describe('a feed that drops mid-session', () => {
  test('is not re-opened once the hold time is over: the session ends', () => {
    const { cam, world } = setup({ holdMs: 10000 });
    cam.trigger('motion');
    world.liveFeeds[0].onFrame(livePicture);
    world.advance(10001);
    world.liveFeeds[0].onClose(1);
    assert.equal(cam.state, 'IDLE');
    assert.equal(world.liveFeeds.length, 1);
    assert.match(world.logs.join('\n'), /feed closed \(1\)/);
  });

  test('a reconnect that comes due after the session ended opens nothing', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { cam, world } = setup();
      cam.trigger('motion');
      world.liveFeeds[0].onFrame(livePicture);
      world.liveFeeds[0].onClose(1);   // reconnect in 2 s...
      cam.stop('manual');              // ...but the session ends first
      mock.timers.tick(2000);
      assert.equal(world.liveFeeds.length, 1);
    } finally {
      mock.timers.reset();
    }
  });

  test('passing through, the re-opened feed still reports movement in the picture', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { cam, world } = passingThrough({ maxReconnects: 1 });
      cam.trigger('motion');
      world.liveFeeds[0].onFrame(keyframe());
      assert.equal(cam.state, 'LIVE');
      world.liveFeeds[0].onClose(1);
      mock.timers.tick(2000);
      const again = world.liveFeeds[1];
      assert.equal(again.mode, 'passthrough');
      const still = Buffer.alloc(THUMB_WIDTH * THUMB_HEIGHT, 80), moved = Buffer.from(still).fill(220, 0, 200);
      again.onThumbnail(still);
      world.advance(25000);
      again.onThumbnail(moved);
      assert.ok(cam.deadline >= world.now + 30000 - 1, 'the movement pushed the end back');
    } finally {
      mock.timers.reset();
    }
  });
});

describe('what a pass-through session leaves behind', () => {
  test('one that never went live keeps no picture and closes its feed at once', async () => {
    const { cam, world } = passingThrough({ firstFrameTimeoutMs: 60000 });
    cam.trigger('motion');
    world.advance(60001);
    cam.check();
    await world.settle();
    assert.deepEqual(world.savedFrames, []);
    assert.equal(world.liveFeeds[0].stopped, true);
    assert.equal(cam.closeWhenShown, null);
  });

  test('one that went live keeps its last keyframe picture as the sleeping picture', async () => {
    const { cam, world } = passingThrough();
    cam.trigger('motion');
    const feed = world.liveFeeds[0];
    feed.onFrame(keyframe());
    feed.onPicture(Buffer.from('jpeg 1'));
    feed.onPicture(Buffer.from('jpeg 2'));
    cam.stop('hold time over');
    await world.settle();
    assert.deepEqual(world.savedFrames, [{ jpeg: Buffer.from('jpeg 2') }]);
  });
});

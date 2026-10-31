// The end of a session: going back to sleep, and what happens when the feed drops.
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setup, livePicture } from './world.mjs';

describe('the end of a session', () => {
  test('closes the live feed, keeps the last frame and shows "Sleeping since"', async () => {
    const { cam, world } = setup({ holdMs: 10000 });
    cam.trigger('motion');
    world.liveFeeds[0].onFrame(livePicture);
    world.advance(10001);
    cam.check();
    await world.settle();
    assert.equal(cam.state, 'IDLE');
    assert.equal(world.liveFeeds[0].stopped, true);
    assert.deepEqual(world.savedFrames, [{ raw: livePicture }]);
    assert.deepEqual(cam.picture, { raw: livePicture });
    assert.deepEqual(world.lastRender(), { kind: 'asleep', title: 'Sleeping', detail: 'since 18:00' });
  });

  test('the live encoder stays on air until the sleeping picture is ready', async () => {
    const { cam, world } = setup({ holdMs: 10000 });
    cam.trigger('motion');
    world.liveFeeds[0].onFrame(livePicture);
    world.advance(10001);
    cam.check();
    assert.equal(world.encoder.running, true, 'still running while the picture renders');
    await world.settle();
    assert.equal(world.encoder.running, false);
    assert.equal(world.feed.mode, 'loop');
  });

  test('a camera that sends no picture in time: "Didn\'t wake up"', async () => {
    const { cam, world } = setup({ firstFrameTimeoutMs: 60000 });
    cam.picture = { file: 'last.jpg' };
    cam.trigger('motion');
    world.advance(60001);
    cam.check();
    await world.settle();
    assert.equal(world.lastRender().kind, 'nowake');
    assert.deepEqual(world.savedFrames, [], 'there was no live frame to keep');
  });

  test('a sleeping picture still rendering when the camera goes live is thrown away', async () => {
    const { cam, world } = setup();
    cam.trigger('motion');                 // starts rendering "Waking up"
    world.liveFeeds[0].onFrame(livePicture); // live before that render finished
    await world.settle();
    assert.equal(cam.frame, livePicture);
    assert.equal(world.feed.loop, null, 'the waking loop never reached the stream');
  });
});

describe('a feed that drops mid-session', () => {
  test('is re-opened after 2 s, up to maxReconnects times, then the session ends', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { cam, world } = setup({ maxReconnects: 1 });
      cam.trigger('motion');
      world.liveFeeds[0].onFrame(livePicture);
      world.liveFeeds[0].onClose(1);
      mock.timers.tick(2000);
      assert.equal(world.liveFeeds.length, 2);
      world.liveFeeds[1].onClose(1);
      assert.equal(cam.state, 'IDLE');
    } finally {
      mock.timers.reset();
    }
  });
});

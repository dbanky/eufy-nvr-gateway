// Waking up: what wakes a camera, what doesn't, and going live.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup, livePicture } from './world.mjs';

describe('a motion event', () => {
  test('wakes the camera: the live feed opens and the stream says "Waking up"', async () => {
    const { cam, world } = setup();
    cam.trigger('motion');
    await world.settle();
    assert.equal(cam.state, 'WAKING');
    assert.equal(world.liveFeeds.length, 1);
    assert.deepEqual(world.lastRender(), { kind: 'waking', title: 'Waking up', detail: 'Motion detected · 18:00' });
  });

  test('the first live picture switches to LIVE and starts the encoder', () => {
    const { cam, world } = setup();
    cam.trigger('motion');
    world.advance(5000);
    world.liveFeeds[0].onFrame(livePicture);
    assert.equal(cam.state, 'LIVE');
    assert.equal(world.encoder.running, true);
    assert.equal(world.feed.liveArmed, true);
    assert.equal(cam.frame, livePicture);
  });

  test('stays live while motion continues, and stops 30 s after the last detection', () => {
    const { cam, world } = setup();
    cam.trigger('motion');
    world.liveFeeds[0].onFrame(livePicture);
    for (let i = 0; i < 30; i++) {   // ten minutes of motion, a detection every 20 s
      world.advance(20000);
      cam.trigger('motion');
      cam.check();
    }
    assert.equal(cam.state, 'LIVE', 'still live after 10 minutes of motion');
    world.advance(29000);
    cam.check();
    assert.equal(cam.state, 'LIVE', 'the last detection was less than 30 s ago');
    world.advance(2000);
    cam.check();
    assert.equal(cam.state, 'IDLE', 'no motion for 30 s');
  });

  test('a second event while awake extends the session instead of waking it twice', () => {
    const { cam, world } = setup();
    cam.trigger('motion');
    world.liveFeeds[0].onFrame(livePicture);
    const deadline = cam.deadline;
    world.advance(60000);
    cam.trigger('personDetected');
    assert.equal(world.liveFeeds.length, 1);
    assert.equal(cam.deadline, deadline + 60000);
  });
});

describe('the battery', () => {
  test('below the limit, motion is ignored but the doorbell still wakes the camera', () => {
    const { cam, world } = setup({ minBatteryPct: 15 });
    cam.battery = 10;
    cam.trigger('motion');
    assert.equal(cam.state, 'IDLE');
    cam.trigger('doorbellPress');
    assert.equal(cam.state, 'WAKING');
    assert.equal(world.liveFeeds.length, 1);
  });
});

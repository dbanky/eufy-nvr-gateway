// The "Waking up" picture is prepared while the camera sleeps, so it is on the stream the moment a
// trigger arrives. Rendering it only then is too slow: an H.265 loop on a small NAS takes longer than
// the camera takes to wake up, and it would never be seen.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup, livePicture } from './world.mjs';

describe('the "Waking up" picture', () => {
  test('is prepared in the background once the sleeping picture is on the stream', async () => {
    const { cam, world } = setup();
    cam.picture = { file: 'last.jpg' };
    await cam.refresh();
    await world.settle();
    assert.equal(world.prepared.length, 1);
  });

  test('is on the stream at once when a trigger arrives, before the one with the reason is rendered', async () => {
    const { cam, world } = setup();
    cam.picture = { file: 'last.jpg' };
    await cam.refresh();
    await world.settle();
    cam.trigger('personDetected');
    assert.equal(String(cam.frame), 'still:waking', 'shown without waiting for a render');
    await world.settle();
    assert.equal(world.lastRender().detail, 'Person detected · 18:00', 'then replaced by the one with the reason');
  });

  test('is not prepared again while the sleeping picture stays the same', async () => {
    const { cam, world } = setup();
    cam.picture = { file: 'last.jpg' };
    await cam.refresh();
    await world.settle();
    world.offline = 'login';                // a different label on the same picture
    await cam.refresh();
    await world.settle();
    assert.equal(world.prepared.length, 1);
  });

  test('is prepared again for the new picture after a session', async () => {
    const { cam, world } = setup({ holdMs: 10000 });
    cam.picture = { file: 'last.jpg' };
    await cam.refresh();
    await world.settle();
    cam.trigger('motion');
    world.liveFeeds[0].onFrame(livePicture);
    world.advance(10001);
    cam.check();
    await world.settle();
    await world.settle();
    assert.equal(world.prepared.length, 2);
  });
});

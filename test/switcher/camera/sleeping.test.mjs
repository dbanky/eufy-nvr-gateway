// What a camera that is not live puts on its stream.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './world.mjs';

describe('a sleeping camera', () => {
  test('without any picture yet shows "No picture yet"', async () => {
    const { cam, world } = setup();
    await cam.refresh();
    assert.equal(world.lastRender().kind, 'nopicture');
  });

  test('is rendered once per change, not on every refresh', async () => {
    const { cam, world } = setup();
    await cam.refresh();
    await cam.refresh();
    assert.equal(world.renders.length, 1);
  });

  test('shows the offline label when eufy is unreachable, and goes back when it returns', async () => {
    const { cam, world } = setup();
    cam.picture = { file: 'last.jpg' };
    world.offline = 'login';
    await cam.refresh();
    assert.equal(world.lastRender().kind, 'offline');
    world.offline = null;
    await cam.refresh();
    assert.equal(world.lastRender().kind, 'asleep');
  });
});

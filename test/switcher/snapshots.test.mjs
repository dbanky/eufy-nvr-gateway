import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshots } from '../../src/switcher/snapshots.mjs';

function setup() {
  let now = 0, encodes = 0;
  const snapshot = createSnapshots(async (cam, frame) => { encodes++; return Buffer.from(`jpeg of ${frame}`); }, () => now);
  return { snapshot, encodes: () => encodes, advance: (ms) => { now += ms; } };
}

test('a snapshot is a JPEG of what the stream shows', async () => {
  const { snapshot } = setup();
  assert.equal(String(await snapshot({ state: 'IDLE', frame: 'still' })), 'jpeg of still');
});

test('the same picture is encoded only once every 2 s, however often the page asks', async () => {
  const { snapshot, encodes, advance } = setup();
  const camera = { state: 'IDLE', frame: 'still' };
  await snapshot(camera);
  await snapshot(camera);
  assert.equal(encodes(), 1);
  advance(2000);
  await snapshot(camera);
  assert.equal(encodes(), 2);
});

test("while passing through, it is the camera's newest keyframe picture", async () => {
  const { snapshot, encodes } = setup();
  const jpeg = Buffer.from('keyframe');
  assert.equal(await snapshot({ state: 'LIVE', liveJpeg: jpeg, frame: 'still' }), jpeg);
  assert.equal(encodes(), 0);
});

test('no picture yet: an error the web page shows as a missing image', async () => {
  const { snapshot } = setup();
  await assert.rejects(snapshot({ state: 'IDLE', frame: null }), /no picture yet/);
});

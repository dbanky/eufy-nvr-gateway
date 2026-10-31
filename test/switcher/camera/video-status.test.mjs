// What the status (and the web page) says about a camera's video.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './world.mjs';

describe('the status says what happens to the video', () => {
  test('converting, when turned on', () => {
    const { cam } = setup({ transcode: true });
    assert.equal(cam.status().video.text, 'H.264 · converted');
  });

  test('by default, converted until the camera\'s format is known', () => {
    const { cam } = setup();
    assert.equal(cam.status().video.text, 'H.264 · converted until the camera\'s format is known');
  });

  test('passed through once the stream runs in the camera\'s format', async () => {
    const { cam } = setup();
    cam.codec = 'hevc';
    assert.equal(cam.status().video.converted, true, 'not yet: the H.265 loop is not on air');
    await cam.refresh();
    assert.equal(cam.status().video.text, 'H.265 · passed through, no conversion');
  });
});

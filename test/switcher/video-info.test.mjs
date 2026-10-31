import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { videoInfo } from '../../src/switcher/video-info.mjs';

// streamCodec is what the camera's RTSP stream currently uses (the feed's codec).
const info = (cam) => videoInfo({ transcode: true, codec: null, streamCodec: 'h264', ...cam });

describe('the web page says which codec the stream uses, and whether it is converted', () => {
  test('converting a camera whose format is not known yet', () => {
    assert.deepEqual(info({}), { codec: 'h264', cameraCodec: null, converted: true, text: 'H.264 · converted' });
  });

  test('converting an H.265 camera to H.264', () => {
    assert.equal(info({ codec: 'hevc' }).text, 'H.264 · converted from H.265');
  });

  test('converting an H.264 camera (re-encoded, same format)', () => {
    assert.equal(info({ codec: 'h264' }).text, 'H.264 · converted from H.264');
  });

  test('passing the camera\'s own H.265 through', () => {
    assert.deepEqual(info({ transcode: false, codec: 'hevc', streamCodec: 'hevc' }),
      { codec: 'hevc', cameraCodec: 'hevc', converted: false, text: 'H.265 · passed through, no conversion' });
  });

  test('conversion turned off, but the first session has not told the camera\'s format yet', () => {
    assert.equal(info({ transcode: false }).text, 'H.264 · converted until the camera\'s format is known');
  });
});

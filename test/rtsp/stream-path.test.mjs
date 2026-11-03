// What an RTSP address asks for: the camera, its variants, and whether the sound is wanted.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamPath, streamUri } from '../../src/rtsp/stream-path.mjs';

const plain = { mjpeg: false, g711: false, videoOnly: false };

describe('parseStreamPath', () => {
  test('a camera\'s name is the first path segment, from a whole URI or just the path', () => {
    assert.deepEqual(parseStreamPath('rtsp://192.168.1.10:8554/garden'), { name: 'garden', ...plain });
    assert.deepEqual(parseStreamPath('garden'), { name: 'garden', ...plain });
  });

  test('a name with characters a URI escapes comes back as written', () => {
    assert.equal(parseStreamPath('rtsp://192.168.1.10:8554/front%20door').name, 'front door');
  });

  test('~mjpeg and ~g711 ask for the JPEG picture and the G.711 sound, alone or together', () => {
    assert.deepEqual(parseStreamPath('garden~mjpeg'), { name: 'garden', ...plain, mjpeg: true });
    assert.deepEqual(parseStreamPath('garden~g711'), { name: 'garden', ...plain, g711: true });
    assert.deepEqual(parseStreamPath('garden~mjpeg~g711'), { name: 'garden', ...plain, mjpeg: true, g711: true });
  });

  test('?video asks for the picture without the sound (?video&audio still has the sound)', () => {
    assert.equal(parseStreamPath('garden?video').videoOnly, true);
    assert.equal(parseStreamPath('garden?video&audio').videoOnly, false);
  });

  test('a SETUP\'s track control after the path or the query changes nothing', () => {
    assert.deepEqual(parseStreamPath('rtsp://192.168.1.10:8554/garden/trackID=0'), { name: 'garden', ...plain });
    assert.deepEqual(parseStreamPath('rtsp://192.168.1.10:8554/garden~mjpeg~g711/trackID=1'), { name: 'garden', ...plain, mjpeg: true, g711: true });
    assert.equal(parseStreamPath('rtsp://192.168.1.10:8554/garden?video/trackID=0').videoOnly, true);
  });

  test('no name, or a variant that doesn\'t exist: nothing', () => {
    assert.equal(parseStreamPath('rtsp://192.168.1.10:8554/'), null);
    assert.equal(parseStreamPath('rtsp://192.168.1.10:8554/garden~flv'), null);
  });
});

describe('streamUri', () => {
  test('drops a track\'s control, so every SETUP of a session names the same stream', () => {
    assert.equal(streamUri('rtsp://192.168.1.10:8554/garden/trackID=1'), 'rtsp://192.168.1.10:8554/garden');
    assert.equal(streamUri('rtsp://192.168.1.10:8554/garden?video'), 'rtsp://192.168.1.10:8554/garden?video');
  });
});

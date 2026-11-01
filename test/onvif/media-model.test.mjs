import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jpegSize, streamPath, MediaModel } from '../../src/onvif/media-model.mjs';
import { device } from './fixtures.mjs';

test('the MJPEG size: 640 wide, the camera\'s aspect, in 8-pixel blocks (RTP/JPEG counts in blocks)', () => {
  assert.deepEqual(jpegSize({ width: 2880, height: 1616 }), { width: 640, height: 360 });
  assert.deepEqual(jpegSize({ width: 1600, height: 1200 }), { width: 640, height: 480 });
  assert.deepEqual(jpegSize({ width: 1920, height: 1080 }), { width: 640, height: 360 });
});

test('stream paths: the camera\'s stream, its MJPEG and G711 variants, or only its video', () => {
  assert.equal(streamPath('garden', { video: 'native', audio: null, hasAudio: false }), 'garden');
  assert.equal(streamPath('garden', { video: 'JPEG', audio: null, hasAudio: false }), 'garden~mjpeg');
  assert.equal(streamPath('garden', { video: 'native', audio: 'AAC', hasAudio: true }), 'garden');
  assert.equal(streamPath('garden', { video: 'JPEG', audio: 'G711', hasAudio: true }), 'garden~mjpeg~g711');
  assert.equal(streamPath('garden', { video: 'native', audio: null, hasAudio: true }), 'garden?video');
});

test('a factory reset brings back the profile from config.json', () => {
  const model = new MediaModel(device());
  model.createProfile('extra');
  model.setVideoEncoder({ token: 'video_encoder', encoding: 'JPEG' });
  model.reset();
  assert.equal(model.profiles.length, 1);
  assert.equal(model.videoOf(model.config('videoEncoder', 'video_encoder')).encoding, 'H264');
});

test('a camera whose sound is turned off loses its audio configurations at once', () => {
  let audio = true;
  const model = new MediaModel(device({ audio: () => audio }));
  assert.equal(model.inProfile(model.profile('main'), 'audioEncoder').token, 'audio_encoder');
  audio = false;
  assert.equal(model.inProfile(model.profile('main'), 'audioEncoder'), null);
  assert.equal(model.streamPathOf(model.profile('main')), 'garden');
});

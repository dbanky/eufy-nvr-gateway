import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mediaResponse } from '../../src/onvif/media.mjs';
import { device } from './fixtures.mjs';

const answer = (op, over) => mediaResponse(op, device(over));

describe('the media service', () => {
  test('one profile per camera (a second one would show up as another camera)', () => {
    const xml = answer('GetProfiles');
    assert.equal(xml.match(/<trt:Profiles /g).length, 1);
  });

  test('the profile has a video source and an encoder configuration with rate control', () => {
    const xml = answer('GetProfiles');
    assert.match(xml, /<tt:VideoSourceConfiguration /);
    assert.match(xml, /<tt:VideoEncoderConfiguration /);
    assert.match(xml, /<tt:RateControl>/);
    assert.match(xml, /<tt:Width>2880<\/tt:Width><tt:Height>1616<\/tt:Height>/);
  });

  test('the stream is the gateway\'s RTSP stream: nothing is encoded for ONVIF', () => {
    assert.match(answer('GetStreamUri'), /<tt:Uri>rtsp:\/\/192\.168\.1\.51:8554\/garden<\/tt:Uri>/);
  });

  test('the snapshot is the web page\'s snapshot', () => {
    assert.match(answer('GetSnapshotUri'), /<tt:Uri>http:\/\/192\.168\.1\.51:8099\/api\/cameras\/garden\/snapshot\.jpg<\/tt:Uri>/);
  });

  test('the encoding says what the stream really is: H.264, or H.265 when the camera\'s own is passed through', () => {
    assert.match(answer('GetVideoEncoderConfigurations'), /<tt:Encoding>H264<\/tt:Encoding>/);
    assert.match(answer('GetVideoEncoderConfigurations', { codec: () => 'hevc' }), /<tt:Encoding>H265<\/tt:Encoding>/);
  });

  test('no audio', () => {
    assert.match(answer('GetAudioSources'), /<trt:GetAudioSourcesResponse\/>/);
  });
});

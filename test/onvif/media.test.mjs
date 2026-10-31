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

  test('the snapshot is served on the camera\'s ONVIF port', () => {
    assert.match(answer('GetSnapshotUri'), /<tt:Uri>http:\/\/192\.168\.1\.51:8000\/onvif\/snapshot\.jpg<\/tt:Uri>/);
  });

  test('the encoding says what the stream really is: H.264, or H.265 when the camera\'s own is passed through', () => {
    assert.match(answer('GetVideoEncoderConfigurations'), /<tt:Encoding>H264<\/tt:Encoding>/);
    assert.match(answer('GetVideoEncoderConfigurations', { codec: () => 'hevc' }), /<tt:Encoding>H265<\/tt:Encoding>/);
  });

  test('no audio for a camera without it', () => {
    assert.match(answer('GetAudioSources'), /<trt:GetAudioSourcesResponse\/>/);
    assert.doesNotMatch(answer('GetProfiles'), /Audio/);
    assert.equal(answer('GetAudioEncoderConfiguration'), null);
  });

  test('with audio: the profile names an audio source and the AAC encoder (16 kHz), in the schema\'s order', () => {
    const audio = { audio: () => true };
    const profile = answer('GetProfiles', audio);
    const order = ['VideoSourceConfiguration', 'AudioSourceConfiguration', 'VideoEncoderConfiguration', 'AudioEncoderConfiguration'].map((t) => profile.indexOf(`<tt:${t} `));
    assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), `order: ${order}`);
    assert.match(profile, /<tt:Encoding>AAC<\/tt:Encoding><tt:Bitrate>32<\/tt:Bitrate><tt:SampleRate>16<\/tt:SampleRate>/);
    assert.match(answer('GetAudioSources', audio), /<trt:AudioSources token="audio_src"><tt:Channels>1<\/tt:Channels>/);
    assert.match(answer('GetAudioEncoderConfigurations', audio), /<tt:Encoding>AAC<\/tt:Encoding>/);
    assert.match(answer('GetAudioEncoderConfiguration', audio), /token="audio_encoder"/);
  });
});

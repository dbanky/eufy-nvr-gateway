import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mediaResponse } from '../../src/onvif/media.mjs';
import { onvifCamera, body } from './fixtures.mjs';

function service(over = {}) {
  const camera = onvifCamera(over);
  const call = (op, inner = '') => mediaResponse(op, body(op, inner), camera);
  return { call, model: camera.model };
}
const faultOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  assert.fail('expected a fault');
};
const streamUri = (call, profile = 'main', setup = '') => /<tt:Uri>([^<]+)<\/tt:Uri>/.exec(call('GetStreamUri', `${setup}<ProfileToken>${profile}</ProfileToken>`))[1];
const AUDIO = { audio: () => true };
const encoderSet = (token, encoding, { width, height, fps = 15, bitrate, quality = 5, gov } = {}) => `<Configuration token="${token}"><Name>${token}</Name><UseCount>1</UseCount>`
  + `<Encoding>${encoding}</Encoding><Resolution><Width>${width}</Width><Height>${height}</Height></Resolution><Quality>${quality}</Quality>`
  + `<RateControl><FrameRateLimit>${fps}</FrameRateLimit><EncodingInterval>1</EncodingInterval>${bitrate ? `<BitrateLimit>${bitrate}</BitrateLimit>` : ''}</RateControl>`
  + (gov ? `<H264><GovLength>${gov}</GovLength><H264Profile>High</H264Profile></H264>` : '') + '</Configuration><ForcePersistence>true</ForcePersistence>';

describe('the media service: the ready-to-use profile', () => {
  test('one profile, "main", fixed: what NVRs pick', () => {
    const xml = service().call('GetProfiles');
    assert.equal(xml.match(/<trt:Profiles /g).length, 1);
    assert.match(xml, /<trt:Profiles token="main" fixed="true"><tt:Name>garden<\/tt:Name>/);
  });

  test('it has a video source and an encoder configuration with rate control (UniFi Protect needs it)', () => {
    const xml = service().call('GetProfiles');
    assert.match(xml, /<tt:VideoSourceConfiguration token="video_src_config">/);
    assert.match(xml, /<tt:VideoEncoderConfiguration token="video_encoder">/);
    assert.match(xml, /<tt:RateControl>/);
    assert.match(xml, /<tt:Width>2880<\/tt:Width><tt:Height>1616<\/tt:Height>/);
  });

  test('its stream is the gateway\'s RTSP stream: nothing is encoded for ONVIF', () => {
    assert.equal(streamUri(service().call), 'rtsp://192.168.1.51:8554/garden');
  });

  test('every transport gets the same address (TCP, UDP and HTTP all work on it); multicast doesn\'t exist', () => {
    const { call } = service();
    for (const protocol of ['UDP', 'TCP', 'RTSP', 'HTTP']) {
      assert.equal(streamUri(call, 'main', `<StreamSetup><Stream>RTP-Unicast</Stream><Transport><Protocol>${protocol}</Protocol></Transport></StreamSetup>`), 'rtsp://192.168.1.51:8554/garden');
    }
    assert.equal(faultOf(() => call('GetStreamUri', '<StreamSetup><Stream>RTP-Multicast</Stream></StreamSetup><ProfileToken>main</ProfileToken>')), 'ter:InvalidArgVal/ter:InvalidStreamSetup');
  });

  test('the snapshot is served on the camera\'s ONVIF port', () => {
    assert.match(service().call('GetSnapshotUri', '<ProfileToken>main</ProfileToken>'), /<tt:Uri>http:\/\/192\.168\.1\.51:8000\/onvif\/snapshot\.jpg<\/tt:Uri>/);
  });

  test('the encoding says what the stream really is: H.264, or H.265 when the camera\'s own is passed through', () => {
    assert.match(service().call('GetVideoEncoderConfiguration', '<ConfigurationToken>video_encoder</ConfigurationToken>'), /<tt:Encoding>H264<\/tt:Encoding>/);
    assert.match(service({ codec: () => 'hevc' }).call('GetVideoEncoderConfiguration', '<ConfigurationToken>video_encoder</ConfigurationToken>'), /<tt:Encoding>H265<\/tt:Encoding>/);
  });

  test('a camera without sound: no audio anywhere, and audio configurations are refused', () => {
    const { call } = service();
    assert.match(call('GetAudioSources'), /<trt:GetAudioSourcesResponse><\/trt:GetAudioSourcesResponse>/);
    assert.doesNotMatch(call('GetProfiles'), /Audio/);
    assert.match(call('GetAudioEncoderConfigurations'), /<trt:GetAudioEncoderConfigurationsResponse><\/trt:GetAudioEncoderConfigurationsResponse>/);
    assert.equal(faultOf(() => call('GetAudioEncoderConfiguration', '<ConfigurationToken>audio_encoder</ConfigurationToken>')), 'ter:ActionNotSupported/ter:AudioNotSupported');
    assert.equal(faultOf(() => call('AddAudioEncoderConfiguration', '<ProfileToken>main</ProfileToken><ConfigurationToken>audio_encoder</ConfigurationToken>')), 'ter:ActionNotSupported/ter:AudioNotSupported');
  });

  test('with audio: an audio source and the AAC encoder (16 kHz), in the schema\'s order', () => {
    const { call } = service(AUDIO);
    const profile = call('GetProfiles');
    const order = ['VideoSourceConfiguration', 'AudioSourceConfiguration', 'VideoEncoderConfiguration', 'AudioEncoderConfiguration'].map((t) => profile.indexOf(`<tt:${t} `));
    assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), `order: ${order}`);
    assert.match(profile, /<tt:Encoding>AAC<\/tt:Encoding><tt:Bitrate>32<\/tt:Bitrate><tt:SampleRate>16<\/tt:SampleRate>/);
    assert.match(call('GetAudioSources'), /<trt:AudioSources token="audio_src"><tt:Channels>1<\/tt:Channels>/);
  });
});

describe('the media service: video encoders (Profile S: H.264 and JPEG)', () => {
  test('options: the camera\'s H.264 at its own size and rate, and JPEG at 640 wide, both fixed', () => {
    const xml = service().call('GetVideoEncoderConfigurationOptions', '<ConfigurationToken>video_encoder</ConfigurationToken>');
    assert.match(xml, /<tt:JPEG><tt:ResolutionsAvailable><tt:Width>640<\/tt:Width><tt:Height>360<\/tt:Height><\/tt:ResolutionsAvailable><tt:FrameRateRange><tt:Min>15<\/tt:Min><tt:Max>15<\/tt:Max>/);
    assert.match(xml, /<tt:H264><tt:ResolutionsAvailable><tt:Width>2880<\/tt:Width><tt:Height>1616<\/tt:Height>.*<tt:H264ProfilesSupported>High<\/tt:H264ProfilesSupported>/);
    assert.match(xml, /<tt:Extension><tt:JPEG>.*<tt:BitrateRange>/);
  });

  test('a camera passing its H.265 through has no H.264 to offer, only JPEG', () => {
    const xml = service({ codec: () => 'hevc' }).call('GetVideoEncoderConfigurationOptions', '<ConfigurationToken>video_encoder</ConfigurationToken>');
    assert.match(xml, /<tt:JPEG>/);
    assert.doesNotMatch(xml, /<tt:H264>/);
  });

  test('two encoder configurations: the camera\'s own and JPEG', () => {
    const xml = service().call('GetVideoEncoderConfigurations');
    assert.match(xml, /token="video_encoder">.*<tt:Encoding>H264<\/tt:Encoding>/);
    assert.match(xml, /token="jpeg_encoder">.*<tt:Encoding>JPEG<\/tt:Encoding><tt:Resolution><tt:Width>640<\/tt:Width><tt:Height>360<\/tt:Height>/);
    assert.match(service().call('GetGuaranteedNumberOfVideoEncoderInstances', '<ConfigurationToken>video_src_config</ConfigurationToken>'),
      /<trt:TotalNumber>2<\/trt:TotalNumber><trt:JPEG>2<\/trt:JPEG><trt:H264>2<\/trt:H264>/);
  });

  test('switching the profile\'s encoder to JPEG makes its stream MJPEG; back to H.264 restores it', () => {
    const { call } = service();
    call('SetVideoEncoderConfiguration', encoderSet('video_encoder', 'JPEG', { width: 640, height: 360 }));
    assert.match(call('GetVideoEncoderConfiguration', '<ConfigurationToken>video_encoder</ConfigurationToken>'), /<tt:Encoding>JPEG<\/tt:Encoding>/);
    assert.equal(streamUri(call), 'rtsp://192.168.1.51:8554/garden~mjpeg');
    call('SetVideoEncoderConfiguration', encoderSet('video_encoder', 'H264', { width: 2880, height: 1616, bitrate: 6600, gov: 60 }));
    assert.equal(streamUri(call), 'rtsp://192.168.1.51:8554/garden');
  });

  test('echoing the current configuration back is always accepted (also H.265)', () => {
    const { call } = service({ codec: () => 'hevc' });
    call('SetVideoEncoderConfiguration', encoderSet('video_encoder', 'H265', { width: 2880, height: 1616, bitrate: 6600 }));
  });

  test('values the stream doesn\'t have are refused: it is the camera\'s stream', () => {
    const { call } = service();
    assert.equal(faultOf(() => call('SetVideoEncoderConfiguration', encoderSet('video_encoder', 'H264', { width: 1280, height: 720 }))), 'ter:InvalidArgVal/ter:ConfigModify');
    assert.equal(faultOf(() => call('SetVideoEncoderConfiguration', encoderSet('video_encoder', 'H264', { width: 2880, height: 1616, fps: 30 }))), 'ter:InvalidArgVal/ter:ConfigModify');
    assert.equal(faultOf(() => call('SetVideoEncoderConfiguration', encoderSet('video_encoder', 'MPEG4', { width: 2880, height: 1616 }))), 'ter:InvalidArgVal/ter:ConfigModify');
    assert.equal(faultOf(() => call('SetVideoEncoderConfiguration', encoderSet('nope', 'H264', {}))), 'ter:InvalidArgVal/ter:NoConfig');
  });
});

describe('the media service: profiles and configurations', () => {
  test('a new profile starts empty, takes configurations, and streams once it has video', () => {
    const { call } = service();
    assert.match(call('CreateProfile', '<Name>small</Name><Token>small</Token>'), /<trt:Profile token="small" fixed="false"><tt:Name>small<\/tt:Name><\/trt:Profile>/);
    assert.equal(faultOf(() => call('GetStreamUri', '<ProfileToken>small</ProfileToken>')), 'ter:Action/ter:IncompleteConfiguration');
    call('AddVideoSourceConfiguration', '<ProfileToken>small</ProfileToken><ConfigurationToken>video_src_config</ConfigurationToken>');
    call('AddVideoEncoderConfiguration', '<ProfileToken>small</ProfileToken><ConfigurationToken>jpeg_encoder</ConfigurationToken>');
    assert.equal(streamUri(call, 'small'), 'rtsp://192.168.1.51:8554/garden~mjpeg');
    assert.match(call('GetVideoSourceConfiguration', '<ConfigurationToken>video_src_config</ConfigurationToken>'), /<tt:UseCount>2<\/tt:UseCount>/);
    call('RemoveVideoEncoderConfiguration', '<ProfileToken>small</ProfileToken>');
    assert.doesNotMatch(call('GetProfile', '<ProfileToken>small</ProfileToken>'), /VideoEncoderConfiguration/);
    call('DeleteProfile', '<ProfileToken>small</ProfileToken>');
    assert.equal(faultOf(() => call('GetProfile', '<ProfileToken>small</ProfileToken>')), 'ter:InvalidArgVal/ter:NoProfile');
  });

  test('the fixed profile can\'t be deleted; there is a limit of four; tokens are unique', () => {
    const { call } = service();
    assert.equal(faultOf(() => call('DeleteProfile', '<ProfileToken>main</ProfileToken>')), 'ter:Action/ter:DeletionOfFixedProfile');
    assert.equal(faultOf(() => call('CreateProfile', '<Name>x</Name><Token>main</Token>')), 'ter:InvalidArgVal/ter:ProfileExists');
    for (let i = 0; i < 3; i++) call('CreateProfile', `<Name>p${i}</Name>`);
    assert.equal(faultOf(() => call('CreateProfile', '<Name>one too many</Name>')), 'ter:Action/ter:MaxNVTProfiles');
    assert.match(call('GetServiceCapabilities'), /MaximumNumberOfProfiles="4"/);
  });

  test('a profile with audio picks AAC or G711 (Profile S requires G711), or no sound at all', () => {
    const { call } = service(AUDIO);
    call('SetAudioEncoderConfiguration', '<Configuration token="audio_encoder"><Name>a</Name><UseCount>1</UseCount><Encoding>G711</Encoding><Bitrate>64</Bitrate><SampleRate>8</SampleRate></Configuration>');
    assert.equal(streamUri(call), 'rtsp://192.168.1.51:8554/garden~g711');
    call('AddAudioEncoderConfiguration', '<ProfileToken>main</ProfileToken><ConfigurationToken>audio_encoder</ConfigurationToken>');
    call('RemoveAudioEncoderConfiguration', '<ProfileToken>main</ProfileToken>');
    assert.equal(streamUri(call), 'rtsp://192.168.1.51:8554/garden?video');
    const options = call('GetAudioEncoderConfigurationOptions');
    assert.match(options, /<tt:Encoding>G711<\/tt:Encoding><tt:BitrateList><tt:Items>64<\/tt:Items>/);
    assert.match(options, /<tt:Encoding>AAC<\/tt:Encoding><tt:BitrateList><tt:Items>32<\/tt:Items>/);
    assert.equal(faultOf(() => call('SetAudioEncoderConfiguration', '<Configuration token="audio_encoder"><Encoding>AAC</Encoding><Bitrate>128</Bitrate><SampleRate>16</SampleRate></Configuration>')), 'ter:InvalidArgVal/ter:ConfigModify');
  });

  test('a camera\'s compatible configurations, options, video source and metadata', () => {
    const { call } = service();
    assert.match(call('GetCompatibleVideoEncoderConfigurations', '<ProfileToken>main</ProfileToken>'), /video_encoder.*jpeg_encoder/);
    assert.match(call('GetVideoSourceConfigurationOptions'), /<tt:WidthRange><tt:Min>2880<\/tt:Min><tt:Max>2880<\/tt:Max><\/tt:WidthRange>/);
    assert.match(call('GetVideoSources'), /<trt:VideoSources token="video_src"><tt:Framerate>15<\/tt:Framerate>/);
    assert.equal(faultOf(() => call('SetVideoSourceConfiguration', '<Configuration token="video_src_config"><Name>v</Name><SourceToken>video_src</SourceToken><Bounds x="0" y="0" width="100" height="100"/></Configuration>')), 'ter:InvalidArgVal/ter:ConfigModify');
    call('AddMetadataConfiguration', '<ProfileToken>main</ProfileToken><ConfigurationToken>metadata</ConfigurationToken>');
    assert.match(call('GetProfiles'), /<tt:MetadataConfiguration token="metadata">/);
    assert.match(call('GetMetadataConfigurationOptions'), /<tt:PTZStatusFilterOptions>/);
    assert.equal(faultOf(() => call('SetMetadataConfiguration', '<Configuration token="metadata"><Name>m</Name><Analytics>true</Analytics></Configuration>')), 'ter:InvalidArgVal/ter:ConfigModify');
    call('SetSynchronizationPoint', '<ProfileToken>main</ProfileToken>');
  });

  test('streaming capabilities: RTSP (TCP, UDP, HTTP), no multicast, no deprecated RTP/TCP', () => {
    assert.match(service().call('GetServiceCapabilities'), /RTPMulticast="false" RTP_TCP="false" RTP_RTSP_TCP="true" NonAggregateControl="false" NoRTSPStreaming="false"/);
  });

  test('unknown operations: null', () => {
    assert.equal(service().call('StartMulticastStreaming'), null);
  });
});

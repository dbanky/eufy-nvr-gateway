import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { media2Response } from '../../src/onvif/media2.mjs';
import { onvifCamera, body } from './fixtures.mjs';

function service(over = {}) {
  const camera = onvifCamera({ codec: () => 'hevc', ...over });
  return { call: (op, inner = '') => media2Response(op, body(op, inner), camera), model: camera.model };
}

describe('Media2 (for cameras that pass their H.265 through)', () => {
  test('the profile says H.265, which Media ver10 can\'t', () => {
    const xml = service().call('GetProfiles', '<Type>All</Type>');
    assert.match(xml, /<tr2:Profiles token="main" fixed="true"><tr2:Name>garden<\/tr2:Name><tr2:Configurations><tr2:VideoSource token="video_src_config">/);
    assert.match(xml, /<tr2:VideoEncoder token="video_encoder" GovLength="60" Profile="Main"><tt:Name>video_encoder<\/tt:Name><tt:UseCount>1<\/tt:UseCount><tt:Encoding>H265<\/tt:Encoding>/);
  });

  test('Type picks the configurations a client wants', () => {
    const xml = service().call('GetProfiles', '<Type>VideoEncoder</Type>');
    assert.match(xml, /<tr2:VideoEncoder /);
    assert.doesNotMatch(xml, /<tr2:VideoSource /);
  });

  test('stream and snapshot addresses, the same as through Media ver10', () => {
    const { call } = service();
    assert.match(call('GetStreamUri', '<Protocol>RTSP</Protocol><ProfileToken>main</ProfileToken>'), /<tr2:Uri>rtsp:\/\/192\.168\.1\.51:8554\/garden<\/tr2:Uri>/);
    assert.match(call('GetStreamUri', '<Protocol>RtspOverHttp</Protocol><ProfileToken>main</ProfileToken>'), /garden</);
    assert.throws(() => call('GetStreamUri', '<Protocol>RtspMulticast</Protocol><ProfileToken>main</ProfileToken>'), { code: 'ter:InvalidArgVal/ter:InvalidStreamSetup' });
    assert.match(call('GetSnapshotUri', '<ProfileToken>main</ProfileToken>'), /<tr2:Uri>http:\/\/192\.168\.1\.51:8000\/onvif\/snapshot\.jpg<\/tr2:Uri>/);
  });

  test('options: the camera\'s H.265 and JPEG', () => {
    const xml = service().call('GetVideoEncoderConfigurationOptions');
    assert.match(xml, /<tr2:Options GovLengthRange="60 60" ProfilesSupported="Main" FrameRatesSupported="15" ConstantBitRateSupported="false"><tt:Encoding>H265<\/tt:Encoding>/);
    assert.match(xml, /<tt:Encoding>JPEG<\/tt:Encoding>.*<tt:Width>640<\/tt:Width>/);
  });

  test('audio in Media2 names: MP4A-LATM (AAC) at 16000 Hz', () => {
    assert.match(service({ audio: () => true }).call('GetAudioEncoderConfigurations'), /<tt:Encoding>MP4A-LATM<\/tt:Encoding>.*<tt:SampleRate>16000<\/tt:SampleRate>/);
  });

  test('profiles can be made from configurations, changed and deleted', () => {
    const { call } = service();
    const token = /<tr2:Token>([^<]+)</.exec(call('CreateProfile', '<Name>jpeg</Name><Configuration><Type>VideoSource</Type><Token>video_src_config</Token></Configuration>'
      + '<Configuration><Type>VideoEncoder</Type><Token>jpeg_encoder</Token></Configuration>'))[1];
    assert.match(call('GetStreamUri', `<Protocol>RTSP</Protocol><ProfileToken>${token}</ProfileToken>`), /garden~mjpeg</);
    call('RemoveConfiguration', `<ProfileToken>${token}</ProfileToken><Configuration><Type>VideoEncoder</Type></Configuration>`);
    assert.throws(() => call('GetStreamUri', `<Protocol>RTSP</Protocol><ProfileToken>${token}</ProfileToken>`), { code: 'ter:Action/ter:IncompleteConfiguration' });
    call('AddConfiguration', `<ProfileToken>${token}</ProfileToken><Configuration><Type>VideoEncoder</Type><Token>video_encoder</Token></Configuration>`);
    call('DeleteProfile', `<Token>${token}</Token>`);
    assert.throws(() => call('DeleteProfile', '<Token>main</Token>'), { code: 'ter:Action/ter:DeletionOfFixedProfile' });
  });

  test('encoder instances: two of each encoding', () => {
    assert.match(service().call('GetVideoEncoderInstances', '<ConfigurationToken>video_src_config</ConfigurationToken>'),
      /<tr2:Codec><tr2:Encoding>H265<\/tr2:Encoding><tr2:Number>2<\/tr2:Number><\/tr2:Codec>.*<tr2:Total>2<\/tr2:Total>/);
  });
});

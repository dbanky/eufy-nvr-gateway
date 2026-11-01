// The ONVIF media service, version 2: the same profiles and configurations as Media (media-model.mjs),
// in the newer form, which also knows H.265. It describes a camera whose own H.265 is passed through
// correctly (Media ver10 can't). It is not a full Profile T implementation.
//
// media2Response(op, xml, { device, model }) -> response body, or null for operations it doesn't support.

import { xmlEscape as x, valueOf, valuesOf, elementsOf, OnvifFault } from './xml.mjs';
import { AUDIO } from './media-model.mjs';
import { videoSourceXml, audioSourceXml, metadataXml, multicastXml, resolutionXml } from './media.mjs';

// Media2 names configuration kinds like this; "All" means every kind.
const TYPES = { VideoSource: 'videoSource', VideoEncoder: 'videoEncoder', AudioSource: 'audioSource', AudioEncoder: 'audioEncoder', Metadata: 'metadata' };
const MEDIA2_AUDIO = { AAC: 'MP4A-LATM', G711: 'PCMU' };

export const media2Capabilities = () => '<tr2:Capabilities SnapshotUri="true" Rotation="false" VideoSourceMode="false" OSD="false" '
  + 'TemporaryOSDText="false" Mask="false" SourceMask="false"><tr2:ProfileCapabilities MaximumNumberOfProfiles="4" '
  + 'ConfigurationsSupported="VideoSource VideoEncoder AudioSource AudioEncoder Metadata"/>'
  + '<tr2:StreamingCapabilities RTSPStreaming="true" RTPMulticast="false" RTP_RTSP_TCP="true" NonAggregateControl="false" AutoStartMulticast="false"/>'
  + '</tr2:Capabilities>';

function videoEncoderXml(tag, c, model) {
  const v = model.videoOf(c);
  const attrs = v.gop ? ` GovLength="${v.gop}" Profile="${v.profile}"` : '';
  return `<${tag} token="${x(c.token)}"${attrs}><tt:Name>${x(c.name)}</tt:Name><tt:UseCount>${model.useCount('videoEncoder', c.token)}</tt:UseCount>`
    + `<tt:Encoding>${v.encoding}</tt:Encoding>${resolutionXml(v)}<tt:RateControl ConstantBitRate="false"><tt:FrameRateLimit>${v.fps}</tt:FrameRateLimit>`
    + `<tt:BitrateLimit>${v.bitrateKbps}</tt:BitrateLimit></tt:RateControl>${multicastXml(c.multicast)}<tt:Quality>${v.quality}</tt:Quality></${tag}>`;
}

// Media2: Bitrate in kbit/s, SampleRate in Hz.
function audioEncoderXml(tag, c, model) {
  const a = AUDIO[c.audio];
  return `<${tag} token="${x(c.token)}"><tt:Name>${x(c.name)}</tt:Name><tt:UseCount>${model.useCount('audioEncoder', c.token)}</tt:UseCount>`
    + `<tt:Encoding>${MEDIA2_AUDIO[a.encoding]}</tt:Encoding>${multicastXml(c.multicast)}<tt:Bitrate>${a.bitrate}</tt:Bitrate>`
    + `<tt:SampleRate>${a.sampleRate * 1000}</tt:SampleRate></${tag}>`;
}

const RENDER = { videoSource: videoSourceXml, videoEncoder: videoEncoderXml, audioSource: audioSourceXml, audioEncoder: audioEncoderXml, metadata: metadataXml };
const ELEMENT = { videoSource: 'VideoSource', audioSource: 'AudioSource', videoEncoder: 'VideoEncoder', audioEncoder: 'AudioEncoder', metadata: 'Metadata' };

// types: the Type values asked for ([] or "All" = everything).
function profileXml(p, model, types) {
  const all = !types.length || types.includes('All');
  const parts = ['videoSource', 'audioSource', 'videoEncoder', 'audioEncoder', 'metadata'].map((kind) => {
    const c = (all || types.includes(ELEMENT[kind])) && model.inProfile(p, kind);
    return c ? RENDER[kind](`tr2:${ELEMENT[kind]}`, c, model) : '';
  }).join('');
  return `<tr2:Profiles token="${x(p.token)}" fixed="${p.fixed}"><tr2:Name>${x(p.name)}</tr2:Name><tr2:Configurations>${parts}</tr2:Configurations></tr2:Profiles>`;
}

// Configurations of a kind, optionally one (ConfigurationToken) or those that fit a profile (ProfileToken).
function configurations(kind, xml, model) {
  const token = valueOf(xml, 'ConfigurationToken');
  const profile = valueOf(xml, 'ProfileToken');
  if (profile) model.profile(profile);
  const list = token ? [model.config(kind, token)] : model.list(kind);
  return list.map((c) => RENDER[kind]('tr2:Configurations', c, model)).join('');
}

function videoOptions(model) {
  return model.videoChoices().map((c) => {
    const attrs = c.gop ? ` GovLengthRange="${c.gop} ${c.gop}" ProfilesSupported="${c.profile}"` : '';
    return `<tr2:Options${attrs} FrameRatesSupported="${c.fps}" ConstantBitRateSupported="false"><tt:Encoding>${c.encoding}</tt:Encoding>`
      + `<tt:QualityRange><tt:Min>${c.quality}</tt:Min><tt:Max>${c.quality}</tt:Max></tt:QualityRange>`
      + `<tt:ResolutionsAvailable><tt:Width>${c.width}</tt:Width><tt:Height>${c.height}</tt:Height></tt:ResolutionsAvailable>`
      + `<tt:BitrateRange><tt:Min>${c.bitrateKbps}</tt:Min><tt:Max>${c.bitrateKbps}</tt:Max></tt:BitrateRange></tr2:Options>`;
  }).join('');
}

const audioOptions = () => Object.values(AUDIO).map((a) => `<tr2:Options><tt:Encoding>${MEDIA2_AUDIO[a.encoding]}</tt:Encoding>`
  + `<tt:BitrateList><tt:Items>${a.bitrate}</tt:Items></tt:BitrateList><tt:SampleRateList><tt:Items>${a.sampleRate * 1000}</tt:Items></tt:SampleRateList></tr2:Options>`).join('');

export function media2Response(op, xml, { device, model }) {
  const r = (body = '') => `<tr2:${op}Response>${body}</tr2:${op}Response>`;
  const m = /^Get(VideoSource|VideoEncoder|AudioSource|AudioEncoder|Metadata)Configurations$/.exec(op);
  if (m) return r(configurations(TYPES[m[1]], xml, model));
  switch (op) {
    case 'GetServiceCapabilities': return r(media2Capabilities());
    case 'GetProfiles': {
      const token = valueOf(xml, 'Token');
      const list = token ? [model.profile(token)] : model.profiles;
      return r(list.map((p) => profileXml(p, model, valuesOf(xml, 'Type'))).join(''));
    }
    case 'CreateProfile': {
      const profile = model.createProfile(valueOf(xml, 'Name'));
      for (const c of elementsOf(xml, 'Configuration')) addConfiguration(model, profile.token, c);
      return r(`<tr2:Token>${x(profile.token)}</tr2:Token>`);
    }
    case 'DeleteProfile':
      model.deleteProfile(valueOf(xml, 'Token'));
      return r();
    case 'AddConfiguration':
      for (const c of elementsOf(xml, 'Configuration')) addConfiguration(model, valueOf(xml, 'ProfileToken'), c);
      return r();
    case 'RemoveConfiguration':
      for (const c of elementsOf(xml, 'Configuration')) {
        const type = valueOf(c, 'Type');
        const kinds = type === 'All' ? Object.values(TYPES).filter((k) => model.list(k).length) : [TYPES[type]];
        if (kinds.some((k) => !k)) throw new OnvifFault('ter:InvalidArgVal/ter:NoConfig', `unknown configuration type ${type}`);
        for (const kind of kinds) model.removeFromProfile(valueOf(xml, 'ProfileToken'), kind);
      }
      return r();
    case 'GetVideoEncoderConfigurationOptions': return r(videoOptions(model));
    case 'GetAudioEncoderConfigurationOptions':
      if (!model.hasAudio()) throw new OnvifFault('ter:ActionNotSupported/ter:AudioNotSupported', 'this camera has no sound');
      return r(audioOptions());
    case 'GetVideoEncoderInstances': {
      model.config('videoSource', valueOf(xml, 'ConfigurationToken'));
      const n = model.videoEncoders.length;
      return r(`<tr2:Info>${model.videoChoices().map((c) => `<tr2:Codec><tr2:Encoding>${c.encoding}</tr2:Encoding><tr2:Number>${n}</tr2:Number></tr2:Codec>`).join('')}`
        + `<tr2:Total>${n}</tr2:Total></tr2:Info>`);
    }
    case 'GetStreamUri': {
      const protocol = valueOf(xml, 'Protocol');
      if (protocol && !['RtspUnicast', 'RTSP', 'RtspOverHttp'].includes(protocol)) {
        throw new OnvifFault('ter:InvalidArgVal/ter:InvalidStreamSetup', `${protocol} is not available: RtspUnicast, RTSP or RtspOverHttp`);
      }
      const path = model.streamPathOf(model.profile(valueOf(xml, 'ProfileToken')));
      return r(`<tr2:Uri>rtsp://${device.address}:${device.rtspPort}/${x(path)}</tr2:Uri>`);
    }
    case 'GetSnapshotUri':
      model.profile(valueOf(xml, 'ProfileToken'));
      return r(`<tr2:Uri>${x(device.snapshotUrl)}</tr2:Uri>`);
    case 'SetSynchronizationPoint':
      model.profile(valueOf(xml, 'ProfileToken'));
      return r();
    case 'GetAudioOutputConfigurations':
    case 'GetAudioDecoderConfigurations':
    case 'GetAnalyticsConfigurations':
    case 'GetOSDs':
    case 'GetMasks':
      return r();
    default:
      return null;
  }
}

// <tr2:Configuration><tr2:Type>VideoEncoder</tr2:Type><tr2:Token>jpeg_encoder</tr2:Token></tr2:Configuration>
function addConfiguration(model, profileToken, c) {
  const kind = TYPES[valueOf(c, 'Type')];
  if (!kind) throw new OnvifFault('ter:InvalidArgVal/ter:NoConfig', `unknown configuration type ${valueOf(c, 'Type')}`);
  const token = valueOf(c, 'Token') ?? model.list(kind)[0]?.token;
  model.addToProfile(profileToken, kind, token);
}

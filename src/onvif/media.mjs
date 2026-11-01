// The ONVIF media service, version 1 (what UniFi Protect uses), with everything Profile S requires:
// profiles, video source, video encoder (H.264 and JPEG), audio (AAC and G711) and metadata
// configurations, stream and snapshot URIs. The profiles and configurations: media-model.mjs.
//
// A camera whose own H.265 is passed through reports "H265" here, outside the ver10 schema (which
// knows JPEG, MPEG4 and H264): it isn't Profile S. Media2 (media2.mjs) describes it properly.
//
// mediaResponse(op, xml, { device, model }) -> response body, or null for operations it doesn't support.

import { xmlEscape as x, valueOf, elementsOf, attributeOf, OnvifFault } from './xml.mjs';
import { AUDIO } from './media-model.mjs';

const AUDIO_SOURCE = 'audio_src', VIDEO_SOURCE = 'video_src';

// ---- configurations as XML (shared with Media2 where the schema is the same) ----

export const multicastXml = (m) => '<tt:Multicast><tt:Address><tt:Type>IPv4</tt:Type>'
  + `<tt:IPv4Address>${x(m.address)}</tt:IPv4Address></tt:Address><tt:Port>${m.port}</tt:Port>`
  + `<tt:TTL>${m.ttl}</tt:TTL><tt:AutoStart>${m.autoStart}</tt:AutoStart></tt:Multicast>`;

export const resolutionXml = ({ width, height }) => `<tt:Resolution><tt:Width>${width}</tt:Width><tt:Height>${height}</tt:Height></tt:Resolution>`;

export function videoSourceXml(tag, c, model) {
  const d = model.device;
  return `<${tag} token="${x(c.token)}"><tt:Name>${x(c.name)}</tt:Name><tt:UseCount>${model.useCount('videoSource', c.token)}</tt:UseCount>`
    + `<tt:SourceToken>${c.sourceToken}</tt:SourceToken><tt:Bounds x="0" y="0" width="${d.width}" height="${d.height}"/></${tag}>`;
}

// RateControl must be there (UniFi Protect needs it).
function videoEncoderXml(tag, c, model) {
  const v = model.videoOf(c);
  return `<${tag} token="${x(c.token)}"><tt:Name>${x(c.name)}</tt:Name><tt:UseCount>${model.useCount('videoEncoder', c.token)}</tt:UseCount>`
    + `<tt:Encoding>${v.encoding}</tt:Encoding>${resolutionXml(v)}<tt:Quality>${v.quality}</tt:Quality>`
    + `<tt:RateControl><tt:FrameRateLimit>${v.fps}</tt:FrameRateLimit><tt:EncodingInterval>1</tt:EncodingInterval>`
    + `<tt:BitrateLimit>${v.bitrateKbps}</tt:BitrateLimit></tt:RateControl>`
    + (v.encoding === 'H264' ? `<tt:H264><tt:GovLength>${v.gop}</tt:GovLength><tt:H264Profile>${v.profile}</tt:H264Profile></tt:H264>` : '')
    + `${multicastXml(c.multicast)}<tt:SessionTimeout>${x(c.sessionTimeout)}</tt:SessionTimeout></${tag}>`;
}

export function audioSourceXml(tag, c, model) {
  return `<${tag} token="${x(c.token)}"><tt:Name>${x(c.name)}</tt:Name><tt:UseCount>${model.useCount('audioSource', c.token)}</tt:UseCount>`
    + `<tt:SourceToken>${c.sourceToken}</tt:SourceToken></${tag}>`;
}

// Bitrate in kbit/s, SampleRate in kHz (ver10).
function audioEncoderXml(tag, c, model) {
  const a = AUDIO[c.audio];
  return `<${tag} token="${x(c.token)}"><tt:Name>${x(c.name)}</tt:Name><tt:UseCount>${model.useCount('audioEncoder', c.token)}</tt:UseCount>`
    + `<tt:Encoding>${a.encoding}</tt:Encoding><tt:Bitrate>${a.bitrate}</tt:Bitrate><tt:SampleRate>${a.sampleRate}</tt:SampleRate>`
    + `${multicastXml(c.multicast)}<tt:SessionTimeout>${x(c.sessionTimeout)}</tt:SessionTimeout></${tag}>`;
}

export function metadataXml(tag, c, model) {
  const events = c.events ? '<tt:Events><tt:Filter/></tt:Events>' : '';
  return `<${tag} token="${x(c.token)}"><tt:Name>${x(c.name)}</tt:Name><tt:UseCount>${model.useCount('metadata', c.token)}</tt:UseCount>`
    + `${events}<tt:Analytics>${c.analytics}</tt:Analytics>${multicastXml(c.multicast)}<tt:SessionTimeout>${x(c.sessionTimeout)}</tt:SessionTimeout></${tag}>`;
}

// The schema's order: video source, audio source, video encoder, audio encoder, (PTZ), (analytics), metadata.
function profileXml(tag, p, model) {
  const part = (kind, render, name) => {
    const c = model.inProfile(p, kind);
    return c ? render(`tt:${name}`, c, model) : '';
  };
  return `<trt:${tag} token="${x(p.token)}" fixed="${p.fixed}"><tt:Name>${x(p.name)}</tt:Name>`
    + part('videoSource', videoSourceXml, 'VideoSourceConfiguration') + part('audioSource', audioSourceXml, 'AudioSourceConfiguration')
    + part('videoEncoder', videoEncoderXml, 'VideoEncoderConfiguration') + part('audioEncoder', audioEncoderXml, 'AudioEncoderConfiguration')
    + part('metadata', metadataXml, 'MetadataConfiguration')
    + `</trt:${tag}>`;
}

const uriXml = (u) => `<trt:MediaUri><tt:Uri>${x(u)}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>`
  + '<tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout></trt:MediaUri>';

const range = (tag, min, max = min) => `<tt:${tag}><tt:Min>${min}</tt:Min><tt:Max>${max}</tt:Max></tt:${tag}>`;

// The encodings a video encoder configuration can have, each at the stream's own values.
function videoOptionsXml(model) {
  const choices = model.videoChoices();
  const jpeg = choices.find((c) => c.encoding === 'JPEG');
  const h264 = choices.find((c) => c.encoding === 'H264');
  const sizes = (c) => `<tt:ResolutionsAvailable><tt:Width>${c.width}</tt:Width><tt:Height>${c.height}</tt:Height></tt:ResolutionsAvailable>`;
  const rates = (c) => `${range('FrameRateRange', c.fps)}${range('EncodingIntervalRange', 1)}`;
  return `<trt:Options>${range('QualityRange', 5)}`
    + `<tt:JPEG>${sizes(jpeg)}${rates(jpeg)}</tt:JPEG>`
    + (h264 ? `<tt:H264>${sizes(h264)}${range('GovLengthRange', h264.gop)}${rates(h264)}<tt:H264ProfilesSupported>${h264.profile}</tt:H264ProfilesSupported></tt:H264>` : '')
    + `<tt:Extension><tt:JPEG>${sizes(jpeg)}${rates(jpeg)}${range('BitrateRange', jpeg.bitrateKbps)}</tt:JPEG>`
    + (h264 ? `<tt:H264>${sizes(h264)}${range('GovLengthRange', h264.gop)}${rates(h264)}<tt:H264ProfilesSupported>${h264.profile}</tt:H264ProfilesSupported>`
      + `${range('BitrateRange', h264.bitrateKbps)}</tt:H264>` : '')
    + '</tt:Extension></trt:Options>';
}

const audioOptionsXml = () => '<trt:Options>' + Object.values(AUDIO).map((a) => `<tt:Options><tt:Encoding>${a.encoding}</tt:Encoding>`
  + `<tt:BitrateList><tt:Items>${a.bitrate}</tt:Items></tt:BitrateList><tt:SampleRateList><tt:Items>${a.sampleRate}</tt:Items></tt:SampleRateList></tt:Options>`).join('')
  + '</trt:Options>';

// ---- reading requests ----

const num = (v) => (v == null || v === '' ? null : Number(v));

function readMulticast(xml) {
  const m = elementsOf(xml, 'Multicast')[0];
  if (m == null) return null;
  return { address: valueOf(m, 'IPv4Address') ?? '0.0.0.0', port: num(valueOf(m, 'Port')) ?? 0, ttl: num(valueOf(m, 'TTL')) ?? 0,
    autoStart: valueOf(m, 'AutoStart') === 'true' };
}

function readVideoEncoder(xml) {
  const c = elementsOf(xml, 'Configuration')[0] ?? '';
  const rate = elementsOf(c, 'RateControl')[0] ?? '';
  return { token: attributeOf(xml, 'Configuration', 'token'), name: valueOf(c, 'Name'), encoding: valueOf(c, 'Encoding'),
    width: num(valueOf(c, 'Width')), height: num(valueOf(c, 'Height')), quality: num(valueOf(c, 'Quality')),
    fps: num(valueOf(rate, 'FrameRateLimit')), interval: num(valueOf(rate, 'EncodingInterval')), bitrateKbps: num(valueOf(rate, 'BitrateLimit')),
    gop: num(valueOf(c, 'GovLength')), profile: valueOf(c, 'H264Profile'), multicast: readMulticast(c), sessionTimeout: valueOf(c, 'SessionTimeout') };
}

const bounds = (c) => (/<(?:[\w-]+:)?Bounds\b/.test(c)
  ? { x: attributeOf(c, 'Bounds', 'x'), y: attributeOf(c, 'Bounds', 'y'), width: attributeOf(c, 'Bounds', 'width'), height: attributeOf(c, 'Bounds', 'height') }
  : null);

// The kinds of configuration per operation name ("AddVideoEncoderConfiguration" -> 'videoEncoder').
const KINDS = { VideoSource: 'videoSource', VideoEncoder: 'videoEncoder', AudioSource: 'audioSource', AudioEncoder: 'audioEncoder', Metadata: 'metadata' };
const RENDER = { videoSource: videoSourceXml, videoEncoder: videoEncoderXml, audioSource: audioSourceXml, audioEncoder: audioEncoderXml, metadata: metadataXml };

function needAudio(model) {
  if (!model.hasAudio()) throw new OnvifFault('ter:ActionNotSupported/ter:AudioNotSupported', 'this camera has no sound ("audio" is off in config.json)');
}

// ---- the service ----

export function mediaResponse(op, xml, { device, model }) {
  const profileToken = () => valueOf(xml, 'ProfileToken');
  const configToken = () => valueOf(xml, 'ConfigurationToken');
  const r = (body) => `<trt:${op}Response>${body}</trt:${op}Response>`;

  // Get/Set/Add/Remove/GetCompatible ...Configuration(s) and ...ConfigurationOptions, for every kind.
  const m = /^(Get|Set|Add|Remove|GetCompatible)(VideoSource|VideoEncoder|AudioSource|AudioEncoder|Metadata)Configuration(s|Options)?$/.exec(op);
  if (m) {
    const [, verb, name, suffix] = m;
    const kind = KINDS[name];
    // Listing audio configurations of a camera without sound gives none; anything else is refused.
    if (kind.startsWith('audio') && !(verb === 'Get' && suffix === 's')) needAudio(model);
    const render = (tag, c) => RENDER[kind](tag, c, model);
    if (verb === 'Get' && suffix === 's') return r(model.list(kind).map((c) => render('trt:Configurations', c)).join(''));
    if (verb === 'Get' && suffix === 'Options') return r(optionsXml(kind, model));
    if (verb === 'Get') return r(render('trt:Configuration', model.config(kind, configToken())));
    if (verb === 'GetCompatible') {
      model.profile(profileToken());
      return r(model.list(kind).map((c) => render('trt:Configurations', c)).join(''));
    }
    if (verb === 'Add') {
      model.addToProfile(profileToken(), kind, configToken());
      return r('');
    }
    if (verb === 'Remove') {
      model.removeFromProfile(profileToken(), kind);
      return r('');
    }
    setConfiguration(kind, xml, model);
    return r('');
  }

  switch (op) {
    case 'GetProfiles': return r(model.profiles.map((p) => profileXml('Profiles', p, model)).join(''));
    case 'GetProfile': return r(profileXml('Profile', model.profile(profileToken()), model));
    case 'CreateProfile': return r(profileXml('Profile', model.createProfile(valueOf(xml, 'Name'), valueOf(xml, 'Token')), model));
    case 'DeleteProfile':
      model.deleteProfile(profileToken());
      return r('');
    case 'GetVideoSources':
      return r(`<trt:VideoSources token="${VIDEO_SOURCE}"><tt:Framerate>${device.fps}</tt:Framerate>${resolutionXml(device)}</trt:VideoSources>`);
    case 'GetAudioSources':
      return r(model.hasAudio() ? `<trt:AudioSources token="${AUDIO_SOURCE}"><tt:Channels>1</tt:Channels></trt:AudioSources>` : '');
    case 'GetGuaranteedNumberOfVideoEncoderInstances': {
      model.config('videoSource', configToken());
      const h264 = model.videoChoices().some((c) => c.encoding === 'H264');
      return r(`<trt:TotalNumber>${model.videoEncoders.length}</trt:TotalNumber><trt:JPEG>${model.videoEncoders.length}</trt:JPEG>`
        + (h264 ? `<trt:H264>${model.videoEncoders.length}</trt:H264>` : ''));
    }
    case 'GetStreamUri': {
      const stream = valueOf(xml, 'Stream');
      if (stream && stream !== 'RTP-Unicast') throw new OnvifFault('ter:InvalidArgVal/ter:InvalidStreamSetup', `${stream} is not available: RTP-Unicast only`);
      const protocol = valueOf(xml, 'Protocol');
      if (protocol && !['UDP', 'TCP', 'RTSP', 'HTTP'].includes(protocol)) throw new OnvifFault('ter:InvalidArgVal/ter:InvalidStreamSetup', `unknown transport ${protocol}`);
      return r(uriXml(`rtsp://${device.address}:${device.rtspPort}/${model.streamPathOf(model.profile(profileToken()))}`));
    }
    case 'GetSnapshotUri':
      model.profile(profileToken());
      return r(uriXml(device.snapshotUrl));
    case 'SetSynchronizationPoint':
      // A new client joins at the next keyframe, at most 4 s away; the stream can't be asked for one.
      model.profile(profileToken());
      return r('');
    case 'GetServiceCapabilities': return r(mediaCapabilities());
    case 'GetVideoAnalyticsConfigurations':
    case 'GetCompatibleVideoAnalyticsConfigurations':
    case 'GetAudioOutputs':
    case 'GetAudioOutputConfigurations':
    case 'GetCompatibleAudioOutputConfigurations':
    case 'GetAudioDecoderConfigurations':
    case 'GetCompatibleAudioDecoderConfigurations':
    case 'GetOSDs':
      return r('');
    default:
      return null;
  }
}

export const mediaCapabilities = () => '<trt:Capabilities SnapshotUri="true" Rotation="false" VideoSourceMode="false" OSD="false">'
  + '<trt:ProfileCapabilities MaximumNumberOfProfiles="4"/>'
  + '<trt:StreamingCapabilities RTPMulticast="false" RTP_TCP="false" RTP_RTSP_TCP="true" NonAggregateControl="false" NoRTSPStreaming="false"/>'
  + '</trt:Capabilities>';

function optionsXml(kind, model) {
  const d = model.device;
  switch (kind) {
    case 'videoEncoder': return videoOptionsXml(model);
    case 'videoSource':
      return `<trt:Options><tt:BoundsRange>${range('XRange', 0)}${range('YRange', 0)}${range('WidthRange', d.width)}${range('HeightRange', d.height)}</tt:BoundsRange>`
        + `<tt:VideoSourceTokensAvailable>${VIDEO_SOURCE}</tt:VideoSourceTokensAvailable></trt:Options>`;
    case 'audioSource': return `<trt:Options><tt:InputTokensAvailable>${AUDIO_SOURCE}</tt:InputTokensAvailable></trt:Options>`;
    case 'audioEncoder': return audioOptionsXml();
    default:
      return '<trt:Options><tt:PTZStatusFilterOptions><tt:PanTiltStatusSupported>false</tt:PanTiltStatusSupported>'
        + '<tt:ZoomStatusSupported>false</tt:ZoomStatusSupported></tt:PTZStatusFilterOptions></trt:Options>';
  }
}

function setConfiguration(kind, xml, model) {
  const c = elementsOf(xml, 'Configuration')[0] ?? '';
  const token = attributeOf(xml, 'Configuration', 'token');
  const name = valueOf(c, 'Name');
  switch (kind) {
    case 'videoEncoder': return model.setVideoEncoder(readVideoEncoder(xml));
    case 'videoSource': return model.setVideoSource({ token, name, sourceToken: valueOf(c, 'SourceToken'), bounds: bounds(c) });
    case 'audioSource': return model.setAudioSource({ token, name, sourceToken: valueOf(c, 'SourceToken') });
    case 'audioEncoder':
      return model.setAudioEncoder({ token, name, encoding: valueOf(c, 'Encoding'), bitrate: num(valueOf(c, 'Bitrate')),
        sampleRate: num(valueOf(c, 'SampleRate')), multicast: readMulticast(c), sessionTimeout: valueOf(c, 'SessionTimeout') });
    default: {
      const analytics = valueOf(c, 'Analytics');
      return model.setMetadata({ token, name, analytics: analytics == null ? null : analytics === 'true',
        events: elementsOf(c, 'Events').length > 0, multicast: readMulticast(c), sessionTimeout: valueOf(c, 'SessionTimeout') });
    }
  }
}

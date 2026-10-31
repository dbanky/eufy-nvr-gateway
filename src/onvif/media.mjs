// The ONVIF media service (version 1, what UniFi Protect uses): one profile per camera that points
// at the gateway's own RTSP stream and snapshot. Nothing is encoded for ONVIF.
// Pure: operation + device -> response body, or null for operations it doesn't support.

import { xmlEscape as x } from './xml.mjs';

const PROFILE = 'main', SOURCE = 'video_src', SOURCE_CONFIG = 'video_src_config', ENCODER = 'video_encoder';
const ENCODINGS = { h264: 'H264', hevc: 'H265' };

const resolution = (d) => `<tt:Resolution><tt:Width>${d.width}</tt:Width><tt:Height>${d.height}</tt:Height></tt:Resolution>`;

const sourceConfig = (tag, d) => `<tt:${tag} token="${SOURCE_CONFIG}"><tt:Name>${SOURCE_CONFIG}</tt:Name><tt:UseCount>1</tt:UseCount>`
  + `<tt:SourceToken>${SOURCE}</tt:SourceToken><tt:Bounds x="0" y="0" width="${d.width}" height="${d.height}"/></tt:${tag}>`;

// RateControl must be there (UniFi Protect needs it); its values are informational.
function encoderConfig(tag, d) {
  const codec = d.codec();
  return `<tt:${tag} token="${ENCODER}"><tt:Name>${ENCODER}</tt:Name><tt:UseCount>1</tt:UseCount>`
    + `<tt:Encoding>${ENCODINGS[codec] ?? 'H264'}</tt:Encoding>${resolution(d)}<tt:Quality>5</tt:Quality>`
    + `<tt:RateControl><tt:FrameRateLimit>${d.fps}</tt:FrameRateLimit><tt:EncodingInterval>1</tt:EncodingInterval>`
    + `<tt:BitrateLimit>${d.bitrateKbps}</tt:BitrateLimit></tt:RateControl>`
    + (codec === 'h264' ? `<tt:H264><tt:GovLength>${d.fps * 4}</tt:GovLength><tt:H264Profile>High</tt:H264Profile></tt:H264>` : '')
    + '<tt:Multicast><tt:Address><tt:Type>IPv4</tt:Type><tt:IPv4Address>0.0.0.0</tt:IPv4Address></tt:Address><tt:Port>0</tt:Port>'
    + '<tt:TTL>0</tt:TTL><tt:AutoStart>false</tt:AutoStart></tt:Multicast><tt:SessionTimeout>PT60S</tt:SessionTimeout>'
    + `</tt:${tag}>`;
}

const profile = (tag, d) => `<trt:${tag} token="${PROFILE}" fixed="true"><tt:Name>${x(d.name)}</tt:Name>`
  + sourceConfig('VideoSourceConfiguration', d) + encoderConfig('VideoEncoderConfiguration', d) + `</trt:${tag}>`;

const uri = (u) => `<trt:MediaUri><tt:Uri>${x(u)}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>`
  + '<tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout></trt:MediaUri>';

export function mediaResponse(op, d) {
  switch (op) {
    case 'GetProfiles': return `<trt:GetProfilesResponse>${profile('Profiles', d)}</trt:GetProfilesResponse>`;
    case 'GetProfile': return `<trt:GetProfileResponse>${profile('Profile', d)}</trt:GetProfileResponse>`;
    case 'GetVideoSources':
      return `<trt:GetVideoSourcesResponse><trt:VideoSources token="${SOURCE}"><tt:Framerate>${d.fps}</tt:Framerate>${resolution(d)}</trt:VideoSources></trt:GetVideoSourcesResponse>`;
    case 'GetVideoSourceConfigurations':
      return `<trt:GetVideoSourceConfigurationsResponse>${sourceConfig('Configurations', d)}</trt:GetVideoSourceConfigurationsResponse>`;
    case 'GetVideoSourceConfiguration':
      return `<trt:GetVideoSourceConfigurationResponse>${sourceConfig('Configuration', d)}</trt:GetVideoSourceConfigurationResponse>`;
    case 'GetVideoEncoderConfigurations':
      return `<trt:GetVideoEncoderConfigurationsResponse>${encoderConfig('Configurations', d)}</trt:GetVideoEncoderConfigurationsResponse>`;
    case 'GetVideoEncoderConfiguration':
      return `<trt:GetVideoEncoderConfigurationResponse>${encoderConfig('Configuration', d)}</trt:GetVideoEncoderConfigurationResponse>`;
    case 'GetVideoEncoderConfigurationOptions':
      return '<trt:GetVideoEncoderConfigurationOptionsResponse><trt:Options><tt:QualityRange><tt:Min>1</tt:Min><tt:Max>10</tt:Max></tt:QualityRange>'
        + `<tt:H264><tt:ResolutionsAvailable><tt:Width>${d.width}</tt:Width><tt:Height>${d.height}</tt:Height></tt:ResolutionsAvailable>`
        + `<tt:GovLengthRange><tt:Min>${d.fps * 4}</tt:Min><tt:Max>${d.fps * 4}</tt:Max></tt:GovLengthRange>`
        + `<tt:FrameRateRange><tt:Min>${d.fps}</tt:Min><tt:Max>${d.fps}</tt:Max></tt:FrameRateRange>`
        + '<tt:EncodingIntervalRange><tt:Min>1</tt:Min><tt:Max>1</tt:Max></tt:EncodingIntervalRange>'
        + '<tt:H264ProfilesSupported>High</tt:H264ProfilesSupported></tt:H264></trt:Options></trt:GetVideoEncoderConfigurationOptionsResponse>';
    case 'GetStreamUri': return `<trt:GetStreamUriResponse>${uri(d.rtspUrl)}</trt:GetStreamUriResponse>`;
    case 'GetSnapshotUri': return `<trt:GetSnapshotUriResponse>${uri(d.snapshotUrl)}</trt:GetSnapshotUriResponse>`;
    case 'GetServiceCapabilities':
      return '<trt:GetServiceCapabilitiesResponse><trt:Capabilities SnapshotUri="true" Rotation="false" VideoSourceMode="false" OSD="false">'
        + '<trt:ProfileCapabilities MaximumNumberOfProfiles="1"/><trt:StreamingCapabilities RTPMulticast="false" RTP_TCP="false" RTP_RTSP_TCP="true"/>'
        + '</trt:Capabilities></trt:GetServiceCapabilitiesResponse>';
    case 'GetAudioSources': return '<trt:GetAudioSourcesResponse/>';
    case 'GetAudioSourceConfigurations': return '<trt:GetAudioSourceConfigurationsResponse/>';
    case 'GetAudioEncoderConfigurations': return '<trt:GetAudioEncoderConfigurationsResponse/>';
    case 'GetAudioOutputs': return '<trt:GetAudioOutputsResponse/>';
    case 'GetOSDs': return '<trt:GetOSDsResponse/>';
    case 'GetVideoAnalyticsConfigurations': return '<trt:GetVideoAnalyticsConfigurationsResponse/>';
    default: return null;
  }
}

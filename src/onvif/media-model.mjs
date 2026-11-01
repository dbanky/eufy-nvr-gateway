// The media profiles and configurations of one camera's ONVIF device, shared by Media (ver10) and
// Media2. NVRs may create profiles, move configurations between them and change encoder settings
// (Profile S requires it); the model only allows what the gateway can really stream.
//
// What can be streamed (each a go2rtc stream; the variants run ffmpeg only while someone watches):
//   video: the camera's stream as it is (H.264, or the camera's own H.265 passed through), or MJPEG
//          at 640 pixels wide (Profile S requires JPEG)
//   audio: AAC 16 kHz mono as it is, or G711 µ-law 8 kHz (ONVIF requires G711 when there is audio),
//          or none
// Frame rate, resolution, bitrate and quality of each encoding are fixed: the stream is the camera's.
//
// It lives in memory and starts from config.json at every start (SetSystemFactoryDefault resets it).

import { OnvifFault } from './xml.mjs';

export const MAX_PROFILES = 4;
export const JPEG_WIDTH = 640;
export const AUDIO = {
  AAC: { encoding: 'AAC', bitrate: 32, sampleRate: 16 },   // kbit/s, kHz (ONVIF's units)
  G711: { encoding: 'G711', bitrate: 64, sampleRate: 8 },
};
const NATIVE = { h264: 'H264', hevc: 'H265' };

// The MJPEG size: 640 wide, the camera's aspect, both multiples of 8 (RTP/JPEG counts in 8-pixel blocks).
export function jpegSize({ width, height }) {
  return { width: JPEG_WIDTH, height: Math.max(8, Math.round((JPEG_WIDTH * height) / width / 8) * 8) };
}

// The go2rtc stream for a video and audio choice (the RTSP path). Camera names can't contain "~".
// video: 'native' | 'JPEG'   audio: 'AAC' | 'G711' | null   hasAudio: the camera stream has sound
export function streamPath(name, { video, audio, hasAudio }) {
  const path = name + (video === 'JPEG' ? '~mjpeg' : '') + (hasAudio && audio === 'G711' ? '~g711' : '');
  return hasAudio && !audio ? `${path}?video` : path;   // go2rtc: only the video track
}

const multicast = () => ({ address: '0.0.0.0', port: 0, ttl: 0, autoStart: false });

export class MediaModel {
  // device: { name, width, height, fps, bitrateKbps, codec(), audio() }
  constructor(device) {
    this.device = device;
    this.reset();
  }

  reset() {
    const d = this.device;
    this.videoSources = [{ token: 'video_src_config', name: 'video_src_config', sourceToken: 'video_src' }];
    this.videoEncoders = [
      { token: 'video_encoder', name: 'video_encoder', video: 'native', multicast: multicast(), sessionTimeout: 'PT60S' },
      { token: 'jpeg_encoder', name: 'jpeg_encoder', video: 'JPEG', multicast: multicast(), sessionTimeout: 'PT60S' },
    ];
    this.audioSources = [{ token: 'audio_src_config', name: 'audio_src_config', sourceToken: 'audio_src' }];
    this.audioEncoders = [
      { token: 'audio_encoder', name: 'audio_encoder', audio: 'AAC', multicast: multicast(), sessionTimeout: 'PT60S' },
      { token: 'g711_encoder', name: 'g711_encoder', audio: 'G711', multicast: multicast(), sessionTimeout: 'PT60S' },
    ];
    this.metadata = [{ token: 'metadata', name: 'metadata', analytics: false, events: false, multicast: multicast(), sessionTimeout: 'PT60S' }];
    // The ready-to-use profile, the one NVRs pick: the camera's stream with its sound.
    this.profiles = [{ token: 'main', name: d.name, fixed: true, videoSource: 'video_src_config', videoEncoder: 'video_encoder',
      audioSource: 'audio_src_config', audioEncoder: 'audio_encoder', metadata: null }];
  }

  hasAudio() {
    return !!this.device.audio?.();
  }

  // ---- reading ----

  profile(token) {
    const profile = this.profiles.find((p) => p.token === token);
    if (!profile) throw new OnvifFault('ter:InvalidArgVal/ter:NoProfile', `no profile "${token}"`);
    return profile;
  }

  // Configurations of a kind: 'videoSource' | 'videoEncoder' | 'audioSource' | 'audioEncoder' | 'metadata'.
  // Audio ones exist only while the camera has sound.
  list(kind) {
    if ((kind === 'audioSource' || kind === 'audioEncoder') && !this.hasAudio()) return [];
    return { videoSource: this.videoSources, videoEncoder: this.videoEncoders, audioSource: this.audioSources,
      audioEncoder: this.audioEncoders, metadata: this.metadata }[kind];
  }

  config(kind, token) {
    const found = this.list(kind).find((c) => c.token === token);
    if (!found) throw new OnvifFault('ter:InvalidArgVal/ter:NoConfig', `no ${kind} configuration "${token}"`);
    return found;
  }

  // The configuration of a kind in a profile, or null (audio ones only while the camera has sound).
  inProfile(profile, kind) {
    const token = profile[kind];
    return token ? this.list(kind).find((c) => c.token === token) ?? null : null;
  }

  useCount(kind, token) {
    return this.profiles.filter((p) => p[kind] === token).length;
  }

  // What a video encoder configuration streams.
  videoOf(config) {
    const d = this.device;
    if (config.video === 'JPEG') return { encoding: 'JPEG', ...jpegSize(d), fps: d.fps, bitrateKbps: Math.round(d.fps * 40), quality: 5, gop: null, profile: null };
    const codec = d.codec();
    return { encoding: NATIVE[codec] ?? 'H264', width: d.width, height: d.height, fps: d.fps, bitrateKbps: d.bitrateKbps, quality: 5,
      gop: d.fps * 4, profile: codec === 'hevc' ? 'Main' : 'High' };
  }

  // The encodings a video encoder configuration may switch to: the camera's own, and JPEG.
  videoChoices() {
    const native = { ...this.videoOf({ video: 'native' }), video: 'native' };
    return [native, { ...this.videoOf({ video: 'JPEG' }), video: 'JPEG' }];
  }

  // The RTSP path of a profile's stream. Profiles need a video source and encoder to stream.
  streamPathOf(profile) {
    const encoder = this.inProfile(profile, 'videoEncoder');
    if (!encoder || !this.inProfile(profile, 'videoSource')) {
      throw new OnvifFault('ter:Action/ter:IncompleteConfiguration', `profile "${profile.token}" needs a video source and a video encoder configuration`);
    }
    const audio = this.inProfile(profile, 'audioEncoder')?.audio ?? null;
    return streamPath(this.device.name, { video: encoder.video, audio, hasAudio: this.hasAudio() });
  }

  // ---- changing ----

  createProfile(name, token) {
    if (token && this.profiles.some((p) => p.token === token)) throw new OnvifFault('ter:InvalidArgVal/ter:ProfileExists', `profile "${token}" exists`);
    if (this.profiles.length >= MAX_PROFILES) throw new OnvifFault('ter:Action/ter:MaxNVTProfiles', `at most ${MAX_PROFILES} profiles`);
    let n = this.profiles.length;
    while (!token && this.profiles.some((p) => p.token === `profile_${n}`)) n++;
    const profile = { token: token || `profile_${n}`, name: name || token || `profile_${n}`, fixed: false,
      videoSource: null, videoEncoder: null, audioSource: null, audioEncoder: null, metadata: null };
    this.profiles.push(profile);
    return profile;
  }

  deleteProfile(token) {
    const profile = this.profile(token);
    if (profile.fixed) throw new OnvifFault('ter:Action/ter:DeletionOfFixedProfile', `profile "${token}" is fixed`);
    this.profiles = this.profiles.filter((p) => p !== profile);
  }

  addToProfile(profileToken, kind, configToken) {
    const profile = this.profile(profileToken);
    if ((kind === 'audioSource' || kind === 'audioEncoder') && !this.hasAudio()) {
      throw new OnvifFault('ter:ActionNotSupported/ter:AudioNotSupported', 'this camera has no sound ("audio" is off in config.json)');
    }
    this.config(kind, configToken);
    profile[kind] = configToken;
  }

  removeFromProfile(profileToken, kind) {
    const profile = this.profile(profileToken);
    if ((kind === 'audioSource' || kind === 'audioEncoder') && !this.hasAudio()) {
      throw new OnvifFault('ter:ActionNotSupported/ter:AudioNotSupported', 'this camera has no sound ("audio" is off in config.json)');
    }
    profile[kind] = null;
  }

  // wanted: { token, name, encoding, width, height, fps, interval, bitrateKbps, quality, gop, profile, multicast, sessionTimeout }
  // (missing fields keep their value). Only an encoding the gateway streams, at its own values.
  setVideoEncoder(wanted) {
    const config = this.config('videoEncoder', wanted.token);
    const choice = this.videoChoices().find((c) => c.encoding === (wanted.encoding ?? this.videoOf(config).encoding));
    if (!choice) throw configModify(`${wanted.encoding} is not available: ${this.videoChoices().map((c) => c.encoding).join(' or ')}`);
    const fixed = [['width', 'width'], ['height', 'height'], ['fps', 'fps'], ['bitrateKbps', 'bitrateKbps'], ['quality', 'quality'], ['gop', 'gop'], ['profile', 'profile']];
    for (const [key, label] of fixed) {
      if (wanted[key] == null || choice[key] == null) continue;
      const same = typeof choice[key] === 'number' ? Math.abs(Number(wanted[key]) - choice[key]) < 0.01 : String(wanted[key]) === String(choice[key]);
      if (!same) throw configModify(`${label} ${wanted[key]} is not available for ${choice.encoding}: it is ${choice[key]}`);
    }
    if (wanted.interval != null && Number(wanted.interval) !== 1) throw configModify('EncodingInterval must be 1');
    Object.assign(config, { video: choice.video, name: wanted.name || config.name },
      wanted.multicast ? { multicast: wanted.multicast } : {}, wanted.sessionTimeout ? { sessionTimeout: wanted.sessionTimeout } : {});
  }

  setVideoSource({ token, name, sourceToken, bounds }) {
    const config = this.config('videoSource', token);
    if (sourceToken && sourceToken !== 'video_src') throw configModify(`no video source "${sourceToken}"`);
    const d = this.device;
    if (bounds && (Number(bounds.x) || Number(bounds.y) || Number(bounds.width) !== d.width || Number(bounds.height) !== d.height)) {
      throw configModify(`the picture is always the whole ${d.width}×${d.height}`);
    }
    if (name) config.name = name;
  }

  setAudioSource({ token, name, sourceToken }) {
    const config = this.config('audioSource', token);
    if (sourceToken && sourceToken !== 'audio_src') throw configModify(`no audio source "${sourceToken}"`);
    if (name) config.name = name;
  }

  // wanted: { token, name, encoding, bitrate, sampleRate, multicast, sessionTimeout }
  setAudioEncoder(wanted) {
    const config = this.config('audioEncoder', wanted.token);
    const choice = AUDIO[wanted.encoding ?? config.audio];
    if (!choice) throw configModify(`${wanted.encoding} is not available: AAC or G711`);
    if (wanted.bitrate != null && Number(wanted.bitrate) !== choice.bitrate) throw configModify(`${choice.encoding} is ${choice.bitrate} kbit/s`);
    if (wanted.sampleRate != null && Number(wanted.sampleRate) !== choice.sampleRate) throw configModify(`${choice.encoding} is ${choice.sampleRate} kHz`);
    Object.assign(config, { audio: choice.encoding, name: wanted.name || config.name },
      wanted.multicast ? { multicast: wanted.multicast } : {}, wanted.sessionTimeout ? { sessionTimeout: wanted.sessionTimeout } : {});
  }

  // Metadata: the motion events go through the event service; there is no analytics.
  setMetadata({ token, name, analytics, events, multicast: m, sessionTimeout }) {
    const config = this.config('metadata', token);
    if (analytics === true) throw configModify('there are no video analytics');
    Object.assign(config, { name: name || config.name }, events != null ? { events } : {}, m ? { multicast: m } : {},
      sessionTimeout ? { sessionTimeout } : {});
  }
}

const configModify = (why) => new OnvifFault('ter:InvalidArgVal/ter:ConfigModify', why);

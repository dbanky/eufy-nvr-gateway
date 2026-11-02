// RTP for the stream the gateway publishes (into its stream hub): H.264 (RFC 6184) or H.265 (RFC 7798)
// video and AAC audio (RFC 3640, mpeg4-generic), plus the SDP that announces them. Pure.
//
// RTP timestamps are the wall clock in each track's clock rate (milliseconds × rate / 1000, modulo
// 2^32), so both tracks share one timeline and a sender report can be exact (sender-report.mjs).

import { adtsHeader, STREAM_FORMAT } from '../audio/adts.mjs';
import { wallClockRtpTime } from '../rtsp/sender-report.mjs';

export const VIDEO_PT = 96;
export const AUDIO_PT = 97;
export const VIDEO_RATE = 90000;
export const MAX_PAYLOAD = 1400;   // fits an Ethernet MTU with IP/TCP/RTP headers to spare

const NAL = {
  h264: { type: (nal) => nal[0] & 0x1f, aud: 9, params: { 7: 'sps', 8: 'pps' } },
  hevc: { type: (nal) => (nal[0] >> 1) & 0x3f, aud: 35, params: { 32: 'vps', 33: 'sps', 34: 'pps' } },
};

// The RTP timestamp of wall-clock time `ms` for a clock of `rate` Hz.
export const rtpTime = wallClockRtpTime;

// The NAL units of an Annex B frame, without start codes; delimiters (AUD) are left out.
export function nalUnits(frame, codec = 'h264') {
  const starts = [];
  for (let i = 0; i + 2 < frame.length; i++) {
    if (frame[i] === 0 && frame[i + 1] === 0 && frame[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  const units = [];
  starts.forEach((start, n) => {
    let end = n + 1 < starts.length ? starts[n + 1] - 3 : frame.length;
    while (end > start && frame[end - 1] === 0) end--;   // the 4-byte form's zero, trailing zeros
    if (end > start && NAL[codec].type(frame.subarray(start, end)) !== NAL[codec].aud) units.push(frame.subarray(start, end));
  });
  return units;
}

// The parameter sets in a frame: { sps, pps } (H.264) or { vps, sps, pps } (H.265), base64.
export function parameterSets(frame, codec = 'h264') {
  const sets = {};
  for (const nal of nalUnits(frame, codec)) {
    const name = NAL[codec].params[NAL[codec].type(nal)];
    if (name && !sets[name]) sets[name] = nal.toString('base64');
  }
  return sets;
}

// One NAL unit as RTP payloads: whole if it fits, else fragmented (FU-A for H.264, FU for H.265).
export function nalPayloads(nal, codec = 'h264', max = MAX_PAYLOAD) {
  if (nal.length <= max) return [nal];
  const out = [];
  if (codec === 'h264') {
    const indicator = (nal[0] & 0xe0) | 28, type = nal[0] & 0x1f;
    for (let at = 1; at < nal.length; at += max - 2) {
      const end = Math.min(at + max - 2, nal.length);
      const fu = (at === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0) | type;
      out.push(Buffer.concat([Buffer.from([indicator, fu]), nal.subarray(at, end)]));
    }
    return out;
  }
  const type = (nal[0] >> 1) & 0x3f, head = [(nal[0] & 0x81) | (49 << 1), nal[1]];
  for (let at = 2; at < nal.length; at += max - 3) {
    const end = Math.min(at + max - 3, nal.length);
    const fu = (at === 2 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0) | type;
    out.push(Buffer.concat([Buffer.from([...head, fu]), nal.subarray(at, end)]));
  }
  return out;
}

// All payloads of one video frame, in order; the last one carries the marker bit.
export function framePayloads(frame, codec = 'h264', max = MAX_PAYLOAD) {
  return nalUnits(frame, codec).flatMap((nal) => nalPayloads(nal, codec, max));
}

// One ADTS frame as an RTP payload (AAC-hbr: one AU header with the 13-bit size, then the raw AU).
export function aacPayload(adts) {
  const h = adtsHeader(adts);
  if (!h) return null;
  const headerLength = adts[1] & 0x01 ? 7 : 9;   // protection_absent = 1: no CRC
  const au = adts.subarray(headerLength, h.length);
  const auHeader = Buffer.from([0, 16, (au.length >> 5) & 0xff, (au.length & 0x1f) << 3]);
  return Buffer.concat([auHeader, au]);
}

// AudioSpecificConfig (ISO 14496-3) as hex: object type, sampling frequency index, channels.
export function aacConfig({ profile = STREAM_FORMAT.profile, sampleRate = STREAM_FORMAT.sampleRate, channels = STREAM_FORMAT.channels } = {}) {
  const objectType = ['aac-main', 'aac-lc', 'aac-ssr', 'aac-ltp'].indexOf(profile) + 1;
  const index = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350].indexOf(sampleRate);
  return ((objectType << 11) | (index << 7) | (channels << 3)).toString(16).padStart(4, '0');
}

export function rtpPacket({ pt, seq, ts, ssrc, marker = false, payload }) {
  const head = Buffer.alloc(12);
  head[0] = 0x80;
  head[1] = (marker ? 0x80 : 0) | pt;
  head.writeUInt16BE(seq & 0xffff, 2);
  head.writeUInt32BE(ts >>> 0, 4);
  head.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([head, payload]);
}

// H.264's profile-level-id (RFC 6184): the three bytes after the SPS's NAL header, in hex. Players,
// browsers above all, set up their decoder from it; ffmpeg's RTSP output always carried it.
export function profileLevelId(spsBase64) {
  return Buffer.from(spsBase64, 'base64').subarray(1, 4).toString('hex');
}

// The SDP the publisher announces: the video track, and the audio track if there is sound.
export function publishSdp({ codec = 'h264', params = {}, audio = false }) {
  const video = codec === 'hevc'
    ? [`a=rtpmap:${VIDEO_PT} H265/${VIDEO_RATE}`,
      `a=fmtp:${VIDEO_PT} ${['vps', 'sps', 'pps'].filter((k) => params[k]).map((k) => `sprop-${k}=${params[k]}`).join(';')}`]
    : [`a=rtpmap:${VIDEO_PT} H264/${VIDEO_RATE}`,
      `a=fmtp:${VIDEO_PT} packetization-mode=1${params.sps ? `;profile-level-id=${profileLevelId(params.sps)}` : ''}${params.sps && params.pps ? `;sprop-parameter-sets=${params.sps},${params.pps}` : ''}`];
  const lines = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=eufy-nvr-gateway', 'c=IN IP4 127.0.0.1', 't=0 0',
    `m=video 0 RTP/AVP ${VIDEO_PT}`, ...video, 'a=control:trackID=0'];
  if (audio) {
    lines.push(`m=audio 0 RTP/AVP ${AUDIO_PT}`, `a=rtpmap:${AUDIO_PT} MPEG4-GENERIC/${STREAM_FORMAT.sampleRate}/${STREAM_FORMAT.channels}`,
      `a=fmtp:${AUDIO_PT} streamtype=5;profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=${aacConfig()}`,
      'a=control:trackID=1');
  }
  return lines.join('\r\n') + '\r\n';
}

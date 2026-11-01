// RTCP sender reports (RFC 3550 section 6.4.1), which ONVIF requires for audio/video sync: they tie
// each track's RTP clock to the wall clock. go2rtc sends none, so the RTSP front makes them from the
// packets it forwards. Pure except for the clock passed in.

const NTP_EPOCH_OFFSET = 2208988800;   // seconds from 1900 to 1970
export const CNAME = 'eufy-nvr-gateway';

// One forwarded RTP track: what a sender report needs to know about it.
export class RtpTrackStats {
  constructor(clockRate) {
    Object.assign(this, { clockRate, ssrc: null, packets: 0, octets: 0, lastRtpTime: null, lastArrival: null });
  }

  // packet: an RTP packet (header included), arrival: ms.
  count(packet, arrival) {
    if (packet.length < 12 || packet[0] >> 6 !== 2) return;
    const csrcs = packet[0] & 0x0f;
    this.ssrc = packet.readUInt32BE(8);
    this.lastRtpTime = packet.readUInt32BE(4);
    this.lastArrival = arrival;
    this.packets = (this.packets + 1) >>> 0;
    this.octets = (this.octets + Math.max(0, packet.length - 12 - csrcs * 4)) >>> 0;
  }

  // A compound RTCP packet (SR + SDES CNAME) for `now`, or null before the first packet.
  report(now) {
    if (this.ssrc == null) return null;
    const rtpTime = this.onWallClock()
      ? wallClockRtpTime(now, this.clockRate)   // the gateway's own stream: exact, whatever arrived when
      : (this.lastRtpTime + Math.round((now - this.lastArrival) * this.clockRate / 1000)) >>> 0;
    return Buffer.concat([senderReport({ ssrc: this.ssrc, now, rtpTime, packets: this.packets, octets: this.octets }), sdes(this.ssrc)]);
  }

  // The gateway's publisher stamps RTP with the wall clock (video/rtp.mjs). A random timestamp base
  // (any other source) lands within a few seconds of that by chance only about once in 5000.
  onWallClock() {
    const diff = Math.abs(((this.lastRtpTime - wallClockRtpTime(this.lastArrival, this.clockRate)) | 0));
    return diff < WALL_CLOCK_WINDOW_S * this.clockRate;
  }
}

export const WALL_CLOCK_WINDOW_S = 5;
export const wallClockRtpTime = (ms, rate) => Math.round(ms * rate / 1000) % 4294967296 >>> 0;

export function ntpTime(ms) {
  const seconds = Math.floor(ms / 1000);
  const fraction = Math.floor(((ms % 1000) / 1000) * 2 ** 32);
  return [(seconds + NTP_EPOCH_OFFSET) >>> 0, fraction >>> 0];
}

export function senderReport({ ssrc, now, rtpTime, packets, octets }) {
  const b = Buffer.alloc(28);
  b[0] = 0x80;              // version 2, no padding, no report blocks
  b[1] = 200;               // SR
  b.writeUInt16BE(6, 2);    // length in 32-bit words minus one
  b.writeUInt32BE(ssrc >>> 0, 4);
  const [hi, lo] = ntpTime(now);
  b.writeUInt32BE(hi, 8);
  b.writeUInt32BE(lo, 12);
  b.writeUInt32BE(rtpTime >>> 0, 16);
  b.writeUInt32BE(packets >>> 0, 20);
  b.writeUInt32BE(octets >>> 0, 24);
  return b;
}

// SDES with the CNAME item: RFC 3550 wants it in every compound RTCP packet.
export function sdes(ssrc, cname = CNAME) {
  const text = Buffer.from(cname);
  const itemLength = 2 + text.length + 1;            // type, length, text, end-of-list
  const chunk = 4 + Math.ceil(itemLength / 4) * 4;   // SSRC + items padded to 32 bits
  const b = Buffer.alloc(4 + chunk);
  b[0] = 0x81;              // version 2, one chunk
  b[1] = 202;               // SDES
  b.writeUInt16BE(b.length / 4 - 1, 2);
  b.writeUInt32BE(ssrc >>> 0, 4);
  b[8] = 1;                 // CNAME
  b[9] = text.length;
  text.copy(b, 10);
  return b;
}

// Is this RTCP packet (from a client) a receiver report? Any RTCP from a client keeps its session alive.
export const isRtcp = (packet) => packet.length >= 8 && packet[0] >> 6 === 2 && packet[1] >= 200 && packet[1] <= 207;

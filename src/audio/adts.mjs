// ADTS: the framing eufy cameras send their AAC audio in. Each frame is a 7-byte header (9 with a
// CRC) followed by one AAC access unit of 1024 samples. Pure.

const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const PROFILES = ['aac-main', 'aac-lc', 'aac-ssr', 'aac-ltp'];

// What eufy cameras send, and so what every stream with audio carries (silence included): the stream
// copies the frames, so all of them must agree.
export const STREAM_FORMAT = Object.freeze({ profile: 'aac-lc', sampleRate: 16000, channels: 1 });
export const SAMPLES_PER_FRAME = 1024;

// { profile, sampleRate, channels, length } of the frame starting at buf[0], or null.
export function adtsHeader(buf) {
  if (buf.length < 7 || buf[0] !== 0xff || (buf[1] & 0xf6) !== 0xf0) return null;
  const sampleRate = RATES[(buf[2] >> 2) & 0x0f];
  const length = ((buf[3] & 0x03) << 11) | (buf[4] << 3) | (buf[5] >> 5);
  if (!sampleRate || length < 7) return null;
  return { profile: PROFILES[buf[2] >> 6], sampleRate, channels: ((buf[2] & 0x01) << 2) | (buf[3] >> 6), length };
}

export function fitsStream(frame) {
  const h = adtsHeader(frame);
  return !!h && h.profile === STREAM_FORMAT.profile && h.sampleRate === STREAM_FORMAT.sampleRate && h.channels === STREAM_FORMAT.channels;
}

// Cuts a byte stream (HTTP chunks) into whole ADTS frames for onFrame(frame).
export class AdtsSplitter {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const start = findSync(this.buffer);
      if (start < 0) { this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 1)); return; }
      if (start > 0) this.buffer = this.buffer.subarray(start);
      const h = adtsHeader(this.buffer);
      if (!h) {
        if (this.buffer.length < 7) return;   // the header isn't complete yet
        this.buffer = this.buffer.subarray(1);   // a false sync word
        continue;
      }
      if (this.buffer.length < h.length) return;
      this.onFrame(Buffer.from(this.buffer.subarray(0, h.length)));
      this.buffer = this.buffer.subarray(h.length);
    }
  }
}

function findSync(buf) {
  for (let i = 0; i + 1 < buf.length; i++) if (buf[i] === 0xff && (buf[i + 1] & 0xf6) === 0xf0) return i;
  return -1;
}

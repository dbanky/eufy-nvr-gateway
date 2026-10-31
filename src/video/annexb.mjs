// Small helpers for H.264 and H.265 byte streams ("Annex B": NAL units after 00 00 01 start codes).
// Every frame starts with an access unit delimiter (AUD), so a frame is everything from one AUD to
// the next. Codecs are named as ffmpeg names them: 'h264' and 'hevc'.

const NAL = {
  h264: { type: (b) => b & 0x1f, aud: 9, isKeyframe: (t) => t === 5, isPicture: (t) => t >= 1 && t <= 5 },
  hevc: { type: (b) => (b >> 1) & 0x3f, aud: 35, isKeyframe: (t) => t >= 16 && t <= 21, isPicture: (t) => t <= 31 },
};   // keyframes: H.264 IDR; H.265 IRAP (BLA, IDR, CRA). Pictures: the slice NAL types.

// Position of the start code before the first NAL unit for which match(type) is true; -1 if none.
function findNal(buf, codec, match, from) {
  const { type } = NAL[codec];
  for (let i = from; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1 && match(type(buf[i + 3]))) {
      return i > 0 && buf[i - 1] === 0 ? i - 1 : i;   // include the 4-byte form's extra zero
    }
  }
  return -1;
}

// True if the frame is a clean switching point (no references to earlier frames).
export function isKeyframe(frame, codec = 'h264') {
  return findNal(frame, codec, NAL[codec].isKeyframe, 0) >= 0;
}

// The frame minus its leading delimiter: everything from the second start code on.
function withoutDelimiter(frame) {
  const next = frame.indexOf(Buffer.from([0, 0, 1]), 4);
  return next < 0 ? Buffer.alloc(0) : frame.subarray(frame[next - 1] === 0 ? next - 1 : next);
}

// Collects stream chunks and hands out complete frames. A frame is only complete once the next
// one starts (or the stream ends: flush()). A "frame" without a picture (a stray delimiter, or only
// parameter sets) is joined to the next one, so every frame handed out is one picture.
export class FrameSplitter {
  constructor(onFrame, codec = 'h264') {
    this.emit = onFrame;
    this.isAud = (t) => t === NAL[codec].aud;
    this.codec = codec;
    this.buf = Buffer.alloc(0);   // starts with an AUD once `inFrame` is true
    this.inFrame = false;
    this.carry = null;            // picture-less bytes waiting for the next picture
  }

  onFrame(frame) {
    if (this.carry) frame = Buffer.concat([this.carry, withoutDelimiter(frame)]);   // one delimiter per frame
    if (findNal(frame, this.codec, NAL[this.codec].isPicture, 0) < 0) {
      this.carry = frame;
      return;
    }
    this.carry = null;
    this.emit(frame);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let start = findNal(this.buf, this.codec, this.isAud, 0);
    if (start < 0) return;                 // no frame started yet (or none in this chunk)
    for (let next; (next = findNal(this.buf, this.codec, this.isAud, start + 4)) >= 0; start = next) {
      this.onFrame(Buffer.from(this.buf.subarray(start, next)));
    }
    this.buf = this.buf.subarray(start);   // the frame still being written
    this.inFrame = true;
  }

  // End of stream: the last frame is complete now.
  flush() {
    if (this.inFrame && this.buf.length) this.onFrame(Buffer.from(this.buf));
    this.buf = Buffer.alloc(0);
    this.inFrame = false;
  }
}

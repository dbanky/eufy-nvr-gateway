// Small helpers for H.264 Annex B byte streams (00 00 01 start codes).
// The encoders write an access unit delimiter (AUD, NAL type 9) before every frame, so a frame is
// everything from one AUD to the next.

const NAL_IDR = 5;
const NAL_AUD = 9;

// Position of the start code before a NAL unit of `type`, scanning from `from`; -1 if none.
function findNal(buf, type, from) {
  for (let i = from; i + 3 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1 && (buf[i + 3] & 0x1f) === type) {
      return i > 0 && buf[i - 1] === 0 ? i - 1 : i;   // include the 4-byte form's extra zero
    }
  }
  return -1;
}

// True if the frame contains an IDR slice: a clean switching point.
export function isKeyframe(frame) {
  return findNal(frame, NAL_IDR, 0) >= 0;
}

// Collects stream chunks and hands out complete frames. A frame is only complete once the next
// one starts (or the stream ends: flush()).
export class FrameSplitter {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buf = Buffer.alloc(0);   // starts with an AUD once `inFrame` is true
    this.inFrame = false;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let start = findNal(this.buf, NAL_AUD, 0);
    if (start < 0) return;                 // no frame started yet (or none in this chunk)
    for (let next; (next = findNal(this.buf, NAL_AUD, start + 4)) >= 0; start = next) {
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

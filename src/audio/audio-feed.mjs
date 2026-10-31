// Decides which AAC frame a camera's stream plays next: silence while the camera sleeps (so the
// audio track never stops, which NVRs expect), the camera's own audio while it is live.
//
// Camera audio arrives over the network in bursts. A short buffer (prebuffer frames) absorbs that;
// when it runs dry, silence fills the gap and the buffer fills again. A backlog beyond maxBacklog is
// dropped rather than letting the sound fall behind the picture.

import { fitsStream } from './adts.mjs';

export class AudioFeed {
  // silence: one silent ADTS frame in the stream's format (see silence.mjs).
  constructor({ silence, prebuffer = 4, maxBacklog = 16 }) {
    Object.assign(this, { silence, prebuffer, maxBacklog });
    this.live = false;
    this.queue = [];
    this.playing = false;
  }

  startLive() {
    Object.assign(this, { live: true, queue: [], playing: false });
  }

  stopLive() {
    Object.assign(this, { live: false, queue: [], playing: false });
  }

  // A frame of the camera's audio. false: not taken (not live, or a format the stream can't carry).
  pushLive(frame) {
    if (!this.live || !fitsStream(frame)) return false;
    this.queue.push(frame);
    if (this.queue.length > this.maxBacklog) this.queue.splice(0, this.queue.length - Math.ceil(this.maxBacklog / 2));
    return true;
  }

  next() {
    if (!this.live) return this.silence;
    if (!this.playing && this.queue.length >= this.prebuffer) this.playing = true;
    if (this.playing && this.queue.length) return this.queue.shift();
    this.playing = false;
    return this.silence;
  }
}

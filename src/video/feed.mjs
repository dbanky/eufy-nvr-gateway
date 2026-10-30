// Decides which encoded frame the stream plays next.
//
//   loop  a still picture's frames (a few seconds), repeated forever. Costs no encoding.
//   live  frames from the live encoder, in order.
//
// Switching is only safe at a keyframe: a loop always starts with one, and live takes over at the
// first live keyframe after armLive().

import { isKeyframe } from './h264.mjs';

export class Feed {
  constructor({ maxLiveBacklog = 30 } = {}) {
    this.mode = 'loop';
    this.loop = null;
    this.loopIndex = 0;
    this.liveArmed = false;
    this.liveQueue = [];
    this.maxLiveBacklog = maxLiveBacklog;   // frames; older ones are dropped rather than adding delay
  }

  // Play this loop from its start, right away. Live, if it was on, ends here.
  showLoop(frames) {
    Object.assign(this, { mode: 'loop', loop: frames, loopIndex: 0, liveArmed: false, liveQueue: [] });
  }

  // Live frames are welcome from now on; the switch happens at the first keyframe.
  armLive() {
    this.liveArmed = true;
  }

  pushLive(frame) {
    if (this.mode !== 'live') {
      if (!this.liveArmed || !isKeyframe(frame)) return;
      this.mode = 'live';
      this.liveQueue = [];
    }
    this.liveQueue.push(frame);
    if (this.liveQueue.length > this.maxLiveBacklog) this.liveQueue.splice(0, this.liveQueue.length - this.maxLiveBacklog / 2);
  }

  // The next frame to send, or undefined if there is none yet (live frame not encoded yet).
  // fromKeyframe: the receiver needs a clean start (e.g. a freshly started publisher).
  next({ fromKeyframe = false } = {}) {
    if (this.mode === 'live') {
      if (fromKeyframe) while (this.liveQueue.length && !isKeyframe(this.liveQueue[0])) this.liveQueue.shift();
      return this.liveQueue.shift();
    }
    if (!this.loop?.length) return undefined;
    if (fromKeyframe) this.loopIndex = 0;
    const frame = this.loop[this.loopIndex];
    this.loopIndex = (this.loopIndex + 1) % this.loop.length;
    return frame;
  }
}

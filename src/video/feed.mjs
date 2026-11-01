// Decides which encoded frame the stream plays next.
//
//   loop  a still picture's frames (a few seconds), repeated forever. Costs no encoding.
//   live  frames from the live encoder, in order.
//
// Switching is only safe at a keyframe: a loop always starts with one, and live takes over at the
// first live keyframe after armLive(). Every live frame is announced ('live') the moment it arrives,
// with its arrival time (arrivalOf), so the publisher sends it at once and stamps it with that time.
//
// The stream has one codec: 'h264', or 'hevc' for a camera whose own H.265 is passed through.
// A change emits 'codec': the publisher restarts with the new format.

import { EventEmitter } from 'node:events';
import { isKeyframe } from './annexb.mjs';

export class Feed extends EventEmitter {
  constructor({ maxLiveBacklog = 300, now = Date.now } = {}) {
    super();
    this.codec = 'h264';
    this.mode = 'loop';
    this.loop = null;
    this.loopIndex = 0;
    this.liveArmed = false;
    this.liveQueue = [];
    this.maxLiveBacklog = maxLiveBacklog;   // frames; only a safety net: the publisher takes each at once
    this.now = now;
    this.arrivals = new WeakMap();          // live frame -> arrival time (ms)
  }

  // When a live frame arrived (ms), or undefined for a loop frame.
  arrivalOf(frame) {
    return this.arrivals.get(frame);
  }

  // Play this loop from its start, right away. Live, if it was on, ends here.
  showLoop(frames, codec = 'h264') {
    Object.assign(this, { mode: 'loop', loop: frames, loopIndex: 0, liveArmed: false, liveQueue: [] });
    if (codec !== this.codec) {
      this.codec = codec;
      this.emit('codec', codec);
    }
  }

  // Live frames are welcome from now on; the switch happens at the first keyframe.
  armLive() {
    this.liveArmed = true;
  }

  pushLive(frame) {
    if (this.mode !== 'live') {
      if (!this.liveArmed || !isKeyframe(frame, this.codec)) return;
      this.mode = 'live';
      this.liveQueue = [];
    }
    this.arrivals.set(frame, this.now());
    this.liveQueue.push(frame);
    if (this.liveQueue.length > this.maxLiveBacklog) this.liveQueue.splice(0, this.liveQueue.length - this.maxLiveBacklog / 2);
    this.emit('live');
  }

  // The next frame to send, or undefined if there is none yet (live frame not encoded yet).
  // fromKeyframe: the receiver needs a clean start (e.g. a freshly started publisher).
  next({ fromKeyframe = false } = {}) {
    if (this.mode === 'live') {
      if (fromKeyframe) while (this.liveQueue.length && !isKeyframe(this.liveQueue[0], this.codec)) this.liveQueue.shift();
      return this.liveQueue.shift();
    }
    if (!this.loop?.length) return undefined;
    if (fromKeyframe) this.loopIndex = 0;
    const frame = this.loop[this.loopIndex];
    this.loopIndex = (this.loopIndex + 1) % this.loop.length;
    return frame;
  }
}

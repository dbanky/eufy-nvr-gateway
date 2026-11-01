// A camera's sound for its stream: the camera's own AAC frames while a session is on, announced
// ('frame') the moment each arrives, so the publisher sends it at once. Silence (one frame, made at
// start-up) fills the time the camera sends none, so the audio track never stops (NVRs expect that).
// Nothing is buffered or dropped here.

import { EventEmitter } from 'node:events';
import { fitsStream } from './adts.mjs';

export class AudioFeed extends EventEmitter {
  // silence: one silent ADTS frame in the stream's format (see silence.mjs).
  constructor({ silence }) {
    super();
    this.silence = silence;
    this.live = false;
  }

  startLive() {
    this.live = true;
  }

  stopLive() {
    this.live = false;
  }

  // A frame of the camera's audio. false: not taken (no session on, or a format the stream can't carry).
  pushLive(frame) {
    if (!this.live || !fitsStream(frame)) return false;
    this.emit('frame', frame);
    return true;
  }
}

// One camera's stream as its publisher (video/publisher.mjs) hands it in. Viewers listen to it.
//
// Events:
//   'ready'                                   once, right after it opens (the publisher then sends
//                                             what it kept since the last keyframe)
//   'packet' (track, packet, startsKeyframe)  an RTP packet; track 0 is the video, 1 the sound
//   'media'  ('video' | 'audio', frame)       the encoded frame itself, for the transcoders
//   'close'  (reason)                         once; nothing is sent after it

import { EventEmitter } from 'node:events';
import { mediaSections } from './sdp.mjs';

export class Publication extends EventEmitter {
  constructor(name, { sdp, codec }) {
    super();
    this.setMaxListeners(0);   // one listener per viewer
    this.name = name;
    this.sdp = sdp;
    this.codec = codec;
    this.sections = mediaSections(sdp);   // video first, then the sound if there is any
    this.ready = true;
    this.closed = false;
    setImmediate(() => !this.closed && this.emit('ready'));
  }

  // false once closed: the publisher has to open a new one
  send(track, packet, startsKeyframe = false) {
    if (this.closed) return false;
    this.emit('packet', track, packet, startsKeyframe);
    return true;
  }

  media(what, frame) {
    if (!this.closed) this.emit('media', what, frame);
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.emit('close', reason);
  }
}

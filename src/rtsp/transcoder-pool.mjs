// The running transcoders: one per camera and kind (JPEG or G.711), shared by all its viewers,
// started by the first and stopped with the last.

import { Transcoder } from './transcoder.mjs';
import { jpegSize } from '../onvif/media-model.mjs';

export class TranscoderPool {
  // cameras: Map name -> { width, height } (the JPEG's size follows the camera's shape).
  constructor({ cameras = new Map(), log = () => {}, transcoderImpl = (o) => new Transcoder(o) } = {}) {
    this.cameras = cameras;
    this.log = log;
    this.transcoderImpl = transcoderImpl;
    this.running = new Map();   // "name kind" -> { transcoder, publication, users }
  }

  // Starts listening to the publication's `kind` version: onPacket(packet, startsPicture).
  // Returns release(), to call once when done.
  lease(publication, kind, onPacket) {
    const entry = this.entryFor(publication, kind);
    entry.users++;
    entry.transcoder.on('packet', onPacket);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.transcoder.off('packet', onPacket);
      if (--entry.users === 0) this.stop(entry);
    };
  }

  // The running transcoder for the publication, or a new one. A transcoder of an older publication
  // of the camera (before a codec change) is stopped: it reads a stream that has ended.
  entryFor(publication, kind) {
    const key = `${publication.name} ${kind}`;
    const entry = this.running.get(key);
    if (entry?.publication === publication) return entry;
    entry?.transcoder.stop();
    return this.start(key, publication, kind);
  }

  start(key, publication, kind) {
    const camera = this.cameras.get(publication.name);
    const transcoder = this.transcoderImpl({ kind, publication, size: camera ? jpegSize(camera) : undefined, log: this.log });
    const entry = { key, transcoder, publication, users: 0 };
    this.running.set(key, entry);
    transcoder.start()?.catch?.((e) => this.log(publication.name, `${kind}: ${e.message}`));
    return entry;
  }

  stop(entry) {
    entry.transcoder.stop();
    if (this.running.get(entry.key) === entry) this.running.delete(entry.key);
  }
}

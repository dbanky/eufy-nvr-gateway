// The gateway's streams, kept in memory: each camera's publisher (video/publisher.mjs) publishes
// its stream here, and every RTSP viewer of the camera (session.mjs) subscribes to it.
//
// A viewer asks for an address (stream-path.mjs). It gets the publisher's own tracks, or in their
// place the JPEG or G.711 version made by a transcoder (transcoder-pool.mjs) while anyone watches.
//
// A viewer's video starts at the next keyframe: nothing it can't decode, and no old pictures that
// would leave it behind for good. Its sound starts at once.

import { Publication } from './publication.mjs';
import { TranscoderPool } from './transcoder-pool.mjs';
import { SDP_SECTION } from './transcoder.mjs';
import { parseStreamPath } from './stream-path.mjs';
import { viewerSdp } from './sdp.mjs';

// The tracks a viewer of `want` (parseStreamPath) gets, in order: each one either the publisher's
// own track `publisherTrack` or a transcoder's `kind`, with the SDP section it is described by.
// null: G.711 of a stream without sound.
export function viewerTracks(want, publication) {
  const [video, audio] = publication.sections;
  if (want.g711 && !audio) return null;
  const tracks = [want.mjpeg ? transcoded('mjpeg') : own(0, video)];
  if (audio && !want.videoOnly) tracks.push(want.g711 ? transcoded('pcmu') : own(1, audio));
  return tracks;
}
const own = (publisherTrack, section) => ({ publisherTrack, section });
const transcoded = (kind) => ({ kind, section: SDP_SECTION[kind] });

// onPacket(track, packet, starts), with the video (track 0) held back until a packet starts a
// keyframe. The other tracks pass at once.
export function startVideoAtKeyframe(onPacket) {
  let waiting = true;
  return (track, packet, starts) => {
    if (track === 0 && waiting) {
      if (!starts) return;
      waiting = false;
    }
    onPacket(track, packet, starts);
  };
}

export class StreamHub {
  // cameras: [{ name, width, height }], for the size of the JPEG version.
  constructor({ cameras = [], log = () => {}, transcoderImpl } = {}) {
    this.publications = new Map();   // name -> its current Publication
    this.transcoders = new TranscoderPool({ cameras: new Map(cameras.map((c) => [c.name, c])), log, transcoderImpl });
  }

  // The publisher's side: a new stream for `name`. One before it is closed, which lets its viewers
  // go (they come back to the new one).
  publish(name, { sdp, codec }) {
    this.publications.get(name)?.close('replaced');
    const publication = new Publication(name, { sdp, codec });
    this.publications.set(name, publication);
    publication.once('close', () => {
      if (this.publications.get(name) === publication) this.publications.delete(name);
    });
    return publication;
  }

  // A viewer's side: { sdp, subscribe(onPacket, onEnd) } for an address, or null if there's no such
  // stream. subscribe returns unsubscribe(). onPacket(track, packet, startsKeyframe) gets the
  // viewer's own track numbers; onEnd() runs when the stream ends.
  source(uri) {
    const want = parseStreamPath(uri);
    const publication = want && this.publications.get(want.name);
    const tracks = publication && viewerTracks(want, publication);
    if (!tracks) return null;
    return {
      sdp: viewerSdp(tracks.map((t) => t.section)),
      subscribe: (onPacket, onEnd = () => {}) => this.subscribe(publication, tracks, onPacket, onEnd),
    };
  }

  subscribe(publication, tracks, onPacket, onEnd) {
    const deliver = startVideoAtKeyframe(onPacket);
    const fromPublisher = (publisherTrack, packet, starts) => {
      const track = tracks.findIndex((t) => t.publisherTrack === publisherTrack);
      if (track >= 0) deliver(track, packet, starts);
    };
    const releases = tracks.flatMap((t, track) => (t.kind
      ? [this.transcoders.lease(publication, t.kind, (packet, starts) => deliver(track, packet, starts))]
      : []));

    let ended = false;
    const unsubscribe = () => {
      if (ended) return;
      ended = true;
      publication.off('packet', fromPublisher);
      publication.off('close', onClose);
      for (const release of releases) release();
    };
    const onClose = () => {
      unsubscribe();
      onEnd();
    };
    publication.on('packet', fromPublisher);
    publication.once('close', onClose);
    return unsubscribe;
  }
}

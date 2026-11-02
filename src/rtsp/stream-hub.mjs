// The gateway's streams, kept in memory: each camera's publisher (video/publisher.mjs) hands its RTP
// packets in, and every RTSP viewer of the camera takes them out (session.mjs). go2rtc used to sit in
// between as a separate program.
//
// Paths (rtsp://host:port/<path>):
//   <name>               the camera's stream: its video and, with sound, AAC
//   <name>?video         the video only
//   <name>~mjpeg         JPEG pictures instead of the video (ONVIF Profile S requires JPEG)
//   <name>~g711          G.711 µ-law sound instead of AAC (ONVIF requires G.711 when there is sound)
//   <name>~mjpeg~g711    both
// The JPEG and G.711 tracks come from an ffmpeg that runs only while someone watches (transcoder.mjs),
// one per camera and kind, shared by all its viewers.
//
// A viewer's video starts at the next keyframe: nothing it can't decode, and no old pictures that
// would leave it behind for good. Its sound starts at once.

import { EventEmitter } from 'node:events';
import { Transcoder, PAYLOAD_TYPE } from './transcoder.mjs';
import { jpegSize } from '../onvif/media-model.mjs';

// The stream a URI asks for: rtsp://host:port/garden~mjpeg?video/trackID=0 (or just the path)
// -> { name, mjpeg, g711, videoOnly }, or null for a variant that doesn't exist.
export function parsePath(uri) {
  const rest = String(uri).replace(/^rtsp:\/\/[^/]*\/?/i, '');
  const [path, query = ''] = rest.split('?');
  const first = decodeURIComponent(path.split('/')[0] ?? '');
  const [name, ...variants] = first.split('~');
  if (!name || variants.some((v) => v !== 'mjpeg' && v !== 'g711')) return null;
  const params = query.split('/')[0].split('&').filter(Boolean).map((p) => p.split('=')[0]);
  return { name, mjpeg: variants.includes('mjpeg'), g711: variants.includes('g711'), videoOnly: params.includes('video') && !params.includes('audio') };
}

// The SDP split into its session lines and one list of lines per media section (from each m= line).
export function sdpSections(sdp) {
  const media = [];
  for (const line of String(sdp).split(/\r?\n/).filter(Boolean)) if (line.startsWith('m=') || media.length) {
    if (line.startsWith('m=')) media.push([]);
    media.at(-1).push(line);
  }
  return media;
}

const SECTION = {
  mjpeg: [`m=video 0 RTP/AVP ${PAYLOAD_TYPE.mjpeg}`, `a=rtpmap:${PAYLOAD_TYPE.mjpeg} JPEG/90000`],
  pcmu: [`m=audio 0 RTP/AVP ${PAYLOAD_TYPE.pcmu}`, `a=rtpmap:${PAYLOAD_TYPE.pcmu} PCMU/8000`],
};

// What a viewer is told: the tracks in order, flowing from the device, each with its control.
export function viewerSdp(sections) {
  const head = ['v=0', 'o=- 1 1 IN IP4 0.0.0.0', 's=eufy-nvr-gateway', 'c=IN IP4 0.0.0.0', 't=0 0', 'a=control:*'];
  const body = sections.flatMap((lines, i) => [
    ...lines.filter((l) => !/^a=(control|sendonly|recvonly|sendrecv|inactive)\b/.test(l)), 'a=sendonly', `a=control:trackID=${i}`]);
  return [...head, ...body].join('\r\n') + '\r\n';
}

// One camera's stream as its publisher sends it. Emits 'packet' (track, packet, startsKeyframe),
// 'media' ('video' | 'audio', encoded frame) for the transcoders, and 'close' (reason) once.
export class Publication extends EventEmitter {
  constructor(name, { sdp, codec }) {
    super();
    this.setMaxListeners(0);
    Object.assign(this, { name, sdp, codec, ready: true, closed: false });
    this.sections = sdpSections(sdp);   // video first, then audio if there is sound
    setImmediate(() => !this.closed && this.emit('ready'));
  }

  send(track, packet, startsKeyframe = false) {
    if (this.closed) return false;
    this.emit('packet', track, packet, startsKeyframe);
    return true;
  }

  media(what, data) {
    if (!this.closed) this.emit('media', what, data);
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.emit('close', reason);
  }
}

export class StreamHub {
  // cameras: [{ name, width, height }] (the JPEG size follows the camera's shape).
  constructor({ cameras = [], log = () => {}, transcoderImpl = (o) => new Transcoder(o) } = {}) {
    Object.assign(this, { log, transcoderImpl });
    this.cameras = new Map(cameras.map((c) => [c.name, c]));
    this.publications = new Map();   // name -> Publication
    this.transcoders = new Map();    // "name kind" -> { transcoder, publication, refs }
  }

  // The publisher's side: a new stream for `name` (replacing one before it).
  publish(name, { sdp, codec }) {
    this.publications.get(name)?.close('replaced');
    const publication = new Publication(name, { sdp, codec });
    this.publications.set(name, publication);
    publication.once('close', () => {
      if (this.publications.get(name) === publication) this.publications.delete(name);
    });
    return publication;
  }

  // A viewer's side: { sdp, subscribe(onPacket, onEnd) } for a URI, or null if there's no such stream.
  // onPacket(track, packet, startsKeyframe); onEnd() when the stream ends (the viewer has to come back).
  source(uri) {
    const want = parsePath(uri);
    const publication = want && this.publications.get(want.name);
    if (!publication) return null;
    const [video, audio] = publication.sections;
    if (want.g711 && !audio) return null;
    const tracks = [want.mjpeg ? { kind: 'mjpeg' } : { base: 0 }];
    if (audio && !want.videoOnly) tracks.push(want.g711 ? { kind: 'pcmu' } : { base: 1 });
    const sections = tracks.map((t) => (t.kind ? SECTION[t.kind] : publication.sections[t.base]));
    return {
      sdp: viewerSdp(sections),
      subscribe: (onPacket, onEnd = () => {}) => this.subscribe(publication, tracks, onPacket, onEnd),
    };
  }

  subscribe(publication, tracks, onPacket, onEnd) {
    let waitingForKeyframe = true;   // the video track is always track 0
    const deliver = (track, packet, starts) => {
      if (track === 0 && waitingForKeyframe) {
        if (!starts) return;
        waitingForKeyframe = false;
      }
      onPacket(track, packet, starts);
    };
    const fromPublisher = (baseTrack, packet, starts) => {
      const track = tracks.findIndex((t) => t.base === baseTrack);
      if (track >= 0) deliver(track, packet, starts);
    };
    const leases = tracks.map((t, track) => t.kind && this.lease(publication, t.kind, (packet, starts) => deliver(track, packet, starts)))
      .filter(Boolean);
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      publication.off('packet', fromPublisher);
      publication.off('close', onClose);
      for (const release of leases) release();
    };
    const onClose = () => { end(); onEnd(); };
    publication.on('packet', fromPublisher);
    publication.once('close', onClose);
    return end;
  }

  // One shared transcoder per camera and kind, running while anyone uses it.
  lease(publication, kind, onPacket) {
    const key = `${publication.name} ${kind}`;
    let entry = this.transcoders.get(key);
    if (entry && entry.publication !== publication) {
      entry.transcoder.stop();
      entry = null;
    }
    if (!entry) {
      const cam = this.cameras.get(publication.name);
      const transcoder = this.transcoderImpl({ kind, publication, size: cam ? jpegSize(cam) : undefined, log: this.log });
      entry = { transcoder, publication, refs: 0 };
      this.transcoders.set(key, entry);
      transcoder.start()?.catch?.((e) => this.log(publication.name, `${kind}: ${e.message}`));
    }
    entry.refs++;
    entry.transcoder.on('packet', onPacket);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.transcoder.off('packet', onPacket);
      if (--entry.refs > 0) return;
      entry.transcoder.stop();
      if (this.transcoders.get(key) === entry) this.transcoders.delete(key);
    };
  }
}

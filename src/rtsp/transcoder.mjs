// A JPEG or G.711 version of one camera's stream, made by an ffmpeg only while someone watches it.
//
//   publication 'media'  ->  ffmpeg stdin  ->  RTP to a UDP port on 127.0.0.1  ->  'packet'
//   (Annex B video, or      (RFC 2435 JPEG, or PCMU)       (only this process reads it)
//    ADTS sound)
//
// Emits 'packet' (packet, startsPicture): every packet, in order. startsPicture is true for the
// first packet of a JPEG picture (each one stands alone, like a keyframe) and for every sound packet.
// ffmpeg is started again after RESTART_MS if it exits.

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { isKeyframe } from '../video/annexb.mjs';

export const PAYLOAD_TYPE = { mjpeg: 26, pcmu: 0 };

// The SDP media section a viewer is told for each kind (static payload types: no fmtp needed).
export const SDP_SECTION = {
  mjpeg: [`m=video 0 RTP/AVP ${PAYLOAD_TYPE.mjpeg}`, `a=rtpmap:${PAYLOAD_TYPE.mjpeg} JPEG/90000`],
  pcmu: [`m=audio 0 RTP/AVP ${PAYLOAD_TYPE.pcmu}`, `a=rtpmap:${PAYLOAD_TYPE.pcmu} PCMU/8000`],
};

// What each kind is made from.
export const SOURCE_OF = { mjpeg: 'video', pcmu: 'audio' };

export const MAX_STDIN_BACKLOG = 8 * 1024 * 1024;   // ffmpeg this far behind: frames are skipped
export const RESTART_MS = 1000;
const RTP_HEADER = 12;

// The input's format is given, so ffmpeg needn't wait for data to probe: 32 KB would be 8 s of the
// camera's sound, or seconds of the sleeping picture.
const INPUT = ['-probesize', '32', '-analyzeduration', '0', '-flags', 'low_delay'];

// RFC 2435 needs ffmpeg's standard Huffman tables and both quantisation tables in every picture.
const jpegArgs = ({ codec, width, height }) => [
  ...INPUT, '-use_wallclock_as_timestamps', '1', '-f', codec, '-i', 'pipe:0',
  '-an', '-vf', `scale=${width}:${height}`,
  '-c:v', 'mjpeg', '-huffman', 'default', '-force_duplicated_matrix', '1', '-q:v', '5', '-fps_mode', 'passthrough',
];
const g711Args = () => [...INPUT, '-f', 'aac', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_mulaw'];

// ffmpeg's arguments up to the output address.
export function transcoderArgs(kind, { codec = 'h264', width = 640, height = 360 } = {}) {
  const convert = kind === 'mjpeg' ? jpegArgs({ codec, width, height }) : g711Args();
  return ['-hide_banner', '-loglevel', 'error', ...convert, '-payload_type', String(PAYLOAD_TYPE[kind]), '-f', 'rtp'];
}

// Where ffmpeg sends its RTP and RTCP.
const rtpUrl = (rtp, rtcp) => `rtp://127.0.0.1:${rtp.address().port}?pkt_size=1400&rtcpport=${rtcp.address().port}`;

const bindLocal = () => new Promise((resolve, reject) => {
  const socket = createSocket('udp4');
  socket.once('error', reject);
  socket.bind(0, '127.0.0.1', () => resolve(socket));
});

const isBehind = (stdin) => stdin.writableLength > MAX_STDIN_BACKLOG;
const hasMarker = (packet) => (packet[1] & 0x80) !== 0;   // the last packet of a picture

export class Transcoder extends EventEmitter {
  // kind: 'mjpeg' | 'pcmu'. publication: the camera's stream (publication.mjs).
  // size: { width, height } for JPEG.
  constructor({ kind, publication, size, log = () => {}, spawnImpl = spawn }) {
    super();
    Object.assign(this, { kind, publication, size, log, spawnImpl });
    this.child = null;
    this.sockets = [];
    this.stopped = false;
    this.waitingForKeyframe = true;   // ffmpeg's decoder can only start at one
    this.nextStartsPicture = true;
    this.onMedia = (what, frame) => this.feed(what, frame);
  }

  async start() {
    const [rtp, rtcp] = this.sockets = await Promise.all([bindLocal(), bindLocal()]);
    if (this.stopped) return this.closeSockets();
    rtp.on('message', (packet) => this.fromFfmpeg(packet));
    rtcp.on('message', () => {});   // ffmpeg's own sender reports: the RTSP session makes its own
    this.publication.on('media', this.onMedia);
    this.spawn();
  }

  spawn() {
    if (this.stopped) return;
    const args = [...transcoderArgs(this.kind, { codec: this.publication.codec, ...this.size }), rtpUrl(...this.sockets)];
    const child = this.spawnImpl('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.child = child;
    this.waitingForKeyframe = true;
    child.stdin.on('error', () => {});
    child.stderr.on('data', (chunk) => this.say(String(chunk).trim().slice(0, 200)));
    child.on('error', (e) => this.say(e.message));
    child.on('close', () => {
      if (this.child !== child || this.stopped) return;
      this.child = null;
      setTimeout(() => this.spawn(), RESTART_MS).unref?.();
    });
  }

  // A frame from the publisher. Only the source of this kind is used.
  feed(what, frame) {
    const stdin = this.child?.stdin;
    if (what !== SOURCE_OF[this.kind] || !stdin || stdin.destroyed) return;
    const accept = what === 'video' ? this.acceptVideo(frame, stdin) : !isBehind(stdin);
    if (accept) stdin.write(frame);
  }

  // Video goes in from a keyframe on. When ffmpeg falls behind, it waits for the next keyframe:
  // pictures are skipped, but what goes in can always be decoded. (Sound frames stand alone: one
  // that comes while ffmpeg is behind is just skipped.)
  acceptVideo(frame, stdin) {
    if (isBehind(stdin)) this.waitingForKeyframe = true;
    if (this.waitingForKeyframe && !isKeyframe(frame, this.publication.codec)) return false;
    this.waitingForKeyframe = false;
    return true;
  }

  fromFfmpeg(packet) {
    if (packet.length < RTP_HEADER) return;
    const starts = this.kind === 'pcmu' || this.nextStartsPicture;
    this.nextStartsPicture = hasMarker(packet);
    this.emit('packet', packet, starts);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.publication.off('media', this.onMedia);
    this.child?.kill('SIGKILL');
    this.child = null;
    this.closeSockets();
  }

  closeSockets() {
    for (const socket of this.sockets) socket.close();
    this.sockets = [];
  }

  say(message) {
    this.log(this.publication.name, `${this.kind}: ${message}`);
  }
}

// A JPEG or G.711 version of one camera's stream, made by an ffmpeg only while someone watches it.
// ffmpeg reads what the publisher sends (its encoded video as Annex B, or its AAC as ADTS) on stdin and
// sends RTP (RFC 2435 JPEG, or PCMU) to a UDP port on 127.0.0.1 that only this process reads.
//
// Emits 'packet' (packet, startsPicture): every packet, in order; startsPicture is true for the first
// packet of a JPEG picture (each one stands alone, like a keyframe) and for every sound packet.

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { isKeyframe } from '../video/annexb.mjs';

export const PAYLOAD_TYPE = { mjpeg: 26, pcmu: 0 };
const MAX_STDIN_BACKLOG = 8 * 1024 * 1024;   // ffmpeg this far behind: skip to the next keyframe
const RESTART_MS = 1000;

// The input's format is given, so ffmpeg needn't wait for data to probe: 32 KB would be 8 s of the
// camera's sound, or seconds of the sleeping picture.
const INPUT = ['-probesize', '32', '-analyzeduration', '0', '-flags', 'low_delay'];

// RFC 2435 needs ffmpeg's standard Huffman tables and both quantisation tables in every picture.
export function transcoderArgs(kind, { codec = 'h264', width = 640, height = 360 } = {}) {
  const input = kind === 'mjpeg'
    ? [...INPUT, '-use_wallclock_as_timestamps', '1', '-f', codec, '-i', 'pipe:0', '-an', '-vf', `scale=${width}:${height}`,
      '-c:v', 'mjpeg', '-huffman', 'default', '-force_duplicated_matrix', '1', '-q:v', '5', '-fps_mode', 'passthrough']
    : [...INPUT, '-f', 'aac', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_mulaw'];
  return ['-hide_banner', '-loglevel', 'error', ...input, '-payload_type', String(PAYLOAD_TYPE[kind]), '-f', 'rtp'];
}

const bindLocal = () => new Promise((resolve, reject) => {
  const socket = createSocket('udp4');
  socket.once('error', reject);
  socket.bind(0, '127.0.0.1', () => resolve(socket));
});

export class Transcoder extends EventEmitter {
  // kind: 'mjpeg' | 'pcmu'. publication: the camera's stream (stream-hub.mjs). size: { width, height } for JPEG.
  constructor({ kind, publication, size, log = () => {}, spawnImpl = spawn }) {
    super();
    Object.assign(this, { kind, publication, size, log, spawnImpl, stopped: false, child: null, sockets: [] });
    this.waitKeyframe = true;
    this.pictureStarts = true;
    this.onMedia = (what, data) => this.feed(what, data);
  }

  async start() {
    const [rtp, rtcp] = this.sockets = await Promise.all([bindLocal(), bindLocal()]);
    if (this.stopped) return this.closeSockets();
    rtp.on('message', (packet) => this.fromFfmpeg(packet));
    rtcp.on('message', () => {});   // ffmpeg's own sender reports: the RTSP front makes its own
    this.publication.on('media', this.onMedia);
    this.spawn();
  }

  spawn() {
    if (this.stopped) return;
    const [rtp, rtcp] = this.sockets;
    const url = `rtp://127.0.0.1:${rtp.address().port}?pkt_size=1400&rtcpport=${rtcp.address().port}`;
    const child = this.spawnImpl('ffmpeg', [...transcoderArgs(this.kind, { codec: this.publication.codec, ...this.size }), url],
      { stdio: ['pipe', 'ignore', 'pipe'] });
    this.child = child;
    this.waitKeyframe = true;
    child.stdin.on('error', () => {});
    child.stderr.on('data', (c) => this.log(this.publication.name, `${this.kind}: ${String(c).trim().slice(0, 200)}`));
    child.on('error', (e) => this.log(this.publication.name, `${this.kind}: ${e.message}`));
    child.on('close', () => {
      if (this.child !== child || this.stopped) return;
      this.child = null;
      setTimeout(() => this.spawn(), RESTART_MS).unref?.();
    });
  }

  // What the publisher sends: only the kind this transcoder makes, video from a keyframe on.
  feed(what, data) {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || what !== (this.kind === 'mjpeg' ? 'video' : 'audio')) return;
    if (what === 'video') {
      if (stdin.writableLength > MAX_STDIN_BACKLOG) this.waitKeyframe = true;
      if (this.waitKeyframe && !isKeyframe(data, this.publication.codec)) return;
      this.waitKeyframe = false;
    } else if (stdin.writableLength > MAX_STDIN_BACKLOG) {
      return;
    }
    stdin.write(data);
  }

  fromFfmpeg(packet) {
    if (packet.length < 12) return;
    const starts = this.kind === 'pcmu' || this.pictureStarts;
    this.pictureStarts = (packet[1] & 0x80) !== 0;   // the marker ends a picture
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
    for (const s of this.sockets) s.close();
    this.sockets = [];
  }
}

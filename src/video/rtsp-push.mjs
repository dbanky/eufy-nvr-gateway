// Publishing into go2rtc over RTSP (ANNOUNCE, SETUP per track, RECORD), RTP interleaved on the
// same TCP connection. send() never waits: it hands the packet to the socket and returns.

import { connect } from 'node:net';
import { EventEmitter } from 'node:events';
import { RtspReader, formatMessage, formatFrame, header } from '../rtsp/messages.mjs';

// The socket's own buffer may hold this much before the connection counts as stuck (go2rtc not
// reading): it is then closed and opened again, rather than growing without end.
export const MAX_BACKLOG_BYTES = 32 * 1024 * 1024;

// Emits 'ready' after RECORD and 'close' (once) with a reason.
export class RtspPush extends EventEmitter {
  // url: rtsp://127.0.0.1:port/name. tracks: number of tracks in the SDP (control trackID=0, 1).
  constructor({ url, sdp, tracks, connectImpl = connect }) {
    super();
    Object.assign(this, { url, sdp, tracks, ready: false, closed: false, cseq: 0, session: null, pending: null });
    const { hostname, port } = new URL(url);
    this.socket = connectImpl(Number(port) || 554, hostname);
    this.socket.setNoDelay?.(true);
    this.reader = new RtspReader();
    this.socket.on('connect', () => this.handshake().catch((e) => this.close(e.message)));
    this.socket.on('data', (chunk) => {
      try {
        for (const item of this.reader.push(chunk)) if (item.message) this.pending?.(item.message);
      } catch (e) {
        this.close(e.message);
      }
    });
    this.socket.on('error', (e) => this.close(e.message));
    this.socket.on('close', () => this.close('connection closed'));
  }

  request(method, uri, headers = [], body) {
    return new Promise((resolve, reject) => {
      const cseq = String(++this.cseq);
      this.pending = (message) => {
        if (header(message.headers, 'cseq') !== cseq) return;
        this.pending = null;
        const status = Number(message.startLine.split(' ')[1]);
        if (status !== 200) return reject(new Error(`${method}: ${message.startLine.replace(/^RTSP\/1\.0 /, '')}`));
        resolve(message);
      };
      const all = [['CSeq', cseq], ...(this.session ? [['Session', this.session]] : []), ...headers];
      this.socket.write(formatMessage({ startLine: `${method} ${uri} RTSP/1.0`, headers: all, body }));
    });
  }

  async handshake() {
    await this.request('ANNOUNCE', this.url, [['Content-Type', 'application/sdp']], this.sdp);
    for (let track = 0; track < this.tracks; track++) {
      const reply = await this.request('SETUP', `${this.url}/trackID=${track}`,
        [['Transport', `RTP/AVP/TCP;unicast;interleaved=${2 * track}-${2 * track + 1};mode=record`]]);
      this.session ??= header(reply.headers, 'session')?.split(';')[0] ?? null;
    }
    await this.request('RECORD', this.url, [['Range', 'npt=0.000-']]);
    this.ready = true;
    this.emit('ready');
  }

  // An RTP packet on `track`. false if it can't go out (not ready, closed, or stuck: then closed).
  send(track, packet) {
    if (!this.ready || this.closed) return false;
    if (this.socket.writableLength > MAX_BACKLOG_BYTES) {
      this.close(`go2rtc took nothing for a while (${Math.round(this.socket.writableLength / 1048576)} MB waiting)`);
      return false;
    }
    this.socket.write(formatFrame(2 * track, packet));
    return true;
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.socket.destroy();
    this.emit('close', reason);
  }
}

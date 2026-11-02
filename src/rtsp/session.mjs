// One viewer's RTSP session, served from the gateway's own streams (stream-hub.mjs).
//
// - DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER and SET_PARAMETER are answered here.
// - RTP goes over UDP (from the camera's fixed port pair, track-binding.mjs) or inside the RTSP
//   connection, whichever the viewer asked for.
// - RTCP sender reports for every track, every 5 s and at the first packet (ONVIF wants them for
//   audio/video sync).
// - The session id stays the same for the whole session, and a viewer on UDP may come back with it on
//   a new connection (RFC 2326 section 12.37).
// - Keep-alive per ONVIF: any request or RTCP report from the viewer; a session whose viewer left
//   ends after the timeout.

import { header, requestLine, response, formatMessage } from './messages.mjs';
import { parseTransport, chooseTransport } from './transport.mjs';
import { sdpTracks, trackFor } from './sdp.mjs';
import { TrackBinding, chooseChannels } from './track-binding.mjs';

// Ends a client connection after what was written to it (an answer) has gone out.
export function endPeer(peer) {
  if (!peer || peer.destroyed) return;
  peer.end();
  setTimeout(() => peer.destroy(), 2000).unref?.();
}

export const TIMEOUT_S = 60;
export const PUBLIC = 'OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER, SET_PARAMETER';
const REPORT_MS = 5000;
const MAX_CLIENT_BACKLOG = 8 * 1024 * 1024;   // a viewer this far behind skips to the next keyframe

// The URI without a track's control: rtsp://host/garden/trackID=1 -> rtsp://host/garden
const streamUri = (uri) => String(uri).replace(/\/trackID=\d+$/, '');

// deps: hub (StreamHub), openUdp(localAddress, { uri, media }) -> Promise<{ rtp, rtcp, ports, onRtcp, close }>,
// now() ms, onClose(session), log(...)
export class RtspSession {
  constructor(id, deps) {
    Object.assign(this, { id, deps });
    this.client = null;
    this.source = null;         // what DESCRIBE (or the first SETUP) found
    this.tracks = [];           // [{ media, control, clockRate }] of that source
    this.bindings = new Map();  // track index -> TrackBinding
    this.unsubscribe = null;
    this.playing = false;
    this.resync = false;        // the viewer fell behind: wait for a keyframe
    this.closed = false;
    this.lastActivity = deps.now();
    this.timer = setInterval(() => this.tick(), REPORT_MS);
    this.timer.unref?.();
  }

  attach(client) {
    this.client = client;
    this.clientAddress();   // remembered: UDP packets keep going there if the connection ends
    this.lastActivity = this.deps.now();
  }

  // The client's connection ended. A UDP session that is playing may live on (it can come back).
  detach(client) {
    if (this.client !== client) return;
    this.client = null;
    const udpOnly = this.bindings.size && [...this.bindings.values()].every((b) => b.udp);
    if (!(this.playing && udpOnly)) this.close();
  }

  // An authorised request from the client.
  async fromClient({ startLine, headers }) {
    this.lastActivity = this.deps.now();
    const { method, uri } = requestLine(startLine);
    const cseq = header(headers, 'cseq');
    const session = [['Session', `${this.id};timeout=${TIMEOUT_S}`]];
    switch (method) {
      case 'OPTIONS':
        return this.reply(response(200, 'OK', cseq, [['Public', PUBLIC], ...session]));
      case 'DESCRIBE': {
        if (!this.find(uri)) return this.reply(response(404, 'Not Found', cseq));
        return this.reply(formatMessage({ startLine: 'RTSP/1.0 200 OK',
          headers: [['CSeq', cseq], ['Content-Type', 'application/sdp'], ['Content-Base', `${streamUri(uri)}/`]], body: this.source.sdp }));
      }
      case 'SETUP':
        return this.setup(uri, header(headers, 'transport'), cseq);
      case 'PLAY':
        if (!this.bindings.size) return this.reply(response(455, 'Method Not Valid in This State', cseq));
        this.play();
        return this.reply(response(200, 'OK', cseq, [...session, ['Range', 'npt=0.000-']]));
      case 'PAUSE':
        this.pause();
        return this.reply(response(200, 'OK', cseq, session));
      case 'GET_PARAMETER':
      case 'SET_PARAMETER':
        return this.reply(response(200, 'OK', cseq, session));
      case 'TEARDOWN':
        this.reply(response(200, 'OK', cseq, [['Session', this.id]]));
        return this.close();
      default:
        return this.reply(response(501, 'Not Implemented', cseq));
    }
  }

  // The stream a URI names, remembered for the session (a later SETUP may name the stream again).
  find(uri) {
    const want = streamUri(uri);
    if (this.source && (this.sourceUri === want || this.bindings.size)) return this.source;
    this.sourceUri = want;
    this.source = this.deps.hub.source(want);
    this.tracks = this.source ? sdpTracks(this.source.sdp) : [];
    return this.source;
  }

  async setup(uri, transportHeader, cseq) {
    if (!this.find(uri)) return this.reply(response(404, 'Not Found', cseq));
    const track = trackFor(this.tracks, uri);
    const index = this.tracks.indexOf(track);
    if (index < 0) return this.reply(response(404, 'Not Found', cseq));
    const choice = chooseTransport(parseTransport(transportHeader));
    if (!choice) return this.reply(response(461, 'Unsupported Transport', cseq));
    this.bindings.get(index)?.close();
    const taken = [...this.bindings].filter(([i]) => i !== index).flatMap(([, b]) => b.channels);
    const binding = new TrackBinding({ channels: chooseChannels(taken, choice.protocol === 'tcp' ? choice.interleaved : null), clockRate: track.clockRate });
    if (choice.protocol === 'udp') {
      try {
        await binding.openUdp({
          openUdp: this.deps.openUdp, localAddress: this.client?.localAddress, uri, media: track.media,
          clientPort: choice.clientPort, clientAddress: () => this.clientAddress(),
          onAlive: () => { this.lastActivity = this.deps.now(); },
        });
      } catch (e) {   // 461 makes the client use TCP instead
        this.deps.log?.(`RTSP: no UDP for a viewer (${e.message}), it is told to use TCP`);
        return this.reply(response(461, 'Unsupported Transport', cseq));
      }
    }
    if (this.closed) return binding.close();
    this.bindings.set(index, binding);
    this.reply(response(200, 'OK', cseq, [['Transport', binding.transport()], ['Session', `${this.id};timeout=${TIMEOUT_S}`]]));
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this.unsubscribe = this.source.subscribe((track, packet, starts) => this.deliver(track, packet, starts), () => this.close());
  }

  pause() {
    this.playing = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // Interleaved data from the client: RTCP receiver reports. They keep the session alive.
  fromClientFrame() {
    this.lastActivity = this.deps.now();
  }

  deliver(track, packet, starts) {
    const binding = this.bindings.get(track);
    if (!binding) return;   // a track the viewer didn't set up
    if (this.resync) {
      if (track !== 0 || !starts) return;
      this.resync = false;
    }
    const first = binding.stats.ssrc == null;
    binding.stats.count(packet, this.deps.now());
    binding.sendRtp(packet, this.clientAddress(), (bytes) => this.writeToClient(bytes));
    if (first) this.report(binding);
  }

  clientAddress() {
    this.lastAddress = this.client?.remoteAddress?.replace(/^::ffff:/, '') ?? this.lastAddress;
    return this.lastAddress;
  }

  report(binding) {
    const packet = binding.stats.report(this.deps.now());
    if (packet) binding.sendRtcp(packet, this.clientAddress(), (bytes) => this.writeToClient(bytes));
  }

  // Inside the RTSP connection. A viewer that can't keep up loses pictures, never the stream: from
  // this far behind it skips ahead to the next keyframe.
  writeToClient(data) {
    const client = this.client;
    if (!client) return;
    if (client.writableLength > MAX_CLIENT_BACKLOG) {
      this.resync = true;
      return;
    }
    client.write(data);
  }

  reply(data) {
    this.client?.write(data);
  }

  tick() {
    if (this.closed) return;
    if (!this.client && this.deps.now() - this.lastActivity > TIMEOUT_S * 1000) return this.close();
    if (this.playing) for (const binding of this.bindings.values()) this.report(binding);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.pause();
    for (const binding of this.bindings.values()) binding.close();
    endPeer(this.client);
    this.client = null;
    this.deps.onClose?.(this);
  }
}

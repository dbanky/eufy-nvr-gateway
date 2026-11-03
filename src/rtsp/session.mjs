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
import { streamUri } from './stream-path.mjs';

// Ends a client connection after what was written to it (an answer) has gone out.
export function endPeer(peer) {
  if (!peer || peer.destroyed) return;
  peer.end();
  setTimeout(() => peer.destroy(), 2000).unref?.();
}

export const TIMEOUT_S = 60;
export const PUBLIC = 'OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER, SET_PARAMETER';
export const REPORT_MS = 5000;
export const MAX_CLIENT_BACKLOG = 8 * 1024 * 1024;   // a viewer this far behind skips to the next keyframe

const VIDEO_TRACK = 0;
const plainAddress = (address) => address?.replace(/^::ffff:/, '');

// deps: hub (StreamHub), openUdp(localAddress, { uri, media }) -> Promise<{ rtp, rtcp, ports, onRtcp, close }>,
// now() ms, onClose(session), log(...)
export class RtspSession {
  constructor(id, deps) {
    this.id = id;
    this.deps = deps;
    this.client = null;              // the viewer's RTSP connection, while it has one
    this.lastAddress = undefined;    // where its UDP packets go, also after the connection ends
    this.source = null;              // the stream it watches: { sdp, subscribe }
    this.sourceUri = null;
    this.tracks = [];                // [{ media, control, clockRate }] of that stream
    this.bindings = new Map();       // track index -> TrackBinding, one per SETUP
    this.unsubscribe = null;         // while playing
    this.skippingToKeyframe = false; // the viewer fell behind
    this.closed = false;
    this.lastActivity = deps.now();
    this.timer = setInterval(() => this.tick(), REPORT_MS);
    this.timer.unref?.();
  }

  get playing() {
    return this.unsubscribe != null;
  }

  // --- the viewer's connection

  attach(client) {
    this.client = client;
    this.clientAddress();   // remembered: UDP packets keep going there if the connection ends
    this.alive();
  }

  // The client's connection ended. A session that plays over UDP only lives on: the viewer may
  // come back with its id. Any other session ends with its connection.
  detach(client) {
    if (this.client !== client) return;
    this.client = null;
    if (!(this.playing && this.allOverUdp())) this.close();
  }

  allOverUdp() {
    return this.bindings.size > 0 && [...this.bindings.values()].every((b) => b.udp);
  }

  // Interleaved data from the client: RTCP receiver reports. They keep the session alive.
  fromClientFrame() {
    this.alive();
  }

  alive() {
    this.lastActivity = this.deps.now();
  }

  // --- requests

  // An authorised request from the client.
  async fromClient({ startLine, headers }) {
    this.alive();
    const { method, uri } = requestLine(startLine);
    const request = { uri, cseq: header(headers, 'cseq'), transport: header(headers, 'transport') };
    const handle = Object.hasOwn(this.handlers, method) ? this.handlers[method] : this.notImplemented;
    return handle.call(this, request);
  }

  // One per method; called with the session as `this`.
  handlers = {
    OPTIONS({ cseq }) {
      this.ok(cseq, [['Public', PUBLIC], this.sessionHeader()]);
    },

    DESCRIBE({ uri, cseq }) {
      if (!this.sourceFor(uri)) return this.notFound(cseq);
      this.reply(formatMessage({
        startLine: 'RTSP/1.0 200 OK',
        headers: [['CSeq', cseq], ['Content-Type', 'application/sdp'], ['Content-Base', `${streamUri(uri)}/`]],
        body: this.source.sdp,
      }));
    },

    SETUP(request) {
      return this.setup(request);
    },

    PLAY({ cseq }) {
      if (!this.bindings.size) return this.reply(response(455, 'Method Not Valid in This State', cseq));
      this.play();
      this.ok(cseq, [this.sessionHeader(), ['Range', 'npt=0.000-']]);
    },

    PAUSE({ cseq }) {
      this.pause();
      this.ok(cseq, [this.sessionHeader()]);
    },

    // keep-alives
    GET_PARAMETER({ cseq }) {
      this.ok(cseq, [this.sessionHeader()]);
    },
    SET_PARAMETER({ cseq }) {
      this.ok(cseq, [this.sessionHeader()]);
    },

    TEARDOWN({ cseq }) {
      this.ok(cseq, [['Session', this.id]]);
      this.close();
    },
  };

  notImplemented({ cseq }) {
    this.reply(response(501, 'Not Implemented', cseq));
  }

  // The stream a URI names. Once a track is set up, the session stays on its stream: a later SETUP
  // or PLAY may name it differently (with a query, or the aggregate address).
  sourceFor(uri) {
    const wanted = streamUri(uri);
    const keep = this.source && (this.sourceUri === wanted || this.bindings.size > 0);
    if (keep) return this.source;
    this.sourceUri = wanted;
    this.source = this.deps.hub.source(wanted);
    this.tracks = this.source ? sdpTracks(this.source.sdp) : [];
    return this.source;
  }

  async setup({ uri, cseq, transport }) {
    if (!this.sourceFor(uri)) return this.notFound(cseq);
    const track = trackFor(this.tracks, uri);
    if (!track) return this.notFound(cseq);
    const choice = chooseTransport(parseTransport(transport));
    if (!choice) return this.unsupportedTransport(cseq);

    const index = this.tracks.indexOf(track);
    this.bindings.get(index)?.close();   // set up again: the new transport wins
    const binding = new TrackBinding({ channels: this.freeChannels(index, choice), clockRate: track.clockRate });
    if (choice.protocol === 'udp') {
      try {
        await this.openUdp(binding, uri, track, choice);
      } catch (e) {   // 461 makes the client use TCP instead
        this.deps.log?.(`RTSP: no UDP for a viewer (${e.message}), it is told to use TCP`);
        return this.unsupportedTransport(cseq);
      }
    }
    if (this.closed) return binding.close();   // torn down while the UDP ports opened
    this.bindings.set(index, binding);
    this.ok(cseq, [['Transport', binding.transport()], this.sessionHeader()]);
  }

  // The interleaved channels for a track: the ones asked for over TCP if free, else the first free pair.
  freeChannels(index, choice) {
    const taken = [...this.bindings].filter(([i]) => i !== index).flatMap(([, b]) => b.channels);
    return chooseChannels(taken, choice.protocol === 'tcp' ? choice.interleaved : null);
  }

  openUdp(binding, uri, track, choice) {
    return binding.openUdp({
      openUdp: this.deps.openUdp,
      localAddress: this.client?.localAddress,
      uri,
      media: track.media,
      clientPort: choice.clientPort,
      clientAddress: () => this.clientAddress(),
      onAlive: () => this.alive(),
    });
  }

  play() {
    if (this.playing) return;
    this.unsubscribe = this.source.subscribe((track, packet, starts) => this.deliver(track, packet, starts), () => this.close());
  }

  pause() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // --- answers

  sessionHeader() {
    return ['Session', `${this.id};timeout=${TIMEOUT_S}`];
  }

  ok(cseq, headers) {
    this.reply(response(200, 'OK', cseq, headers));
  }

  notFound(cseq) {
    this.reply(response(404, 'Not Found', cseq));
  }

  unsupportedTransport(cseq) {
    this.reply(response(461, 'Unsupported Transport', cseq));
  }

  reply(data) {
    this.client?.write(data);
  }

  // --- media

  // A packet of the stream (the viewer's track numbers). Tracks it didn't set up are left out.
  deliver(track, packet, startsKeyframe) {
    const binding = this.bindings.get(track);
    if (!binding) return;
    if (this.skippingToKeyframe) {
      if (track !== VIDEO_TRACK || !startsKeyframe) return;
      this.skippingToKeyframe = false;
    }
    const first = binding.stats.ssrc == null;
    binding.stats.count(packet, this.deps.now());
    binding.sendRtp(packet, this.clientAddress(), (bytes) => this.writeToClient(bytes));
    if (first) this.sendReport(binding);   // the player can sync the tracks from the start
  }

  sendReport(binding) {
    const packet = binding.stats.report(this.deps.now());
    if (packet) binding.sendRtcp(packet, this.clientAddress(), (bytes) => this.writeToClient(bytes));
  }

  // Inside the RTSP connection. A viewer that can't keep up loses pictures, never the stream: from
  // this far behind it skips ahead to the next keyframe.
  writeToClient(data) {
    const client = this.client;
    if (!client) return;
    if (client.writableLength > MAX_CLIENT_BACKLOG) {
      this.skippingToKeyframe = true;
      return;
    }
    client.write(data);
  }

  // The viewer's address, without the IPv4-in-IPv6 prefix; the last one known once it has gone.
  clientAddress() {
    this.lastAddress = plainAddress(this.client?.remoteAddress) ?? this.lastAddress;
    return this.lastAddress;
  }

  // --- every REPORT_MS

  tick() {
    if (this.closed) return;
    if (this.viewerGone()) return this.close();
    if (this.playing) for (const binding of this.bindings.values()) this.sendReport(binding);
  }

  // No connection, and nothing heard from the viewer (requests or RTCP) for TIMEOUT_S.
  viewerGone() {
    return !this.client && this.deps.now() - this.lastActivity > TIMEOUT_S * 1000;
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

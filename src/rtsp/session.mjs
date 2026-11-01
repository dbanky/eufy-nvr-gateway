// One client's RTSP session, relayed to go2rtc (which only does RTP inside the RTSP connection).
//
// What the front adds on the way:
// - RTP over UDP: the client's UDP SETUP becomes an interleaved one upstream; its packets are sent
//   to the client's ports from a UDP port pair on the address the client connected to.
// - RTCP sender reports for every track (go2rtc sends none), every 5 s and at the first packet.
// - Its own session id: go2rtc hands out a new one per SETUP. The client sees one id for the session,
//   and may come back with it on a new connection (allowed with UDP; RFC 2326 section 12.37).
// - "sendonly" in the SDP (go2rtc says recvonly).
// - Keep-alive per ONVIF: any request or RTCP report from the client; a session whose client left
//   ends after the timeout. GET_PARAMETER, SET_PARAMETER and TEARDOWN are answered here: go2rtc
//   leaves them unanswered once a stream plays.

import { formatMessage, header, withHeader, requestLine, response } from './messages.mjs';
import { parseTransport, chooseTransport, interleavedTransport } from './transport.mjs';
import { sdpTracks, trackFor, fromTheDevice } from './sdp.mjs';
import { TrackBinding, chooseChannels } from './track-binding.mjs';
import { RtspReader } from './messages.mjs';

// Ends a client connection after what was written to it (an answer) has gone out.
export function endPeer(peer) {
  if (!peer || peer.destroyed) return;
  peer.end();
  setTimeout(() => peer.destroy(), 2000).unref?.();
}

export const TIMEOUT_S = 60;
const REPORT_MS = 5000;
// go2rtc drops a viewer's connection after 60 s without hearing from it, and a viewer on UDP sends
// its RTCP over UDP: nothing reaches go2rtc. So the front sends OPTIONS (which go2rtc answers)
// whenever it has sent go2rtc nothing for this long.
export const UPSTREAM_KEEPALIVE_MS = 20000;
const KEEPALIVE_CSEQ = 1_000_000;   // far from the client's own CSeq numbers
const MAX_CLIENT_BACKLOG = 8 * 1024 * 1024;   // a client this far behind pauses the stream

// deps: connectUpstream() -> net.Socket, openUdp(localAddress, { uri, media }) -> Promise<{ rtp, rtcp, ports, onRtcp, close }>,
// now() ms, onClose(session), log(...)
export class ProxySession {
  constructor(id, deps) {
    Object.assign(this, { id, deps });
    this.client = null;
    this.upstream = null;
    this.upstreamSession = null;
    this.pending = new Map();   // CSeq -> { method, uri, setup }
    this.tracks = [];           // from the last DESCRIBE
    this.channels = new Map();  // upstream channel -> { kind: 'rtp' | 'rtcp', binding }
    this.bindings = [];         // one TrackBinding per SETUP
    this.playing = false;
    this.closed = false;
    this.lastActivity = deps.now();
    this.upstreamWrittenAt = 0;
    this.keepaliveCseq = KEEPALIVE_CSEQ;
    this.uri = null;            // the stream's URI, for the keep-alive
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
    const udpOnly = this.bindings.length && this.bindings.every((b) => b.udp);
    if (!(this.playing && udpOnly)) this.close();
  }

  // An authorised request from the client.
  async fromClient({ startLine, headers, body }) {
    this.lastActivity = this.deps.now();
    const { method, uri } = requestLine(startLine);
    const cseq = header(headers, 'cseq');
    // go2rtc answers OPTIONS while playing, but never GET_PARAMETER, SET_PARAMETER or TEARDOWN:
    // VLC's keep-alives went unanswered and it gave up after a few minutes. Answered here instead.
    if (method === 'GET_PARAMETER' || method === 'SET_PARAMETER') {
      return this.reply(response(200, 'OK', cseq, [['Session', `${this.id};timeout=${TIMEOUT_S}`]]));
    }
    if (method === 'TEARDOWN') {
      this.reply(response(200, 'OK', cseq, [['Session', this.id]]));
      return this.close();
    }
    let out = withHeader(headers, 'Session', this.upstreamSession);
    let setup = null;
    if (method === 'SETUP') {
      setup = await this.prepareSetup(uri, header(headers, 'transport'));
      if (!setup) return this.reply(response(461, 'Unsupported Transport', cseq));
      out = withHeader(out, 'Transport', interleavedTransport(setup.channels));
    }
    this.pending.set(cseq, { method, uri, setup });
    if (method === 'PLAY' || method === 'DESCRIBE') this.uri = uri;
    this.writeUpstream(formatMessage({ startLine, headers: out, body }));
  }

  writeUpstream(data) {
    this.upstreamWrittenAt = this.deps.now();
    this.toUpstream().write(data);
  }

  keepUpstreamAlive() {
    if (!this.playing || !this.upstream || !this.uri) return;
    if (this.deps.now() - this.upstreamWrittenAt < UPSTREAM_KEEPALIVE_MS) return;
    const cseq = String(++this.keepaliveCseq);
    this.pending.set(cseq, { method: 'OPTIONS', keepalive: true });
    this.writeUpstream(formatMessage({ startLine: `OPTIONS ${this.uri} RTSP/1.0`, headers: [['CSeq', cseq], ...(this.upstreamSession ? [['Session', this.upstreamSession]] : [])], body: Buffer.alloc(0) }));
  }

  // Interleaved data from the client: RTCP receiver reports. They keep the session alive; go2rtc
  // doesn't need them.
  fromClientFrame() {
    this.lastActivity = this.deps.now();
  }

  async prepareSetup(uri, transportHeader) {
    const choice = chooseTransport(parseTransport(transportHeader));
    if (!choice) return null;
    const channels = chooseChannels(this.bindings.flatMap((b) => b.channels), choice.protocol === 'tcp' ? choice.interleaved : null);
    const track = trackFor(this.tracks, uri);
    const binding = new TrackBinding({ channels, clockRate: track?.clockRate ?? 90000 });
    if (choice.protocol === 'udp') {
      try {
        await binding.openUdp({
          openUdp: this.deps.openUdp, localAddress: this.client?.localAddress, uri, media: track?.media ?? 'video',
          clientPort: choice.clientPort, clientAddress: () => this.clientAddress(),
          onAlive: () => { this.lastActivity = this.deps.now(); },
        });
      } catch (e) {   // 461 makes the client use TCP instead
        this.deps.log?.(`RTSP: no UDP for a viewer (${e.message}), it is told to use TCP`);
        return null;
      }
    }
    return binding;
  }

  toUpstream() {
    if (this.upstream) return this.upstream;
    const socket = this.deps.connectUpstream();
    const reader = new RtspReader();
    socket.on('data', (chunk) => {
      let items;
      try {
        items = reader.push(chunk);
      } catch (e) {
        this.deps.log?.(`RTSP: bad answer from the stream server: ${e.message}`);
        return this.close();
      }
      for (const item of items) item.frame ? this.fromUpstreamFrame(item.frame) : this.fromUpstreamMessage(item.message);
    });
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
    this.upstream = socket;
    return socket;
  }

  fromUpstreamMessage({ startLine, headers, body }) {
    const cseq = header(headers, 'cseq');
    const request = this.pending.get(cseq);
    this.pending.delete(cseq);
    if (request?.keepalive) return;   // the front's own keep-alive: not the client's business
    const ok = /^RTSP\/1\.0 2\d\d/.test(startLine);
    let out = headers;
    if (header(headers, 'session')) out = withHeader(out, 'Session', this.id);
    if (request?.method === 'DESCRIBE' && ok) {
      this.tracks = sdpTracks(body);
      body = Buffer.from(fromTheDevice(body));
    }
    if (request?.method === 'SETUP') {
      const binding = request.setup;
      if (ok) {
        this.upstreamSession = (header(headers, 'session') ?? '').split(';')[0] || this.upstreamSession;
        this.bind(binding);
        out = withHeader(out, 'Session', `${this.id};timeout=${TIMEOUT_S}`);
        out = withHeader(out, 'Transport', binding.transport());
      } else {
        binding?.close();
      }
    }
    if (request?.method === 'PLAY' && ok) this.playing = true;
    this.reply(formatMessage({ startLine, headers: out, body }));
  }

  bind(binding) {
    this.bindings.push(binding);
    this.channels.set(binding.channels[0], { kind: 'rtp', binding });
    this.channels.set(binding.channels[1], { kind: 'rtcp', binding });
  }

  fromUpstreamFrame({ channel, data }) {
    const route = this.channels.get(channel);
    if (!route) return;
    const { binding } = route;
    if (route.kind === 'rtp') {
      const first = binding.stats.ssrc == null;
      binding.stats.count(data, this.deps.now());
      this.sendRtp(binding, data);
      if (first) this.report(binding);
    } else {
      this.sendRtcp(binding, data);
    }
  }

  sendRtp(binding, data) {
    binding.sendRtp(data, this.clientAddress(), (bytes) => this.writeToClient(bytes));
  }

  sendRtcp(binding, data) {
    binding.sendRtcp(data, this.clientAddress(), (bytes) => this.writeToClient(bytes));
  }

  clientAddress() {
    this.lastAddress = this.client?.remoteAddress?.replace(/^::ffff:/, '') ?? this.lastAddress;
    return this.lastAddress;
  }

  report(binding) {
    const packet = binding.stats.report(this.deps.now());
    if (packet) this.sendRtcp(binding, packet);
  }

  writeToClient(data) {
    const client = this.client;
    if (!client) return;
    client.write(data);
    if (client.writableLength > MAX_CLIENT_BACKLOG && this.upstream && !this.upstream.isPaused()) {
      this.upstream.pause();
      client.once('drain', () => this.upstream?.resume());
    }
  }

  reply(data) {
    this.client?.write(data);
  }

  tick() {
    if (this.closed) return;
    if (!this.client && this.deps.now() - this.lastActivity > TIMEOUT_S * 1000) return this.close();
    if (this.playing) for (const binding of this.bindings) this.report(binding);
    this.keepUpstreamAlive();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.upstream?.destroy();
    for (const binding of this.bindings) binding.close();
    for (const { setup } of this.pending.values()) setup?.close();
    endPeer(this.client);
    this.client = null;
    this.deps.onClose?.(this);
  }
}

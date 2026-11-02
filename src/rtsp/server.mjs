// The RTSP port NVRs connect to. It serves the gateway's own streams (stream-hub.mjs) with what
// ONVIF's streaming specification asks for: RTP over UDP or TCP, RTSP over HTTP on the same port,
// RTCP sender reports, and the login (RTSP Digest or Basic).

import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { RtspSession } from './session.mjs';
import { ClientConnection } from './client-connection.mjs';
import { HttpTunnels } from './http-tunnel.mjs';
import { createHttpAuth } from '../onvif/http-auth.mjs';

export class SessionRegistry {
  constructor(deps) {
    this.deps = deps;
    this.sessions = new Map();
  }

  create() {
    let id;
    do id = randomBytes(8).toString('hex').toUpperCase(); while (this.sessions.has(id));
    const session = new RtspSession(id, { ...this.deps, onClose: (s) => this.sessions.delete(s.id) });
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    return this.sessions.get(id);
  }

  get size() {
    return this.sessions.size;
  }

  closeAll() {
    for (const session of [...this.sessions.values()]) session.close();
  }
}

// UDP ports are fixed per camera (cameras[].udpPort, config.mjs): video RTP/RTCP on udpPort and
// udpPort + 1, sound on udpPort + 2 and + 3. Every viewer of a camera shares them (packets go to
// each viewer's own ports), so a firewall needs exactly four ports per camera, known in advance.

// The camera a SETUP is for: rtsp://host:port/<name>[~variant][?query]/trackID=n -> name.
export function cameraOf(uri) {
  const path = String(uri).replace(/^rtsp:\/\/[^/]*\//, '').split('?')[0];
  return decodeURIComponent(path.split('/')[0]).split('~')[0];
}

// Shared socket pairs, one per (local address, port), counted by the bindings that use them.
export class UdpPorts {
  constructor() {
    this.pairs = new Map();   // "address port" -> Promise<{ rtp, rtcp, refs }>
  }

  // A lease of the pair on `port` (RTP) and port + 1 (RTCP). Throws if another program has them.
  async lease(address, port) {
    const key = `${address} ${port}`;
    if (!this.pairs.has(key)) {
      const opening = bindPair(address, port).then((p) => ({ ...p, refs: 0 }));
      this.pairs.set(key, opening);
      opening.catch(() => this.pairs.delete(key));
    }
    const pair = await this.pairs.get(key);
    pair.refs++;
    const listeners = [];
    let closed = false;
    return {
      rtp: pair.rtp, rtcp: pair.rtcp, ports: [port, port + 1],
      onRtcp: (fn) => { pair.rtcp.on('message', fn); listeners.push(fn); },
      close: () => {
        if (closed) return;
        closed = true;
        for (const fn of listeners) pair.rtcp.off('message', fn);
        if (--pair.refs === 0) {
          this.pairs.delete(key);
          pair.rtp.close();
          pair.rtcp.close();
        }
      },
    };
  }
}

async function bindPair(address, port) {
  const bind = (p) => new Promise((resolve, reject) => {
    const socket = createSocket(address?.includes(':') ? 'udp6' : 'udp4');
    socket.once('error', reject);
    socket.bind(p, address, () => {
      socket.off('error', reject);
      socket.on('error', () => {});
      resolve(socket);
    });
  });
  const rtp = await bind(port).catch((e) => { throw new Error(`UDP port ${port} is in use by another program (${e.code ?? e.message})`); });
  try {
    return { rtp, rtcp: await bind(port + 1) };
  } catch (e) {
    rtp.close();
    throw new Error(`UDP port ${port + 1} is in use by another program (${e.code ?? e.message})`);
  }
}

// hub: the StreamHub the publishers send into. credentials: { username, password } or null.
// udpPortOf(cameraName): the camera's first UDP port, or null (then viewers are told to use TCP).
export function createRtspFront({ hub, credentials, log = () => {}, now = Date.now, udpPortOf = () => null }) {
  const udp = new UdpPorts();
  const auth = credentials ? createHttpAuth(credentials, { now }) : null;
  const sessions = new SessionRegistry({
    hub,
    // video on the camera's first pair, sound on the second
    openUdp: async (address, { uri, media }) => {
      const base = udpPortOf(cameraOf(uri));
      if (base == null) throw new Error(`no UDP ports set for "${cameraOf(uri)}"`);
      return udp.lease(address?.replace(/^::ffff:/, ''), base + (media === 'audio' ? 2 : 0));
    },
    now, log,
  });
  const connectionFor = (peer) => new ClientConnection(peer, { sessions, auth, log });
  const tunnels = new HttpTunnels({ connectionFor, log });

  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setNoDelay(true);
    socket.on('error', () => {});
    socket.once('data', (first) => {
      if (/^(GET|POST) /.test(first.subarray(0, 5).toString('latin1'))) return tunnels.accept(socket, first);
      const connection = connectionFor(socket);
      connection.push(first);
      socket.on('data', (chunk) => connection.push(chunk));
      socket.on('close', () => connection.end());
    });
  });
  server.sessions = sessions;
  // Ends every session and stops listening (shutdown, tests).
  server.shutdown = () => {
    server.close();
    sessions.closeAll();
    for (const socket of sockets) socket.destroy();
  };
  return server;
}

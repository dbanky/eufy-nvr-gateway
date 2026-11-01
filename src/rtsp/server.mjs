// The RTSP port NVRs connect to. It sits in front of go2rtc (which listens on 127.0.0.1 only) and
// adds what ONVIF's streaming specification asks for and go2rtc lacks: RTP over UDP, RTSP over
// HTTP on the same port, RTCP sender reports, and the login (RTSP Digest or Basic).
// Video and audio pass through untouched.

import { createServer, connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { ProxySession } from './session.mjs';
import { ClientConnection } from './client-connection.mjs';
import { HttpTunnels } from './http-tunnel.mjs';
import { createHttpAuth } from '../onvif/http-auth.mjs';

export const UDP_PORTS = { first: 40000, last: 49998 };   // RTP on even ports, RTCP on the next one

export class SessionRegistry {
  constructor(deps) {
    this.deps = deps;
    this.sessions = new Map();
  }

  create() {
    let id;
    do id = randomBytes(8).toString('hex').toUpperCase(); while (this.sessions.has(id));
    const session = new ProxySession(id, { ...this.deps, onClose: (s) => this.sessions.delete(s.id) });
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

// A pair of UDP sockets (RTP even, RTCP the next port) on `address`.
export async function openUdpPair(address, { first, last } = UDP_PORTS, tries = 30) {
  const bind = (port) => new Promise((resolve, reject) => {
    const socket = createSocket(address?.includes(':') ? 'udp6' : 'udp4');
    socket.once('error', reject);
    socket.bind(port, address, () => {
      socket.off('error', reject);
      socket.on('error', () => {});
      resolve(socket);
    });
  });
  for (let i = 0; i < tries; i++) {
    const port = first + 2 * Math.floor(Math.random() * ((last - first) / 2 + 1));
    let rtp;
    try {
      rtp = await bind(port);
      const rtcp = await bind(port + 1);
      return { rtp, rtcp, ports: [port, port + 1], close() { rtp.close(); rtcp.close(); } };
    } catch {
      rtp?.close();
    }
  }
  throw new Error('no free UDP ports for RTP');
}

// upstream: { host, port } of go2rtc. credentials: { username, password } or null.
export function createRtspFront({ upstream, credentials, log = () => {}, now = Date.now, udpPorts = UDP_PORTS }) {
  const auth = credentials ? createHttpAuth(credentials, { now }) : null;
  const sessions = new SessionRegistry({
    connectUpstream: () => connect(upstream.port, upstream.host),
    openUdp: (address) => openUdpPair(address?.replace(/^::ffff:/, ''), udpPorts),
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

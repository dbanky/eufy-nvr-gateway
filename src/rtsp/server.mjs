// The RTSP port NVRs connect to. It serves the gateway's own streams (stream-hub.mjs) with what
// ONVIF's streaming specification asks for: RTP over UDP or TCP, RTSP over HTTP on the same port,
// RTCP sender reports, and the login (RTSP Digest or Basic).

import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { RtspSession } from './session.mjs';
import { ClientConnection } from './client-connection.mjs';
import { HttpTunnels } from './http-tunnel.mjs';
import { createHttpAuth } from '../onvif/http-auth.mjs';
import { noGuard } from '../security/login-guard.mjs';
import { parseStreamPath } from './stream-path.mjs';
import { UdpPorts, trackPort } from './udp-ports.mjs';

// The open sessions by id, each with a fresh random one.
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

const isHttp = (firstBytes) => /^(GET|POST) /.test(firstBytes.subarray(0, 5).toString('latin1'));

// hub: the StreamHub the publishers send into. credentials: { username, password } or null.
// udpPortOf(cameraName): the camera's first UDP port, or null (then viewers are told to use TCP).
// guard: the login guard shared with the web page and ONVIF (security/login-guard.mjs).
export function createRtspFront({ hub, credentials, log = () => {}, now = Date.now, udpPortOf = () => null, guard = noGuard }) {
  const udp = new UdpPorts();
  const auth = credentials ? createHttpAuth(credentials, { now }) : null;
  const sessions = new SessionRegistry({
    hub,
    openUdp: async (address, { uri, media }) => {
      const camera = parseStreamPath(uri)?.name;
      const udpPort = udpPortOf(camera);
      if (udpPort == null) throw new Error(`no UDP ports set for "${camera}"`);
      return udp.lease(address?.replace(/^::ffff:/, ''), trackPort(udpPort, media));
    },
    now,
    log,
  });
  const connectionFor = (peer) => new ClientConnection(peer, { sessions, auth, log, guard });
  const tunnels = new HttpTunnels({ connectionFor, log });

  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setNoDelay(true);
    socket.on('error', () => {});
    // RTSP and RTSP over HTTP share the port: the first bytes tell them apart.
    socket.once('data', (first) => {
      if (isHttp(first)) return tunnels.accept(socket, first);
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

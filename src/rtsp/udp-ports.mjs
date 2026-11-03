// The UDP ports RTP goes out of. They are fixed per camera (cameras[].udpPort, config.mjs):
//
//   udpPort      video RTP        udpPort + 2   sound RTP
//   udpPort + 1  video RTCP       udpPort + 3   sound RTCP
//
// Every viewer of a camera shares them (each viewer's packets go to its own ports), so a firewall
// needs exactly four ports per camera, known in advance.

import { createSocket } from 'node:dgram';

// The first port of a track's pair: video on the camera's first pair, sound on the second.
export const trackPort = (udpPort, media) => udpPort + (media === 'audio' ? 2 : 0);

// Shared socket pairs, one per (local address, port), open while any session uses them.
export class UdpPorts {
  constructor() {
    this.pairs = new Map();   // "address port" -> Promise<{ rtp, rtcp, users }>
  }

  // A lease of the pair on `port` (RTP) and port + 1 (RTCP):
  // { rtp, rtcp, ports, onRtcp(fn(packet, from)), close() }. Throws if another program has them.
  async lease(address, port) {
    const key = `${address} ${port}`;
    if (!this.pairs.has(key)) this.open(key, address, port);
    const pair = await this.pairs.get(key);
    pair.users++;
    const listeners = [];
    let closed = false;
    return {
      rtp: pair.rtp,
      rtcp: pair.rtcp,
      ports: [port, port + 1],
      onRtcp: (fn) => {
        pair.rtcp.on('message', fn);
        listeners.push(fn);
      },
      close: () => {
        if (closed) return;
        closed = true;
        for (const fn of listeners) pair.rtcp.off('message', fn);
        if (--pair.users === 0) this.close(key, pair);
      },
    };
  }

  open(key, address, port) {
    const opening = bindPair(address, port).then((sockets) => ({ ...sockets, users: 0 }));
    this.pairs.set(key, opening);
    opening.catch(() => this.pairs.delete(key));   // the next lease tries again
  }

  close(key, pair) {
    this.pairs.delete(key);
    pair.rtp.close();
    pair.rtcp.close();
  }
}

const inUse = (port, e) => new Error(`UDP port ${port} is in use by another program (${e.code ?? e.message})`);

async function bindPair(address, port) {
  const rtp = await bindOne(address, port).catch((e) => { throw inUse(port, e); });
  try {
    return { rtp, rtcp: await bindOne(address, port + 1) };
  } catch (e) {
    rtp.close();
    throw inUse(port + 1, e);
  }
}

function bindOne(address, port) {
  return new Promise((resolve, reject) => {
    const socket = createSocket(address?.includes(':') ? 'udp6' : 'udp4');
    socket.once('error', reject);
    socket.bind(port, address, () => {
      socket.off('error', reject);
      socket.on('error', () => {});   // a viewer's port unreachable must not end the pair
      resolve(socket);
    });
  });
}

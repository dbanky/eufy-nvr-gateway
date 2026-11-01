import { createServer } from 'node:net';

// Resolves true if nothing listens on host:port yet. With host networking the container shares
// the host's 127.0.0.1, so an internal port can already belong to another program (Home
// Assistant's own go2rtc uses 127.0.0.1:18554, for example).
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

// `port` if it is free, else the next free one within `range` ports above it, else null.
export async function freePort(port, { host = '127.0.0.1', range = 100, isFree = isPortFree } = {}) {
  for (let p = port; p <= Math.min(port + range, 65535); p++) {
    if (await isFree(p, host)) return p;
  }
  return null;
}

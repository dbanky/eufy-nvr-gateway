// RTSP tunnelled over HTTP (RTP/RTSP/HTTP/TCP; Apple's "Tunneling QuickTime RTSP and RTP over
// HTTP", which ONVIF requires): the client opens two HTTP connections with the same
// x-sessioncookie. The GET one receives everything from the server, as plain RTSP and interleaved
// frames; the POST one carries the client's requests, base64-encoded. Both arrive on the RTSP port.

const GET_ANSWER = 'HTTP/1.0 200 OK\r\nServer: eufy-nvr-gateway\r\nConnection: close\r\nCache-Control: no-store\r\n'
  + 'Pragma: no-cache\r\nContent-Type: application/x-rtsp-tunnelled\r\n\r\n';
const WAIT_FOR_GET_MS = 5000;

// Base64 that arrives in arbitrary pieces: decodes whole 4-character groups, keeps the rest.
export class Base64Stream {
  constructor() {
    this.rest = '';
  }

  push(chunk) {
    const text = this.rest + String(chunk).replace(/[^A-Za-z0-9+/=]/g, '');
    const whole = text.length - (text.length % 4);
    this.rest = text.slice(whole);
    return Buffer.from(text.slice(0, whole), 'base64');
  }
}

// The HTTP request head at the start of a connection: { method, cookie, rest } or null if incomplete.
export function httpHead(buffer) {
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
  const method = lines[0].split(' ')[0];
  const cookie = lines.find((l) => /^x-sessioncookie:/i.test(l))?.split(':').slice(1).join(':').trim() ?? null;
  return { method, cookie, rest: buffer.subarray(end + 4) };
}

// Pairs the GET and POST connections. connectionFor(getSocket) -> ClientConnection.
export class HttpTunnels {
  constructor({ connectionFor, log }) {
    Object.assign(this, { connectionFor, log });
    this.tunnels = new Map();   // cookie -> { get, connection }
    this.waiting = new Map();   // cookie -> [resume(tunnel)]: POSTs that came before their GET
  }

  // socket: a connection whose first bytes are an HTTP request (`first`, maybe with more after it).
  accept(socket, first) {
    let buffer = first;
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      start();
    };
    const start = () => {
      const head = httpHead(buffer);
      if (!head) return;
      socket.off('data', onData);
      if (!head.cookie) return socket.end('HTTP/1.0 400 Bad Request\r\nConnection: close\r\n\r\n');
      if (head.method === 'GET') return this.openGet(socket, head.cookie);
      if (head.method === 'POST') return this.openPost(socket, head.cookie, head.rest);
      socket.end('HTTP/1.0 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
    };
    socket.on('data', onData);
    start();
  }

  openGet(socket, cookie) {
    if (this.tunnels.has(cookie)) return socket.end('HTTP/1.0 409 Conflict\r\nConnection: close\r\n\r\n');
    socket.write(GET_ANSWER);
    const tunnel = { get: socket, connection: this.connectionFor(socket) };
    this.tunnels.set(cookie, tunnel);
    socket.on('data', () => {});   // nothing more is expected on the GET connection
    socket.on('close', () => {
      this.tunnels.delete(cookie);
      tunnel.connection.end();
    });
    for (const resume of this.waiting.get(cookie) ?? []) resume(tunnel);
    this.waiting.delete(cookie);
  }

  openPost(socket, cookie, rest) {
    const decoder = new Base64Stream();
    const feed = (tunnel) => {
      const push = (chunk) => tunnel.connection.push(decoder.push(chunk));
      if (rest.length) push(rest);
      socket.on('data', push);
      // A client may close the POST after each request and open a new one; the GET carries on.
    };
    const tunnel = this.tunnels.get(cookie);
    if (tunnel) return feed(tunnel);
    // The POST came first: wait a moment for its GET.
    const pending = [];
    socket.on('data', (chunk) => pending.push(chunk));
    const timer = setTimeout(() => {
      this.waiting.delete(cookie);
      socket.destroy();
    }, WAIT_FOR_GET_MS);
    this.waitFor(cookie, (t) => {
      clearTimeout(timer);
      socket.removeAllListeners('data');
      rest = Buffer.concat([rest, ...pending]);
      feed(t);
    });
  }

  waitFor(cookie, resume) {
    const list = this.waiting.get(cookie) ?? [];
    list.push(resume);
    this.waiting.set(cookie, list);
  }
}

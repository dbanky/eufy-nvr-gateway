// Starts the web page on its port: plain HTTP, or HTTPS. With HTTPS, a plain-HTTP request on the same
// port is answered with a redirect to https://, so an old bookmark still leads to the page: the first
// byte of a connection tells them apart (a TLS handshake starts with 0x16).

import { createServer as createNet } from 'node:net';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFileSync } from 'node:fs';

const TLS_HANDSHAKE = 0x16;

// handler: (req, res) => …   tls: null or { cert, key } (file paths)
export function listenWeb(handler, { port, tls = null }, onListening) {
  if (!tls) return createHttp(handler).listen(port, onListening);
  const secure = createHttps({ cert: readFileSync(tls.cert), key: readFileSync(tls.key) }, handler);
  const plain = createHttp(redirectToHttps);
  const server = createNet((socket) => {
    socket.once('data', (first) => {
      socket.pause();
      socket.unshift(first);
      (first[0] === TLS_HANDSHAKE ? secure : plain).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
    socket.on('error', () => socket.destroy());
  });
  return server.listen(port, onListening);
}

export function redirectToHttps(req, res) {
  const host = (req.headers.host ?? '').replace(/[^\w.:[\]-]/g, '');
  if (!host) {
    res.writeHead(400).end('use https://');
    return;
  }
  res.writeHead(308, { location: `https://${host}${req.url}` });
  res.end();
}

// One ONVIF camera's HTTP endpoint: routes SOAP requests to the device, media and events services,
// checks the login, and always answers in SOAP (faults included). Also serves the snapshot
// (GET /onvif/snapshot.jpg, open like the RTSP stream it shows) and remembers the last request, so
// the web page can show whether an NVR talks to the camera.

import { createServer } from 'node:http';
import { operation, envelope, fault } from './xml.mjs';
import { checkUsernameToken } from './auth.mjs';
import { deviceResponse } from './device.mjs';
import { mediaResponse } from './media.mjs';

// What a client may ask before logging in (ONVIF "pre-auth" operations).
const OPEN = new Set(['GetSystemDateAndTime', 'GetCapabilities', 'GetServices', 'GetServiceCapabilities', 'GetHostname', 'GetEndpointReference']);

// device: see index.mjs   events: MotionEvents   credentials: { username, password } | null
// snapshot() -> Promise<jpeg Buffer>   contact: filled with { at, from, op } of the last SOAP request
export function createCameraServer({ device, events, credentials, log, snapshot, contact = {}, now = Date.now }) {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url.split('?')[0] === '/onvif/snapshot.jpg') return sendSnapshot(res, snapshot);
    const send = (status, xml) => {
      res.writeHead(status, { 'content-type': 'application/soap+xml; charset=utf-8' });
      res.end(xml);
    };
    const xml = await readBody(req);
    const op = operation(xml);
    const path = req.url.split('?')[0];
    if (req.method !== 'POST' || !op) return send(400, fault('ter:InvalidArgVal', 'expected a SOAP request'));
    Object.assign(contact, { at: now(), from: String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''), op });

    if (!(path === '/onvif/device_service' && OPEN.has(op))) {
      const problem = checkUsernameToken(xml, credentials, now());
      if (problem) {
        log(device.name, `ONVIF: ${op} refused: ${problem}`);
        return send(400, fault('ter:NotAuthorized', `Sender not authorized: ${problem}`));
      }
    }
    try {
      const answer = await route(path, op, xml, device, events, now);
      if (!answer) return send(400, fault('ter:ActionNotSupported', `${op} is not supported`));
      send(200, envelope(answer.body, { action: answer.action }));
    } catch (e) {
      send(400, fault(e.code ?? 'ter:InvalidArgVal', e.message));
    }
  });
  server.requestTimeout = 0;   // PullMessages may wait up to a minute
  return server;
}

async function route(path, op, xml, device, events, now) {
  const plain = (body) => body && { body };
  if (path === '/onvif/device_service') return plain(deviceResponse(op, device, now()));
  if (path === '/onvif/media_service') return plain(mediaResponse(op, device));
  if (path === '/onvif/events_service') return events.handle(op, xml);
  const subscription = /^\/onvif\/subscription\/(\w+)$/.exec(path);
  if (subscription) return events.handle(op, xml, subscription[1]);
  return null;
}

async function sendSnapshot(res, snapshot) {
  try {
    const jpg = await snapshot();
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': jpg.length, 'cache-control': 'no-store' });
    res.end(jpg);
  } catch {
    res.writeHead(503).end();
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(body));
  });
}

// One ONVIF camera's HTTP endpoint: routes SOAP requests to the device, media, media2 and events
// services, checks the login, and always answers in SOAP (faults included). Also serves the snapshot
// (GET /onvif/snapshot.jpg, with the same login over HTTP Digest or Basic) and remembers the last
// request, so the web page can show whether an NVR talks to the camera.

import { createServer } from 'node:http';
import { operation, envelope, fault, isReceiverFault } from './xml.mjs';
import { checkUsernameToken, hasUsernameToken, WRONG_LOGIN } from './auth.mjs';
import { noGuard } from '../security/login-guard.mjs';
import { deviceResponse } from './device.mjs';
import { mediaResponse } from './media.mjs';
import { media2Response } from './media2.mjs';
import { createHttpAuth } from './http-auth.mjs';

// What a client may ask before logging in (ONVIF "pre-auth" operations).
const OPEN = new Set(['GetSystemDateAndTime', 'GetCapabilities', 'GetServices', 'GetServiceCapabilities', 'GetHostname',
  'GetWsdlUrl', 'GetEndpointReference']);

// camera: { device, settings, model, events } (index.mjs)   credentials: { username, password } | null
// snapshot() -> Promise<jpeg Buffer>   contact: filled with { at, from, op } of the last SOAP request
// guard: the login guard shared with the web page and RTSP (security/login-guard.mjs). Only wrong
// passwords count, never a request without a login or a clock that is off, so a working NVR is
// never locked out.
export function createCameraServer({ camera, credentials, log, snapshot, contact = {}, now = Date.now, guard = noGuard }) {
  const { device, settings, events } = camera;
  const httpAuth = createHttpAuth(credentials, { now });
  const server = createServer(async (req, res) => {
    const address = req.socket.remoteAddress;
    if (req.method === 'GET' && req.url.split('?')[0] === '/onvif/snapshot.jpg') {
      const verdict = httpAuth.check(req);
      if (credentials && verdict !== 'none' && guard.blocked(address)) {
        res.writeHead(403);
        return res.end();
      }
      if (verdict === 'ok') return sendSnapshot(res, snapshot);
      if (verdict === 'wrong') guard.failed(address, 'ONVIF snapshot');
      res.writeHead(401, { 'www-authenticate': httpAuth.challenges() });
      return res.end();
    }
    const send = (status, xml) => {
      res.writeHead(status, { 'content-type': 'application/soap+xml; charset=utf-8' });
      res.end(xml);
    };
    const sendFault = (code, reason) => send(isReceiverFault(code) ? 500 : 400, fault(code, reason));
    const xml = await readBody(req);
    const op = operation(xml);
    const path = req.url.split('?')[0];
    if (req.method !== 'POST' || !op) return sendFault('ter:InvalidArgVal', 'expected a SOAP request');
    Object.assign(contact, { at: now(), from: String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''), op });

    // WS-UsernameToken (what ONVIF clients send), or HTTP Digest/Basic on the request. The token's
    // time is checked against the device's clock, which an NVR may have set.
    if (credentials && !(path === '/onvif/device_service' && OPEN.has(op))) {
      const http = req.headers.authorization ? httpAuth.check(req) : 'none';
      if ((http !== 'none' || hasUsernameToken(xml)) && guard.blocked(address)) {
        log(device.name, `ONVIF: ${op} refused: too many wrong logins from ${String(address).replace(/^::ffff:/, '')}`);
        return sendFault('ter:NotAuthorized', 'Sender not authorized: too many wrong logins, try again later');
      }
      const problem = http === 'ok' ? null : checkUsernameToken(xml, credentials, settings.clock());
      if (problem) {
        if (problem === WRONG_LOGIN || http === 'wrong') guard.failed(address, 'ONVIF');
        log(device.name, `ONVIF: ${op} refused: ${problem}`);
        return sendFault('ter:NotAuthorized', `Sender not authorized: ${problem}`);
      }
    }
    try {
      const answer = await route(path, op, xml, camera, credentials);
      if (!answer) return sendFault('ter:ActionNotSupported', `${op} is not supported`);
      send(200, envelope(answer.body, { action: answer.action }));
    } catch (e) {
      if (!e.code) log(device.name, `ONVIF: ${op} failed: ${e.stack ?? e.message}`);
      sendFault(e.code ?? 'ter:Action', e.code ? e.message : `${op} failed`);
    }
  });
  server.requestTimeout = 0;   // PullMessages may wait up to a minute
  server.on('clientError', (e, socket) => socket.destroy());
  return server;
}

// A device restart (SystemReboot, SetSystemFactoryDefault) ends event subscriptions; a factory
// default also resets the media profiles. The stream itself keeps running.
const restart = (camera) => (why) => {
  camera.events.reset();
  if (why === 'factory default') camera.model.reset();
};

async function route(path, op, xml, camera, credentials) {
  const plain = (body) => body && { body };
  const { device, settings, model, events } = camera;
  if (path === '/onvif/device_service') return plain(deviceResponse(op, xml, { device, settings, credentials, onReboot: restart(camera) }));
  if (path === '/onvif/media_service') return plain(mediaResponse(op, xml, { device, model }));
  if (path === '/onvif/media2_service') return plain(media2Response(op, xml, { device, model }));
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

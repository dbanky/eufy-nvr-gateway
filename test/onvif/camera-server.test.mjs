import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCameraServer } from '../../src/onvif/camera-server.mjs';
import { MotionEvents } from '../../src/onvif/events.mjs';
import { device } from './fixtures.mjs';

const credentials = { username: 'protect', password: 'secret' };
let server, base;
before(async () => {
  server = createCameraServer({ device: device(), events: new MotionEvents({ baseUrl: 'http://x' }), credentials, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function security(password = 'secret') {
  const nonce = Buffer.from('nonce-123'), created = new Date().toISOString();
  const digest = createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)])).digest('base64');
  return `<s:Header><Security><UsernameToken><Username>protect</Username><Password>${digest}</Password>`
    + `<Nonce>${nonce.toString('base64')}</Nonce><Created>${created}</Created></UsernameToken></Security></s:Header>`;
}
const soap = (path, body, header = '') => fetch(base + path, { method: 'POST',
  headers: { 'content-type': 'application/soap+xml' },
  body: `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${header}<s:Body>${body}</s:Body></s:Envelope>` });

describe('an ONVIF camera endpoint', () => {
  test('tells the time without a login (clients need it to sign their login)', async () => {
    const res = await soap('/onvif/device_service', '<GetSystemDateAndTime/>');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/soap+xml; charset=utf-8');
    assert.match(await res.text(), /GetSystemDateAndTimeResponse/);
  });

  test('everything else needs the right login', async () => {
    const refused = await soap('/onvif/media_service', '<GetStreamUri/>');
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /ter:NotAuthorized/);
    const wrong = await soap('/onvif/media_service', '<GetStreamUri/>', security('nope'));
    assert.match(await wrong.text(), /ter:NotAuthorized/);
    const ok = await soap('/onvif/media_service', '<GetStreamUri/>', security());
    assert.match(await ok.text(), /rtsp:\/\/192\.168\.1\.51:8554\/garden/);
  });

  test('unknown operations get a SOAP fault, not plain text', async () => {
    const res = await soap('/onvif/device_service', '<SystemReboot/>', security());
    assert.match(await res.text(), /ter:ActionNotSupported/);
  });

  test('event subscriptions are served at their own address', async () => {
    const created = await (await soap('/onvif/events_service', '<CreatePullPointSubscription/>', security())).text();
    const path = new URL(/<wsa:Address>([^<]+)</.exec(created)[1]).pathname;
    const pulled = await (await soap(path, '<PullMessages><Timeout>PT1S</Timeout></PullMessages>', security())).text();
    assert.match(pulled, /IsMotion/);
  });
});

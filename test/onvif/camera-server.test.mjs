import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createCameraServer } from '../../src/onvif/camera-server.mjs';
import { onvifCamera } from './fixtures.mjs';
import { passwordDigest } from '../helpers/logins.mjs';

const credentials = { username: 'protect', password: 'secret' };
let server, base;
const contact = {};
before(async () => {
  server = createCameraServer({ camera: onvifCamera(), credentials, log: () => {}, contact,
    snapshot: async () => Buffer.from('jpeg') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function security(password = 'secret') {
  const nonce = Buffer.from('nonce-123'), created = new Date().toISOString();
  const digest = passwordDigest(nonce, created, password);
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
    const uri = '<GetStreamUri><ProfileToken>main</ProfileToken></GetStreamUri>';
    const refused = await soap('/onvif/media_service', uri);
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /ter:NotAuthorized/);
    const wrong = await soap('/onvif/media_service', uri, security('nope'));
    assert.match(await wrong.text(), /ter:NotAuthorized/);
    const ok = await soap('/onvif/media_service', uri, security());
    assert.match(await ok.text(), /rtsp:\/\/192\.168\.1\.51:8554\/garden/);
  });

  test('unknown operations get a SOAP fault, not plain text: the device can\'t (Receiver, HTTP 500)', async () => {
    const res = await soap('/onvif/device_service', '<UpgradeSystemFirmware/>', security());
    assert.equal(res.status, 500);
    const xml = await res.text();
    assert.match(xml, /<s:Value>s:Receiver<\/s:Value><s:Subcode><s:Value>ter:ActionNotSupported<\/s:Value>/);
  });

  test('a wrong request gets the ONVIF fault codes (Sender, HTTP 400)', async () => {
    const res = await soap('/onvif/media_service', '<GetProfile><ProfileToken>nope</ProfileToken></GetProfile>', security());
    assert.equal(res.status, 400);
    assert.match(await res.text(), /<s:Value>s:Sender<\/s:Value><s:Subcode><s:Value>ter:InvalidArgVal<\/s:Value><s:Subcode><s:Value>ter:NoProfile<\/s:Value>/);
  });

  test('HTTP Basic or Digest on the request is a login too', async () => {
    const res = await fetch(`${base}/onvif/device_service`, { method: 'POST',
      headers: { 'content-type': 'application/soap+xml', authorization: 'Basic ' + Buffer.from('protect:secret').toString('base64') },
      body: '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetUsers/></s:Body></s:Envelope>' });
    assert.match(await res.text(), /<tt:Username>protect<\/tt:Username>/);
  });

  test('Media2 is served too (for H.265 cameras)', async () => {
    const res = await soap('/onvif/media2_service', '<GetProfiles/>', security());
    assert.match(await res.text(), /<tr2:Profiles token="main"/);
  });

  test('serves the snapshot as a JPEG, behind the same login (HTTP Digest or Basic)', async () => {
    const refused = await fetch(`${base}/onvif/snapshot.jpg`);
    assert.equal(refused.status, 401);
    assert.match(refused.headers.get('www-authenticate'), /Digest realm="eufy-nvr-gateway"/);
    const res = await fetch(`${base}/onvif/snapshot.jpg`, { headers: { authorization: 'Basic ' + Buffer.from('protect:secret').toString('base64') } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(await res.text(), 'jpeg');
  });

  test('remembers the last request (when, from where, what), so the web page can show an NVR talks to it', async () => {
    await soap('/onvif/device_service', '<GetSystemDateAndTime/>');
    assert.equal(contact.from, '127.0.0.1');
    assert.equal(contact.op, 'GetSystemDateAndTime');
    assert.ok(Date.now() - contact.at < 5000);
  });

  test('event subscriptions are served at their own address', async () => {
    const created = await (await soap('/onvif/events_service', '<CreatePullPointSubscription/>', security())).text();
    const path = new URL(/<wsa:Address>([^<]+)</.exec(created)[1]).pathname;
    const pulled = await (await soap(path, '<PullMessages><Timeout>PT1S</Timeout></PullMessages>', security())).text();
    assert.match(pulled, /IsMotion/);
  });
});

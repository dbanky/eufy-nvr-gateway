import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { probeMatch } from '../../src/onvif/discovery.mjs';
import { device } from './fixtures.mjs';

const probe = (types = 'dn:NetworkVideoTransmitter') => `<?xml version="1.0" encoding="utf-8"?>
<Envelope xmlns:dn="http://www.onvif.org/ver10/network/wsdl" xmlns="http://www.w3.org/2003/05/soap-envelope">
<Header><wsa:MessageID xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing">uuid:4a8c9d6e-1111-2222-3333-444455556666</wsa:MessageID>
<wsa:Action xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action></Header>
<Body><Probe xmlns="http://schemas.xmlsoap.org/ws/2005/04/discovery"><Types>${types}</Types><Scopes/></Probe></Body></Envelope>`;

describe('answering a WS-Discovery probe', () => {
  test('a camera looking for video transmitters gets this camera', () => {
    const xml = probeMatch(probe(), device());
    assert.match(xml, /<d:ProbeMatch>/);
    assert.match(xml, /<wsa:RelatesTo>uuid:4a8c9d6e-1111-2222-3333-444455556666<\/wsa:RelatesTo>/);
    assert.match(xml, /<d:XAddrs>http:\/\/192\.168\.1\.51:8000\/onvif\/device_service<\/d:XAddrs>/);
    assert.match(xml, /<wsa:Address>urn:uuid:5f0c2a2e-0000-4000-8000-000000000001<\/wsa:Address>/);
    assert.match(xml, /onvif:\/\/www\.onvif\.org\/name\/garden/);
  });

  test('a probe for any device type is answered too', () => {
    assert.ok(probeMatch(probe(''), device()));
    assert.ok(probeMatch(probe('tds:Device'), device()));
  });

  test('probes for other kinds of devices (printers…) are ignored', () => {
    assert.equal(probeMatch(probe('wprt:PrintDeviceType'), device()), null);
  });

  test('anything that is not a probe is ignored', () => {
    assert.equal(probeMatch('<Envelope><Body><Hello/></Body></Envelope>', device()), null);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { operation, valueOf, envelope, fault, xmlEscape } from '../../src/onvif/xml.mjs';

// A request the way the npm "onvif" library (UniFi Protect's ONVIF client) sends it.
const request = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Header><Security/></s:Header>
<s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl"><StreamSetup><Stream xmlns="http://www.onvif.org/ver10/schema">RTP-Unicast</Stream></StreamSetup>
<ProfileToken>main</ProfileToken></GetStreamUri></s:Body></s:Envelope>`;

describe('reading a SOAP request', () => {
  test('the operation is the first element in the body, without its prefix', () => {
    assert.equal(operation(request), 'GetStreamUri');
    assert.equal(operation('<s:Body><tds:GetDeviceInformation/></s:Body>'), 'GetDeviceInformation');
  });

  test('values by element name, whatever the namespace prefix', () => {
    assert.equal(valueOf(request, 'ProfileToken'), 'main');
    assert.equal(valueOf('<a><wsnt:Timeout>PT60S</wsnt:Timeout></a>', 'Timeout'), 'PT60S');
    assert.equal(valueOf(request, 'Missing'), null);
  });
});

describe('writing a SOAP response', () => {
  test('a SOAP 1.2 envelope with the ONVIF namespaces', () => {
    const xml = envelope('<tds:GetHostnameResponse/>');
    assert.match(xml, /^<\?xml/);
    assert.match(xml, /xmlns:s="http:\/\/www\.w3\.org\/2003\/05\/soap-envelope"/);
    assert.match(xml, /xmlns:tds="http:\/\/www\.onvif\.org\/ver10\/device\/wsdl"/);
    assert.match(xml, /<s:Body><tds:GetHostnameResponse\/><\/s:Body>/);
  });

  test('unknown or failing requests get a SOAP fault, never plain text', () => {
    const xml = fault('ter:ActionNotSupported', 'GetFoo is not supported');
    assert.match(xml, /<s:Fault>/);
    assert.match(xml, /<s:Value>ter:ActionNotSupported<\/s:Value>/);
  });

  test('text is escaped', () => {
    assert.equal(xmlEscape('a<b>&"c"'), 'a&lt;b&gt;&amp;&quot;c&quot;');
  });
});

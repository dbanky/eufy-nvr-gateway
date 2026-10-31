import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deviceResponse } from '../../src/onvif/device.mjs';
import { device } from './fixtures.mjs';

const answer = (op) => deviceResponse(op, device(), Date.parse('2026-10-31T12:34:56Z'));

describe('the device service', () => {
  test('tells the time in UTC: clients sign their login with it', () => {
    const xml = answer('GetSystemDateAndTime');
    assert.match(xml, /<tt:UTCDateTime><tt:Time><tt:Hour>12<\/tt:Hour><tt:Minute>34<\/tt:Minute><tt:Second>56<\/tt:Second>/);
    assert.match(xml, /<tt:Year>2026<\/tt:Year><tt:Month>10<\/tt:Month><tt:Day>31<\/tt:Day>/);
  });

  test('lists the device, media (version 1) and events services at the camera\'s own address', () => {
    const xml = answer('GetServices');
    for (const s of ['device', 'media', 'events']) assert.match(xml, new RegExp(`ver10/${s}/wsdl`));
    assert.doesNotMatch(xml, /ver20\/media/, 'Media2 would make clients switch to it');
    assert.match(xml, /http:\/\/192\.168\.1\.51:8000\/onvif\/device_service/);
  });

  test('capabilities: RTSP streaming over TCP, and where media and events are', () => {
    const xml = answer('GetCapabilities');
    assert.match(xml, /<tt:RTP_RTSP_TCP>true<\/tt:RTP_RTSP_TCP>/);
    assert.match(xml, /<tt:Events><tt:XAddr>http:\/\/192\.168\.1\.51:8000\/onvif\/events_service/);
  });

  test('identity: manufacturer, model, and the camera serial (unique per camera)', () => {
    const xml = answer('GetDeviceInformation');
    assert.match(xml, /<tds:Manufacturer>eufy<\/tds:Manufacturer>/);
    assert.match(xml, /<tds:Model>T8170<\/tds:Model>/);
    assert.match(xml, /<tds:SerialNumber>T81XXXXXXXXXXXXX<\/tds:SerialNumber>/);
  });

  test('its network interface: the camera\'s own MAC and address', () => {
    const xml = answer('GetNetworkInterfaces');
    assert.match(xml, /<tt:HwAddress>02:00:00:00:00:01<\/tt:HwAddress>/);
    assert.match(xml, /<tt:Address>192\.168\.1\.51<\/tt:Address>/);
  });

  test('scopes: a video transmitter with the camera\'s name', () => {
    assert.match(answer('GetScopes'), /onvif:\/\/www\.onvif\.org\/name\/garden/);
  });

  test('operations it doesn\'t know: null (the server answers with a fault)', () => {
    assert.equal(answer('SystemReboot'), null);
  });
});

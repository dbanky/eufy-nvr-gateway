import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { onvifDetailsHtml, ago } from '../../../../src/switcher/web/static/onvif-info.js';

const onvif = (over = {}) => ({
  address: '192.168.1.51', port: 8000, mac: '02:00:00:00:00:01',
  deviceService: 'http://192.168.1.51:8000/onvif/device_service', login: true,
  identity: { uuid: 'urn:uuid:5f0c2a2e-0000-4000-8000-000000000001', name: 'garden', hardware: 'T8170' },
  subscriptions: 1, lastContact: { secondsAgo: 4, from: '192.168.1.1', op: 'PullMessages' },
  ...over,
});

describe('a camera\'s ONVIF details', () => {
  test('where NVRs reach it: the device address to copy, IP, port and MAC', () => {
    const html = onvifDetailsHtml(onvif(), 'garden');
    assert.match(html, /value="http:\/\/192\.168\.1\.51:8000\/onvif\/device_service"/);
    assert.match(html, /data-copy="http:\/\/192\.168\.1\.51:8000\/onvif\/device_service"/);
    assert.match(html, /192\.168\.1\.51 · port 8000 · MAC 02:00:00:00:00:01/);
  });

  test('how it shows in NVRs: name, model and UUID', () => {
    assert.match(onvifDetailsHtml(onvif(), 'garden'), /Shows as<\/dt><dd>“garden” · T8170<span class="sub"><code>urn:uuid:5f0c2a2e-0000-4000-8000-000000000001<\/code>/);
    assert.doesNotMatch(onvifDetailsHtml(onvif(), 'garden'), /Discovery|3702/);
  });

  test('a device that isn\'t on the network yet says why, and that the gateway keeps trying', () => {
    const html = onvifDetailsHtml(onvif({ listening: false, error: '192.168.1.51 is not an address of this machine (it has 192.168.1.10)' }));
    assert.match(html, /Not on the network yet\.<\/strong> 192\.168\.1\.51 is not an address of this machine \(it has 192\.168\.1\.10\)\. The gateway tries again every 30 s/);
    assert.doesNotMatch(onvifDetailsHtml(onvif({ listening: true, error: null })), /Not on the network/);
  });

  test('whether a login is required, never the password itself', () => {
    assert.match(onvifDetailsHtml(onvif()), /Required/);
    assert.match(onvifDetailsHtml(onvif({ login: false })), /None: anyone on the LAN can adopt it/);
  });

  test('whether an NVR talks to it', () => {
    assert.match(onvifDetailsHtml(onvif()), /Last request 4 s ago from 192\.168\.1\.1 \(PullMessages\) · 1 motion event subscription</);
    assert.match(onvifDetailsHtml(onvif({ lastContact: null, subscriptions: 0 })), /No NVR has connected yet/);
  });

  test('a camera that isn\'t published says so, and how to publish it', () => {
    const html = onvifDetailsHtml(null, 'garden');
    assert.match(html, /Not published as an ONVIF device/);
    assert.match(html, /docs\/onvif\.md/);
  });
});

test('times ago, in the largest whole unit', () => {
  assert.deepEqual([ago(4), ago(300), ago(7300), ago(200000)], ['4 s ago', '5 min ago', '2 h ago', '2 d ago']);
});

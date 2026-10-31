import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hostAddresses, explainNetworkError, onvifNetworkProblem } from '../../src/onvif/network.mjs';

const interfaces = {
  lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  eth0: [{ family: 'IPv4', address: '192.168.1.10', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
  eth1: [{ family: 'IPv4', address: '192.168.1.11', internal: false }],
};
const error = (code, message = `${code} message`) => Object.assign(new Error(message), { code });

describe('the addresses this machine has', () => {
  test('its IPv4 LAN addresses, without loopback or IPv6', () => {
    assert.deepEqual(hostAddresses(interfaces), ['192.168.1.10', '192.168.1.11']);
  });
});

describe('network errors in plain words', () => {
  const where = { address: '192.168.1.51', port: 8000, addresses: ['192.168.1.10', '192.168.1.11'] };

  test('an address the machine doesn\'t have (ENODEV, EADDRNOTAVAIL): which ones it has and what to do', () => {
    for (const code of ['ENODEV', 'EADDRNOTAVAIL']) {
      const text = explainNetworkError(error(code, `addMembership ${code}`), where);
      assert.match(text, /^192\.168\.1\.51 is not an address of this machine \(it has 192\.168\.1\.10, 192\.168\.1\.11\)/);
      assert.match(text, /host networking/);
      assert.doesNotMatch(text, new RegExp(code));
    }
    assert.match(explainNetworkError(error('ENODEV'), { ...where, addresses: [] }), /\(it has none: is the container on host networking\?\)/);
  });

  test('a port another program already uses', () => {
    assert.equal(explainNetworkError(error('EADDRINUSE'), where), 'port 8000 on 192.168.1.51 is already used by another program: choose another "onvif.port"');
    assert.match(explainNetworkError(error('EADDRINUSE'), { ...where, port: 3702, udp: true }), /UDP port 3702 is already used by another program/);
  });

  test('anything else keeps its own message', () => {
    assert.equal(explainNetworkError(error('EPERM', 'bind EPERM'), where), 'bind EPERM');
  });
});

describe('ONVIF on a Docker bridge network', () => {
  test('is called out loudly, with how to switch to host networking', () => {
    const text = onvifNetworkProblem(['192.168.1.51', '192.168.1.52'], ['172.18.0.2']);
    assert.match(text, /^ONVIF needs host networking, and this container is on a Docker bridge network \(its address: 172\.18\.0\.2\)/);
    assert.match(text, /Network: host; Docker Compose: network_mode: host/);
    assert.match(onvifNetworkProblem(['192.168.1.51'], []), /no LAN address/);
  });

  test('says nothing on host networking, without ONVIF cameras, or when one camera address is here', () => {
    assert.equal(onvifNetworkProblem(['192.168.1.51'], ['192.168.1.10', '172.17.0.1']), null, 'host networking: the LAN address is there');
    assert.equal(onvifNetworkProblem([], ['172.18.0.2']), null, 'no ONVIF cameras');
    assert.equal(onvifNetworkProblem(['172.20.0.5'], ['172.20.0.5']), null);
  });

  test('a camera address on a bridge network names the cause', () => {
    const text = explainNetworkError(Object.assign(new Error('x'), { code: 'EADDRNOTAVAIL' }), { address: '192.168.1.51', port: 8000, addresses: ['172.18.0.2'] });
    assert.match(text, /not an address of this container: it is on a Docker bridge network \(it has 172\.18\.0\.2\)\. ONVIF needs host networking/);
  });
});

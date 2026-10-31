import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hostAddresses, explainNetworkError } from '../../src/onvif/network.mjs';

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

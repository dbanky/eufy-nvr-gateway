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

describe('finding the cameras on each of their addresses', async () => {
  const { EventEmitter } = await import('node:events');
  const { startDiscovery } = await import('../../src/onvif/discovery.mjs');

  // Fake UDP sockets: the machine "has" the addresses in `present`.
  function fakeNetwork(present) {
    const sockets = [];
    const dgram = {
      createSocket() {
        const s = Object.assign(new EventEmitter(), {
          sent: [],
          bind(port, address, done) {
            if (typeof port === 'number' && port === 3702) return setImmediate(address);
            setImmediate(() => (present.has(address) ? done()
              : s.emit('error', Object.assign(new Error(`bind EADDRNOTAVAIL ${address}`), { code: 'EADDRNOTAVAIL' }))));
          },
          addMembership(group, address) {
            if (!present.has(address)) throw Object.assign(new Error('addMembership ENODEV'), { code: 'ENODEV' });
          },
          send(...args) { s.sent.push(args); },
          close() {},
        });
        sockets.push(s);
        return s;
      },
    };
    return { dgram, sockets };
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const devices = [device(), { ...device(), name: 'front-door', address: '192.168.1.52' }];

  test('an address the machine doesn\'t have is explained, retried, and found once it appears', async () => {
    const present = new Set(['192.168.1.51']);
    const { dgram } = fakeNetwork(present);
    const logs = [];
    const { state, stop } = startDiscovery(devices, (m) => logs.push(m), { dgram, retryMs: 10, addresses: () => [...present] });
    await wait(5);
    assert.equal(state.listening, true);
    assert.equal(state.addresses['192.168.1.51'], null);
    assert.match(state.addresses['192.168.1.52'], /^192\.168\.1\.52 is not an address of this machine \(it has 192\.168\.1\.51\)/);
    assert.doesNotMatch(logs.join('\n'), /ENODEV/);
    present.add('192.168.1.52');
    await wait(30);
    assert.equal(state.addresses['192.168.1.52'], null);
    assert.match(logs.at(-1), /ONVIF discovery on 192\.168\.1\.52: on/);
    stop();
  });

  test('each camera answers a probe from its own address', async () => {
    const { dgram, sockets } = fakeNetwork(new Set(['192.168.1.51', '192.168.1.52']));
    const { stop } = startDiscovery(devices, () => {}, { dgram, retryMs: 1000, addresses: () => [] });
    await wait(5);
    const [listener, ...senders] = sockets;
    listener.emit('message', Buffer.from(probe()), { port: 50000, address: '192.168.1.1' });
    assert.deepEqual(senders.map((s) => s.sent.length), [1, 1]);
    assert.match(senders[1].sent[0][0], /192\.168\.1\.52:8000/);
    stop();
  });
});

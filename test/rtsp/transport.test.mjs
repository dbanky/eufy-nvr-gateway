import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTransport, chooseTransport, udpTransport, interleavedTransport } from '../../src/rtsp/transport.mjs';

test('reads what a client offers, best first', () => {
  const [udp, tcp] = parseTransport('RTP/AVP;unicast;client_port=5000-5001, RTP/AVP/TCP;unicast;interleaved=2-3');
  assert.deepEqual({ ...udp, raw: undefined }, { protocol: 'udp', multicast: false, clientPort: [5000, 5001], interleaved: null, raw: undefined });
  assert.equal(tcp.protocol, 'tcp');
  assert.deepEqual(tcp.interleaved, [2, 3]);
});

test('picks unicast UDP or interleaved TCP; multicast and UDP without ports are not possible', () => {
  assert.equal(chooseTransport(parseTransport('RTP/AVP;multicast, RTP/AVP/TCP;unicast')).protocol, 'tcp');
  assert.equal(chooseTransport(parseTransport('RTP/AVP;unicast')), null);
  assert.equal(chooseTransport(parseTransport('RTP/AVP/UDP;unicast;client_port=6000')).clientPort[1], 6001);
});

test('answers', () => {
  assert.equal(udpTransport({ clientPort: [5000, 5001], serverPort: [40000, 40001] }), 'RTP/AVP;unicast;client_port=5000-5001;server_port=40000-40001');
  assert.equal(interleavedTransport([0, 1]), 'RTP/AVP/TCP;unicast;interleaved=0-1');
});

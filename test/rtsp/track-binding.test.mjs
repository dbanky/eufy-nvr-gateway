// One SETUP: its channels, and how its packets reach the client.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TrackBinding, chooseChannels } from '../../src/rtsp/track-binding.mjs';
import { RtspReader } from '../../src/rtsp/messages.mjs';

const RTCP_RR = Buffer.from([0x80, 201, 0, 1, 0, 0, 0, 1]);

describe('choosing interleaved channels', () => {
  test('the ones the client asked for, if free', () => {
    assert.deepEqual(chooseChannels([], [4, 5]), [4, 5]);
  });

  test('else the first free pair', () => {
    assert.deepEqual(chooseChannels([0, 1], [0, 1]), [2, 3]);
    assert.deepEqual(chooseChannels([0, 1, 4, 5], null), [2, 3]);
  });
});

describe('interleaved (TCP)', () => {
  test('packets go out on the RTSP connection, RTP on the first channel, RTCP on the second', () => {
    const binding = new TrackBinding({ channels: [2, 3] });
    const written = [];
    binding.sendRtp(Buffer.from([1]), '192.168.1.20', (b) => written.push(b));
    binding.sendRtcp(Buffer.from([2]), '192.168.1.20', (b) => written.push(b));
    const items = new RtspReader().push(Buffer.concat(written));
    assert.deepEqual(items.map((i) => i.frame.channel), [2, 3]);
    assert.equal(binding.transport(), 'RTP/AVP/TCP;unicast;interleaved=2-3');
  });
});

describe('over UDP', () => {
  function udpBinding({ clientAddress = '192.168.1.20' } = {}) {
    const sent = [];
    let onRtcp = null, alive = 0;
    const udp = {
      ports: [40000, 40001],
      rtp: { send: (data, port, address) => sent.push(['rtp', port, address]) },
      rtcp: { send: (data, port, address) => sent.push(['rtcp', port, address]) },
      onRtcp: (fn) => { onRtcp = fn; },
      closed: false, close() { this.closed = true; },
    };
    const asked = [];
    const binding = new TrackBinding({ channels: [0, 1] });
    const opened = binding.openUdp({
      openUdp: async (localAddress, what) => { asked.push([localAddress, what]); return udp; },
      localAddress: '192.168.1.10', uri: 'rtsp://x/garden/trackID=1', media: 'audio',
      clientPort: [5000, 5001], clientAddress: () => clientAddress, onAlive: () => alive++,
    });
    return { binding, opened, sent, udp, asked, rtcpFrom: (address, port, packet = RTCP_RR) => onRtcp(packet, { address, port }), alive: () => alive };
  }

  test('asks for the camera\'s ports on the address the client came to, for its kind of track', async () => {
    const { opened, asked } = udpBinding();
    await opened;
    assert.deepEqual(asked, [['192.168.1.10', { uri: 'rtsp://x/garden/trackID=1', media: 'audio' }]]);
  });

  test('packets go to the client\'s ports; the Transport header names both sides', async () => {
    const { binding, opened, sent } = udpBinding();
    await opened;
    binding.sendRtp(Buffer.from([1]), '192.168.1.20', () => assert.fail('not interleaved'));
    binding.sendRtcp(Buffer.from([2]), '192.168.1.20', () => assert.fail('not interleaved'));
    assert.deepEqual(sent, [['rtp', 5000, '192.168.1.20'], ['rtcp', 5001, '192.168.1.20']]);
    assert.equal(binding.transport(), 'RTP/AVP;unicast;client_port=5000-5001;server_port=40000-40001');
  });

  test('only this viewer\'s own RTCP (its address and RTCP port) keeps it alive; the ports are shared', async () => {
    const { opened, rtcpFrom, alive } = udpBinding();
    await opened;
    rtcpFrom('::ffff:192.168.1.20', 5001);
    assert.equal(alive(), 1);
    rtcpFrom('192.168.1.99', 5001);              // another viewer
    rtcpFrom('192.168.1.20', 6001);              // another port
    rtcpFrom('192.168.1.20', 5001, Buffer.from([1, 2, 3]));   // not RTCP
    assert.equal(alive(), 1);
  });

  test('closing releases the ports', async () => {
    const { binding, opened, udp } = udpBinding();
    await opened;
    binding.close();
    assert.equal(udp.closed, true);
  });
});

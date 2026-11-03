// The fixed UDP ports RTP goes out of: four per camera, shared by all its viewers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { UdpPorts, trackPort } from '../../src/rtsp/udp-ports.mjs';

const bound = (port) => new Promise((resolve) => {
  const socket = createSocket('udp4');
  socket.bind(port, '127.0.0.1', () => resolve(socket));
});

describe('which ports a track uses', () => {
  test('video on the camera\'s first pair, sound on the second', () => {
    assert.equal(trackPort(40000, 'video'), 40000);
    assert.equal(trackPort(40000, 'audio'), 40002);
  });
});

describe('leasing a pair', () => {
  test('gives the RTP port and the RTCP port after it', async () => {
    const udp = new UdpPorts();
    const lease = await udp.lease('127.0.0.1', 42100);
    assert.deepEqual(lease.ports, [42100, 42101]);
    assert.equal(lease.rtp.address().port, 42100);
    assert.equal(lease.rtcp.address().port, 42101);
    lease.close();
  });

  test('every viewer of the camera shares the same sockets: no new port per viewer', async () => {
    const udp = new UdpPorts();
    const [a, b] = await Promise.all([udp.lease('127.0.0.1', 42110), udp.lease('127.0.0.1', 42110)]);
    assert.equal(a.rtp, b.rtp);
    a.close();
    b.close();
  });

  test('the pair stays open while anyone uses it, and closes with the last one', async () => {
    const udp = new UdpPorts();
    const a = await udp.lease('127.0.0.1', 42120);
    const b = await udp.lease('127.0.0.1', 42120);
    a.close();
    a.close();   // twice: counted once
    assert.equal(udp.pairs.size, 1, 'still in use by b');
    b.close();
    assert.equal(udp.pairs.size, 0);
    const free = await bound(42120);   // the port is free again
    free.close();
  });

  test('each lease hears RTCP until it closes; the others keep hearing it', async () => {
    const udp = new UdpPorts();
    const a = await udp.lease('127.0.0.1', 42130);
    const b = await udp.lease('127.0.0.1', 42130);
    let heardA = 0, heardB = 0;
    a.onRtcp(() => heardA++);
    b.onRtcp(() => heardB++);
    a.close();
    a.rtcp.emit('message', Buffer.alloc(8), { address: '127.0.0.1', port: 5001 });
    assert.deepEqual([heardA, heardB], [0, 1]);
    b.close();
  });
});

describe('a port another program has', () => {
  test('the RTP port: the lease fails, and says which port', async () => {
    const other = await bound(42140);
    await assert.rejects(new UdpPorts().lease('127.0.0.1', 42140), /UDP port 42140 is in use by another program/);
    other.close();
  });

  test('the RTCP port: the lease fails and the RTP port is let go again', async () => {
    const other = await bound(42151);
    const udp = new UdpPorts();
    await assert.rejects(udp.lease('127.0.0.1', 42150), /UDP port 42151 is in use by another program/);
    other.close();
    const lease = await udp.lease('127.0.0.1', 42150);   // tried again: now it works
    assert.deepEqual(lease.ports, [42150, 42151]);
    lease.close();
  });
});

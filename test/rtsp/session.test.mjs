import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProxySession } from '../../src/rtsp/session.mjs';

test('UDP asked for but every port of the range is in use: 461, so the viewer uses TCP instead', async () => {
  const logs = [];
  const sent = [];
  const session = new ProxySession('ABC', {
    now: Date.now,
    log: (m) => logs.push(m),
    connectUpstream: () => { throw new Error('not reached'); },
    openUdp: async () => { throw new Error('all UDP ports 40000–40019 are in use'); },
  });
  session.attach({ write: (b) => sent.push(b.toString()), end() {}, destroy() {}, localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' });
  session.reply = (b) => sent.push(b.toString());
  await session.fromClient({ startLine: 'SETUP rtsp://x/garden/trackID=0 RTSP/1.0', headers: [['CSeq', '3'], ['Transport', 'RTP/AVP;unicast;client_port=5000-5001']], body: Buffer.alloc(0) });
  assert.match(sent.join(''), /^RTSP\/1\.0 461 Unsupported Transport/);
  assert.match(logs.join(' '), /told to use TCP/);
  session.close?.();
});

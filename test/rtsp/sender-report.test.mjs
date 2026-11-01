import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtpTrackStats, ntpTime, sdes, isRtcp } from '../../src/rtsp/sender-report.mjs';

function rtp({ ssrc = 0x11223344, timestamp = 90000, payload = 100 } = {}) {
  const p = Buffer.alloc(12 + payload);
  p[0] = 0x80;
  p[1] = 96;
  p.writeUInt32BE(timestamp, 4);
  p.writeUInt32BE(ssrc, 8);
  return p;
}

test('no report before the first packet', () => {
  assert.equal(new RtpTrackStats(90000).report(0), null);
});

test('a sender report ties the RTP clock to the wall clock, counting what was sent', () => {
  const stats = new RtpTrackStats(90000);
  stats.count(rtp({ timestamp: 90000 }), 1_000_000);
  stats.count(rtp({ timestamp: 93000 }), 1_000_033);
  const report = stats.report(1_000_133);   // 100 ms after the last packet
  assert.equal(report[1], 200);
  assert.equal(report.readUInt32BE(4), 0x11223344);
  assert.deepEqual([report.readUInt32BE(8), report.readUInt32BE(12)], ntpTime(1_000_133));
  assert.equal(report.readUInt32BE(16), 93000 + 9000);
  assert.equal(report.readUInt32BE(20), 2);
  assert.equal(report.readUInt32BE(24), 200);
  assert.equal(report[28 + 1], 202, 'followed by SDES, as RFC 3550 wants');
  assert.ok(isRtcp(report));
});

test('NTP time counts from 1900', () => {
  assert.deepEqual(ntpTime(0), [2208988800, 0]);
  assert.deepEqual(ntpTime(1500), [2208988801, 2 ** 31]);
});

test('the SDES CNAME item fills whole 32-bit words', () => {
  const packet = sdes(1, 'abc');
  assert.equal(packet.length % 4, 0);
  assert.equal(packet.readUInt16BE(2), packet.length / 4 - 1);
  assert.equal(packet.subarray(10, 13).toString(), 'abc');
});

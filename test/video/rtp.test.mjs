import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nalUnits, parameterSets, nalPayloads, framePayloads, aacPayload, aacConfig, rtpPacket, publishSdp, rtpTime } from '../../src/video/rtp.mjs';
import { adtsFrame } from '../helpers/aac.mjs';

const START = [0, 0, 0, 1];
const sps = Buffer.from([0x67, 0x42, 0x00, 0x1f]), pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
const idr = (size) => Buffer.concat([Buffer.from([0x65]), Buffer.alloc(size - 1, 0xab)]);
const frame = (...nals) => Buffer.concat([Buffer.from([...START, 0x09, 0xf0]), ...nals.flatMap((n) => [Buffer.from(START), n])]);

describe('video frames as RTP', () => {
  test('a frame\'s NAL units, without start codes and without the delimiter', () => {
    const units = nalUnits(frame(sps, pps, idr(20)));
    assert.deepEqual(units.map((u) => u[0] & 0x1f), [7, 8, 5]);
    assert.deepEqual(units[0], sps);
  });

  test('also with 3-byte start codes, and H.265 delimiters left out', () => {
    const hevc = Buffer.from([0, 0, 1, 0x46, 0x01, 0x50, 0, 0, 1, 0x26, 0x01, 0xaa]);
    assert.deepEqual(nalUnits(hevc, 'hevc').map((u) => (u[0] >> 1) & 0x3f), [19]);
  });

  test('the parameter sets for the SDP, base64', () => {
    assert.deepEqual(parameterSets(frame(sps, pps, idr(20))), { sps: sps.toString('base64'), pps: pps.toString('base64') });
    const vps = Buffer.from([0x40, 0x01, 0x0c]), hsps = Buffer.from([0x42, 0x01, 0x01]), hpps = Buffer.from([0x44, 0x01, 0xc1]);
    assert.deepEqual(Object.keys(parameterSets(frame(vps, hsps, hpps), 'hevc')), ['vps', 'sps', 'pps']);
  });

  test('a small NAL unit goes whole; a big one in FU-A fragments that rebuild it exactly', () => {
    assert.deepEqual(nalPayloads(sps), [sps]);
    const big = idr(3000);
    const parts = nalPayloads(big, 'h264', 1400);
    assert.ok(parts.length > 2 && parts.every((p) => p.length <= 1400));
    assert.ok(parts.every((p) => (p[0] & 0x1f) === 28 && (p[1] & 0x1f) === 5));
    assert.equal(parts[0][1] & 0x80, 0x80, 'start bit');
    assert.equal(parts.at(-1)[1] & 0x40, 0x40, 'end bit');
    const rebuilt = Buffer.concat([Buffer.from([(parts[0][0] & 0xe0) | (parts[0][1] & 0x1f)]), ...parts.map((p) => p.subarray(2))]);
    assert.deepEqual(rebuilt, big);
  });

  test('H.265 fragments (FU, type 49) rebuild the NAL unit exactly', () => {
    const big = Buffer.concat([Buffer.from([0x26, 0x01]), Buffer.alloc(4000, 0xcd)]);
    const parts = nalPayloads(big, 'hevc', 1400);
    assert.ok(parts.every((p) => ((p[0] >> 1) & 0x3f) === 49 && (p[2] & 0x3f) === 19));
    const rebuilt = Buffer.concat([Buffer.from([(parts[0][0] & 0x81) | (19 << 1), parts[0][1]]), ...parts.map((p) => p.subarray(3))]);
    assert.deepEqual(rebuilt, big);
  });

  test('all of a frame\'s payloads, in order', () => {
    assert.equal(framePayloads(frame(sps, pps, idr(3000)), 'h264', 1400).length, 2 + 3);
  });
});

describe('sound as RTP (AAC, mpeg4-generic)', () => {
  test('one AU header with the size, then the frame without its ADTS header', () => {
    const adts = adtsFrame(Buffer.alloc(100, 0x21));
    const payload = aacPayload(adts);
    assert.deepEqual([...payload.subarray(0, 2)], [0, 16], '16 bits of AU headers');
    assert.equal(((payload[2] << 8) | payload[3]) >> 3, 100, 'the AU size');
    assert.deepEqual(payload.subarray(4), Buffer.alloc(100, 0x21));
  });

  test('the configuration of AAC-LC 16 kHz mono is 1408', () => {
    assert.equal(aacConfig(), '1408');
  });
});

describe('the RTP packet and the SDP', () => {
  test('RTP header: version 2, marker, type, sequence, timestamp, SSRC', () => {
    const p = rtpPacket({ pt: 96, seq: 65536 + 7, ts: 123, ssrc: 0xdeadbeef, marker: true, payload: Buffer.from([1]) });
    assert.equal(p[0], 0x80);
    assert.equal(p[1], 0x80 | 96);
    assert.equal(p.readUInt16BE(2), 7);
    assert.equal(p.readUInt32BE(4), 123);
    assert.equal(p.readUInt32BE(8), 0xdeadbeef);
  });

  test('timestamps are the wall clock in the track\'s rate, so both tracks share one timeline', () => {
    const ms = 1_762_000_000_123;
    assert.equal(rtpTime(ms, 90000), Math.round(ms * 90) % 4294967296);
    assert.equal(rtpTime(ms, 16000), Math.round(ms * 16) % 4294967296);
  });

  test('the SDP announces H.264 with its parameter sets, and AAC when there is sound', () => {
    const sdp = publishSdp({ codec: 'h264', params: { sps: 'Z0IA', pps: 'aM48' }, audio: true });
    assert.match(sdp, /m=video 0 RTP\/AVP 96\r\na=rtpmap:96 H264\/90000\r\na=fmtp:96 packetization-mode=1;sprop-parameter-sets=Z0IA,aM48\r\na=control:trackID=0/);
    assert.match(sdp, /m=audio 0 RTP\/AVP 97\r\na=rtpmap:97 MPEG4-GENERIC\/16000\/1\r\n.*mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=1408\r\na=control:trackID=1/);
    assert.doesNotMatch(publishSdp({ codec: 'h264' }), /m=audio/);
  });

  test('H.265 with its VPS, SPS and PPS', () => {
    assert.match(publishSdp({ codec: 'hevc', params: { vps: 'QAE', sps: 'QgE', pps: 'RAE' } }), /a=rtpmap:96 H265\/90000\r\na=fmtp:96 sprop-vps=QAE;sprop-sps=QgE;sprop-pps=RAE/);
  });
});

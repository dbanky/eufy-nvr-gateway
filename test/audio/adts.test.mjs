import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { adtsHeader, AdtsSplitter, STREAM_FORMAT, fitsStream } from '../../src/audio/adts.mjs';
import { adtsFrame } from '../helpers/aac.mjs';

describe('an ADTS header', () => {
  test('says the profile, sample rate, channels and frame length', () => {
    assert.deepEqual(adtsHeader(adtsFrame()), { profile: 'aac-lc', sampleRate: 16000, channels: 1, length: 17 });
    assert.deepEqual(adtsHeader(adtsFrame(Buffer.alloc(100), { rateIndex: 3, channels: 2 })), { profile: 'aac-lc', sampleRate: 48000, channels: 2, length: 107 });
  });

  test('is null for anything else', () => {
    assert.equal(adtsHeader(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06])), null);
    assert.equal(adtsHeader(Buffer.from([0xff, 0xf1])), null, 'too short');
  });

  test('only AAC-LC 16 kHz mono fits the stream (what eufy cameras send)', () => {
    assert.deepEqual(STREAM_FORMAT, { profile: 'aac-lc', sampleRate: 16000, channels: 1 });
    assert.equal(fitsStream(adtsFrame()), true);
    assert.equal(fitsStream(adtsFrame(undefined, { rateIndex: 4 })), false, '44.1 kHz');
    assert.equal(fitsStream(adtsFrame(undefined, { channels: 2 })), false);
    assert.equal(fitsStream(adtsFrame(undefined, { profile: 0 })), false, 'AAC Main');
  });
});

describe('splitting a byte stream into ADTS frames', () => {
  test('frames that arrive in pieces and in bunches come out whole', () => {
    const a = adtsFrame(Buffer.alloc(10, 1)), b = adtsFrame(Buffer.alloc(20, 2)), c = adtsFrame(Buffer.alloc(5, 3));
    const all = Buffer.concat([a, b, c]);
    const out = [];
    const split = new AdtsSplitter((f) => out.push(f));
    split.push(all.subarray(0, 4));
    split.push(all.subarray(4, 30));
    split.push(all.subarray(30));
    assert.deepEqual(out, [a, b, c]);
  });

  test('skips garbage until the next frame starts', () => {
    const a = adtsFrame();
    const out = [];
    const split = new AdtsSplitter((f) => out.push(f));
    split.push(Buffer.concat([Buffer.from([1, 2, 3]), a]));
    assert.deepEqual(out, [a]);
  });
});

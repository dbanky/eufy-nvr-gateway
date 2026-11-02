import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RawFrameAssembler, liveDecoderArgs } from '../../src/video/live-decoder.mjs';

describe('decoded live frames', () => {
  test('are only handed out whole', () => {
    const assembler = new RawFrameAssembler(4);
    assert.equal(assembler.push(Buffer.from([1, 2, 3])), null);
    assert.deepEqual([...assembler.push(Buffer.from([4, 5]))], [1, 2, 3, 4]);
  });

  test('when several arrive at once, only the newest counts: the stream shows "now"', () => {
    const assembler = new RawFrameAssembler(2);
    assert.deepEqual([...assembler.push(Buffer.from([1, 1, 2, 2, 3]))], [2, 2]);
    assert.deepEqual([...assembler.push(Buffer.from([3]))], [3, 3]);
  });
});

test('reads the stream from its first keyframe: small probe, no nobuffer (it lost that keyframe)', () => {
  const args = liveDecoderArgs({ cam: { width: 640, height: 360 }, url: 'http://bridge/stream/T81XXXXXXXXXXXXX' });
  assert.ok(!args.includes('nobuffer'));
  assert.ok(args.indexOf('-probesize') < args.indexOf('-i') && args.indexOf('-flags') < args.indexOf('-i'));
});

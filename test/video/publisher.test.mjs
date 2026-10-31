import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { framesDue, publisherArgs } from '../../src/video/publisher.mjs';

describe('the publisher sends at exactly the frame rate', () => {
  test('the first frame at once, then one every 1/fps second', () => {
    assert.equal(framesDue(0, 15), 1);
    assert.equal(framesDue(66, 15), 1);
    assert.equal(framesDue(67, 15), 2);
    assert.equal(framesDue(60000, 15), 901);
  });
});

describe('the publisher command', () => {
  test('copies whatever it is fed, H.264 or H.265, without encoding', () => {
    for (const codec of ['h264', 'hevc']) {
      const args = publisherArgs({ fps: 15, codec, output: 'rtsp://127.0.0.1:8554/garden' });
      assert.equal(args[args.indexOf('-i') - 3], codec);
      assert.equal(args[args.indexOf('-c') + 1], 'copy');
    }
  });
});

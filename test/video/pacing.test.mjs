import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { framesDue, publisherArgs } from '../../src/video/publisher.mjs';
import { shouldWrite, HEARTBEAT_MS } from '../../src/video/live-encoder.mjs';
import { RawFrameAssembler } from '../../src/video/live-decoder.mjs';
import { encoderArgs } from '../../src/video/encoder-settings.mjs';

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

describe('feeding the live encoder', () => {
  const frame = Buffer.alloc(1), other = Buffer.alloc(1);

  test('a new picture is written at once', () => {
    assert.equal(shouldWrite({ frame: other, lastWritten: frame, lastWriteAt: 1000, now: 1001 }), true);
  });

  test('the same picture only once per heartbeat (raw 3K frames are 7 MB)', () => {
    assert.equal(shouldWrite({ frame, lastWritten: frame, lastWriteAt: 1000, now: 1000 + HEARTBEAT_MS - 1 }), false);
    assert.equal(shouldWrite({ frame, lastWritten: frame, lastWriteAt: 1000, now: 1000 + HEARTBEAT_MS }), true);
  });
});

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

describe('encoder settings (H.264: live video and sleeping loops)', () => {
  const args = encoderArgs({ fps: 15, bitrateKbps: 6000 });
  const value = (flag) => args[args.indexOf(flag) + 1];

  test('a keyframe every 4 s: where an NVR can join and where the stream can switch', () => {
    assert.equal(value('-g'), '60');
    assert.equal(value('-keyint_min'), '60');
  });

  test('frame delimiters are on, so the output can be split into frames', () => {
    assert.match(value('-x264-params'), /aud=1/);
  });

  test('a cheaper motion search (diamond, subpixel level 1): ~30 % less encoder CPU', () => {
    assert.match(value('-x264-params'), /me=dia/);
    assert.match(value('-x264-params'), /subme=1/);
  });

  test('the bitrate limit follows the camera setting', () => {
    assert.equal(value('-maxrate'), '6000k');
  });
});

describe('encoder settings (H.265: sleeping loops of a camera passed through as H.265)', () => {
  const args = encoderArgs({ fps: 15, bitrateKbps: 6000 }, 'hevc');
  const params = args[args.indexOf('-x265-params') + 1];

  test('x265, fast enough for a still picture', () => {
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx265');
    assert.equal(args[args.indexOf('-preset') + 1], 'ultrafast');
  });

  test('the same structure as a camera stream: keyframe every 4 s, closed GOPs, no B-frames', () => {
    assert.match(params, /keyint=60:min-keyint=60/);
    assert.match(params, /open-gop=0/);
    assert.match(params, /bframes=0/);
  });

  test('frame delimiters and parameter sets on every keyframe, so it can be spliced', () => {
    assert.match(params, /aud=1/);
    assert.match(params, /repeat-headers=1/);
  });

  test('raw H.265 output', () => {
    assert.equal(args.at(-1), 'hevc');
  });
});

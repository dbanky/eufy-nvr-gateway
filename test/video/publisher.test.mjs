import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { framesDue, audioFramesDue, publisherArgs } from '../../src/video/publisher.mjs';

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
      assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
    }
  });
});

describe('audio in the stream', () => {
  test('a second input of AAC frames; the video stays a copy, the sound is AAC-LC 16 kHz mono', () => {
    const args = publisherArgs({ fps: 15, codec: 'hevc', output: 'rtsp://127.0.0.1:8554/garden', audio: true }).join(' ');
    assert.match(args, /-f aac -i pipe:3 -map 0:v -map 1:a/);
    assert.match(args, /-c:v copy/);
    assert.match(args, /-c:a aac -b:a 32k -ar 16000 -ac 1/);
    assert.doesNotMatch(publisherArgs({ fps: 15, codec: 'h264', output: 'rtsp://x/y' }).join(' '), /pipe:3|aac|wallclock/, 'none without audio');
  });

  test('both inputs carry arrival-time stamps, or ffmpeg holds the audio back for good', () => {
    const args = publisherArgs({ fps: 15, codec: 'h264', output: 'rtsp://x/y', audio: true }).join(' ');
    assert.match(args, /^-use_wallclock_as_timestamps 1 -f h264 .* -i pipe:0 -use_wallclock_as_timestamps 1 .*-i pipe:3/);
    assert.match(args, /-probesize 32 -analyzeduration 0 -f aac/, 'no probing: it would stall the pipes');
  });

  test('audio is numbered by sample and video by frame: one timeline, whatever the arrival times', () => {
    const args = publisherArgs({ fps: 15, codec: 'h264', output: 'rtsp://x/y', audio: true }).join(' ');
    assert.match(args, /-af asetpts=N\/SR\/TB/);
    assert.match(args, /-bsf:v setts=ts=N\/\(15\*TB\)/);
  });

  test('is paced by the video frames written, so picture and sound share one timeline', () => {
    // 16 kHz, 1024 samples a frame: 15.625 audio frames per second of video
    assert.equal(audioFramesDue(0, 15), 1);
    assert.equal(audioFramesDue(15, 15), 16);          // 1 s of video: 15.6 → 15 due after the first
    assert.equal(audioFramesDue(15 * 64, 15), 1001);   // 64 s: exactly 1000 frames + the first
    assert.equal(audioFramesDue(25 * 64, 25), 1001, 'the same at another frame rate');
  });
});


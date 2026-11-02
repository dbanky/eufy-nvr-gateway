import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { passthroughArgs, JpegSplitter } from '../../src/video/passthrough.mjs';
import { codecFromLog } from '../../src/video/live-decoder.mjs';

const cam = { name: 'garden', width: 2880, height: 1616 };
const args = passthroughArgs({ cam, url: 'http://bridge/stream/T81XXXXXXXXXXXXX', codec: 'hevc' });
const outputs = () => args.join(' ').split(' -map ').slice(1);

describe("passing a camera's own video through", () => {
  test("copies the camera's stream: no decoding, no encoding", () => {
    assert.match(outputs()[0], /-c:v copy .* -f hevc pipe:1/);
  });

  test('exactly one delimiter per frame, in front, and parameter sets on every keyframe', () => {
    // The camera's own delimiters go first (the bridge's MPEG-TS often has them: a second one would
    // split every frame in two). Then parameter sets in front of every keyframe, then one delimiter
    // in front of every frame: so a frame always carries its parameter sets and the stream can be
    // switched at any keyframe.
    assert.match(outputs()[0], /-bsf:v hevc_metadata=aud=remove,dump_extra=freq=keyframe,hevc_metadata=aud=insert/);
  });

  test('H.264 cameras use the H.264 filters and format', () => {
    const h264 = passthroughArgs({ cam, url: 'u', codec: 'h264' }).join(' ');
    assert.match(h264, /h264_metadata=aud=insert -f h264 pipe:1/);
  });

  test('reads the stream from its first keyframe: small probe, no nobuffer (it lost that keyframe)', () => {
    assert.ok(!args.includes('nobuffer'));
    assert.ok(args.indexOf('-probesize') < args.indexOf('-i') && args.indexOf('-analyzeduration') < args.indexOf('-i'));
  });

  test('also decodes keyframes only, to JPEGs: snapshots and the next sleeping picture', () => {
    assert.ok(args.indexOf('-skip_frame') < args.indexOf('-i'), 'a decoder option, before the input');
    assert.equal(args[args.indexOf('-skip_frame') + 1], 'nokey');
    assert.match(outputs()[1], /-c:v mjpeg .* -f image2pipe pipe:3/);
  });

  test('one JPEG per keyframe, not repeated to a constant frame rate (that would encode 15 per second)', () => {
    assert.match(outputs()[1], /-fps_mode passthrough/);
  });
});

describe('thumbnails of the keyframes, to see motion in the picture', () => {
  test('a third output: 32×24 grey, one per keyframe, raw', () => {
    assert.match(outputs()[2], /scale=32:24:flags=area,format=gray -fps_mode passthrough -f rawvideo pipe:4/);
  });
});

describe('JPEG pictures from the side output', () => {
  const jpeg = (tag) => Buffer.from([0xff, 0xd8, tag, tag, 0xff, 0xd9]);

  test('are handed out whole, even across chunks', () => {
    const pictures = [];
    const splitter = new JpegSplitter((p) => pictures.push(p));
    const stream = Buffer.concat([jpeg(1), jpeg(2)]);
    splitter.push(stream.subarray(0, 3));
    splitter.push(stream.subarray(3, 9));
    splitter.push(stream.subarray(9));
    assert.deepEqual(pictures, [jpeg(1), jpeg(2)]);
  });
});

describe('learning which codec a camera sends', () => {
  test("from ffmpeg's description of the input stream", () => {
    assert.equal(codecFromLog('  Stream #0:0[0x100]: Video: hevc (Main) ([36][0][0][0] / 0x0024), yuv420p(tv), 2880x1616, 15 fps'), 'hevc');
    assert.equal(codecFromLog('  Stream #0:0[0x100]: Video: h264 (Main) ([27][0][0][0] / 0x001B), yuv420p, 2048x1536'), 'h264');
  });

  test('other lines and other codecs say nothing', () => {
    assert.equal(codecFromLog('Input #0, mpegts, from http://bridge/stream/x:'), null);
    assert.equal(codecFromLog('  Stream #0:1: Audio: aac (LC), 16000 Hz, mono'), null);
    assert.equal(codecFromLog('  Stream #0:0: Video: mjpeg, yuvj420p'), null);
  });
});

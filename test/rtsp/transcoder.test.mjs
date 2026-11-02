// The JPEG and G.711 versions of a stream. The real-ffmpeg tests run only where ffmpeg is installed
// (e.g. inside the image: CI has no ffmpeg and skips them).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { Transcoder, transcoderArgs } from '../../src/rtsp/transcoder.mjs';
import { runFfmpeg } from '../../src/video/ffmpeg.mjs';
import { FrameSplitter } from '../../src/video/annexb.mjs';
import { AdtsSplitter } from '../../src/audio/adts.mjs';

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = haveFfmpeg ? false : 'ffmpeg is not installed here';

describe('ffmpeg arguments', () => {
  test('JPEG: RFC 2435 needs the standard Huffman tables and both quantisation tables; the camera\'s shape', () => {
    const args = transcoderArgs('mjpeg', { codec: 'hevc', width: 640, height: 360 }).join(' ');
    assert.match(args, /-f hevc -i pipe:0 -an -vf scale=640:360 -c:v mjpeg -huffman default -force_duplicated_matrix 1/);
    assert.match(args, /-payload_type 26 -f rtp$/);
    assert.doesNotMatch(args, /nobuffer/);
  });

  test('G.711: µ-law, 8 kHz mono, from the AAC', () => {
    const args = transcoderArgs('pcmu').join(' ');
    assert.match(args, /-f aac -i pipe:0 -vn -ac 1 -ar 8000 -c:a pcm_mulaw -payload_type 0 -f rtp$/);
  });
});

// What the publisher hands over, as it would: video frames from a keyframe on, or ADTS frames.
async function publication(kind) {
  const p = Object.assign(new EventEmitter(), { name: 'garden', codec: 'h264' });
  const frames = [];
  if (kind === 'mjpeg') {
    const splitter = new FrameSplitter((f) => frames.push(f), 'h264');
    splitter.push(await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15', '-frames:v', '30',
      '-c:v', 'libx264', '-bf', '0', '-x264-params', 'aud=1', '-f', 'h264', 'pipe:1']));
    splitter.flush();
  } else {
    new AdtsSplitter((f) => frames.push(f)).push(await runFfmpeg(['-f', 'lavfi', '-i', 'sine=f=440:r=16000', '-t', '2', '-ac', '1', '-c:a', 'aac', '-f', 'adts', 'pipe:1']));
  }
  return { p, frames };
}

for (const [kind, pt] of [['mjpeg', 26], ['pcmu', 0]]) {
  test(`${kind}: ffmpeg's RTP comes back as packets (PT ${pt}), and stops with the transcoder`, { skip, timeout: 60000 }, async () => {
    const { p, frames } = await publication(kind);
    const t = new Transcoder({ kind, publication: p, size: { width: 640, height: 360 } });
    const got = [];
    t.on('packet', (packet, starts) => got.push({ pt: packet[1] & 0x7f, starts, marker: !!(packet[1] & 0x80) }));
    await t.start();
    await new Promise((r) => setTimeout(r, 300));   // ffmpeg starting up
    for (const f of frames) p.emit('media', kind === 'mjpeg' ? 'video' : 'audio', f);
    for (let i = 0; i < 100 && got.length < 10; i++) await new Promise((r) => setTimeout(r, 50));
    t.stop();
    assert.ok(got.length >= 10, `packets: ${got.length}`);
    assert.ok(got.every((g) => g.pt === pt));
    assert.equal(got[0].starts, true);
    if (kind === 'mjpeg') {
      const i = got.findIndex((g) => g.marker);
      assert.ok(i >= 0 && (got[i + 1] === undefined || got[i + 1].starts), 'a picture starts after each marker');
    }
    assert.equal(p.listenerCount('media'), 0);
  });
}

// The JPEG and G.711 versions of a stream. A stand-in ffmpeg shows what goes in and when; the
// real-ffmpeg tests at the end run only where ffmpeg is installed (e.g. inside the image: CI has no
// ffmpeg and skips them).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { Transcoder, transcoderArgs, MAX_STDIN_BACKLOG, RESTART_MS } from '../../src/rtsp/transcoder.mjs';
import { keyframe, deltaFrame, tagOf } from '../helpers/h264.mjs';
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

// A stand-in ffmpeg: records what it is given on stdin; the test says how far behind it is.
function fakeFfmpeg() {
  const runs = [];
  const spawnImpl = (cmd, args) => {
    const child = Object.assign(new EventEmitter(), { args, killed: null, stderr: new EventEmitter() });
    child.stdin = Object.assign(new EventEmitter(), { written: [], writableLength: 0, destroyed: false });
    child.stdin.write = (frame) => child.stdin.written.push(frame);
    child.kill = (signal) => { child.killed = signal; };
    runs.push(child);
    return child;
  };
  return { spawnImpl, runs };
}

async function started(kind) {
  const publication = Object.assign(new EventEmitter(), { name: 'garden', codec: 'h264' });
  const logs = [];
  const { spawnImpl, runs } = fakeFfmpeg();
  const transcoder = new Transcoder({ kind, publication, size: { width: 640, height: 360 }, spawnImpl, log: (...m) => logs.push(m.join(' ')) });
  await transcoder.start();
  const ffmpeg = () => runs.at(-1);
  const fed = () => ffmpeg().stdin.written.map(tagOf);
  return { transcoder, publication, runs, ffmpeg, fed, logs };
}

describe('what goes into ffmpeg', () => {
  test('the JPEG version is fed the video, from a keyframe on', async () => {
    const { transcoder, publication, fed } = await started('mjpeg');
    publication.emit('media', 'video', deltaFrame(1));
    publication.emit('media', 'audio', Buffer.from([2]));
    publication.emit('media', 'video', keyframe(3));
    publication.emit('media', 'video', deltaFrame(4));
    assert.deepEqual(fed(), [3, 4]);
    transcoder.stop();
  });

  test('the G.711 version is fed the sound only, every frame at once', async () => {
    const { transcoder, publication, ffmpeg } = await started('pcmu');
    publication.emit('media', 'video', keyframe(1));
    publication.emit('media', 'audio', Buffer.from([2]));
    publication.emit('media', 'audio', Buffer.from([3]));
    assert.deepEqual(ffmpeg().stdin.written.map((f) => f[0]), [2, 3]);
    transcoder.stop();
  });

  test('ffmpeg far behind: the video skips to the next keyframe, so all it gets can be decoded', async () => {
    const { transcoder, publication, ffmpeg, fed } = await started('mjpeg');
    publication.emit('media', 'video', keyframe(1));
    ffmpeg().stdin.writableLength = MAX_STDIN_BACKLOG + 1;
    publication.emit('media', 'video', deltaFrame(2));   // skipped: too far behind
    ffmpeg().stdin.writableLength = 0;
    publication.emit('media', 'video', deltaFrame(3));   // skipped: not a keyframe
    publication.emit('media', 'video', keyframe(4));
    assert.deepEqual(fed(), [1, 4]);
    transcoder.stop();
  });

  test('ffmpeg far behind: sound frames are skipped until it catches up', async () => {
    const { transcoder, publication, ffmpeg } = await started('pcmu');
    ffmpeg().stdin.writableLength = MAX_STDIN_BACKLOG + 1;
    publication.emit('media', 'audio', Buffer.from([1]));
    ffmpeg().stdin.writableLength = 0;
    publication.emit('media', 'audio', Buffer.from([2]));
    assert.deepEqual(ffmpeg().stdin.written.map((f) => f[0]), [2]);
    transcoder.stop();
  });

  test('ffmpeg sends its RTP to a local port only this process reads', async () => {
    const { transcoder, ffmpeg } = await started('mjpeg');
    assert.match(ffmpeg().args.at(-1), /^rtp:\/\/127\.0\.0\.1:\d+\?pkt_size=1400&rtcpport=\d+$/);
    transcoder.stop();
  });
});

describe('what comes out', () => {
  // Sends an RTP packet to the transcoder's port, as ffmpeg would.
  async function fromFfmpeg(ffmpeg, marker) {
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(ffmpeg.args.at(-1))[1]);
    const packet = Buffer.alloc(16);
    packet[0] = 0x80;
    packet[1] = (marker ? 0x80 : 0) | 26;
    const socket = createSocket('udp4');
    await new Promise((r) => socket.send(packet, port, '127.0.0.1', r));
    socket.close();
  }
  const until = async (check) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); };

  test('a JPEG picture starts with the packet after a marker', async () => {
    const { transcoder, ffmpeg } = await started('mjpeg');
    const starts = [];
    transcoder.on('packet', (packet, s) => starts.push(s));
    for (const marker of [false, true, false, false, true]) {
      await fromFfmpeg(ffmpeg(), marker);
      await until(() => starts.length);
    }
    await until(() => starts.length === 5);
    assert.deepEqual(starts, [true, false, true, false, false]);
    transcoder.stop();
  });

  test('every sound packet stands alone', async () => {
    const { transcoder, ffmpeg } = await started('pcmu');
    const starts = [];
    transcoder.on('packet', (packet, s) => starts.push(s));
    for (const marker of [false, false]) {
      await fromFfmpeg(ffmpeg(), marker);
      await until(() => starts.length);
    }
    await until(() => starts.length === 2);
    assert.deepEqual(starts, [true, true]);
    transcoder.stop();
  });
});

describe('ffmpeg\'s life', () => {
  test('if ffmpeg exits, it is started again, and the video waits for a keyframe again', async () => {
    const { transcoder, publication, runs, fed, logs } = await started('mjpeg');
    publication.emit('media', 'video', keyframe(1));
    runs[0].stderr.emit('data', 'Invalid data found when processing input\n');
    runs[0].emit('close');
    assert.match(logs.join(), /garden mjpeg: Invalid data found/);
    await new Promise((r) => setTimeout(r, RESTART_MS + 100));
    assert.equal(runs.length, 2);
    publication.emit('media', 'video', deltaFrame(2));
    publication.emit('media', 'video', keyframe(3));
    assert.deepEqual(fed(), [3]);
    transcoder.stop();
  });

  test('stop() kills ffmpeg, stops listening to the stream, and nothing starts again', async () => {
    const { transcoder, publication, runs } = await started('mjpeg');
    transcoder.stop();
    assert.equal(runs[0].killed, 'SIGKILL');
    assert.equal(publication.listenerCount('media'), 0);
    runs[0].emit('close');
    await new Promise((r) => setTimeout(r, RESTART_MS + 100));
    assert.equal(runs.length, 1);
  });

  test('stopped before it got going: no ffmpeg at all', async () => {
    const publication = Object.assign(new EventEmitter(), { name: 'garden', codec: 'h264' });
    const { spawnImpl, runs } = fakeFfmpeg();
    const transcoder = new Transcoder({ kind: 'mjpeg', publication, spawnImpl });
    const starting = transcoder.start();
    transcoder.stop();
    await starting;
    assert.equal(runs.length, 0);
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

describe('with the real ffmpeg', () => {
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
});

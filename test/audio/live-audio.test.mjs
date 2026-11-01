import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { openLiveAudio } from '../../src/audio/live-audio.mjs';
import { AudioFeed } from '../../src/audio/audio-feed.mjs';
import { adtsFrame } from '../helpers/aac.mjs';

const SILENCE = adtsFrame(Buffer.alloc(4, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  for (let t = 0; t < 400 && !check(); t++) await wait(5);
  assert.ok(check(), 'timed out');
}
// A fetch whose body yields the given chunks, then stays open until aborted.
const streaming = (chunks) => async (url, { signal }) => ({
  ok: true,
  status: 200,
  body: (async function* () {
    for (const c of chunks) yield c;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  })(),
});
const heard = (feed) => {
  const frames = [];
  feed.on('frame', (f) => frames.push(f));
  return frames;
};

describe('a camera\'s live audio', () => {
  test('its frames reach the stream as they arrive, also split across chunks; stopping ends it', async () => {
    const audioFeed = new AudioFeed({ silence: SILENCE });
    const frames = heard(audioFeed);
    const a = adtsFrame(Buffer.alloc(8, 1)), b = adtsFrame(Buffer.alloc(8, 2));
    const both = Buffer.concat([a, b]);
    const audio = openLiveAudio({ name: 'garden', url: 'http://bridge/audio/T81', audioFeed, log: () => {},
      fetchImpl: streaming([both.subarray(0, 10), both.subarray(10)]) });
    await until(() => frames.length === 2);
    assert.deepEqual(frames, [a, b]);
    audio.stop();
    assert.equal(audioFeed.live, false);
  });

  test('asks again, quickly and quietly, while the camera is still connecting (409)', async () => {
    const audioFeed = new AudioFeed({ silence: SILENCE });
    const frames = heard(audioFeed);
    let calls = 0;
    const logs = [];
    const frame = adtsFrame(Buffer.alloc(8, 3));
    const fetchImpl = async (url, opts) => (++calls < 3 ? { ok: false, status: 409 } : streaming([frame])(url, opts));
    const audio = openLiveAudio({ name: 'garden', url: 'x', audioFeed, log: (...m) => logs.push(m.join(' ')), retryMs: 5, fetchImpl });
    await until(() => frames.length === 1);
    assert.equal(calls, 3);
    assert.deepEqual(logs, [], 'expected while waking: not worth a log line');
    audio.stop();
  });

  test('another failure is named once, and it keeps asking', async () => {
    const audioFeed = new AudioFeed({ silence: SILENCE });
    const frames = heard(audioFeed);
    let calls = 0;
    const logs = [];
    const frame = adtsFrame(Buffer.alloc(8, 4));
    const fetchImpl = async (url, opts) => (++calls < 4 ? { ok: false, status: 502 } : streaming([frame])(url, opts));
    const audio = openLiveAudio({ name: 'garden', url: 'x', audioFeed, log: (...m) => logs.push(m.join(' ')), retryMs: 5, fetchImpl });
    await until(() => frames.length === 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /audio: not available yet \(HTTP 502\)/);
    audio.stop();
  });

  test('audio in a format the stream can\'t carry is named once, and none of it is passed on', async () => {
    const audioFeed = new AudioFeed({ silence: SILENCE });
    const frames = heard(audioFeed);
    const logs = [];
    const wrong = adtsFrame(Buffer.alloc(8), { rateIndex: 3 });
    const audio = openLiveAudio({ name: 'garden', url: 'x', audioFeed, log: (...m) => logs.push(m.join(' ')),
      fetchImpl: streaming([wrong, wrong]) });
    await until(() => logs.length === 1);
    await wait(20);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /aac-lc 48000 Hz, 1 channel\(s\); the stream carries AAC-LC 16 kHz mono only/);
    assert.deepEqual(frames, []);
    audio.stop();
  });
});

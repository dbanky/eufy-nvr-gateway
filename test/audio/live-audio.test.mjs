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
  body: (async function* () {
    for (const c of chunks) yield c;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  })(),
});

describe('a camera\'s live audio', () => {
  test('its frames reach the stream; stopping returns to silence', async () => {
    const audioFeed = new AudioFeed({ silence: SILENCE, prebuffer: 1 });
    const a = adtsFrame(Buffer.alloc(8, 1)), b = adtsFrame(Buffer.alloc(8, 2));
    const both = Buffer.concat([a, b]);
    const audio = openLiveAudio({ name: 'garden', url: 'http://bridge/audio/T81', audioFeed, log: () => {},
      fetchImpl: streaming([both.subarray(0, 10), both.subarray(10)]) });
    await until(() => audioFeed.queue.length === 2);
    assert.deepEqual(audioFeed.next(), a);
    audio.stop();
    assert.equal(audioFeed.next(), SILENCE);
  });

  test('asks again while the bridge has no audio yet (the video isn\'t streaming yet)', async () => {
    const audioFeed = new AudioFeed({ silence: SILENCE, prebuffer: 1 });
    let calls = 0;
    const logs = [];
    const frame = adtsFrame(Buffer.alloc(8, 3));
    const fetchImpl = async (url, opts) => (++calls < 3 ? { ok: false, status: 409 } : streaming([frame])(url, opts));
    const audio = openLiveAudio({ name: 'garden', url: 'x', audioFeed, log: (...m) => logs.push(m.join(' ')), retryMs: 5, fetchImpl });
    await until(() => audioFeed.queue.length === 1);
    assert.equal(calls, 3);
    assert.equal(logs.length, 1, 'said once');
    assert.match(logs[0], /audio: not available yet \(HTTP 409\)/);
    audio.stop();
  });

  test('audio in a format the stream can\'t carry is named once, and the stream stays silent', async () => {
    const audioFeed = new AudioFeed({ silence: SILENCE, prebuffer: 1 });
    const logs = [];
    const wrong = adtsFrame(Buffer.alloc(8), { rateIndex: 3 });
    const audio = openLiveAudio({ name: 'garden', url: 'x', audioFeed, log: (...m) => logs.push(m.join(' ')),
      fetchImpl: streaming([wrong, wrong]) });
    await until(() => logs.length === 1);
    await wait(20);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /aac-lc 48000 Hz, 1 channel\(s\); the stream carries AAC-LC 16 kHz mono only/);
    assert.equal(audioFeed.next(), SILENCE);
    audio.stop();
  });
});

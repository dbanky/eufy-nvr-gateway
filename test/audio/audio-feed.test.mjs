import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AudioFeed } from '../../src/audio/audio-feed.mjs';
import { adtsFrame } from '../helpers/aac.mjs';

const SILENCE = adtsFrame(Buffer.alloc(4, 0));
const sound = (n) => adtsFrame(Buffer.alloc(8, n));
const listen = (feed) => {
  const heard = [];
  feed.on('frame', (f) => heard.push(f));
  return heard;
};

describe('the camera sound a stream carries', () => {
  test('each frame is handed on the moment it arrives: nothing is buffered or held back', () => {
    const feed = new AudioFeed({ silence: SILENCE });
    const heard = listen(feed);
    feed.startLive();
    assert.equal(feed.pushLive(sound(1)), true);
    assert.deepEqual(heard, [sound(1)], 'at once, not after a buffer fills');
    feed.pushLive(sound(2));
    feed.pushLive(sound(3));
    assert.deepEqual(heard, [sound(1), sound(2), sound(3)]);
  });

  test('a burst is never cut short', () => {
    const feed = new AudioFeed({ silence: SILENCE });
    const heard = listen(feed);
    feed.startLive();
    for (let i = 1; i <= 100; i++) feed.pushLive(sound(i));
    assert.equal(heard.length, 100);
  });

  test('nothing is taken without a session', () => {
    const feed = new AudioFeed({ silence: SILENCE });
    const heard = listen(feed);
    assert.equal(feed.pushLive(sound(1)), false);
    feed.startLive();
    feed.stopLive();
    assert.equal(feed.pushLive(sound(2)), false);
    assert.deepEqual(heard, []);
  });

  test('audio the stream can\'t carry (not AAC-LC 16 kHz mono) is refused', () => {
    const feed = new AudioFeed({ silence: SILENCE });
    const heard = listen(feed);
    feed.startLive();
    assert.equal(feed.pushLive(adtsFrame(undefined, { rateIndex: 3 })), false);
    assert.deepEqual(heard, []);
  });

  test('keeps the silent frame the publisher fills quiet time with', () => {
    assert.equal(new AudioFeed({ silence: SILENCE }).silence, SILENCE);
  });
});

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AudioFeed } from '../../src/audio/audio-feed.mjs';
import { adtsFrame } from '../helpers/aac.mjs';

const SILENCE = adtsFrame(Buffer.alloc(4, 0));
const sound = (n) => adtsFrame(Buffer.alloc(8, n));

describe('the audio a stream plays', () => {
  test('silence while the camera sleeps, so the audio track never stops', () => {
    const feed = new AudioFeed({ silence: SILENCE });
    assert.deepEqual([feed.next(), feed.next()], [SILENCE, SILENCE]);
    assert.equal(feed.pushLive(sound(1)), false, 'camera audio is ignored while not live');
    assert.equal(feed.next(), SILENCE);
  });

  test('live: the camera\'s audio in order, after a short buffer against network jitter', () => {
    const feed = new AudioFeed({ silence: SILENCE, prebuffer: 3 });
    feed.startLive();
    feed.pushLive(sound(1));
    feed.pushLive(sound(2));
    assert.equal(feed.next(), SILENCE, 'still buffering');
    feed.pushLive(sound(3));
    assert.deepEqual([feed.next(), feed.next(), feed.next()], [sound(1), sound(2), sound(3)]);
  });

  test('a gap in the camera\'s audio is filled with silence, then it buffers again', () => {
    const feed = new AudioFeed({ silence: SILENCE, prebuffer: 2 });
    feed.startLive();
    feed.pushLive(sound(1)); feed.pushLive(sound(2));
    feed.next(); feed.next();
    assert.equal(feed.next(), SILENCE);
    feed.pushLive(sound(3));
    assert.equal(feed.next(), SILENCE, 'buffering again');
    feed.pushLive(sound(4));
    assert.deepEqual([feed.next(), feed.next()], [sound(3), sound(4)]);
  });

  test('a backlog is cut short rather than delaying the sound', () => {
    const feed = new AudioFeed({ silence: SILENCE, prebuffer: 1, maxBacklog: 4 });
    feed.startLive();
    for (let i = 1; i <= 6; i++) feed.pushLive(sound(i));
    // the 5th frame overflowed 4: the oldest went, keeping half; then the 6th joined
    assert.deepEqual(feed.queue, [sound(4), sound(5), sound(6)]);
    assert.deepEqual(feed.next(), sound(4));
  });

  test('audio the stream can\'t carry (not AAC-LC 16 kHz mono) is refused, and silence plays', () => {
    const feed = new AudioFeed({ silence: SILENCE, prebuffer: 1 });
    feed.startLive();
    assert.equal(feed.pushLive(adtsFrame(undefined, { rateIndex: 3 })), false);
    assert.equal(feed.next(), SILENCE);
  });

  test('when live ends, silence again at once', () => {
    const feed = new AudioFeed({ silence: SILENCE, prebuffer: 1 });
    feed.startLive();
    feed.pushLive(sound(1)); feed.pushLive(sound(2));
    feed.stopLive();
    assert.equal(feed.next(), SILENCE);
  });
});

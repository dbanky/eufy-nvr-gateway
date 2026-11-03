// Where each sound frame goes on the clock: the camera's sound as recorded, silence where there is none.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AudioTimeline, liveAudioTime, silenceDue, AUDIO_FRAME_MS, SILENCE_AFTER_MS, LIVE_GAP_MS, MAX_CATCH_UP_MS } from '../../src/video/audio-timeline.mjs';

const T0 = 1_762_000_000_000;
const FRAME = AUDIO_FRAME_MS;   // 64 ms of sound per AAC frame
const ASLEEP = false, IN_A_SESSION = true;

describe('a camera audio frame', () => {
  test('the first one goes where it arrived: with the picture', () => {
    const timeline = new AudioTimeline();
    assert.equal(timeline.cameraFrame(T0 + 500), T0 + 500);
  });

  test('a burst stays one continuous track: each frame right after the one before', () => {
    const timeline = new AudioTimeline();
    const stamps = [0, 1, 2, 3].map(() => timeline.cameraFrame(T0));
    assert.deepEqual(stamps, [T0, T0 + FRAME, T0 + 2 * FRAME, T0 + 3 * FRAME]);
  });

  test('after a short pause (a network hiccup), the late frames fill the gap they belong to', () => {
    assert.equal(liveAudioTime(T0 + 900, T0 + 64, false), T0 + 64, 'a 0.8 s pause: back to back, as recorded');
  });

  test('after a pause longer than LIVE_GAP_MS (a real gap), no further behind its arrival than that', () => {
    assert.equal(liveAudioTime(T0 + 3000, T0 + 64, false), T0 + 3000 - LIVE_GAP_MS);
  });

  test('after silence: at its arrival, never on top of the silence before it', () => {
    assert.equal(liveAudioTime(T0 + 900, T0 + 64, true), T0 + 900);
    assert.equal(liveAudioTime(T0 + 900, T0 + 1000, true), T0 + 1000);
  });
});

describe('silence', () => {
  test('how much is due: enough to keep the track no further behind the clock than the lag', () => {
    assert.equal(silenceDue(T0 + 1000, T0 + 1000 - SILENCE_AFTER_MS), 0);
    assert.equal(silenceDue(T0 + 1000, T0 + 1000 - SILENCE_AFTER_MS - 1), 1);
    assert.equal(silenceDue(T0 + 1000, T0 + 1000 - SILENCE_AFTER_MS - FRAME - 1), 2);
  });

  test('asleep, it keeps the track going in real time, SILENCE_AFTER_MS behind the clock', () => {
    const timeline = new AudioTimeline();
    const stamps = [];
    for (let ms = 0; ms <= 2000; ms += 10) stamps.push(...timeline.silenceUntil(T0 + ms, ASLEEP));
    assert.ok(Math.abs(stamps.length - 2000 / FRAME) <= 1);
    assert.ok(stamps.slice(1).every((ms, i) => ms - stamps[i] === FRAME), 'back to back');
    assert.ok(T0 + 2000 - (stamps.at(-1) + FRAME) <= SILENCE_AFTER_MS);
  });

  test('none while the camera\'s sound keeps up', () => {
    const timeline = new AudioTimeline();
    for (let ms = 0; ms <= 2000; ms += FRAME) {
      timeline.cameraFrame(T0 + ms);
      assert.deepEqual(timeline.silenceUntil(T0 + ms + 1, IN_A_SESSION), []);
    }
  });

  test('in a session, a pause in the camera\'s sound is left open for LIVE_GAP_MS for a late burst', () => {
    const timeline = new AudioTimeline();
    timeline.cameraFrame(T0);
    assert.deepEqual(timeline.silenceUntil(T0 + FRAME + LIVE_GAP_MS, IN_A_SESSION), [], 'still open');
    assert.deepEqual(timeline.silenceUntil(T0 + FRAME + LIVE_GAP_MS + 1, IN_A_SESSION), [T0 + FRAME], 'then filled');
  });

  test('outside a session the same pause fills after SILENCE_AFTER_MS', () => {
    const timeline = new AudioTimeline();
    timeline.cameraFrame(T0);
    assert.deepEqual(timeline.silenceUntil(T0 + FRAME + SILENCE_AFTER_MS + 1, ASLEEP), [T0 + FRAME]);
  });

  test('after a stall longer than MAX_CATCH_UP_MS, it starts again near the clock rather than bursting', () => {
    const timeline = new AudioTimeline();
    timeline.silenceUntil(T0, ASLEEP);
    const stamps = timeline.silenceUntil(T0 + 60_000, ASLEEP);
    assert.ok(stamps.length <= 1, `${stamps.length} frames`);
    assert.ok(MAX_CATCH_UP_MS < 60_000);
  });

  test('the camera\'s next frame after silence goes at its arrival again', () => {
    const timeline = new AudioTimeline();
    timeline.cameraFrame(T0);
    timeline.silenceUntil(T0 + 2000, IN_A_SESSION);
    assert.equal(timeline.cameraFrame(T0 + 2100), T0 + 2100);
  });
});

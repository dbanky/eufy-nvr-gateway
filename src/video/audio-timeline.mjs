// Where each sound frame of a stream goes on the wall clock (ms). The publisher asks it for the
// timestamp of every camera audio frame, and for the silent frames that fill the time without one.
//
// - The camera's sound stays one continuous track, as the camera recorded it: sound that arrives
//   in a burst after a network hiccup fills the gap it belongs to, rather than piling up later
//   (which would push the sound further behind the picture with every hiccup).
// - A pause longer than LIVE_GAP_MS is a real gap: the camera's sound starts again at its arrival.
// - Silence fills only the time the camera sends no sound, so the track never stops: once
//   SILENCE_AFTER_MS has passed while asleep, or LIVE_GAP_MS once the camera's sound flows (that
//   long, a late burst can still fill the pause).

import { SAMPLES_PER_FRAME, STREAM_FORMAT } from '../audio/adts.mjs';

export const AUDIO_FRAME_MS = SAMPLES_PER_FRAME * 1000 / STREAM_FORMAT.sampleRate;   // 64 ms
export const SILENCE_AFTER_MS = 250;   // asleep: silence fills the time after this
export const LIVE_GAP_MS = 1000;       // during a session: a pause in the camera's sound longer than this is a real gap
export const MAX_CATCH_UP_MS = 2000;   // further behind than this (a stall): start again near the clock

// The timestamp of a camera audio frame. After silence: its arrival (where the picture is).
// Within the camera's sound: right after the previous frame, as recorded, unless that is more than
// LIVE_GAP_MS before its arrival (a real gap: start again at the arrival).
export const liveAudioTime = (arrival, audioEnd, afterSilence) =>
  afterSilence ? Math.max(arrival, audioEnd) : Math.max(audioEnd, arrival - LIVE_GAP_MS);

// How many silent frames to add now (stamped from audioEnd on): enough to keep the track no further
// behind the clock than `lag`.
export function silenceDue(now, audioEnd, lag = SILENCE_AFTER_MS) {
  const behind = now - lag - audioEnd;
  return behind > 0 ? Math.ceil(behind / AUDIO_FRAME_MS) : 0;
}

export class AudioTimeline {
  constructor() {
    this.end = null;            // ms: where the track has got to (the end of its last frame)
    this.afterSilence = true;   // the last frame on it was silence (or there was none yet)
  }

  // A camera audio frame that arrived at `now`: its timestamp.
  cameraFrame(now) {
    const ms = liveAudioTime(now, this.end ?? -Infinity, this.afterSilence);
    this.afterSilence = false;
    return this.add(ms);
  }

  // The timestamps of the silent frames due at `now`, in order (none while the camera's sound
  // keeps up). cameraLive: the camera is in a session and may send sound.
  silenceUntil(now, cameraLive) {
    const lag = cameraLive && !this.afterSilence ? LIVE_GAP_MS : SILENCE_AFTER_MS;
    if (this.end == null || now - this.end > lag + MAX_CATCH_UP_MS) this.end = now - lag;
    const stamps = [];
    for (let n = silenceDue(now, this.end, lag); n > 0; n--) {
      this.afterSilence = true;
      stamps.push(this.add(this.end));
    }
    return stamps;
  }

  add(ms) {
    this.end = ms + AUDIO_FRAME_MS;
    return ms;
  }
}

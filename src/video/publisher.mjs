// The one never-ending stream per camera, published into go2rtc over RTSP (rtsp-push.mjs): the
// Feed's video (loop or live) and, with sound, the AudioFeed's AAC. No ffmpeg, nothing re-encoded.
//
// Picture and sound are independent, and neither ever waits for the other:
// - every live frame and every camera audio frame goes out the moment it arrives, stamped with its
//   arrival time; nothing is buffered, re-paced or dropped
// - the sleeping loop plays at exactly `fps`
// - the camera's sound stays one continuous track, as the camera recorded it: sound that arrives
//   in a burst after a network hiccup fills the gap it belongs to, rather than piling up later
//   (which would push the sound further behind the picture with every hiccup)
// - silence fills only the time the camera sends no sound (asleep: after SILENCE_AFTER_MS; during a
//   session: after LIVE_GAP_MS, then the camera's sound starts again at its arrival), so the audio
//   track never stops
// Both tracks are stamped on the one wall clock (rtp.mjs), which is all a player needs to keep
// them in sync.
//
// If the connection to go2rtc drops, it is opened again at once and everything since the last
// keyframe (picture and sound) is sent again first, so a viewer loses nothing it could decode.

import { randomBytes } from 'node:crypto';
import { isKeyframe } from './annexb.mjs';
import { SAMPLES_PER_FRAME, STREAM_FORMAT } from '../audio/adts.mjs';
import { RtspPush } from './rtsp-push.mjs';
import { VIDEO_PT, AUDIO_PT, VIDEO_RATE, rtpTime, framePayloads, aacPayload, parameterSets, publishSdp, rtpPacket } from './rtp.mjs';

export const AUDIO_FRAME_MS = SAMPLES_PER_FRAME * 1000 / STREAM_FORMAT.sampleRate;   // 64 ms
export const SILENCE_AFTER_MS = 250;   // asleep: silence fills the time after this
export const LIVE_GAP_MS = 1000;       // during a session: a pause in the camera's sound longer than this is a real gap
export const RECONNECT_MS = 500;
export const MAX_CATCH_UP_MS = 2000;   // the loop after a stall: carry on, don't burst everything missed
export const MAX_REPLAY = 3000;        // packet groups kept for a resend (a very long GOP)

// The timestamp (ms) a live frame gets: its arrival, but never closer than half a frame to the one
// before, so a burst (the network delivers several at once) still plays as motion.
export const liveFrameTime = (arrival, previous, fps) => Math.max(arrival, previous + 500 / fps);

// The timestamp (ms) of a camera audio frame. After silence: its arrival (where the picture is).
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

export class Publisher {
  // audio: an AudioFeed, or null for a stream without sound.
  constructor({ name, fps, output, feed, audio = null, log, now = Date.now, pushImpl = (o) => new RtspPush(o) }) {
    Object.assign(this, { name, fps, output, feed, audio, log, now, pushImpl });
    this.interval = 1000 / fps;
    this.push = null;
    this.replay = [];             // { track, ts, payloads } since the last keyframe, in order
    this.keyframe = null;         // the newest keyframe sent (for the SDP's parameter sets)
    this.needKeyframe = true;
    this.lastVideoMs = -Infinity;
    this.nextLoopAt = null;
    this.audioEnd = null;         // ms: where the audio track has got to
    this.afterSilence = true;     // the last audio frame sent was silence
    this.stopped = false;
  }

  start() {
    this.feed.on('live', () => this.drainLive());
    this.feed.on('codec', (codec) => {
      this.log(this.name, `stream codec now ${codec}, restarting the stream`);
      Object.assign(this, { replay: [], keyframe: null, needKeyframe: true });
      this.push?.close('codec changed');
    });
    this.audio?.on('frame', (frame) => {
      const ms = liveAudioTime(this.now(), this.audioEnd ?? -Infinity, this.afterSilence);
      this.afterSilence = false;
      this.sendAudio(frame, ms);
    });
    this.timer = setInterval(() => this.tick(), 10);
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.push?.close('stopped');
  }

  tick() {
    const now = this.now();
    if (this.feed.mode === 'live') this.drainLive();
    else this.playLoop(now);
    if (this.audio?.silence) {
      // Once the camera's sound flows, a pause is left open for a late burst to fill; before that
      // (asleep, or the camera still waking), silence keeps the track going.
      const lag = this.audio.live && !this.afterSilence ? LIVE_GAP_MS : SILENCE_AFTER_MS;
      if (this.audioEnd == null || now - this.audioEnd > lag + MAX_CATCH_UP_MS) this.audioEnd = now - lag;
      for (let n = silenceDue(now, this.audioEnd, lag); n > 0; n--) {
        this.afterSilence = true;
        this.sendAudio(this.audio.silence, this.audioEnd);
      }
    }
  }

  playLoop(now) {
    if (this.nextLoopAt == null || now - this.nextLoopAt > MAX_CATCH_UP_MS) this.nextLoopAt = Math.max(now, this.lastVideoMs + this.interval);
    while (this.nextLoopAt <= now) {
      const frame = this.feed.next({ fromKeyframe: this.needKeyframe });
      if (!frame) return;
      this.sendVideo(frame, Math.max(this.nextLoopAt, this.lastVideoMs + this.interval / 2));
      this.nextLoopAt += this.interval;
    }
  }

  drainLive() {
    for (let frame; (frame = this.feed.next({ fromKeyframe: this.needKeyframe }));) {
      this.sendVideo(frame, liveFrameTime(this.feed.arrivalOf(frame) ?? this.now(), this.lastVideoMs, this.fps));
    }
    this.nextLoopAt = null;   // the loop, when it comes back, starts after the last live frame
  }

  sendVideo(frame, ms) {
    const key = isKeyframe(frame, this.feed.codec);
    if (this.needKeyframe && !key) return;   // nothing a viewer could decode yet
    this.needKeyframe = false;
    if (key) {
      this.keyframe = frame;
      this.replay = [];
      if (!this.push) this.connect();
    }
    this.lastVideoMs = ms;
    this.emitGroup({ track: 0, ts: rtpTime(ms, VIDEO_RATE), payloads: framePayloads(frame, this.feed.codec) });
  }

  sendAudio(frame, ms) {
    this.audioEnd = ms + AUDIO_FRAME_MS;
    const payload = aacPayload(frame);
    if (payload) this.emitGroup({ track: 1, ts: rtpTime(ms, STREAM_FORMAT.sampleRate), payloads: [payload] });
  }

  emitGroup(group) {
    if (this.replay.length < MAX_REPLAY) this.replay.push(group);
    if (this.push?.ready) this.sendGroup(group);
  }

  sendGroup({ track, ts, payloads }) {
    const t = this.tracks[track];
    payloads.forEach((payload, i) => {
      const packet = rtpPacket({ pt: track ? AUDIO_PT : VIDEO_PT, seq: t.seq++, ts, ssrc: t.ssrc, marker: i === payloads.length - 1, payload });
      this.push.send(track, packet);
    });
  }

  // Opens the connection once there is a keyframe to describe the stream with.
  connect() {
    if (this.stopped || this.push) return;
    const keyframe = this.keyframe ?? this.feed.loop?.[0];
    if (!keyframe) return;   // sendVideo connects at the first keyframe
    const codec = this.feed.codec, audio = !!this.audio;
    const sdp = publishSdp({ codec, params: parameterSets(keyframe, codec), audio });
    this.tracks = [0, 1].map(() => ({ ssrc: randomBytes(4).readUInt32BE(0), seq: randomBytes(2).readUInt16BE(0) }));
    const push = this.pushImpl({ url: this.output, sdp, tracks: audio ? 2 : 1 });
    this.push = push;
    push.on('ready', () => {
      this.log(this.name, `stream → ${this.output} (${codec}${audio ? ', AAC audio' : ''})`);
      for (const group of this.replay) this.sendGroup(group);   // since the last keyframe: nothing lost
    });
    push.on('close', (reason) => {
      if (this.push !== push) return;
      this.push = null;
      if (this.stopped) return;
      this.log(this.name, `stream to go2rtc ended (${reason}), reconnecting`);
      setTimeout(() => this.connect(), RECONNECT_MS).unref?.();
    });
  }
}

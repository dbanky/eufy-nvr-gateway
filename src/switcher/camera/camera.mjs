// One camera: its state (IDLE -> WAKING -> LIVE -> IDLE) and what its stream shows.
//
//   IDLE    asleep. The stream replays a pre-encoded loop of the sleeping picture.
//   WAKING  a trigger arrived; the live feed is opening. The loop shows "Waking up".
//   LIVE    live video; the stream switches to it at a keyframe.
//
// The pieces: live-feed.mjs (converting or passing through the camera's video),
// sleeping-picture.mjs (the picture for every other state). Everything with side effects (ffmpeg,
// files, the clock) comes in through `deps`, so the behaviour can be tested without video:
//
//   log, now, time                         logging, clock, time formatting (time-format.mjs)
//   offline()                              null | 'login' | 'connection'   (BridgeClient.offline)
//   feed                                   video/feed.mjs: what the stream plays
//   renderLoop({ cam, picture, view, codec }) -> { still: rawFrame, frames: encodedLoop }
//   openLiveFeed({ cam, onFrame, onCodec, onClose })              converting       -> { stop() }
//   openPassthrough({ cam, codec, onFrame, onPicture, onThumbnail, onClose })  passing through -> { stop() }
//   createEncoder({ cam, getFrame, onFrame }) -> { start(), stop() }
//   saveLastFrame(cam, { raw } | { jpeg }), saveCodec(cam, codec)   kept for after a restart
//   openLiveAudio(cam) -> { stop() }        only with `audio: true`: the camera's sound, from the wake-up
//                                           until the session's live connection closes

import { CAMERA_DEFAULTS, decideTrigger, stopReason, deadlineWhenLive, holdForPictureMotion } from '../policy.mjs';
import { pictureMoved } from '../picture-motion.mjs';
import { viewFor } from '../labels.mjs';
import { videoInfo } from '../video-info.mjs';
import { chooseLiveMode, openLiveFeed, endLiveFeed } from './live-feed.mjs';
import { showCurrentState, cancelRendering } from './sleeping-picture.mjs';

export class Camera {
  constructor(settings, deps) {
    Object.assign(this, CAMERA_DEFAULTS, settings);
    this.deps = deps;
    this.state = 'IDLE';
    this.picture = null;              // what the sleeping overlay sits on: { raw } | { jpeg } | { file } | null
    this.pictureFromEvent = false;    // eufy's stored event image: its time is unknown
    this.frame = null;                // the newest raw picture on the stream (snapshots read it)
    this.liveJpeg = null;             // the newest picture while passing through (keyframes only)
    this.codec = null;                // what the camera sends: 'h264' | 'hevc', once learned
    this.lastLiveAt = 0;
    this.deadline = 0; this.sessionStart = 0; this.liveStart = 0; this.lastStop = 0; this.reconnects = 0;
    this.wakeReason = null; this.wakeAt = 0; this.failedAt = 0;
    this.lastDetectionAt = 0;         // the camera's (or the web page's) last trigger
    this.thumbnail = null;            // the previous keyframe's thumbnail this session (picture-motion.mjs)
    this.movingSince = 0;             // when movement in the picture first kept this session live
    this.battery = null; this.model = null;
    this.liveFeed = null;
    this.liveMode = null;             // 'transcode' | 'passthrough' for the current session
    this.closeWhenShown = null;       // a pass-through feed kept on air until the sleeping loop is ready
    this.encoder = deps.createEncoder({ cam: this, getFrame: () => this.frame, onFrame: (f) => deps.feed.pushLive(f) });
    this.shownKey = '';               // the state currently on the stream (or being rendered)
    this.renderId = 0;
  }

  // The codec of this camera's RTSP stream: the camera's own when passing it through.
  streamCodec() {
    return !this.transcode && this.codec ? this.codec : 'h264';
  }

  view() {
    return viewFor(this, { offline: this.deps.offline(), now: this.deps.now(), time: this.deps.time });
  }

  refresh() {
    return showCurrentState(this);
  }

  trigger(kind) {
    const now = this.deps.now();
    const decision = decideTrigger(this, kind, now);
    if (decision.action === 'ignore') return this.deps.log(this.name, `${kind}: ignored, ${decision.reason}`);
    this.deadline = decision.holdUntil;
    this.lastDetectionAt = now;
    if (decision.action === 'extend') return this.deps.log(this.name, `${kind}: extended until ${this.deps.time.hms(this.deadline)}`);

    this.closeWhenShown?.stop();         // the previous session's feed, if still on air
    this.closeWhenShown = null;
    Object.assign(this, { state: 'WAKING', sessionStart: now, liveStart: 0, reconnects: 0, wakeReason: kind, wakeAt: now, thumbnail: null, movingSince: 0 });
    this.liveMode = chooseLiveMode(this);
    const how = this.liveMode === 'passthrough' ? `${this.codec} pass-through` : 'converting';
    this.deps.log(this.name, `${kind}: waking camera (${how}, hold until ${this.deps.time.hms(this.deadline)})`);
    this.refresh();
    openLiveFeed(this);
    // Sound from the start: whatever the camera hears while it wakes is on the stream too, before
    // the first picture. It ends with the live connection (endLiveFeed), not with the hold time.
    this.liveAudio = this.deps.openLiveAudio?.(this) ?? null;
  }

  goLive() {
    this.state = 'LIVE';
    this.liveStart = this.lastLiveAt;
    this.failedAt = 0;
    this.deadline = deadlineWhenLive(this, this.liveStart);
    cancelRendering(this);
    this.deps.log(this.name, `live after ${((this.liveStart - this.sessionStart) / 1000).toFixed(1)} s`);
  }

  // A thumbnail of the live picture (one per keyframe): movement keeps the session live.
  seePicture(thumbnail) {
    const moved = this.state === 'LIVE' && pictureMoved(this.thumbnail, thumbnail);
    this.thumbnail = thumbnail;
    if (!moved) return;
    const until = holdForPictureMotion(this, this.deps.now());
    if (!until) return;
    this.deadline = until;
    if (!this.movingSince) {
      this.movingSince = this.deps.now();
      this.deps.log(this.name, `motion in the picture: staying live (until ${this.deps.time.hms(until)} for now)`);
    }
  }

  learnCodec(codec) {
    if (codec === this.codec) return;
    this.codec = codec;
    this.deps.saveCodec(this, codec);
    this.deps.log(this.name, `camera sends ${codec}`);
  }

  stop(why) {
    if (this.state === 'IDLE') return;
    const now = this.deps.now();
    this.deps.log(this.name, `stopped (${why}) after ${((now - this.sessionStart) / 1000).toFixed(0)} s`);
    if (!this.liveStart) this.failedAt = now;   // never got a picture: "Didn't wake up"
    endLiveFeed(this);
    Object.assign(this, { state: 'IDLE', lastStop: now });
    this.refresh();
  }

  // Called every second.
  check() {
    const why = stopReason(this, this.deps.now());
    if (why) this.stop(why);
  }

  status() {
    const { kind, title, detail } = this.view();
    return {
      name: this.name, serial: this.serial, state: this.state, battery: this.battery,
      resolution: `${this.width}x${this.height}`, rtsp: `/${this.name}`,
      display: { kind, title, detail },
      video: videoInfo({ transcode: this.transcode, codec: this.codec, streamCodec: this.deps.feed.codec }),
      audio: this.deps.openLiveAudio ? 'AAC · 16 kHz mono' : null,
      liveUntil: this.state === 'IDLE' ? null : this.deps.time.hms(this.deadline),
      lastSeen: this.lastLiveAt ? this.deps.time.hms(this.lastLiveAt) : null,
    };
  }
}

// One camera: its state (IDLE -> WAKING -> LIVE -> IDLE) and what its stream shows.
//
//   IDLE    asleep. The stream replays a pre-encoded loop of the sleeping picture.
//   WAKING  a trigger arrived; the live feed is opening. The loop shows "Waking up".
//   LIVE    live video; the stream switches to it at a keyframe.
//
// Live video is either converted (decoded and re-encoded as H.264, the default) or, with
// `transcode: false`, the camera's own H.264/H.265 passed through. Pass-through needs the camera's
// codec, which the first (converted) session learns; the sleeping loops then use that codec too.
//
// Everything with side effects (ffmpeg, files, the clock) comes in through `deps`, so the
// behaviour can be tested without video.

import { CAMERA_DEFAULTS, decideTrigger, stopReason, deadlineWhenLive, shouldReconnect } from './policy.mjs';
import { viewFor, viewKey } from './labels.mjs';

// deps: {
//   log, now, time                         logging, clock, time formatting (time-format.mjs)
//   offline()                              null | 'login' | 'connection'   (BridgeClient.offline)
//   feed                                   video/feed.mjs: what the stream plays
//   renderLoop({ cam, picture, view, codec }) -> { still: rawFrame, frames: encodedLoop }
//   openLiveFeed({ cam, onFrame, onCodec, onClose })        converting: raw frames   -> { stop() }
//   openPassthrough({ cam, codec, onFrame, onPicture, onClose })  encoded frames + JPEGs -> { stop() }
//   createEncoder({ cam, getFrame, onFrame }) -> { start(), stop() }
//   saveLastFrame(cam, { raw } | { jpeg }) kept for after a restart
//   saveCodec(cam, codec)                  remembered for after a restart
// }
// Opening a live feed wakes the camera; stopping it lets the camera sleep.
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
    this.battery = null; this.model = null;
    this.liveFeed = null;
    this.liveMode = null;             // 'transcode' | 'passthrough' for the current session
    this.closeWhenShown = null;       // a pass-through feed kept on air until the sleeping loop is ready
    this.encoder = deps.createEncoder({ cam: this, getFrame: () => this.frame, onFrame: (f) => deps.feed.pushLive(f) });
    this.shownKey = '';               // the state currently on the stream (or being rendered)
    this.renderId = 0;
  }

  // The codec of this camera's RTSP stream.
  streamCodec() {
    return !this.transcode && this.codec ? this.codec : 'h264';
  }

  view() {
    return viewFor(this, { offline: this.deps.offline(), now: this.deps.now(), time: this.deps.time });
  }

  // Bring the stream in line with the current state. Cheap when nothing changed; called often.
  async refresh() {
    if (this.state === 'LIVE') return;
    const view = this.view(), codec = this.streamCodec(), key = `${viewKey(view)}|${codec}`;
    if (key === this.shownKey) return;
    this.shownKey = key;
    const id = ++this.renderId;
    try {
      const { still, frames } = await this.deps.renderLoop({ cam: this, picture: this.picture, view, codec });
      if (id !== this.renderId) return;   // something newer took over while rendering
      this.frame = still;
      this.liveJpeg = null;
      this.deps.feed.showLoop(frames, codec);
    } catch (e) {
      this.deps.log(this.name, 'render failed:', e.message);
      if (id === this.renderId) this.shownKey = '';   // try again on the next refresh
    }
    if (id !== this.renderId) return;
    // A session that just ended stays on air until now
    this.encoder.stop();
    this.closeWhenShown?.stop();
    this.closeWhenShown = null;
  }

  trigger(kind) {
    const now = this.deps.now();
    const decision = decideTrigger(this, kind, now);
    if (decision.action === 'ignore') return this.deps.log(this.name, `${kind}: ignored, ${decision.reason}`);
    this.deadline = decision.holdUntil;
    if (decision.action === 'extend') return this.deps.log(this.name, `${kind}: extended until ${this.deps.time.hms(this.deadline)}`);

    this.closeWhenShown?.stop();         // the previous session's feed, if still on air
    this.closeWhenShown = null;
    Object.assign(this, { state: 'WAKING', sessionStart: now, liveStart: 0, reconnects: 0, wakeReason: kind, wakeAt: now });
    // Pass through only when the stream already runs in the camera's codec (never mix codecs)
    this.liveMode = !this.transcode && this.codec && this.deps.feed.codec === this.codec ? 'passthrough' : 'transcode';
    this.deps.log(this.name, `${kind}: waking camera (${this.liveMode === 'passthrough' ? `${this.codec} pass-through` : 'converting'}, hold until ${this.deps.time.hms(this.deadline)})`);
    this.refresh();
    this.openLiveFeed();
  }

  openLiveFeed() {
    const onClose = (code) => this.onLiveFeedClosed(code);
    this.liveFeed = this.liveMode === 'passthrough'
      ? this.deps.openPassthrough({
        cam: this, codec: this.codec, onClose,
        onFrame: (frame) => this.onPassthroughFrame(frame),
        onPicture: (jpeg) => { this.liveJpeg = jpeg; },
      })
      : this.deps.openLiveFeed({
        cam: this, onClose,
        onFrame: (frame) => this.onLiveFrame(frame),
        onCodec: (codec) => this.learnCodec(codec),
      });
  }

  // Converting: a decoded raw picture.
  onLiveFrame(frame) {
    this.frame = frame;
    this.lastLiveAt = this.deps.now();
    if (this.state !== 'WAKING') return;
    this.goLive();
    this.deps.feed.armLive();
    this.encoder.start();
  }

  // Passing through: one of the camera's own encoded frames. Live starts at its first keyframe.
  onPassthroughFrame(frame) {
    this.lastLiveAt = this.deps.now();
    if (this.state === 'WAKING') this.deps.feed.armLive();
    this.deps.feed.pushLive(frame);
    if (this.state === 'WAKING' && this.deps.feed.mode === 'live') this.goLive();
  }

  goLive() {
    this.state = 'LIVE';
    this.liveStart = this.lastLiveAt;
    this.failedAt = 0;
    this.deadline = deadlineWhenLive(this, this.liveStart);
    this.renderId++;                     // a sleeping picture still being rendered is no longer wanted
    this.shownKey = 'live';
    this.deps.log(this.name, `live after ${((this.liveStart - this.sessionStart) / 1000).toFixed(1)} s`);
  }

  learnCodec(codec) {
    if (codec === this.codec) return;
    this.codec = codec;
    this.deps.saveCodec(this, codec);
    this.deps.log(this.name, `camera sends ${codec}`);
  }

  onLiveFeedClosed(code) {
    this.liveFeed = null;
    if (this.liveMode === 'passthrough' && !this.liveStart && this.state === 'WAKING') {
      this.deps.log(this.name, `pass-through failed (${code}), converting this session`);
      this.liveMode = 'transcode';
      return this.openLiveFeed();
    }
    if (shouldReconnect(this, this.deps.now())) {
      this.reconnects++;
      this.deps.log(this.name, `feed closed (${code}) mid-event, reconnect ${this.reconnects}/${this.maxReconnects}`);
      setTimeout(() => this.state !== 'IDLE' && !this.liveFeed && this.openLiveFeed(), 2000);
      return;
    }
    this.deps.log(this.name, `feed closed (${code})`);
    this.stop('feed closed');
  }

  stop(why) {
    if (this.state === 'IDLE') return;
    const now = this.deps.now();
    this.deps.log(this.name, `stopped (${why}) after ${((now - this.sessionStart) / 1000).toFixed(0)} s`);
    const kept = this.liveMode === 'passthrough' ? (this.liveJpeg && { jpeg: this.liveJpeg }) : (this.liveStart && { raw: this.frame });
    if (this.liveStart && kept) {
      this.picture = kept;
      this.pictureFromEvent = false;
      this.deps.saveLastFrame(this, kept);
    } else if (!this.liveStart) {
      this.failedAt = now;               // never got a picture: "Didn't wake up"
    }
    // Closing the feed lets the camera sleep. A pass-through feed is all that's on air, so it stays
    // until the sleeping loop is ready (a converted session keeps its encoder running instead).
    if (this.liveMode === 'passthrough' && this.liveStart) this.closeWhenShown = this.liveFeed;
    else this.liveFeed?.stop();
    this.liveFeed = null;
    this.state = 'IDLE';
    this.lastStop = now;
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
      liveUntil: this.state === 'IDLE' ? null : this.deps.time.hms(this.deadline),
      lastSeen: this.lastLiveAt ? this.deps.time.hms(this.lastLiveAt) : null,
    };
  }
}

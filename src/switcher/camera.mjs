// One camera: its state (IDLE -> WAKING -> LIVE -> IDLE) and what its stream shows.
//
//   IDLE    asleep. The stream replays a pre-encoded loop of the sleeping picture.
//   WAKING  a trigger arrived; the live feed is opening. The loop shows "Waking up".
//   LIVE    live frames arrive and are encoded; the stream switches to them at a keyframe.
//
// Everything with side effects (ffmpeg, files, the clock) comes in through `deps`, so the
// behaviour can be tested without video.

import { CAMERA_DEFAULTS, decideTrigger, stopReason, deadlineWhenLive, shouldReconnect } from './policy.mjs';
import { viewFor, viewKey } from './labels.mjs';

// deps: {
//   log, now, time                         logging, clock, time formatting (time-format.mjs)
//   offline()                              null | 'login' | 'connection'   (BridgeClient.offline)
//   feed                                   video/feed.mjs: what the stream plays
//   renderLoop({ cam, picture, view })     -> { still: rawFrame, frames: encodedLoop }
//   openLiveFeed({ cam, onFrame, onClose }) -> { stop() }   wakes the camera while open
//   createEncoder({ cam, getFrame, onFrame }) -> { start(), stop() }
//   saveLastFrame(cam, rawFrame)           kept for after a restart
// }
export class Camera {
  constructor(settings, deps) {
    Object.assign(this, CAMERA_DEFAULTS, settings);
    this.deps = deps;
    this.state = 'IDLE';
    this.picture = null;              // what the sleeping overlay sits on: { raw } | { file } | null
    this.pictureFromEvent = false;    // eufy's stored event image: its time is unknown
    this.frame = null;                // the newest picture on the stream (snapshots read it)
    this.lastLiveAt = 0;
    this.deadline = 0; this.sessionStart = 0; this.liveStart = 0; this.lastStop = 0; this.reconnects = 0;
    this.wakeReason = null; this.wakeAt = 0; this.failedAt = 0;
    this.battery = null; this.model = null;
    this.liveFeed = null;
    this.encoder = deps.createEncoder({ cam: this, getFrame: () => this.frame, onFrame: (f) => deps.feed.pushLive(f) });
    this.shownKey = '';               // the state currently on the stream (or being rendered)
    this.renderId = 0;
  }

  view() {
    return viewFor(this, { offline: this.deps.offline(), now: this.deps.now(), time: this.deps.time });
  }

  // Bring the stream in line with the current state. Cheap when nothing changed; called often.
  async refresh() {
    if (this.state === 'LIVE') return;
    const view = this.view(), key = viewKey(view);
    if (key === this.shownKey) return;
    this.shownKey = key;
    const id = ++this.renderId;
    try {
      const { still, frames } = await this.deps.renderLoop({ cam: this, picture: this.picture, view });
      if (id !== this.renderId) return;   // something newer took over while rendering
      this.frame = still;
      this.deps.feed.showLoop(frames);
      this.encoder.stop();                // a live session that just ended stays on air until now
    } catch (e) {
      this.deps.log(this.name, 'render failed:', e.message);
      if (id === this.renderId) this.shownKey = '';   // try again on the next refresh
    }
  }

  trigger(kind) {
    const now = this.deps.now();
    const decision = decideTrigger(this, kind, now);
    if (decision.action === 'ignore') return this.deps.log(this.name, `${kind}: ignored, ${decision.reason}`);
    this.deadline = decision.holdUntil;
    if (decision.action === 'extend') return this.deps.log(this.name, `${kind}: extended until ${this.deps.time.hms(this.deadline)}`);

    Object.assign(this, { state: 'WAKING', sessionStart: now, liveStart: 0, reconnects: 0, wakeReason: kind, wakeAt: now });
    this.deps.log(this.name, `${kind}: waking camera (hold until ${this.deps.time.hms(this.deadline)})`);
    this.refresh();
    this.openLiveFeed();
  }

  openLiveFeed() {
    this.liveFeed = this.deps.openLiveFeed({
      cam: this,
      onFrame: (frame) => this.onLiveFrame(frame),
      onClose: (code) => this.onLiveFeedClosed(code),
    });
  }

  onLiveFrame(frame) {
    this.frame = frame;
    this.lastLiveAt = this.deps.now();
    if (this.state !== 'WAKING') return;
    this.state = 'LIVE';
    this.liveStart = this.lastLiveAt;
    this.failedAt = 0;
    this.deadline = deadlineWhenLive(this, this.liveStart);
    this.renderId++;                    // a sleeping picture still being rendered is no longer wanted
    this.shownKey = 'live';
    this.deps.log(this.name, `live after ${((this.liveStart - this.sessionStart) / 1000).toFixed(1)} s`);
    this.deps.feed.armLive();
    this.encoder.start();
  }

  onLiveFeedClosed(code) {
    this.liveFeed = null;
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
    this.liveFeed?.stop();             // closing the feed lets the camera sleep
    this.liveFeed = null;
    const now = this.deps.now();
    this.deps.log(this.name, `stopped (${why}) after ${((now - this.sessionStart) / 1000).toFixed(0)} s`);
    if (this.liveStart) {
      this.picture = { raw: this.frame };
      this.pictureFromEvent = false;
      this.deps.saveLastFrame(this, this.frame);
    } else {
      this.failedAt = now;               // never got a picture: "Didn't wake up"
    }
    this.state = 'IDLE';
    this.lastStop = now;
    this.refresh();                      // the live encoder keeps the last picture on air meanwhile
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

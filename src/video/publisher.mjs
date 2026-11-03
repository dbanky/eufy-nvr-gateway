// The one never-ending stream per camera, as RTP packets handed to the gateway's stream hub
// (rtsp/stream-hub.mjs), which serves them to every viewer: the Feed's video (loop or live) and, with
// sound, the AudioFeed's AAC. No ffmpeg, nothing re-encoded.
//
// Picture and sound are independent, and neither ever waits for the other:
// - every live frame and every camera audio frame goes out the moment it arrives, stamped with its
//   arrival time; nothing is buffered, re-paced or dropped
// - the sleeping loop plays at exactly `fps`
// - the sound is one continuous track, its frames placed by an AudioTimeline (audio-timeline.mjs):
//   the camera's sound as recorded, silence where there is none
// Both tracks are stamped on the one wall clock (rtp.mjs), which is all a player needs to keep
// them in sync.
//
// When the stream has to start again (the camera's codec changed), it is opened again at once with
// the new description, and everything since the last keyframe (picture and sound) is sent first.

import { randomBytes } from 'node:crypto';
import { isKeyframe } from './annexb.mjs';
import { STREAM_FORMAT } from '../audio/adts.mjs';
import { AudioTimeline, MAX_CATCH_UP_MS } from './audio-timeline.mjs';
import { VIDEO_PT, AUDIO_PT, VIDEO_RATE, rtpTime, framePayloads, aacPayload, parameterSets, publishSdp, rtpPacket } from './rtp.mjs';

export const RECONNECT_MS = 500;
export const MAX_REPLAY = 3000;        // packet groups kept for a resend (a very long GOP)
const VIDEO_TRACK = 0, AUDIO_TRACK = 1;

// The timestamp (ms) a live frame gets: its arrival, but never closer than half a frame to the one
// before, so a burst (the network delivers several at once) still plays as motion.
export const liveFrameTime = (arrival, previous, fps) => Math.max(arrival, previous + 500 / fps);

export class Publisher {
  // audio: an AudioFeed, or null for a stream without sound. publish({ sdp, codec }): opens the stream
  // (StreamHub.publish) and returns its Publication: send(track, packet, startsKeyframe), media(), close().
  constructor({ name, fps, feed, audio = null, log, now = Date.now, publish }) {
    Object.assign(this, { name, fps, feed, audio, log, now, publish });
    this.interval = 1000 / fps;
    this.publication = null;      // the open stream in the hub
    this.rtpTracks = [];          // [{ ssrc, seq }] per track of the open stream
    this.replay = [];             // { track, ts, payloads, key } since the last keyframe, in order
    this.keyframe = null;         // the newest keyframe sent (for the SDP's parameter sets)
    this.needKeyframe = true;     // nothing a viewer could decode goes out before one
    this.lastVideoMs = -Infinity;
    this.nextLoopAt = null;       // when the sleeping loop's next frame is due
    this.audioTimeline = new AudioTimeline();
    this.stopped = false;
  }

  start() {
    this.feed.on('live', () => this.drainLive());
    this.feed.on('codec', (codec) => this.codecChanged(codec));
    this.audio?.on('frame', (frame) => this.sendAudio(frame, this.audioTimeline.cameraFrame(this.now())));
    this.timer = setInterval(() => this.tick(), 10);
    this.openStream();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.publication?.close('stopped');
  }

  // Every 10 ms: the sleeping loop's frames that are due (or live frames waiting), and silence.
  tick() {
    const now = this.now();
    if (this.feed.mode === 'live') this.drainLive();
    else this.playLoop(now);
    if (this.audio?.silence) this.fillSilence(now);
  }

  fillSilence(now) {
    for (const ms of this.audioTimeline.silenceUntil(now, this.audio.live)) this.sendAudio(this.audio.silence, ms);
  }

  // The stream has to start again with the new codec's description, from its first keyframe.
  codecChanged(codec) {
    this.log(this.name, `stream codec now ${codec}, restarting the stream`);
    this.replay = [];
    this.keyframe = null;
    this.needKeyframe = true;
    this.publication?.close('codec changed');
  }

  // The sleeping loop at exactly `fps`. After a stall it carries on from now rather than bursting
  // every frame it missed.
  playLoop(now) {
    if (this.nextLoopAt == null || now - this.nextLoopAt > MAX_CATCH_UP_MS) this.nextLoopAt = Math.max(now, this.lastVideoMs + this.interval);
    while (this.nextLoopAt <= now) {
      const frame = this.feed.next({ fromKeyframe: this.needKeyframe });
      if (!frame) return;
      this.sendVideo(frame, Math.max(this.nextLoopAt, this.lastVideoMs + this.interval / 2));
      this.nextLoopAt += this.interval;
    }
  }

  // Every live frame waiting, each stamped with its arrival.
  drainLive() {
    for (let frame; (frame = this.feed.next({ fromKeyframe: this.needKeyframe }));) {
      this.sendVideo(frame, liveFrameTime(this.feed.arrivalOf(frame) ?? this.now(), this.lastVideoMs, this.fps));
    }
    this.nextLoopAt = null;   // the loop, when it comes back, starts after the last live frame
  }

  sendVideo(frame, ms) {
    const key = isKeyframe(frame, this.feed.codec);
    if (this.needKeyframe && !key) return;
    this.needKeyframe = false;
    if (key) {
      this.keyframe = frame;
      this.replay = [];   // a viewer starts here: nothing before it is needed any more
      if (!this.publication) this.openStream();
    }
    this.lastVideoMs = ms;
    this.publication?.media('video', frame);
    this.emitGroup({ track: VIDEO_TRACK, ts: rtpTime(ms, VIDEO_RATE), payloads: framePayloads(frame, this.feed.codec), key });
  }

  sendAudio(frame, ms) {
    this.publication?.media('audio', frame);
    const payload = aacPayload(frame);
    if (payload) this.emitGroup({ track: AUDIO_TRACK, ts: rtpTime(ms, STREAM_FORMAT.sampleRate), payloads: [payload] });
  }

  // One frame's RTP payloads: kept for a resend, and sent if the stream is open.
  emitGroup(group) {
    if (this.replay.length < MAX_REPLAY) this.replay.push(group);
    if (this.publication?.ready) this.sendPackets(group);
  }

  // The payloads as RTP packets, the marker on the last one. A keyframe's first packet is marked
  // for the hub: a new viewer's video starts there.
  sendPackets({ track, ts, payloads, key = false }) {
    const rtp = this.rtpTracks[track];
    payloads.forEach((payload, i) => {
      const marker = i === payloads.length - 1;
      const packet = rtpPacket({ pt: track === AUDIO_TRACK ? AUDIO_PT : VIDEO_PT, seq: rtp.seq++, ts, ssrc: rtp.ssrc, marker, payload });
      this.publication.send(track, packet, key && i === 0);
    });
  }

  // Opens the stream in the hub once there is a keyframe to describe it with (its parameter sets
  // go into the SDP). Without one yet, sendVideo opens it at the first keyframe.
  openStream() {
    if (this.stopped || this.publication) return;
    const keyframe = this.keyframe ?? this.feed.loop?.[0];
    if (!keyframe) return;
    const codec = this.feed.codec, audio = !!this.audio;
    const sdp = publishSdp({ codec, params: parameterSets(keyframe, codec), audio });
    this.rtpTracks = [VIDEO_TRACK, AUDIO_TRACK].map(newRtpTrack);
    const publication = this.publish({ sdp, codec });
    this.publication = publication;
    publication.on('ready', () => {
      this.log(this.name, `stream ready (${codec}${audio ? ', AAC audio' : ''})`);
      for (const group of this.replay) this.sendPackets(group);   // since the last keyframe: nothing lost
    });
    publication.on('close', (reason) => this.streamClosed(publication, reason));
  }

  // Opened again after RECONNECT_MS, unless the publisher stopped (or it was an older stream).
  streamClosed(publication, reason) {
    if (this.publication !== publication) return;
    this.publication = null;
    if (this.stopped) return;
    this.log(this.name, `stream ended (${reason}), starting it again`);
    setTimeout(() => this.openStream(), RECONNECT_MS).unref?.();
  }
}

// A random SSRC and starting sequence number, as RTP asks for.
const newRtpTrack = () => ({ ssrc: randomBytes(4).readUInt32BE(0), seq: randomBytes(2).readUInt16BE(0) });

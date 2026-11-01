// The one never-ending stream per camera: an "ffmpeg -c copy" that sends whatever the Feed hands
// it to go2rtc, at exactly `fps` frames per second. It never encodes video itself.
//
// With audio (an AudioFeed), a second input carries AAC frames (pipe:3). Raw inputs have no
// timestamps: video is numbered by frame, audio by sample. So audio is paced by the video frames
// actually written, not by the clock: both timelines stay equal even when live video runs short.

import { spawnFfmpeg } from './ffmpeg.mjs';

// How many frames should have been sent `elapsedMs` after the start (the first one at once).
export const framesDue = (elapsedMs, fps) => Math.floor(elapsedMs * fps / 1000) + 1;

// After a stall (busy CPU), don't burst out everything that was missed: just carry on.
export const MAX_CATCH_UP_SECONDS = 2;

// Audio frames (1024 samples each) that belong with `videoFrames` frames of video, the first at once.
export const audioFramesDue = (videoFrames, fps, sampleRate = 16000) => Math.floor(videoFrames * sampleRate / (1024 * fps)) + 1;

// ffmpeg interleaves by time: it can stop reading video until it has sound up to that time. Sound
// paced only by the video written would then never come, a deadlock that silently ends the stream.
// It happens when the sound timeline falls behind, e.g. for every camera audio frame ffmpeg can't
// decode and drops. So when ffmpeg visibly waits for sound (video blocked, the sound pipe free,
// nothing more due), one more sound frame goes out, and the extra is kept for good: it makes up
// for the frame that was lost, so picture and sound stay in step.
export const WAIT_FOR_SOUND_MS = 100;
export const MAX_EXTRA_SOUND_SECONDS = 10;

// Whether to add one more sound frame now (see above).
export const soundWanted = ({ videoBlockedMs, audioBlocked, audioSent, audioDue, extra, fps }) =>
  videoBlockedMs > WAIT_FOR_SOUND_MS && !audioBlocked && audioSent >= audioDue && extra < MAX_EXTRA_SOUND_SECONDS * fps;

// ffmpeg that takes no video for this long is stuck (go2rtc has already dropped it): restart it.
export const STALL_SECONDS = 10;

// Raw H.264/H.265 has no timestamps: the frames are numbered at the fixed rate instead (setts).
//
// With audio, three more things are needed:
// - Arrival-time stamps on both inputs. ffmpeg reads its inputs in timestamp order, and the raw video
//   has none until setts numbers it on the way out: ffmpeg would hold the audio back for good.
// - No probing of the audio input: its format is fixed, and while ffmpeg waited for seconds of audio
//   to analyse, the video pipe (and so the audio, paced by the video) would stall.
// - The sound re-encoded, numbered by sample (asetpts): RTSP announces AAC by a configuration that
//   copied ADTS can't give, and AAC-LC 16 kHz mono costs next to nothing (video stays a copy).
export function publisherArgs({ fps, codec, output, audio = false }) {
  const format = output.startsWith('rtsp://') ? ['-f', 'rtsp', '-rtsp_transport', 'tcp'] : ['-f', 'mpegts'];
  const stamped = audio ? ['-use_wallclock_as_timestamps', '1'] : [];
  const audioIn = audio ? [...stamped, '-probesize', '32', '-analyzeduration', '0', '-f', 'aac', '-i', 'pipe:3', '-map', '0:v', '-map', '1:a'] : [];
  const audioOut = audio ? ['-af', 'asetpts=N/SR/TB', '-c:a', 'aac', '-b:a', '32k', '-ar', '16000', '-ac', '1'] : [];
  return [...stamped, '-f', codec, '-framerate', String(fps), '-i', 'pipe:0', ...audioIn, '-c:v', 'copy', ...audioOut,
    '-bsf:v', `setts=ts=N/(${fps}*TB)`, ...format, output];
}

export class Publisher {
  // audio: an AudioFeed, or null for a stream without sound.
  constructor({ name, fps, output, feed, audio = null, log }) {
    Object.assign(this, { name, fps, output, feed, audio, log });
    // A new codec (the camera's own H.265 passed through) needs a new ffmpeg: restart.
    feed.on('codec', (codec) => {
      this.log(this.name, `stream codec now ${codec}, restarting the stream`);
      this.child?.kill('SIGTERM');
    });
  }

  start() {
    const audio = this.audio;
    const child = spawnFfmpeg(publisherArgs({ fps: this.fps, codec: this.feed.codec, output: this.output, audio: !!audio }),
      { extraPipes: audio ? 1 : 0 });
    this.child = child;
    const audioPipe = audio ? child.stdio[3] : null;
    child.stderr.on('data', (c) => this.log(this.name, 'publisher:', String(c).trim()));
    child.on('error', (e) => this.log(this.name, 'publisher error:', e.message));

    const startedAt = Date.now();
    let sent = 0, written = 0, needKeyframe = true, blocked = false, blockedSince = 0, stalled = false;
    let audioSent = 0, audioBlocked = false, extraSound = 0;
    child.stdin.on('drain', () => { blocked = false; });
    audioPipe?.on('drain', () => { audioBlocked = false; });
    const tick = setInterval(() => {
      const due = framesDue(Date.now() - startedAt, this.fps);
      if (due - sent > this.fps * MAX_CATCH_UP_SECONDS) sent = due - 1;
      while (sent < due && !blocked) {
        const frame = this.feed.next({ fromKeyframe: needKeyframe });
        if (!frame) break;
        needKeyframe = false;
        blocked = !child.stdin.write(frame);
        sent++;
        written++;
      }
      if (!blocked) blockedSince = 0;
      else if (!blockedSince) blockedSince = Date.now();
      else if (!stalled && Date.now() - blockedSince > STALL_SECONDS * 1000) {
        stalled = true;
        this.log(this.name, `publisher took no video for ${STALL_SECONDS} s, restarting the stream`);
        child.kill('SIGKILL');
      }
      if (!audioPipe) return;
      const audioDue = audioFramesDue(written, this.fps) + extraSound;
      const videoBlockedMs = blockedSince ? Date.now() - blockedSince : 0;
      if (soundWanted({ videoBlockedMs, audioBlocked, audioSent, audioDue, extra: extraSound, fps: this.fps })) extraSound++;
      const audioWanted = audioFramesDue(written, this.fps) + extraSound;
      while (audioSent < audioWanted && !audioBlocked) {
        audioBlocked = !audioPipe.write(audio.next());
        audioSent++;
      }
    }, 20);

    child.on('close', (code) => {
      clearInterval(tick);
      this.log(this.name, `publisher exited (${code}), restarting in 2 s`);
      setTimeout(() => this.start(), 2000);
    });
    this.log(this.name, `stream → ${this.output} (${this.feed.codec} @ ${this.fps} fps${audio ? ', AAC audio' : ''})`);
  }
}

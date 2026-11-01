// The publisher: picture and sound into go2rtc, each the moment it is there, neither waiting for
// the other, nothing dropped.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Publisher, liveFrameTime, liveAudioTime, silenceDue, SILENCE_AFTER_MS, LIVE_GAP_MS, AUDIO_FRAME_MS } from '../../src/video/publisher.mjs';
import { Feed } from '../../src/video/feed.mjs';
import { AudioFeed } from '../../src/audio/audio-feed.mjs';
import { rtpTime } from '../../src/video/rtp.mjs';
import { keyframe, deltaFrame } from '../helpers/h264.mjs';
import { adtsFrame } from '../helpers/aac.mjs';

const T0 = 1_762_000_000_000;
const SILENCE = adtsFrame(Buffer.alloc(4, 0));
const sound = (n) => adtsFrame(Buffer.alloc(8, n));

function rig({ audio = false } = {}) {
  let now = T0;
  const clock = () => now;
  const pushes = [];
  const pushImpl = (opts) => {
    const push = Object.assign(new EventEmitter(), { ...opts, ready: false, sent: [] });
    push.send = (track, packet) => push.sent.push({ track, ts: packet.readUInt32BE(4), marker: !!(packet[1] & 0x80), packet });
    push.close = (reason) => push.emit('close', reason);
    push.open = () => { push.ready = true; push.emit('ready'); };
    pushes.push(push);
    return push;
  };
  const feed = new Feed({ now: clock });
  const audioFeed = audio ? new AudioFeed({ silence: SILENCE }) : null;
  feed.showLoop([keyframe(1), deltaFrame(2), deltaFrame(3)]);
  const pub = new Publisher({ name: 'garden', fps: 15, output: 'rtsp://127.0.0.1:28554/garden', feed, audio: audioFeed, log: () => {}, now: clock, pushImpl });
  pub.start();
  clearInterval(pub.timer);   // the test drives the clock
  const at = (ms) => { now = T0 + ms; pub.tick(); };
  return { pub, feed, audioFeed, pushes, at, setNow: (ms) => { now = T0 + ms; } };
}
const video = (push) => push.sent.filter((p) => p.track === 0);
const sounds = (push) => push.sent.filter((p) => p.track === 1);

describe('the sleeping loop', () => {
  test('plays at exactly the frame rate, stamped on the wall clock', () => {
    const { pushes, at } = rig();
    pushes[0].open();
    for (let ms = 0; ms <= 1010; ms += 10) at(ms);
    const v = video(pushes[0]);
    assert.equal(v.length, 16, 'the first at once, then 15 a second');
    assert.equal(v[0].ts, rtpTime(T0, 90000));
    assert.ok(v.slice(1).every((p, i) => p.ts - v[i].ts === 6000), '1/15 s apart');
  });
});

describe('live video', () => {
  test('each frame goes out the moment it arrives, stamped with its arrival', () => {
    const { feed, pushes, at, setNow } = rig();
    pushes[0].open();
    at(0);
    feed.armLive();
    setNow(500);
    feed.pushLive(keyframe(9));
    const v = video(pushes[0]);
    assert.equal(v.at(-1).ts, rtpTime(T0 + 500, 90000), 'sent by pushLive itself, with no tick in between');
  });

  test('a burst is sent at once and complete, spread half a frame apart so it still plays as motion', () => {
    const { feed, pushes, at, setNow } = rig();
    pushes[0].open();
    at(0);
    feed.armLive();
    setNow(1000);
    const before = video(pushes[0]).length;
    feed.pushLive(keyframe(10));
    for (let i = 0; i < 40; i++) feed.pushLive(deltaFrame(i));
    const burst = video(pushes[0]).slice(before);
    assert.equal(burst.length, 41, 'nothing dropped');
    assert.ok(burst.slice(1).every((p, i) => p.ts - burst[i].ts === 3000));
  });

  test('frames are never re-paced to the loop\'s rate or held back', () => {
    assert.equal(liveFrameTime(T0 + 100, T0, 15), T0 + 100);
    assert.equal(liveFrameTime(T0 + 10, T0, 15), T0 + 500 / 15);
  });
});

describe('sound', () => {
  test('a camera audio frame goes out the moment it arrives, without waiting for any picture', () => {
    const { audioFeed, pushes, at, setNow } = rig({ audio: true });
    pushes[0].open();
    at(0);
    const sent = sounds(pushes[0]).length;
    audioFeed.startLive();
    setNow(40);
    audioFeed.pushLive(sound(1));
    const s = sounds(pushes[0]);
    assert.equal(s.length, sent + 1);
    assert.equal(s.at(-1).ts, rtpTime(T0 + 40, 16000));
  });

  test('picture and sound are independent: sound flows while no video comes, video while no sound comes', () => {
    const { feed, audioFeed, pushes, at, setNow } = rig({ audio: true });
    pushes[0].open();
    at(0);
    feed.armLive();
    feed.pushLive(keyframe(5));          // live, then the camera's video stalls
    audioFeed.startLive();
    const v = video(pushes[0]).length;
    for (let ms = 100; ms <= 2000; ms += 64) { setNow(ms); audioFeed.pushLive(sound(ms & 0xff)); }
    assert.equal(video(pushes[0]).length, v, 'no video meanwhile');
    assert.ok(sounds(pushes[0]).length >= 30, 'all the sound went out anyway');
    audioFeed.stopLive();
    for (let i = 0; i < 20; i++) { setNow(2100 + i * 66); feed.pushLive(deltaFrame(i)); }
    assert.equal(video(pushes[0]).length, v + 20, 'and the video flows without sound');
  });

  test('a burst of sound stays one continuous track: each frame right after the one before', () => {
    assert.equal(liveAudioTime(T0, T0 + 64, false), T0 + 64);
    const { audioFeed, pushes, at, setNow } = rig({ audio: true });
    pushes[0].open();
    at(0);
    audioFeed.startLive();
    setNow(1000);
    const before = sounds(pushes[0]).length;
    for (let i = 0; i < 10; i++) audioFeed.pushLive(sound(i));
    const burst = sounds(pushes[0]).slice(before);
    assert.equal(burst.length, 10);
    assert.ok(burst.slice(1).every((p, i) => p.ts - burst[i].ts === 1024));
  });

  test('after a network hiccup, the late burst fills the gap it belongs to: the sound doesn\'t fall behind the picture', () => {
    assert.equal(liveAudioTime(T0 + 900, T0 + 64, false), T0 + 64, 'a 0.8 s pause: back to back, as recorded');
    assert.equal(liveAudioTime(T0 + 3000, T0 + 64, false), T0 + 3000 - LIVE_GAP_MS, 'a real gap: no further behind than that');
    assert.equal(liveAudioTime(T0 + 900, T0 + 64, true), T0 + 900, 'after silence: at its arrival, with the picture');
    const { audioFeed, pushes, at, setNow } = rig({ audio: true });
    pushes[0].open();
    at(0);
    audioFeed.startLive();
    let ms = 1000;
    const before = sounds(pushes[0]).length;
    for (let i = 0; i < 16; i++, ms += 64) { setNow(ms); audioFeed.pushLive(sound(1)); at(ms); }   // 1 s of sound
    for (let t = ms; t < ms + 800; t += 10) at(t);                                                   // 0.8 s nothing
    setNow(ms + 800);
    for (let i = 0; i < 28; i++) audioFeed.pushLive(sound(2));                                       // then all of it at once
    const live = sounds(pushes[0]).slice(before);
    assert.equal(live.length, 16 + 28, 'no silence slipped in');
    assert.ok(live.slice(1).every((p, i) => p.ts - live[i].ts === 1024), 'one continuous track');
    assert.ok(live.at(-1).ts <= rtpTime(T0 + ms + 800 + 1000, 16000), 'not piled up past the clock');
  });

  test('silence fills only the time the camera sends none, so the track never stops', () => {
    assert.equal(silenceDue(T0 + 1000, T0 + 1000 - SILENCE_AFTER_MS), 0);
    assert.equal(silenceDue(T0 + 1000, T0 + 1000 - SILENCE_AFTER_MS - 1), 1);
    const { audioFeed, pushes, at, setNow } = rig({ audio: true });
    pushes[0].open();
    for (let ms = 0; ms <= 2000; ms += 10) at(ms);
    const idle = sounds(pushes[0]);
    assert.ok(Math.abs(idle.length - 2000 / AUDIO_FRAME_MS) <= 6, 'silence while asleep, in real time');
    audioFeed.startLive();
    const before = sounds(pushes[0]).length;
    for (let ms = 2000; ms <= 4000; ms += 64) { setNow(ms); audioFeed.pushLive(sound(1)); at(ms + 1); }
    const live = sounds(pushes[0]).slice(before);
    assert.ok(live.every((p) => !p.packet.subarray(12).equals(Buffer.from(SILENCE.subarray(7)))), 'no silence mixed into flowing camera sound');
  });
});

describe('the connection to go2rtc', () => {
  test('announces H.264 with the loop\'s parameters, and sound when there is some', () => {
    assert.match(rig({ audio: true }).pushes[0].sdp, /H264\/90000[\s\S]*MPEG4-GENERIC\/16000\/1/);
    assert.equal(rig({ audio: true }).pushes[0].tracks, 2);
    assert.equal(rig().pushes[0].tracks, 1);
  });

  test('when it drops, the new one first gets everything since the last keyframe: nothing lost', () => {
    const { pub, feed, audioFeed, pushes, at, setNow } = rig({ audio: true });
    pushes[0].open();
    at(0);
    feed.armLive();
    audioFeed.startLive();
    setNow(100); feed.pushLive(keyframe(7));
    setNow(150); audioFeed.pushLive(sound(1));
    setNow(166); feed.pushLive(deltaFrame(8));
    pushes[0].close('connection closed');
    setNow(200); feed.pushLive(deltaFrame(9));   // while it is down
    pub.connect();
    pushes[1].open();
    const v = video(pushes[1]).map((p) => p.ts);
    assert.deepEqual(v.slice(0, 3), [rtpTime(T0 + 100, 90000), rtpTime(T0 + 166, 90000), rtpTime(T0 + 200, 90000)]);
    assert.ok(sounds(pushes[1]).some((p) => p.ts === rtpTime(T0 + 150, 16000)));
  });

  test('a new codec (H.265 passed through) restarts it with the new description', () => {
    const { feed, pushes, at } = rig();
    pushes[0].open();
    at(0);
    feed.showLoop([Buffer.from([0, 0, 0, 1, 0x46, 0x01, 0x50, 0, 0, 0, 1, 0x26, 0x01, 0xaa])], 'hevc');
    at(100);
    assert.match(pushes.at(-1).sdp, /H265\/90000/);
  });
});

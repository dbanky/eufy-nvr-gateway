// A session stays live while the picture keeps moving, even when the camera sends no new detection
// (eufy cameras send none during continuing motion until their own re-trigger interval is over).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './world.mjs';
import { keyframe } from '../../helpers/h264.mjs';
import { THUMB_WIDTH, THUMB_HEIGHT } from '../../../src/switcher/picture-motion.mjs';

const still = Buffer.alloc(THUMB_WIDTH * THUMB_HEIGHT, 80);
const moved = (n) => { const t = Buffer.from(still); t.fill(200, (n % 10) * 64, (n % 10) * 64 + 120); return t; };

// A pass-through session that is live, with a keyframe thumbnail every 4 s from then on.
function liveSession(settings = {}) {
  const { cam, world } = setup({ holdMs: 30000, ...settings });
  cam.codec = 'h264';
  world.feed.showLoop([keyframe()], 'h264');
  cam.trigger('motion');
  const feed = world.liveFeeds[0];
  assert.equal(feed.mode, 'passthrough');
  feed.onFrame(keyframe());
  assert.equal(cam.state, 'LIVE');
  feed.onThumbnail(still);
  // Plays `seconds` of keyframes (every 4 s), moving or not; returns false once the session ended.
  const play = (seconds, picture) => {
    for (let s = 0; s < seconds; s += 4) {
      world.advance(4000);
      feed.onThumbnail(picture(s));
      cam.check();
      if (cam.state === 'IDLE') return false;
    }
    return true;
  };
  return { cam, world, play };
}

describe('motion in the live picture', () => {
  test('keeps the session live as long as the picture moves, then the usual hold time', () => {
    const { cam, world, play } = liveSession();
    assert.equal(play(120, moved), true, 'two minutes of movement, one detection: still live');
    assert.equal(play(28, () => still), true, 'the hold time runs from the last movement');
    assert.equal(play(8, () => still), false);
    assert.match(world.logs.join('\n'), /motion in the picture: staying live/);
  });

  test('a still picture ends the session after the hold time, as before', () => {
    const { play } = liveSession();
    assert.equal(play(36, () => still), false);
  });

  test('without a new detection it stays live at most motionInPictureMaxMs (battery: leaves in the wind)', () => {
    const { world, play } = liveSession({ motionInPictureMaxMs: 60000 });
    assert.equal(play(200, moved), false);
    assert.ok(world.now - Date.parse('2026-10-30T18:00:00Z') <= 64000);
  });

  test('a new detection from the camera allows another motionInPictureMaxMs', () => {
    const { cam, play } = liveSession({ motionInPictureMaxMs: 60000 });
    assert.equal(play(48, moved), true);
    cam.trigger('motion');
    assert.equal(play(48, moved), true, 'past the first 60 s thanks to the second detection');
  });

  test('switched off with motionInPicture: false', () => {
    const { play } = liveSession({ motionInPicture: false });
    assert.equal(play(36, moved), false);
  });

  test('also when converting: a thumbnail of the decoded picture every 4 s', () => {
    const { cam, world } = setup({ holdMs: 30000, width: 64, height: 48 });
    cam.trigger('motion');
    const feed = world.liveFeeds[0];
    assert.equal(feed.mode, 'transcode');
    const frame = (v) => { const f = Buffer.alloc(64 * 48 * 1.5, 128); f.fill(v, 0, 64 * 24); return f; };
    feed.onFrame(frame(0));
    for (let s = 0; s < 120; s += 1) {
      world.advance(1000);
      feed.onFrame(frame(s % 8 < 4 ? 0 : 250));
      cam.check();
    }
    assert.equal(cam.state, 'LIVE', 'two minutes of a changing picture');
  });
});

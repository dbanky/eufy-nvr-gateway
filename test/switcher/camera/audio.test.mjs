// A camera with `audio: true`: its sound is on the stream from the wake-up until the live
// connection closes, so nothing the camera hears is cut.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup, livePicture } from './world.mjs';
import { hevcKeyframe } from '../../helpers/h264.mjs';

function withAudio(settings = {}) {
  const { cam, world } = setup({ audio: true, ...settings });
  world.audio = [];
  cam.deps.openLiveAudio = () => {
    const audio = { stopped: false, stop() { this.stopped = true; } };
    world.audio.push(audio);
    return audio;
  };
  return { cam, world };
}

describe('a camera\'s sound', () => {
  test('starts with the wake-up, before the first picture arrives', () => {
    const { cam, world } = withAudio();
    cam.trigger('motion');
    assert.equal(cam.state, 'WAKING');
    assert.equal(world.audio.length, 1, 'listening while the camera wakes');
    world.liveFeeds[0].onFrame(livePicture);
    assert.equal(cam.state, 'LIVE');
    assert.equal(world.audio.length, 1, 'the same one carries on when the picture comes');
  });

  test('outlasts the hold time: the camera\'s video stays on air until the sleeping picture is ready, and so does its sound', async () => {
    const { cam, world } = withAudio({ holdMs: 10000 });
    cam.codec = 'hevc';
    await cam.refresh();
    cam.trigger('motion');
    const liveFeed = world.liveFeeds[0];
    liveFeed.onPicture(Buffer.from('jpeg'));
    liveFeed.onFrame(hevcKeyframe(1));
    world.advance(10001);
    cam.check();
    assert.equal(cam.state, 'IDLE');
    assert.equal(liveFeed.stopped, false);
    assert.equal(world.audio[0].stopped, false, 'live video still on air: so is the sound');
    await world.settle();
    assert.equal(liveFeed.stopped, true);
    assert.equal(world.audio[0].stopped, true, 'ends with the live connection');
  });

  test('a session that never got a picture ends its sound with it', () => {
    const { cam, world } = withAudio({ holdMs: 10000 });
    cam.trigger('motion');
    world.advance(10001);
    cam.check();
    assert.equal(cam.state, 'IDLE');
    assert.equal(world.audio[0].stopped, true);
  });

  test('one per session, also when the session is extended', () => {
    const { cam, world } = withAudio({ holdMs: 10000 });
    cam.trigger('motion');
    world.liveFeeds[0].onFrame(livePicture);
    cam.trigger('motion');
    world.liveFeeds[0].onFrame(livePicture);
    assert.equal(world.audio.length, 1);
  });

  test('a new session ends the previous session\'s sound first', () => {
    const { cam, world } = withAudio({ holdMs: 10000, restartGapMs: 0 });
    cam.trigger('motion');
    world.liveFeeds[0].onFrame(livePicture);
    world.advance(10001);
    cam.check();
    world.advance(60000);
    cam.trigger('motion');
    assert.equal(world.audio[0].stopped, true);
    assert.equal(world.audio.length, 2);
    assert.equal(world.audio[1].stopped, false);
  });

  test('the status says the stream has sound', () => {
    assert.equal(withAudio().cam.status().audio, 'AAC · 16 kHz mono');
    assert.equal(setup().cam.status().audio, null);
  });
});

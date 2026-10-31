// A camera with `audio: true`: its sound joins the stream exactly while it is live.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup, livePicture } from './world.mjs';

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
  test('starts when the camera goes live, not while it is still waking up', () => {
    const { cam, world } = withAudio();
    cam.trigger('motion');
    assert.equal(world.audio.length, 0, 'waking: no sound yet');
    world.liveFeeds[0].onFrame(livePicture);
    assert.equal(cam.state, 'LIVE');
    assert.equal(world.audio.length, 1);
  });

  test('stops the moment the session ends', () => {
    const { cam, world } = withAudio({ holdMs: 10000 });
    cam.trigger('motion');
    world.liveFeeds[0].onFrame(livePicture);
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

  test('the status says the stream has sound', () => {
    assert.equal(withAudio().cam.status().audio, 'AAC · 16 kHz mono');
    assert.equal(setup().cam.status().audio, null);
  });
});

// Converting live video to H.264 (default), or passing the camera's own video through.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './world.mjs';
import { hevcKeyframe, hevcDeltaFrame } from '../../helpers/h264.mjs';

describe('conversion (transcode)', () => {
  test('is on by default: the camera is decoded and re-encoded as H.264', () => {
    const { cam, world } = setup();
    assert.equal(cam.transcode, true);
    cam.trigger('motion');
    assert.equal(world.liveFeeds[0].mode, 'transcode');
  });

  test('a session learns which codec the camera sends, and keeps it for next time', () => {
    const { cam, world } = setup();
    cam.trigger('motion');
    world.liveFeeds[0].onCodec('hevc');
    assert.equal(cam.codec, 'hevc');
    assert.deepEqual(world.savedCodecs, ['hevc']);
  });
});

describe('with conversion turned off (transcode: false)', () => {
  test('the first session still converts: the camera\'s codec is not known yet', () => {
    const { cam, world } = setup({ transcode: false });
    cam.trigger('motion');
    assert.equal(world.liveFeeds[0].mode, 'transcode');
  });

  test('once the codec is known, the sleeping loops are encoded in it', async () => {
    const { cam, world } = setup({ transcode: false });
    cam.codec = 'hevc';
    await cam.refresh();
    assert.deepEqual(world.loopCodecs, ['hevc']);
    assert.equal(world.feed.codec, 'hevc');
  });

  test("then the camera's own video is passed through: no encoder runs", async () => {
    const { cam, world } = setup({ transcode: false });
    cam.codec = 'hevc';
    await cam.refresh();
    cam.trigger('motion');
    const liveFeed = world.liveFeeds[0];
    assert.equal(liveFeed.mode, 'passthrough');
    assert.equal(liveFeed.codec, 'hevc');
    liveFeed.onFrame(hevcDeltaFrame(1));         // a camera starts mid-GOP: nothing to show yet
    assert.equal(cam.state, 'WAKING');
    liveFeed.onFrame(hevcKeyframe(2));
    assert.equal(cam.state, 'LIVE', 'live from the first keyframe');
    assert.equal(world.feed.mode, 'live');
    assert.equal(world.encoder.running, false);
  });

  test("after the session its last keyframe picture becomes the sleeping picture; the camera's video stays on air until that is ready", async () => {
    const { cam, world } = setup({ transcode: false, holdMs: 10000 });
    cam.codec = 'hevc';
    await cam.refresh();
    cam.trigger('motion');
    const liveFeed = world.liveFeeds[0];
    liveFeed.onPicture(Buffer.from('jpeg'));
    liveFeed.onFrame(hevcKeyframe(1));
    world.advance(10001);
    cam.check();
    assert.equal(cam.state, 'IDLE');
    assert.equal(liveFeed.stopped, false, 'still on air while the sleeping picture renders');
    await world.settle();
    assert.equal(liveFeed.stopped, true);
    assert.deepEqual(cam.picture, { jpeg: Buffer.from('jpeg') });
    assert.deepEqual(world.savedFrames, [{ jpeg: Buffer.from('jpeg') }]);
  });

  test('if pass-through fails before any picture, that session converts instead', async () => {
    const { cam, world } = setup({ transcode: false });
    cam.codec = 'hevc';
    await cam.refresh();
    cam.trigger('motion');
    world.liveFeeds[0].onClose(1);
    assert.equal(world.liveFeeds[1].mode, 'transcode');
  });

  test('passes through only when the stream already has that codec (no mixing)', () => {
    const { cam, world } = setup({ transcode: false });
    cam.codec = 'hevc';                           // learned, but the H.265 loop isn't rendered yet
    cam.trigger('motion');
    assert.equal(world.liveFeeds[0].mode, 'transcode');
  });
});

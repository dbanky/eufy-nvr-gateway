import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../../src/switcher/camera.mjs';
import { createTimeFormat } from '../../src/switcher/time-format.mjs';
import { Feed } from '../../src/video/feed.mjs';
import { keyframe } from '../helpers/h264.mjs';

// A camera wired to fakes: no ffmpeg, no files, a clock the test moves by hand.
function setup(settings = {}) {
  const world = {
    now: Date.parse('2026-10-30T18:00:00Z'),
    offline: null,
    renders: [],        // every view the stream was asked to show
    liveFeeds: [],      // every time the camera was woken
    savedFrames: [],
    encoder: { running: false, start() { this.running = true; }, stop() { this.running = false; } },
    feed: new Feed(),
    logs: [],
  };
  const cam = new Camera({ name: 'garden', serial: 'T81XXXXXXXXXXXXX', width: 64, height: 36, ...settings }, {
    log: (...a) => world.logs.push(a.join(' ')),
    now: () => world.now,
    time: createTimeFormat('UTC'),
    offline: () => world.offline,
    feed: world.feed,
    renderLoop: async ({ view }) => {
      world.renders.push(view);
      return { still: Buffer.from(`still:${view.kind}`), frames: [keyframe()] };
    },
    openLiveFeed: ({ onFrame, onClose }) => {
      const liveFeed = { onFrame, onClose, stopped: false, stop() { this.stopped = true; } };
      world.liveFeeds.push(liveFeed);
      return liveFeed;
    },
    createEncoder: () => world.encoder,
    saveLastFrame: (c, frame) => world.savedFrames.push(frame),
  });
  world.advance = (ms) => { world.now += ms; };
  world.lastRender = () => world.renders.at(-1);
  world.settle = () => new Promise(setImmediate);   // let async renders finish
  return { cam, world };
}

const livePicture = Buffer.from('a live frame');

describe('a sleeping camera', () => {
  test('without any picture yet shows "No picture yet"', async () => {
    const { cam, world } = setup();
    await cam.refresh();
    assert.equal(world.lastRender().kind, 'nopicture');
  });

  test('is rendered once per change, not on every refresh', async () => {
    const { cam, world } = setup();
    await cam.refresh();
    await cam.refresh();
    assert.equal(world.renders.length, 1);
  });

  test('shows the offline label when eufy is unreachable, and goes back when it returns', async () => {
    const { cam, world } = setup();
    cam.picture = { file: 'last.jpg' };
    world.offline = 'login';
    await cam.refresh();
    assert.equal(world.lastRender().kind, 'offline');
    world.offline = null;
    await cam.refresh();
    assert.equal(world.lastRender().kind, 'asleep');
  });
});

describe('a motion event', () => {
  test('wakes the camera: the live feed opens and the stream says "Waking up"', async () => {
    const { cam, world } = setup();
    cam.trigger('motion');
    await world.settle();
    assert.equal(cam.state, 'WAKING');
    assert.equal(world.liveFeeds.length, 1);
    assert.deepEqual(world.lastRender(), { kind: 'waking', title: 'Waking up', detail: 'Motion detected · 18:00' });
  });

  test('the first live picture switches to LIVE and starts the encoder', () => {
    const { cam, world } = setup();
    cam.trigger('motion');
    world.advance(5000);
    world.liveFeeds[0].onFrame(livePicture);
    assert.equal(cam.state, 'LIVE');
    assert.equal(world.encoder.running, true);
    assert.equal(world.feed.liveArmed, true);
    assert.equal(cam.frame, livePicture);
  });

  test('a second event while awake extends the session instead of waking it twice', () => {
    const { cam, world } = setup();
    cam.trigger('motion');
    world.liveFeeds[0].onFrame(livePicture);
    const deadline = cam.deadline;
    world.advance(60000);
    cam.trigger('personDetected');
    assert.equal(world.liveFeeds.length, 1);
    assert.equal(cam.deadline, deadline + 60000);
  });
});

describe('the end of a session', () => {
  test('closes the live feed, keeps the last frame and shows "Sleeping since"', async () => {
    const { cam, world } = setup({ holdMs: 10000 });
    cam.trigger('motion');
    world.liveFeeds[0].onFrame(livePicture);
    world.advance(10001);
    cam.check();
    await world.settle();
    assert.equal(cam.state, 'IDLE');
    assert.equal(world.liveFeeds[0].stopped, true);
    assert.deepEqual(world.savedFrames, [livePicture]);
    assert.deepEqual(cam.picture, { raw: livePicture });
    assert.deepEqual(world.lastRender(), { kind: 'asleep', title: 'Sleeping', detail: 'since 18:00' });
  });

  test('the live encoder stays on air until the sleeping picture is ready', async () => {
    const { cam, world } = setup({ holdMs: 10000 });
    cam.trigger('motion');
    world.liveFeeds[0].onFrame(livePicture);
    world.advance(10001);
    cam.check();
    assert.equal(world.encoder.running, true, 'still running while the picture renders');
    await world.settle();
    assert.equal(world.encoder.running, false);
    assert.equal(world.feed.mode, 'loop');
  });

  test('a camera that sends no picture in time: "Didn\'t wake up"', async () => {
    const { cam, world } = setup({ firstFrameTimeoutMs: 60000 });
    cam.picture = { file: 'last.jpg' };
    cam.trigger('motion');
    world.advance(60001);
    cam.check();
    await world.settle();
    assert.equal(world.lastRender().kind, 'nowake');
    assert.deepEqual(world.savedFrames, [], 'there was no live frame to keep');
  });

  test('a sleeping picture still rendering when the camera goes live is thrown away', async () => {
    const { cam, world } = setup();
    cam.trigger('motion');                 // starts rendering "Waking up"
    world.liveFeeds[0].onFrame(livePicture); // live before that render finished
    await world.settle();
    assert.equal(cam.frame, livePicture);
    assert.equal(world.feed.loop, null, 'the waking loop never reached the stream');
  });
});

describe('a feed that drops mid-session', () => {
  test('is re-opened after 2 s, up to maxReconnects times, then the session ends', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { cam, world } = setup({ maxReconnects: 1 });
      cam.trigger('motion');
      world.liveFeeds[0].onFrame(livePicture);
      world.liveFeeds[0].onClose(1);
      mock.timers.tick(2000);
      assert.equal(world.liveFeeds.length, 2);
      world.liveFeeds[1].onClose(1);
      assert.equal(cam.state, 'IDLE');
    } finally {
      mock.timers.reset();
    }
  });
});

describe('the battery', () => {
  test('below the limit, motion is ignored but the doorbell still wakes the camera', () => {
    const { cam, world } = setup({ minBatteryPct: 15 });
    cam.battery = 10;
    cam.trigger('motion');
    assert.equal(cam.state, 'IDLE');
    cam.trigger('doorbellPress');
    assert.equal(cam.state, 'WAKING');
    assert.equal(world.liveFeeds.length, 1);
  });
});

// A camera wired to fakes, shared by the camera tests: no ffmpeg, no files, and a clock the test
// moves by hand. `world` records what the camera did: renders, live feeds, saved frames and codecs.

import { Camera } from '../../../src/switcher/camera/camera.mjs';
import { createTimeFormat } from '../../../src/switcher/time-format.mjs';
import { Feed } from '../../../src/video/feed.mjs';
import { keyframe, hevcKeyframe } from '../../helpers/h264.mjs';

export function setup(settings = {}) {
  const world = {
    now: Date.parse('2026-10-30T18:00:00Z'),
    offline: null,
    renders: [],        // every view the stream was asked to show
    liveFeeds: [],      // every time the camera was woken
    savedFrames: [],
    encoder: { running: false, start() { this.running = true; }, stop() { this.running = false; } },
    feed: new Feed(),
    logs: [],
    loopCodecs: [],
    savedCodecs: [],
  };
  const cam = new Camera({ name: 'garden', serial: 'T81XXXXXXXXXXXXX', width: 64, height: 36, ...settings }, {
    log: (...a) => world.logs.push(a.join(' ')),
    now: () => world.now,
    time: createTimeFormat('UTC'),
    offline: () => world.offline,
    feed: world.feed,
    renderLoop: async ({ view, codec }) => {
      world.renders.push(view);
      world.loopCodecs.push(codec);
      return { still: Buffer.from(`still:${view.kind}`), frames: [codec === 'hevc' ? hevcKeyframe() : keyframe()] };
    },
    openLiveFeed: ({ onFrame, onCodec, onClose }) => {
      const liveFeed = { mode: 'transcode', onFrame, onCodec, onClose, stopped: false, stop() { this.stopped = true; } };
      world.liveFeeds.push(liveFeed);
      return liveFeed;
    },
    openPassthrough: ({ codec, onFrame, onPicture, onClose }) => {
      const liveFeed = { mode: 'passthrough', codec, onFrame, onPicture, onClose, stopped: false, stop() { this.stopped = true; } };
      world.liveFeeds.push(liveFeed);
      return liveFeed;
    },
    saveCodec: (c, codec) => world.savedCodecs.push(codec),
    createEncoder: () => world.encoder,
    saveLastFrame: (c, frame) => world.savedFrames.push(frame),
  });
  world.advance = (ms) => { world.now += ms; };
  world.lastRender = () => world.renders.at(-1);
  world.settle = () => new Promise(setImmediate);   // let async renders finish
  return { cam, world };
}

export const livePicture = Buffer.from('a live frame');

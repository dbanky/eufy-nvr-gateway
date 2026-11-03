// The streams in memory: publishers publish, viewers subscribe to an address.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StreamHub, viewerTracks, startVideoAtKeyframe } from '../../src/rtsp/stream-hub.mjs';
import { parseStreamPath } from '../../src/rtsp/stream-path.mjs';
import { publishSdp } from '../../src/video/rtp.mjs';

// garden has sound, front-door doesn't. The transcoders are stand-ins the test speaks for.
function rig() {
  const transcoders = [];
  const transcoderImpl = (opts) => {
    const t = Object.assign(new EventEmitter(), { kind: opts.kind, stopped: false });
    t.start = async () => {};
    t.stop = () => { t.stopped = true; };
    transcoders.push(t);
    return t;
  };
  const hub = new StreamHub({ cameras: [{ name: 'garden', width: 2880, height: 1616 }], transcoderImpl });
  const garden = hub.publish('garden', { sdp: publishSdp({ codec: 'h264', params: {}, audio: true }), codec: 'h264' });
  const frontDoor = hub.publish('front-door', { sdp: publishSdp({ codec: 'h264', params: {} }), codec: 'h264' });
  return { hub, garden, frontDoor, transcoders };
}

// A viewer: what it got as [track, packet number], and whether its stream ended.
function watch(source) {
  const got = [];
  let ended = false;
  const unsubscribe = source.subscribe((track, packet) => got.push([track, packet[0]]), () => { ended = true; });
  return { got, unsubscribe, ended: () => ended };
}
const packet = (n) => Buffer.from([n]);
const VIDEO = 0, SOUND = 1, KEYFRAME = true;

describe('which tracks a viewer gets', () => {
  const { garden, frontDoor } = rig();
  const tracksFor = (path, publication = garden) => viewerTracks(parseStreamPath(path), publication)
    ?.map((t) => t.kind ?? `own ${t.publisherTrack}`);

  test('the camera\'s own video and sound', () => {
    assert.deepEqual(tracksFor('garden'), ['own 0', 'own 1']);
  });

  test('~mjpeg and ~g711 put a transcoder\'s version in place of the original', () => {
    assert.deepEqual(tracksFor('garden~mjpeg'), ['mjpeg', 'own 1']);
    assert.deepEqual(tracksFor('garden~g711'), ['own 0', 'pcmu']);
    assert.deepEqual(tracksFor('garden~mjpeg~g711'), ['mjpeg', 'pcmu']);
  });

  test('?video, or a camera without sound: the video only', () => {
    assert.deepEqual(tracksFor('garden?video'), ['own 0']);
    assert.deepEqual(tracksFor('front-door', frontDoor), ['own 0']);
  });

  test('G.711 of a camera without sound: no such stream', () => {
    assert.equal(tracksFor('front-door~g711', frontDoor), undefined);
  });
});

describe('a viewer\'s video starts at a keyframe', () => {
  test('packets before the first keyframe are held back; from it on everything passes', () => {
    const got = [];
    const deliver = startVideoAtKeyframe((track, p) => got.push(p[0]));
    deliver(VIDEO, packet(1), false);
    deliver(VIDEO, packet(2), KEYFRAME);
    deliver(VIDEO, packet(3), false);
    assert.deepEqual(got, [2, 3]);
  });

  test('the sound doesn\'t wait for it', () => {
    const got = [];
    const deliver = startVideoAtKeyframe((track, p) => got.push([track, p[0]]));
    deliver(SOUND, packet(1), false);
    deliver(VIDEO, packet(2), false);
    assert.deepEqual(got, [[SOUND, 1]]);
  });
});

describe('the description a viewer gets', () => {
  test('the publisher\'s tracks, or the variant\'s: JPEG (PT 26) and G.711 µ-law (PT 0)', () => {
    const { hub } = rig();
    assert.match(hub.source('garden').sdp, /m=video 0 RTP\/AVP 96[\s\S]*m=audio 0 RTP\/AVP 97/);
    assert.match(hub.source('garden~mjpeg').sdp, /m=video 0 RTP\/AVP 26\r\na=rtpmap:26 JPEG\/90000\r\n[\s\S]*m=audio 0 RTP\/AVP 97/);
    assert.match(hub.source('garden~g711').sdp, /m=video 0 RTP\/AVP 96[\s\S]*m=audio 0 RTP\/AVP 0\r\na=rtpmap:0 PCMU\/8000\r\n/);
    assert.doesNotMatch(hub.source('garden?video').sdp, /m=audio/);
  });

  test('no stream for an address the hub doesn\'t have', () => {
    const { hub } = rig();
    assert.equal(hub.source('nobody'), null);
    assert.equal(hub.source('garden~flv'), null);
    assert.equal(hub.source('front-door~g711'), null);
  });
});

describe('watching', () => {
  test('the publisher\'s packets reach the viewer: the video from the next keyframe, the sound at once', () => {
    const { hub, garden } = rig();
    const viewer = watch(hub.source('garden'));
    garden.send(VIDEO, packet(1));
    garden.send(SOUND, packet(2));
    garden.send(VIDEO, packet(3), KEYFRAME);
    garden.send(VIDEO, packet(4));
    assert.deepEqual(viewer.got, [[SOUND, 2], [VIDEO, 3], [VIDEO, 4]]);
  });

  test('a track the viewer didn\'t ask for isn\'t sent to it', () => {
    const { hub, garden } = rig();
    const viewer = watch(hub.source('garden?video'));
    garden.send(SOUND, packet(1));
    garden.send(VIDEO, packet(2), KEYFRAME);
    assert.deepEqual(viewer.got, [[VIDEO, 2]]);
  });

  test('after unsubscribing, nothing more arrives', () => {
    const { hub, garden } = rig();
    const viewer = watch(hub.source('garden'));
    viewer.unsubscribe();
    garden.send(SOUND, packet(1));
    assert.deepEqual(viewer.got, []);
    assert.equal(garden.listenerCount('packet'), 0);
  });

  test('a new stream for the camera (a new codec) ends its viewers; they come back to the new one', () => {
    const { hub } = rig();
    const viewer = watch(hub.source('garden'));
    const next = hub.publish('garden', { sdp: publishSdp({ codec: 'hevc', params: {} }), codec: 'hevc' });
    assert.equal(viewer.ended(), true);
    assert.match(hub.source('garden').sdp, /H265/);
    assert.equal(next.listenerCount('packet'), 0, 'nobody is left on it from before');
  });

  test('a stream that closes is gone from the hub', () => {
    const { hub, frontDoor } = rig();
    frontDoor.close('stopped');
    assert.equal(hub.source('front-door'), null);
  });
});

describe('watching a JPEG or G.711 version', () => {
  test('the transcoder\'s packets go out as the variant\'s track, from the first picture start', () => {
    const { hub, garden, transcoders } = rig();
    const viewer = watch(hub.source('garden~mjpeg'));
    const [mjpeg] = transcoders;
    mjpeg.emit('packet', packet(1), false);   // the end of a picture already under way
    mjpeg.emit('packet', packet(2), true);
    garden.send(SOUND, packet(3));            // the camera's sound, as it is
    garden.send(VIDEO, packet(4), KEYFRAME);  // the camera's video: not in this variant
    assert.deepEqual(viewer.got, [[VIDEO, 2], [SOUND, 3]]);
  });

  test('the transcoders run while someone watches, shared by all viewers', () => {
    const { hub, transcoders } = rig();
    const a = watch(hub.source('garden~mjpeg'));
    const b = watch(hub.source('garden~mjpeg~g711'));
    assert.deepEqual(transcoders.map((t) => t.kind), ['mjpeg', 'pcmu']);
    a.unsubscribe();
    assert.equal(transcoders[0].stopped, false, 'b still watches');
    b.unsubscribe();
    assert.ok(transcoders.every((t) => t.stopped));
  });

  test('the stream ending stops the viewer\'s transcoders too', () => {
    const { hub, garden, transcoders } = rig();
    watch(hub.source('garden~mjpeg'));
    garden.close('stopped');
    assert.equal(transcoders[0].stopped, true);
  });
});

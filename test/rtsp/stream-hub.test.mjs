import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StreamHub, parsePath, sdpSections, viewerSdp } from '../../src/rtsp/stream-hub.mjs';
import { publishSdp } from '../../src/video/rtp.mjs';

const cameras = [{ name: 'garden', width: 2880, height: 1616 }, { name: 'front-door', width: 2048, height: 1536 }];

// Stand-in transcoders: they record how they were made and let the test send their packets.
function rig() {
  const made = [];
  const transcoderImpl = (opts) => {
    const t = Object.assign(new EventEmitter(), { opts, started: false, stopped: false });
    t.start = async () => { t.started = true; };
    t.stop = () => { t.stopped = true; };
    made.push(t);
    return t;
  };
  const hub = new StreamHub({ cameras, transcoderImpl });
  const garden = hub.publish('garden', { sdp: publishSdp({ codec: 'h264', params: {}, audio: true }), codec: 'h264' });
  const frontDoor = hub.publish('front-door', { sdp: publishSdp({ codec: 'h264', params: {} }), codec: 'h264' });
  return { hub, garden, frontDoor, made };
}
const watch = (source) => {
  const got = [];
  let ended = false;
  const stop = source.subscribe((track, packet, starts) => got.push({ track, n: packet[0], starts }), () => { ended = true; });
  return { got, stop, ended: () => ended };
};
const p = (n) => Buffer.from([n]);

describe('paths', () => {
  test('the camera, its variants and video-only, from a path or a whole URI', () => {
    assert.deepEqual(parsePath('garden'), { name: 'garden', mjpeg: false, g711: false, videoOnly: false });
    assert.deepEqual(parsePath('rtsp://192.168.1.10:8554/garden~mjpeg~g711'), { name: 'garden', mjpeg: true, g711: true, videoOnly: false });
    assert.deepEqual(parsePath('rtsp://192.168.1.10:8554/garden?video'), { name: 'garden', mjpeg: false, g711: false, videoOnly: true });
    assert.equal(parsePath('rtsp://192.168.1.10:8554/garden~flv'), null);
    assert.equal(parsePath('rtsp://192.168.1.10:8554/'), null);
  });
});

describe('what a viewer is told (SDP)', () => {
  test('the publisher\'s tracks, flowing from the device, numbered in order', () => {
    const sdp = viewerSdp(sdpSections(publishSdp({ codec: 'h264', params: {}, audio: true })));
    assert.match(sdp, /^v=0\r\no=- 1 1 IN IP4 0\.0\.0\.0\r\ns=eufy-nvr-gateway\r\nc=IN IP4 0\.0\.0\.0\r\nt=0 0\r\na=control:\*\r\n/);
    assert.match(sdp, /m=video 0 RTP\/AVP 96\r\na=rtpmap:96 H264\/90000\r\na=fmtp:96 packetization-mode=1\r\na=sendonly\r\na=control:trackID=0\r\n/);
    assert.match(sdp, /m=audio [\s\S]*a=sendonly\r\na=control:trackID=1\r\n$/);
    assert.doesNotMatch(sdp, /127\.0\.0\.1/);
  });

  test('variants: JPEG (RFC 2435, PT 26) and G.711 µ-law (PCMU, PT 0) in place of the originals', () => {
    const { hub } = rig();
    assert.match(hub.source('garden~mjpeg').sdp, /m=video 0 RTP\/AVP 26\r\na=rtpmap:26 JPEG\/90000\r\n[\s\S]*m=audio 0 RTP\/AVP 97/);
    assert.match(hub.source('garden~g711').sdp, /m=video 0 RTP\/AVP 96[\s\S]*m=audio 0 RTP\/AVP 0\r\na=rtpmap:0 PCMU\/8000\r\n/);
    assert.match(hub.source('garden~mjpeg~g711').sdp, /RTP\/AVP 26[\s\S]*RTP\/AVP 0\r\n/);
    assert.doesNotMatch(hub.source('garden?video').sdp, /m=audio/);
  });

  test('no stream: none to give; G.711 of a camera without sound: none either', () => {
    const { hub } = rig();
    assert.equal(hub.source('nobody'), null);
    assert.equal(hub.source('front-door~g711'), null);
    assert.ok(hub.source('front-door~mjpeg'));
  });
});

describe('watching', () => {
  test('the video starts at the next keyframe, the sound at once', () => {
    const { hub, garden } = rig();
    const v = watch(hub.source('garden'));
    garden.send(0, p(1));
    garden.send(1, p(2));
    garden.send(0, p(3), true);
    garden.send(0, p(4));
    assert.deepEqual(v.got.map((g) => [g.track, g.n]), [[1, 2], [0, 3], [0, 4]]);
    v.stop();
  });

  test('?video gets no sound packets', () => {
    const { hub, garden } = rig();
    const v = watch(hub.source('garden?video'));
    garden.send(1, p(1));
    garden.send(0, p(2), true);
    assert.deepEqual(v.got.map((g) => g.track), [0]);
    v.stop();
  });

  test('a new stream for the camera (a new codec) ends its viewers; they come back to the new one', () => {
    const { hub } = rig();
    const v = watch(hub.source('garden'));
    const next = hub.publish('garden', { sdp: publishSdp({ codec: 'hevc', params: {} }), codec: 'hevc' });
    assert.equal(v.ended(), true);
    assert.match(hub.source('garden').sdp, /H265/);
    assert.equal(next.listenerCount('packet'), 0);
  });
});

describe('JPEG and G.711 versions', () => {
  test('one transcoder per camera and kind, shared, started on first use and stopped with the last viewer', () => {
    const { hub, made } = rig();
    const a = watch(hub.source('garden~mjpeg'));
    const b = watch(hub.source('garden~mjpeg~g711'));
    assert.deepEqual(made.map((t) => t.opts.kind), ['mjpeg', 'pcmu']);
    assert.deepEqual(made[0].opts.size, { width: 640, height: 360 }, 'the JPEG size follows the camera\'s shape');
    assert.ok(made.every((t) => t.started));
    a.stop();
    assert.equal(made[0].stopped, false, 'still watched');
    b.stop();
    assert.ok(made.every((t) => t.stopped));
  });

  test('the transcoder\'s packets go out as the variant\'s track, from the first picture start', () => {
    const { hub, garden, made } = rig();
    const v = watch(hub.source('garden~mjpeg'));
    const [mjpeg] = made;
    mjpeg.emit('packet', p(1), false);   // the end of a picture already under way
    mjpeg.emit('packet', p(2), true);
    garden.send(1, p(3));                // the camera's sound, as it is
    garden.send(0, p(4), true);          // the camera's video: not in this variant
    assert.deepEqual(v.got.map((g) => [g.track, g.n]), [[0, 2], [1, 3]]);
    v.stop();
  });
});

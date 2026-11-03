// One camera's stream in the hub, as the publisher hands it in and the viewers hear it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Publication } from '../../src/rtsp/publication.mjs';
import { publishSdp } from '../../src/video/rtp.mjs';

const open = (audio = true) => new Publication('garden', { sdp: publishSdp({ codec: 'h264', params: {}, audio }), codec: 'h264' });
const nextTurn = () => new Promise((r) => setImmediate(r));

test('is ready at once, and says so once the publisher has had the chance to listen', async () => {
  const publication = open();
  assert.equal(publication.ready, true);
  let ready = 0;
  publication.on('ready', () => ready++);
  await nextTurn();
  assert.equal(ready, 1);
});

test('knows its media sections: the video first, then the sound if there is any', () => {
  assert.deepEqual(open(true).sections.map((s) => s[0]), ['m=video 0 RTP/AVP 96', 'm=audio 0 RTP/AVP 97']);
  assert.deepEqual(open(false).sections.map((s) => s[0]), ['m=video 0 RTP/AVP 96']);
});

test('passes each packet to every listener, with its track and whether it starts a keyframe', () => {
  const publication = open();
  const heard = [];
  publication.on('packet', (track, packet, starts) => heard.push([track, packet[0], starts]));
  assert.equal(publication.send(0, Buffer.from([7]), true), true);
  publication.send(1, Buffer.from([8]));
  assert.deepEqual(heard, [[0, 7, true], [1, 8, false]]);
});

test('passes the encoded frames on as well, for the transcoders', () => {
  const publication = open();
  const heard = [];
  publication.on('media', (what, frame) => heard.push([what, frame[0]]));
  publication.media('video', Buffer.from([1]));
  publication.media('audio', Buffer.from([2]));
  assert.deepEqual(heard, [['video', 1], ['audio', 2]]);
});

test('closes once, with its reason; after that nothing is sent and send() says so', async () => {
  const publication = open();
  const reasons = [];
  let packets = 0, ready = 0;
  publication.on('close', (reason) => reasons.push(reason));
  publication.on('packet', () => packets++);
  publication.on('ready', () => ready++);
  publication.close('replaced');
  publication.close('again');
  assert.deepEqual(reasons, ['replaced']);
  assert.equal(publication.send(0, Buffer.from([1]), true), false);
  assert.equal(packets, 0);
  assert.equal(publication.ready, false);
  await nextTurn();
  assert.equal(ready, 0, 'closed before it got to say it was ready');
});

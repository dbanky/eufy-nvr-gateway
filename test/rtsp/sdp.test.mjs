import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sdpTracks, trackFor, fromTheDevice } from '../../src/rtsp/sdp.mjs';

// What go2rtc 1.9.15 answers to DESCRIBE.
const SDP = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=go2rtc/1.9.15\r\nc=IN IP4 0.0.0.0\r\nt=0 0\r\n'
  + 'm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=recvonly\r\na=control:trackID=0\r\n'
  + 'm=audio 0 RTP/AVP 97\r\na=rtpmap:97 MPEG4-GENERIC/16000\r\na=recvonly\r\na=control:trackID=1\r\n';

test('tracks with their RTP clocks', () => {
  assert.deepEqual(sdpTracks(SDP), [{ media: 'video', control: 'trackID=0', clockRate: 90000 }, { media: 'audio', control: 'trackID=1', clockRate: 16000 }]);
});

test('a SETUP address belongs to the track whose control it ends with (query strings too)', () => {
  const tracks = sdpTracks(SDP);
  assert.equal(trackFor(tracks, 'rtsp://192.168.1.51:8554/garden/trackID=1').media, 'audio');
  assert.equal(trackFor(tracks, 'rtsp://192.168.1.51:8554/garden?video/trackID=0').media, 'video');
});

test('the streams come from the device: sendonly, not go2rtc\'s recvonly', () => {
  assert.doesNotMatch(fromTheDevice(SDP), /recvonly/);
  assert.equal(fromTheDevice(SDP).match(/a=sendonly\r/g).length, 2);
});

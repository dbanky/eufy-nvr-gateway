// The SDP of a DESCRIBE answer: reading its tracks, and writing the one a viewer gets.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sdpTracks, trackFor, mediaSections, viewerSdp } from '../../src/rtsp/sdp.mjs';

// A description with a video and a sound track, as a publisher writes it.
const SDP = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=eufy-nvr-gateway\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n'
  + 'm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=recvonly\r\na=control:trackID=0\r\n'
  + 'm=audio 0 RTP/AVP 97\r\na=rtpmap:97 MPEG4-GENERIC/16000\r\na=recvonly\r\na=control:trackID=1\r\n';

describe('reading the tracks', () => {
  test('each m= line is a track, with its control and RTP clock', () => {
    assert.deepEqual(sdpTracks(SDP), [
      { media: 'video', control: 'trackID=0', clockRate: 90000 },
      { media: 'audio', control: 'trackID=1', clockRate: 16000 },
    ]);
  });

  test('a SETUP address belongs to the track whose control it ends with (query strings too)', () => {
    const tracks = sdpTracks(SDP);
    assert.equal(trackFor(tracks, 'rtsp://192.168.1.51:8554/garden/trackID=1').media, 'audio');
    assert.equal(trackFor(tracks, 'rtsp://192.168.1.51:8554/garden?video/trackID=0').media, 'video');
    assert.equal(trackFor(tracks, 'rtsp://192.168.1.51:8554/garden/trackID=5'), null);
  });

  test('a stream with one track: any SETUP address is for it', () => {
    const [video] = sdpTracks(SDP);
    assert.equal(trackFor([video], 'rtsp://192.168.1.51:8554/garden'), video);
  });
});

describe('media sections', () => {
  test('one list of lines per m= line, the session lines left out', () => {
    const [video, audio, more] = mediaSections(SDP);
    assert.equal(video[0], 'm=video 0 RTP/AVP 96');
    assert.equal(video.at(-1), 'a=control:trackID=0');
    assert.equal(audio[0], 'm=audio 0 RTP/AVP 97');
    assert.equal(more, undefined);
  });
});

describe('what a viewer is told', () => {
  const sdp = viewerSdp(mediaSections(SDP));

  test('a session of its own, without the publisher\'s local address', () => {
    assert.match(sdp, /^v=0\r\no=- 1 1 IN IP4 0\.0\.0\.0\r\ns=eufy-nvr-gateway\r\nc=IN IP4 0\.0\.0\.0\r\nt=0 0\r\na=control:\*\r\n/);
    assert.doesNotMatch(sdp, /127\.0\.0\.1/);
  });

  test('every track flows from the device (sendonly), numbered in order for SETUP', () => {
    assert.match(sdp, /m=video 0 RTP\/AVP 96\r\na=rtpmap:96 H264\/90000\r\na=sendonly\r\na=control:trackID=0\r\n/);
    assert.match(sdp, /m=audio 0 RTP\/AVP 97\r\na=rtpmap:97 MPEG4-GENERIC\/16000\r\na=sendonly\r\na=control:trackID=1\r\n$/);
    assert.doesNotMatch(sdp, /recvonly/);
  });

  test('the tracks are numbered by their place, whatever the source called them', () => {
    const [, audio] = mediaSections(SDP);
    assert.match(viewerSdp([audio]), /m=audio[\s\S]*a=control:trackID=0\r\n$/);
  });
});

// The SDP of a DESCRIBE answer: which tracks there are, their RTP clocks (for sender reports), and
// the description a viewer gets. Pure.

// [{ media, control, clockRate }] in the order of the m= lines.
export function sdpTracks(sdp) {
  const tracks = [];
  for (const line of String(sdp).split(/\r?\n/)) {
    if (line.startsWith('m=')) tracks.push({ media: line.slice(2).split(' ')[0], control: null, clockRate: 90000 });
    const track = tracks.at(-1);
    if (!track) continue;
    const control = /^a=control:(\S+)/.exec(line);
    if (control) track.control = control[1];
    const rtpmap = /^a=rtpmap:\d+ [^/]+\/(\d+)/.exec(line);
    if (rtpmap) track.clockRate = Number(rtpmap[1]);
  }
  return tracks;
}

// The SETUP URI belongs to the track whose control it ends with (absolute or relative controls).
export function trackFor(tracks, uri) {
  const path = String(uri).split('?')[0];
  return tracks.find((t) => t.control && (uri === t.control || uri.endsWith(`/${t.control}`) || path.endsWith(`/${t.control}`)))
    ?? (tracks.length === 1 ? tracks[0] : null);
}

// The media sections of an SDP: one list of lines per m= line, starting with it (the session lines
// before the first m= line are left out).
export function mediaSections(sdp) {
  const sections = [];
  for (const line of String(sdp).split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith('m=')) sections.push([]);
    sections.at(-1)?.push(line);
  }
  return sections;
}

const VIEWER_SESSION = ['v=0', 'o=- 1 1 IN IP4 0.0.0.0', 's=eufy-nvr-gateway', 'c=IN IP4 0.0.0.0', 't=0 0', 'a=control:*'];
const DIRECTION_OR_CONTROL = /^a=(control|sendonly|recvonly|sendrecv|inactive)\b/;

// What a viewer is told: the given media sections in order, each flowing from the device (sendonly)
// and numbered trackID=0, 1, ... for its SETUP. No addresses: the viewer asked this server.
export function viewerSdp(sections) {
  const media = sections.flatMap((lines, i) => [
    ...lines.filter((line) => !DIRECTION_OR_CONTROL.test(line)),
    'a=sendonly',
    `a=control:trackID=${i}`,
  ]);
  return [...VIEWER_SESSION, ...media].join('\r\n') + '\r\n';
}

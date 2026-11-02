// The SDP of a DESCRIBE answer: which tracks there are, and their RTP clocks (for sender reports).
// Pure.

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

// Encoder settings for everything the gateway encodes itself: live video (H.264) and the sleeping
// loops (H.264, or H.265 for a camera whose own H.265 is passed through).
//
// The loops and the live video of one stream must have the same structure (keyframe every 4 s, no
// B-frames, frame delimiters, parameter sets on every keyframe) so the publisher can splice them.

export function encoderArgs(cam, codec = 'h264') {
  return codec === 'hevc' ? x265Args(cam) : x264Args(cam);
}

function x264Args({ fps, bitrateKbps }) {
  const gop = String(fps * 4);   // a keyframe every 4 s: where NVRs can join and the feed can switch
  return [
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-bf', '0', '-g', gop, '-keyint_min', gop, '-sc_threshold', '0',
    // crf 20: SSIM ~0.997 vs. the camera's own stream. qpmin stops x264 from endlessly "refining"
    // a still picture (~1.6 Mbit/s without it). aud marks frame boundaries for FrameSplitter.
    // me=dia:subme=1: a cheaper motion search, ~30 % less encoder CPU on 3K. The default bitrate
    // limit is 10 % higher to make up for it: same quality (SSIM), slightly larger stream.
    // sliced-threads=0: one slice per picture. zerolatency would cut every picture into one slice
    // per thread, and UniFi Protect's live view takes each slice for a frame: its player stalls.
    '-crf', '20', '-x264-params', 'qpmin=19:me=dia:subme=1:aud=1:repeat-headers=1:sliced-threads=0',
    '-maxrate', `${bitrateKbps}k`, '-bufsize', `${bitrateKbps * 2}k`,
    '-f', 'h264',
  ];
}

// Only used for still pictures, so the fastest preset loses nothing visible. An 8 s 3K loop takes
// ~2 s on a fast core (H.264: ~0.4 s).
function x265Args({ fps, bitrateKbps }) {
  const gop = fps * 4;
  return [
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-crf', '22',
    '-x265-params', `keyint=${gop}:min-keyint=${gop}:scenecut=0:bframes=0:open-gop=0:qpmin=19:aud=1:repeat-headers=1:log-level=error`,
    '-maxrate', `${bitrateKbps}k`, '-bufsize', `${bitrateKbps * 2}k`,
    '-f', 'hevc',
  ];
}

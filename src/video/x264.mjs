// H.264 encoder settings shared by the live encoder and the still loops. Identical settings give
// identical parameter sets, which is what lets the publisher splice both into one stream.
export function x264Args({ fps, bitrateKbps }) {
  const gop = String(fps * 4);   // a keyframe every 4 s: where NVRs can join and the feed can switch
  return [
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-bf', '0', '-g', gop, '-keyint_min', gop, '-sc_threshold', '0',
    // crf 20: SSIM ~0.997 vs. the camera's own stream. qpmin stops x264 from endlessly "refining"
    // a still picture (~1.6 Mbit/s without it). aud marks frame boundaries for FrameSplitter.
    // me=dia:subme=1: a cheaper motion search, ~30 % less encoder CPU on 3K. The default bitrate
    // limit is 10 % higher to make up for it: same quality (SSIM), slightly larger stream.
    '-crf', '20', '-x264-params', 'qpmin=19:me=dia:subme=1:aud=1:repeat-headers=1',
    '-maxrate', `${bitrateKbps}k`, '-bufsize', `${bitrateKbps * 2}k`,
    '-f', 'h264',
  ];
}

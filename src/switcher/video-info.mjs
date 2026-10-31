// What the web page says about a camera's video: the stream's codec, and whether the camera's
// video is converted (decoded and re-encoded as H.264) or passed through as it is. Pure.

const NAMES = { h264: 'H.264', hevc: 'H.265' };

// cam: { transcode, codec (what the camera sends, once learned), streamCodec (what the stream uses) }
export function videoInfo({ transcode, codec, streamCodec }) {
  const converted = !(transcode === false && codec && streamCodec === codec);
  let text;
  if (!converted) text = `${NAMES[streamCodec]} · passed through, no conversion`;
  else if (transcode === false) text = `${NAMES[streamCodec]} · converted until the camera's format is known`;
  else if (codec === streamCodec) text = `${NAMES[streamCodec]}, as the camera sends it`;   // same format: no conversion to speak of
  else text = `${NAMES[streamCodec]} · converted${codec ? ` from ${NAMES[codec]}` : ''}`;
  return { codec: streamCodec, cameraCodec: codec ?? null, converted, text };
}

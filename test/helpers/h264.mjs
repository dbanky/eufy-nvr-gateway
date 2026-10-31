// Tiny fake H.264 and H.265 frames: an access unit delimiter followed by one slice. Enough for the
// code that splits streams and looks for keyframes; no decoder ever sees them.

const START = [0, 0, 0, 1];
const H264_AUD = [...START, 0x09, 0xf0];
const HEVC_AUD = [...START, 0x46, 0x01, 0x50];   // NAL type 35

export const keyframe = (tag = 0) => Buffer.from([...H264_AUD, ...START, 0x65, 0x88, tag]);   // IDR slice (type 5)
export const deltaFrame = (tag = 0) => Buffer.from([...H264_AUD, ...START, 0x41, 0x9a, tag]); // non-IDR slice (type 1)

export const hevcKeyframe = (tag = 0) => Buffer.from([...HEVC_AUD, ...START, 0x26, 0x01, tag]);   // IDR_W_RADL (type 19)
export const hevcDeltaFrame = (tag = 0) => Buffer.from([...HEVC_AUD, ...START, 0x02, 0x01, tag]); // TRAIL_R (type 1)

// The tag byte identifies a frame in assertions.
export const tagOf = (frame) => frame[frame.length - 1];

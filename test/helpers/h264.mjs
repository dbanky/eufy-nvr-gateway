// Tiny fake H.264 frames: an access unit delimiter followed by one slice NAL. Enough for the code
// that splits streams and looks for keyframes; no decoder ever sees them.

const AUD = [0, 0, 0, 1, 0x09, 0xf0];

export const keyframe = (tag = 0) => Buffer.from([...AUD, 0, 0, 0, 1, 0x65, 0x88, tag]);   // IDR slice (type 5)
export const deltaFrame = (tag = 0) => Buffer.from([...AUD, 0, 0, 0, 1, 0x41, 0x9a, tag]); // non-IDR slice (type 1)

// The tag byte identifies a frame in assertions.
export const tagOf = (frame) => frame[frame.length - 1];

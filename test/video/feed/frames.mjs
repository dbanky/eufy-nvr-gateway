// Frames and helpers shared by the Feed tests.
import { keyframe, deltaFrame, tagOf } from '../../helpers/h264.mjs';

export const loop = [keyframe(1), deltaFrame(2), deltaFrame(3)];
export const take = (feed, n, options) => Array.from({ length: n }, () => feed.next(options)).map((f) => f && tagOf(f));


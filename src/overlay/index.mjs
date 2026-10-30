// The overlay module's entry point: one state's picture, ready to stream.
import { renderStill } from './render-still.mjs';
import { encodeStillLoop } from './still-loop.mjs';

// picture: { raw } | { file } | null    view: { kind, title, detail }
// Returns { still: the raw frame (for snapshots), frames: the encoded loop }.
export async function renderStateLoop({ cam, picture, view, tmpDir }) {
  const { frame, spinner } = await renderStill({ cam, base: picture, view, tmpDir });
  const frames = await encodeStillLoop({ cam, still: frame, spinner, tmpDir });
  return { still: frame, frames };
}

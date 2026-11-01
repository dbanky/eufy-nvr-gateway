// Motion seen in the live picture itself. eufy cameras send a detection when motion starts, then
// none until their own re-trigger interval is over, however long the motion goes on; and there is
// no "motion ended" event. So while live, consecutive keyframes (every 4 s on eufy cameras) are
// compared as tiny grey thumbnails: a decoder that already runs for snapshots makes them, so this
// costs next to nothing.
//
// Measured on a doorbell standing still: consecutive keyframes differ in 0 of 768 cells. The
// whole picture shifting together (the camera adjusting its exposure) is taken out first.

import { FixedSizeSplitter } from '../video/fixed-size.mjs';

export const THUMB_WIDTH = 32, THUMB_HEIGHT = 24;
const CELLS = THUMB_WIDTH * THUMB_HEIGHT;
export const CELL_CHANGE = 10;          // brightness levels (0–255) a cell must change by
export const MIN_CHANGED_SHARE = 0.02;  // ... in at least this share of the picture (16 cells)

// The share of cells (0–1) that changed between two thumbnails, after taking out an overall shift.
export function changedShare(prev, cur) {
  let shift = 0;
  for (let i = 0; i < CELLS; i++) shift += cur[i] - prev[i];
  shift /= CELLS;
  let changed = 0;
  for (let i = 0; i < CELLS; i++) if (Math.abs(cur[i] - prev[i] - shift) > CELL_CHANGE) changed++;
  return changed / CELLS;
}

export function pictureMoved(prev, cur) {
  if (!prev || prev.length !== CELLS || cur?.length !== CELLS) return false;
  return changedShare(prev, cur) >= MIN_CHANGED_SHARE;
}

// A thumbnail from a raw yuv420p picture (converting): the average brightness of each cell.
export function thumbnailFromLuma(frame, width, height) {
  const thumb = Buffer.alloc(CELLS);
  for (let ty = 0; ty < THUMB_HEIGHT; ty++) {
    const y0 = Math.floor(ty * height / THUMB_HEIGHT), y1 = Math.floor((ty + 1) * height / THUMB_HEIGHT);
    for (let tx = 0; tx < THUMB_WIDTH; tx++) {
      const x0 = Math.floor(tx * width / THUMB_WIDTH), x1 = Math.floor((tx + 1) * width / THUMB_WIDTH);
      let sum = 0;
      // Every other row and column is plenty for an average, and halves the work on 3K pictures.
      let n = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { sum += frame[y * width + x]; n++; }
      thumb[ty * THUMB_WIDTH + tx] = n ? Math.round(sum / n) : 0;
    }
  }
  return thumb;
}

// Splits a byte stream into whole thumbnails.
export class ThumbnailSplitter {
  constructor(onThumbnail) {
    this.onThumbnail = onThumbnail;
    this.splitter = new FixedSizeSplitter(CELLS);
  }

  push(chunk) {
    for (const thumbnail of this.splitter.push(chunk)) this.onThumbnail(thumbnail);
  }
}

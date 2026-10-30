// Draws the overlay's shapes (the label capsule, the icon chip, the centre disc) into a transparent
// RGBA image, anti-aliased. Every shape is a capsule: a rectangle with fully rounded ends, which
// is a circle when it is as wide as it is tall.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Paint colour `rgb` with opacity `alpha` over pixel `i` ("source over", straight alpha).
function blend(px, i, rgb, alpha) {
  if (alpha <= 0) return;
  const below = px[i + 3] / 255, out = alpha + below * (1 - alpha);
  for (let c = 0; c < 3; c++) px[i + c] = (rgb[c] * alpha + px[i + c] * below * (1 - alpha)) / out;
  px[i + 3] = out * 255;
}

// Signed distance from (x, y) to the capsule's edge: negative inside.
export function capsuleDistance({ x, y, w, h }, px, py) {
  const r = h / 2, cy = y + r, left = x + r, right = x + w - r;
  const nearestX = px < left ? left : px > right ? right : px;
  return Math.hypot(px - nearestX, py - cy) - r;
}

// shape: { x, y, w, h, fill: [r,g,b], fillAlpha, border?: { alpha, width } } — white border.
export function drawCapsule(px, width, height, shape) {
  const x0 = Math.max(0, Math.floor(shape.x - 1)), x1 = Math.min(width, Math.ceil(shape.x + shape.w + 1));
  const y0 = Math.max(0, Math.floor(shape.y - 1)), y1 = Math.min(height, Math.ceil(shape.y + shape.h + 1));
  for (let py = y0; py < y1; py++) {
    for (let qx = x0; qx < x1; qx++) {
      const d = capsuleDistance(shape, qx + 0.5, py + 0.5), i = (py * width + qx) * 4;
      const inside = clamp01(0.5 - d);   // pixel coverage: 1 inside, 0 outside, fractional on the edge
      blend(px, i, shape.fill, shape.fillAlpha * inside);
      if (shape.border) blend(px, i, [255, 255, 255], shape.border.alpha * (inside - clamp01(0.5 - d - shape.border.width)));
    }
  }
}

export function rasterize(width, height, shapes) {
  const px = Buffer.alloc(width * height * 4);   // fully transparent
  for (const shape of shapes) drawCapsule(px, width, height, shape);
  return px;
}

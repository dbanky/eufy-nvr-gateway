// Where everything of a state's overlay goes, in pixels. Pure: no drawing, no ffmpeg.
//
//   view         { kind, title, detail }   (see switcher/labels.mjs)
//   measureText  (font: 'title'|'detail', text, sizePx) -> width in px
//
// Returns { shapes, icons, texts, spinner }: shapes for raster.mjs, the rest for render-still.mjs.

import { CENTRE, LABEL, NO_PICTURE_TEXT, STATES } from './design.mjs';

export function layoutOverlay({ width, height, view, measureText }) {
  const H = height;   // sizes in design.mjs are fractions of the frame height
  const style = STATES[view.kind] ?? STATES.asleep;
  const noPicture = view.kind === 'nopicture';
  const out = { shapes: [], icons: [], texts: [], spinner: null };

  // Centre mark
  const disc = CENTRE.disc * H, cx = width / 2, cy = height / 2 - (noPicture ? CENTRE.noPictureLift * H : 0);
  out.shapes.push({ x: cx - disc / 2, y: cy - disc / 2, w: disc, h: disc, fill: CENTRE.fill, fillAlpha: CENTRE.fillAlpha,
    border: { alpha: CENTRE.borderAlpha, width: hairline(H) } });
  const accented = view.kind === 'waking' || noPicture;
  out.icons.push({ name: style.icon, size: CENTRE.icon * H, cx, cy,
    rgb: accented ? style.accent : CENTRE.iconRgb, alpha: accented ? 1 : CENTRE.iconAlpha });
  if (view.kind === 'waking') {
    const size = disc * CENTRE.spinner;
    out.icons.push({ name: 'ring-track', size, cx, cy, rgb: [255, 255, 255], alpha: 1 });
    out.spinner = { name: 'ring-arc', size, cx, cy, rgb: style.accent };   // animated by the loop
  }

  const title = LABEL.title * H, detail = LABEL.detail * H, lineGap = LABEL.lineGap * H;
  if (noPicture) {
    const top = height / 2 + NO_PICTURE_TEXT.top * H;
    out.texts.push({ font: 'title', text: view.title, size: title, color: NO_PICTURE_TEXT.titleColor, x: 'center', y: top });
    out.texts.push({ font: 'detail', text: view.detail, size: detail, color: NO_PICTURE_TEXT.detailColor, x: 'center',
      y: top + title * LABEL.lineHeight + lineGap });
    return out;
  }

  // Label, bottom left, as wide as its longer line
  const padY = LABEL.padY * H, chip = LABEL.chip * H, gap = LABEL.gap * H;
  const textBlock = title * LABEL.lineHeight + lineGap + detail * LABEL.lineHeight;
  const content = Math.max(chip, textBlock);
  const textWidth = Math.max(measureText('title', view.title, title), measureText('detail', view.detail, detail));
  const label = { h: content + 2 * padY, w: padY + chip + gap + textWidth + LABEL.padRight * H };
  label.x = LABEL.margin * H;
  label.y = height - LABEL.margin * H - label.h;
  out.shapes.push({ ...label, fill: LABEL.fill, fillAlpha: LABEL.fillAlpha, border: { alpha: LABEL.borderAlpha, width: hairline(H) } });
  out.shapes.push({ x: label.x + padY, y: label.y + (label.h - chip) / 2, w: chip, h: chip, fill: style.accent, fillAlpha: LABEL.chipAlpha });
  out.icons.push({ name: style.icon, size: chip * LABEL.chipIcon, cx: label.x + padY + chip / 2, cy: label.y + label.h / 2, rgb: style.accent, alpha: 1 });
  const textX = label.x + padY + chip + gap, textY = label.y + padY + (content - textBlock) / 2;
  out.texts.push({ font: 'title', text: view.title, size: title, color: LABEL.titleColor, x: textX, y: textY });
  out.texts.push({ font: 'detail', text: view.detail, size: detail, color: LABEL.detailColor, x: textX, y: textY + title * LABEL.lineHeight + lineGap });
  return out;
}

// A 1 px border at 1080p, never thinner than one pixel.
const hairline = (H) => Math.max(1, H / 1000);

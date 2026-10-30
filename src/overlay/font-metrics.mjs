// Measures text width with a TrueType font, so the label can be sized to its text before ffmpeg
// draws it. A minimal reader: character map (cmap format 12 or 4) and advance widths (hmtx).
// Kerning is ignored; the label's padding absorbs the difference.

import { readFileSync } from 'node:fs';

// Returns measure(text, sizePx) -> width in pixels.
export function loadFontMeasure(file) {
  const font = readFileSync(file);
  const tables = readTableDirectory(font);
  const unitsPerEm = font.readUInt16BE(tables.head + 18);
  const advanceCount = font.readUInt16BE(tables.hhea + 34);
  const glyphOf = glyphLookup(font, tables.cmap);
  const advance = (glyph) => font.readUInt16BE(tables.hmtx + 4 * Math.min(glyph, advanceCount - 1));
  return (text, size) => [...text].reduce((sum, ch) => sum + advance(glyphOf(ch.codePointAt(0))), 0) * size / unitsPerEm;
}

// Table tag -> byte offset.
function readTableDirectory(font) {
  const tables = {};
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const entry = 12 + i * 16;
    tables[font.toString('latin1', entry, entry + 4)] = font.readUInt32BE(entry + 8);
  }
  return tables;
}

// Code point -> glyph id, from the best Unicode subtable.
function glyphLookup(font, cmap) {
  let format12 = 0, format4 = 0;
  for (let i = 0; i < font.readUInt16BE(cmap + 2); i++) {
    const platform = font.readUInt16BE(cmap + 4 + i * 8);
    const offset = cmap + font.readUInt32BE(cmap + 8 + i * 8);
    const format = font.readUInt16BE(offset);
    if (format === 12) format12 = offset;
    else if (format === 4 && platform === 3) format4 = offset;
  }
  return format12 ? (cp) => format12Glyph(font, format12, cp) : (cp) => format4Glyph(font, format4, cp);
}

function format12Glyph(font, table, cp) {
  for (let g = 0, groups = font.readUInt32BE(table + 12); g < groups; g++) {
    const group = table + 16 + g * 12;
    const start = font.readUInt32BE(group), end = font.readUInt32BE(group + 4);
    if (cp >= start && cp <= end) return font.readUInt32BE(group + 8) + cp - start;
  }
  return 0;
}

function format4Glyph(font, table, cp) {
  const segX2 = font.readUInt16BE(table + 6);
  const ends = table + 14, starts = ends + segX2 + 2, deltas = starts + segX2, rangeOffsets = deltas + segX2;
  for (let i = 0; i < segX2; i += 2) {
    if (cp > font.readUInt16BE(ends + i)) continue;
    const start = font.readUInt16BE(starts + i);
    if (cp < start) return 0;
    const delta = font.readUInt16BE(deltas + i), rangeOffset = font.readUInt16BE(rangeOffsets + i);
    if (!rangeOffset) return (cp + delta) & 0xffff;
    const glyph = font.readUInt16BE(rangeOffsets + i + rangeOffset + 2 * (cp - start));
    return glyph ? (glyph + delta) & 0xffff : 0;
  }
  return 0;
}

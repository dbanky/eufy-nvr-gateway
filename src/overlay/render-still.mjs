// Renders one finished still frame for a state: the picture (blurred and dimmed), the shapes, the
// icons and the text, in a single ffmpeg run. Output: one raw yuv420p frame.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFfmpeg, rawInput, fitFilter, frameSize, tint } from '../video/ffmpeg.mjs';
import { PICTURE } from './design.mjs';
import { layoutOverlay } from './layout.mjs';
import { rasterize } from './raster.mjs';
import { loadFontMeasure } from './font-metrics.mjs';
import { iconFile, FONTS } from './assets.mjs';

let measures;   // fonts are read once, on first use
const measureText = (font, text, size) => (measures ??= {
  title: loadFontMeasure(FONTS.title), detail: loadFontMeasure(FONTS.detail),
})[font](text, size);

// The sleeping look, applied to the picture before anything is drawn on top.
export function pictureFilter({ height }) {
  const sigma = (PICTURE.blurAt1080p * height / 1080).toFixed(1);
  const s = PICTURE.saturation;
  return `gblur=sigma=${sigma},lutyuv=y=val*${PICTURE.brightness}:u=128+(val-128)*${s}:v=128+(val-128)*${s},vignette=${PICTURE.vignette}`;
}

// base:       { raw: Buffer } | { jpeg: Buffer } | { file: path } | null (no picture yet)
// shapesFile: the rasterised shapes, raw RGBA at the frame size
// textFile(index, text): stores label text, returns its path (drawtext reads files: no escaping)
// Returns { args, input } for ffmpeg.
export function stillCommand({ cam, base, layout, shapesFile, textFile }) {
  const { width, height } = cam;
  const inputs = base?.raw ? [...rawInput(cam), '-i', 'pipe:0']
    : base?.jpeg ? ['-f', 'image2pipe', '-i', 'pipe:0']
    : base?.file ? ['-i', base.file]
    : ['-f', 'lavfi', '-i', `color=c=${PICTURE.noPictureBackground}:s=${width}x${height}:d=1`];
  inputs.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', shapesFile);
  for (const icon of layout.icons) inputs.push('-i', iconFile(icon.name));

  const graph = [`[0:v]${fitFilter(cam)}${base ? ',' + pictureFilter(cam) : ''}[pic]`, '[pic][1:v]overlay=0:0:format=auto[v0]'];
  layout.icons.forEach((icon, k) => {
    const size = even(icon.size);
    graph.push(`[${k + 2}:v]scale=${size}:${size},format=rgba,${tint(icon.rgb, icon.alpha)}[icon${k}]`);
    graph.push(`[v${k}][icon${k}]overlay=${Math.round(icon.cx - size / 2)}:${Math.round(icon.cy - size / 2)}:format=auto[v${k + 1}]`);
  });
  const text = layout.texts.map((t, k) => [
    `drawtext=fontfile=${FONTS[t.font]}`, `textfile=${textFile(k, t.text)}`, 'expansion=none',
    `fontsize=${t.size.toFixed(1)}`, `fontcolor=0x${t.color}`,
    `x=${t.x === 'center' ? '(w-text_w)/2' : Math.round(t.x)}`, `y=${Math.round(t.y)}`, 'y_align=font',
  ].join(':'));
  graph.push(`[v${layout.icons.length}]${[...text, 'format=yuv420p'].join(',')}[out]`);

  return {
    args: [...inputs, '-filter_complex', graph.join(';'), '-map', '[out]', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'],
    input: base?.raw ?? base?.jpeg,
  };
}

const even = (n) => Math.round(n / 2) * 2;

export async function renderStill({ cam, base, view, tmpDir }) {
  const layout = layoutOverlay({ width: cam.width, height: cam.height, view, measureText });
  const shapesFile = join(tmpDir, `${cam.name}-shapes.rgba`);
  writeFileSync(shapesFile, rasterize(cam.width, cam.height, layout.shapes));
  const textFile = (k, text) => {
    const file = join(tmpDir, `${cam.name}-text${k}.txt`);
    writeFileSync(file, text);
    return file;
  };
  const { args, input } = stillCommand({ cam, base, layout, shapesFile, textFile });
  const frame = await runFfmpeg(args, input);
  if (frame.length < frameSize(cam)) throw new Error('short frame from ffmpeg');
  return { frame: frame.subarray(0, frameSize(cam)), spinner: layout.spinner };
}

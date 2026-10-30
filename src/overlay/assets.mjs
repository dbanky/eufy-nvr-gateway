// Files built into the image by the Dockerfile's assets stage: icons (from assets/icons/*.svg)
// rasterised to 256 px PNGs, and the Inter typeface.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../assets/', import.meta.url));

export const iconFile = (name) => join(ROOT, 'icons', `${name}.png`);
export const FONTS = {
  title: join(ROOT, 'fonts', 'Inter-SemiBold.ttf'),
  detail: join(ROOT, 'fonts', 'Inter-Regular.ttf'),
};

// Remembers which codec each camera sends ('h264' | 'hevc'), learned during a converted session,
// so a camera with `transcode: false` can be passed through right after a restart.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = (dataDir, cam) => join(dataDir, `codec-${cam.name}.txt`);

export function loadCodec(dataDir, cam) {
  const codec = existsSync(file(dataDir, cam)) ? readFileSync(file(dataDir, cam), 'utf8').trim() : '';
  return codec === 'h264' || codec === 'hevc' ? codec : null;
}

export function saveCodec(dataDir, cam, codec) {
  writeFileSync(file(dataDir, cam), `${codec}\n`);
}

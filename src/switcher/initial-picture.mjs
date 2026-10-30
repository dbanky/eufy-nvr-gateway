// What a camera shows right after the gateway starts, before any event:
//   1. its last live frame from before the restart (kept as last-<name>.jpg), with its time
//   2. else eufy's stored image of the last event (never wakes the camera), time unknown
//   3. else nothing: the stream says "No picture yet"

import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const lastFrameFile = (dataDir, cam) => join(dataDir, `last-${cam.name}.jpg`);

// Returns { picture, fromEvent, takenAt } for the camera's fields.
export async function loadInitialPicture({ cam, dataDir, tmpDir, bridgeHttp, fetchImpl = fetch }) {
  const last = lastFrameFile(dataDir, cam);
  if (existsSync(last)) return { picture: { file: last }, fromEvent: false, takenAt: statSync(last).mtimeMs };
  try {
    const answer = await fetchImpl(`${bridgeHttp}/snapshot/${cam.serial}?mode=stored`);
    if (answer.ok) {
      const file = join(tmpDir, `${cam.name}-event.jpg`);
      writeFileSync(file, Buffer.from(await answer.arrayBuffer()));
      return { picture: { file }, fromEvent: true, takenAt: 0 };
    }
  } catch {
    // bridge not up yet: start without a picture
  }
  return { picture: null, fromEvent: false, takenAt: 0 };
}

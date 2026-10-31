// JPEG snapshots of what each camera's stream shows right now (the web page polls them).

const CACHE_MS = 2000;

// encodeJpeg(camera, rawFrame) -> Promise<jpeg>. Returns snapshot(camera) -> Promise<jpeg>.
export function createSnapshots(encodeJpeg, now = Date.now) {
  const cache = new Map();
  return function snapshot(camera) {
    if (camera.state === 'LIVE' && camera.liveJpeg) return Promise.resolve(camera.liveJpeg);   // passing through
    const cached = cache.get(camera);
    if (cached?.frame === camera.frame && now() - cached.at < CACHE_MS) return cached.jpg;
    const jpg = camera.frame ? encodeJpeg(camera, camera.frame) : Promise.reject(new Error('no picture yet'));
    cache.set(camera, { frame: camera.frame, at: now(), jpg });
    jpg.catch(() => cache.delete(camera));
    return jpg;
  };
}

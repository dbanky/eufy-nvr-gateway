import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadInitialPicture } from '../../src/switcher/initial-picture.mjs';

const cam = { name: 'garden', serial: 'T81XXXXXXXXXXXXX' };
const folder = () => mkdtempSync(join(tmpdir(), 'picture-test-'));
const noBridge = async () => { throw new Error('connection refused'); };

describe('after a restart, a camera shows', () => {
  test('its last live frame, with the time it was taken', async () => {
    const dataDir = folder();
    writeFileSync(join(dataDir, 'last-garden.jpg'), 'jpeg');
    utimesSync(join(dataDir, 'last-garden.jpg'), 1000, 1000);
    const result = await loadInitialPicture({ cam, dataDir, tmpDir: folder(), bridgeHttp: 'http://bridge', fetchImpl: noBridge });
    assert.deepEqual(result, { picture: { file: join(dataDir, 'last-garden.jpg') }, fromEvent: false, takenAt: 1000000 });
  });

  test("else eufy's stored event image (the request never wakes the camera)", async () => {
    let url;
    const fetchImpl = async (u) => { url = u; return { ok: true, arrayBuffer: async () => Buffer.from('event') }; };
    const result = await loadInitialPicture({ cam, dataDir: folder(), tmpDir: folder(), bridgeHttp: 'http://bridge', fetchImpl });
    assert.equal(url, 'http://bridge/snapshot/T81XXXXXXXXXXXXX?mode=stored');
    assert.equal(result.fromEvent, true);
    assert.equal(readFileSync(result.picture.file, 'utf8'), 'event');
  });

  test('else nothing, and the stream says "No picture yet"', async () => {
    const result = await loadInitialPicture({ cam, dataDir: folder(), tmpDir: folder(), bridgeHttp: 'http://bridge', fetchImpl: noBridge });
    assert.equal(result.picture, null);
  });
});

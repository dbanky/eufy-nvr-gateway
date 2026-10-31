import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCodec, saveCodec } from '../../src/switcher/codec-memory.mjs';

const cam = { name: 'garden' };

test("a camera's learned codec survives a restart", () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codec-test-'));
  assert.equal(loadCodec(dataDir, cam), null, 'unknown until a session learned it');
  saveCodec(dataDir, cam, 'hevc');
  assert.equal(loadCodec(dataDir, cam), 'hevc');
});

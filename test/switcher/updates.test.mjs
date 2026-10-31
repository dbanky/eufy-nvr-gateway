import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, newerRelease, createUpdateCheck, parseVersion } from '../../src/switcher/updates.mjs';

const release = (tag, over = {}) => ({ tag_name: tag, html_url: `https://github.com/dbanky/eufy-nvr-gateway/releases/tag/${tag}`,
  prerelease: /-/.test(tag), draft: false, ...over });

describe('version order (Semantic Versioning)', () => {
  test('numbers compare as numbers', () => {
    assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
    assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
    assert.equal(compareVersions('v0.4.0', '0.4.0'), 0);
  });

  test('a release is newer than its betas, and betas count up', () => {
    assert.ok(compareVersions('0.4.0', '0.4.0-beta.2') > 0);
    assert.ok(compareVersions('0.4.0-beta.2', '0.4.0-beta.1') > 0);
    assert.ok(compareVersions('0.4.0-beta.10', '0.4.0-beta.9') > 0);
    assert.ok(compareVersions('0.4.0-rc.1', '0.4.0-beta.3') > 0);
  });

  test('anything else is not a version', () => {
    assert.equal(parseVersion('latest'), null);
  });
});

describe('which release to offer', () => {
  const releases = [release('v0.5.0-beta.1'), release('v0.4.1'), release('v0.4.0'), release('v0.4.0-beta.1')];

  test('someone on a release is offered the newest release, not betas', () => {
    assert.equal(newerRelease(releases, '0.4.0').version, '0.4.1');
  });

  test('someone on a beta is offered newer betas too', () => {
    const offer = newerRelease(releases, '0.4.0-beta.1');
    assert.equal(offer.version, '0.5.0-beta.1');
    assert.equal(offer.prerelease, true);
    assert.match(offer.url, /\/releases\/tag\/v0\.5\.0-beta\.1$/);
  });

  test('nothing newer, drafts and odd tags: nothing to offer', () => {
    assert.equal(newerRelease(releases, '0.5.0'), null);
    assert.equal(newerRelease([release('v9.0.0', { draft: true }), release('nightly')], '0.4.0'), null);
  });
});

describe('the check', () => {
  const answer = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 403, json: async () => body });

  test('reports a newer version, and logs it once', async () => {
    const logged = [];
    const check = createUpdateCheck({ current: '0.4.0', fetch: answer([release('v0.4.1')]), log: (m) => logged.push(m) });
    await check.check();
    await check.check();
    assert.deepEqual(check.status().newer.version, '0.4.1');
    assert.equal(check.status().checked, true);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /0\.4\.1 is available/);
  });

  test('up to date: checked, nothing newer', async () => {
    const check = createUpdateCheck({ current: '0.4.1', fetch: answer([release('v0.4.1')]) });
    await check.check();
    assert.deepEqual([check.status().checked, check.status().newer], [true, null]);
  });

  test('GitHub unreachable: says so and keeps what it knew', async () => {
    let fail = false;
    const fetch = async (...a) => (fail ? Promise.reject(new Error('offline')) : answer([release('v0.4.1')])(...a));
    const check = createUpdateCheck({ current: '0.4.0', fetch });
    await check.check();
    fail = true;
    await check.check();
    assert.equal(check.status().error, 'offline');
    assert.equal(check.status().newer.version, '0.4.1');
  });

  test('"checkForUpdates": false sends no request', () => {
    let asked = false;
    const check = createUpdateCheck({ current: '0.4.0', enabled: false, fetch: async () => { asked = true; } });
    check.start();
    assert.equal(asked, false);
    assert.equal(check.status().enabled, false);
  });
});

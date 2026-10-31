import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { updateState, updatePillHtml, updateBannerHtml, footerHtml } from '../../../../src/switcher/web/static/gateway.js';

const project = 'https://github.com/dbanky/eufy-nvr-gateway';
const gateway = (update) => ({ version: '0.4.0-beta.1', update: { project, enabled: true, checked: true, newer: null, error: null, ...update } });
const newer = { version: '0.4.0', url: `${project}/releases/tag/v0.4.0`, prerelease: false };

describe('the gateway\'s version on the page', () => {
  test('the footer names the version and links the project', () => {
    const html = footerHtml(gateway());
    assert.match(html, /Eufy NVR Gateway <strong>0\.4\.0-beta\.1<\/strong>/);
    assert.match(html, /href="https:\/\/github\.com\/dbanky\/eufy-nvr-gateway"[^>]*>.*GitHub/);
    assert.match(html, /\/issues"/);
  });

  test('says when it is the latest version, still checking, unable to check, or not checking', () => {
    assert.match(footerHtml(gateway()), /Latest version/);
    assert.match(footerHtml(gateway({ checked: false })), /Checking for updates/);
    assert.match(footerHtml(gateway({ checked: false, error: 'offline' })), /Couldn’t check for updates/);
    assert.match(footerHtml(gateway({ enabled: false })), /Update check off/);
    assert.equal(updateState({ version: '0.4.0' }), 'off');
  });

  test('a newer version: a banner with what\'s new and how to update, and a reminder in the header', () => {
    const g = gateway({ newer });
    assert.match(updateBannerHtml(g), /Version 0\.4\.0 is available/);
    assert.match(updateBannerHtml(g), /This gateway runs 0\.4\.0-beta\.1/);
    assert.match(updateBannerHtml(g), /href="https:\/\/github\.com\/dbanky\/eufy-nvr-gateway\/releases\/tag\/v0\.4\.0"[^>]*>What’s new/);
    assert.match(updateBannerHtml(g), /#updating"[^>]*>How to update/);
    assert.match(updateBannerHtml(g), /data-dismiss="0\.4\.0"/);
    assert.match(updatePillHtml(g), /Update to 0\.4\.0/);
    assert.match(footerHtml(g), /0\.4\.0 is available/);
  });

  test('a newer beta is marked as one', () => {
    assert.match(updateBannerHtml(gateway({ newer: { ...newer, version: '0.5.0-beta.1', prerelease: true } })), /<span class="tag">beta<\/span>/);
  });

  test('up to date: no banner, no reminder', () => {
    assert.equal(updateBannerHtml(gateway()), '');
    assert.equal(updatePillHtml(gateway()), '');
  });
});

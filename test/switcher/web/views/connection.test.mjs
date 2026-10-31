import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionHtml } from '../../../../src/switcher/web/static/connection.js';

test('logged in: one calm "Connected to eufy"', () => {
  const html = connectionHtml({ connected: true, login: 'ok' });
  assert.match(html, /class="pill ok"/);
  assert.match(html, /Connected to eufy/);
});

test('a code or captcha is needed: says so', () => {
  assert.match(connectionHtml({ connected: true, login: 'require_2fa' }), /Login needs a code/);
  assert.match(connectionHtml({ connected: true, login: 'require_captcha' }), /Login needs a captcha/);
});

test('bridge still starting', () => {
  assert.match(connectionHtml({ connected: false, login: 'unknown' }), /Connecting to eufy…/);
});

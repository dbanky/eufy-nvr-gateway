import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tileHtml, tileStatusHtml, tileDetailsHtml, aspectRatio } from '../../../../src/switcher/web/static/camera-tile.js';

const camera = (over = {}) => ({
  name: 'garden', state: 'IDLE', battery: 86, resolution: '2880x1616',
  display: { kind: 'asleep', title: 'Sleeping', detail: 'since 12:28' },
  video: { text: 'H.265 · passed through, no conversion' },
  ...over,
});
const where = { host: '192.168.1.10', rtspPort: 8554 };

describe('a camera tile', () => {
  test('is mostly picture, in the camera\'s own shape (no letterboxing)', () => {
    assert.equal(aspectRatio('2880x1616'), '2880 / 1616');
    assert.match(tileHtml(camera(), where), /aspect-ratio: 2880 \/ 1616/);
  });

  test('puts the camera name on the picture', () => {
    assert.match(tileHtml(camera(), where), /<div class="tile-media"[\s\S]*class="tile-name">[\s\S]*garden<\/span>[\s\S]*<\/div>/);
  });

  test('keeps stream details out of sight until asked for', () => {
    const html = tileHtml(camera(), where);
    assert.match(html, /<details class="tile-details"/);
    assert.doesNotMatch(html, /<details[^>]*open/);
  });

  test('escapes camera names', () => {
    assert.doesNotMatch(tileHtml(camera({ name: '<b>x</b>' }), where), /<b>x<\/b>/);
  });
});

describe('the status line under the picture', () => {
  test('says the state once, in words', () => {
    const html = tileStatusHtml(camera());
    assert.match(html, /<strong>Sleeping<\/strong>/);
    assert.match(html, /since 12:28/);
  });

  test('offers the one action that fits: wake a sleeping camera…', () => {
    const html = tileStatusHtml(camera());
    assert.match(html, /data-act="live"[^>]*>Wake up</);
    assert.doesNotMatch(html, /data-act="idle"/);
  });

  test('…or stop a live one', () => {
    const html = tileStatusHtml(camera({ state: 'LIVE', display: { kind: 'live', title: 'Live', detail: 'until 12:31' } }));
    assert.match(html, /data-act="idle"[^>]*>Stop</);
    assert.doesNotMatch(html, /data-act="live"/);
  });

  test('shows the battery, highlighted when low', () => {
    assert.match(tileStatusHtml(camera()), /86 %/);
    assert.match(tileStatusHtml(camera({ battery: 12 })), /battery low/);
  });

  test('a camera without a battery reading shows none', () => {
    assert.doesNotMatch(tileStatusHtml(camera({ battery: null })), /%/);
  });
});

describe('stream details', () => {
  test('give the RTSP address, the video and the size', () => {
    const html = tileDetailsHtml(camera(), where);
    assert.match(html, /rtsp:\/\/192\.168\.1\.10:8554\/garden/);
    assert.match(html, /H\.265 · passed through, no conversion/);
    assert.match(html, /2880 × 1616/);
  });
});

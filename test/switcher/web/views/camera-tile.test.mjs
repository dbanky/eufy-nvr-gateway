import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tileHtml, tileStatusHtml, tileDetailsHtml } from '../../../../src/switcher/web/static/camera-tile.js';

const camera = (over = {}) => ({
  name: 'garden', state: 'IDLE', battery: 86, resolution: '2880x1616',
  display: { kind: 'asleep', title: 'Sleeping', detail: 'since 12:28' },
  video: { text: 'H.265 · passed through, no conversion' },
  ...over,
});
const where = { host: '192.168.1.10', rtspPort: 8554 };

describe('a camera tile', () => {
  test('every tile has the same picture area, whatever the camera\'s shape (rows line up)', () => {
    const a = tileHtml(camera(), where), b = tileHtml(camera({ resolution: '2048x1536' }), where);
    assert.doesNotMatch(a, /aspect-ratio/, 'the size comes from the stylesheet, not the camera');
    assert.equal(a.match(/<div class="tile-media">/g).length, 1);
    assert.equal(b.match(/<div class="tile-media">/g).length, 1);
  });

  test('shows the whole picture over a blurred copy of itself', () => {
    const html = tileHtml(camera(), where);
    assert.match(html, /<img class="backdrop" alt="" aria-hidden="true">/);
    assert.match(html, /<img class="picture" alt="What garden's stream shows">/);
  });

  test('waits for its first picture with a placeholder, never a broken image', () => {
    const html = tileHtml(camera(), where);
    assert.match(html, /data-picture="waiting"/);
    assert.doesNotMatch(html, /<img[^>]* src=/, 'no picture address until the picture has arrived');
    assert.match(html, /<div class="picture-wait" role="status">[\s\S]*class="spinner"[\s\S]*Getting the picture[\s\S]*The first one takes a few seconds/);
    assert.ok(html.indexOf('picture-wait') < html.indexOf('tile-name'), 'the name stays on top');
  });

  test('says on the details line whether the camera is published as ONVIF', () => {
    assert.match(tileHtml(camera({ onvif: { address: '192.168.1.51' } }), where), /<summary>Stream details <span class="tag onvif">ONVIF<\/span>/);
    assert.match(tileHtml(camera({ onvif: null }), where), /<span class="tag">RTSP only<\/span>/);
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
    const html = tileStatusHtml(camera({ state: 'LIVE', display: { kind: 'live', title: 'Live', detail: 'until 12:31:05' } }));
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

describe('the RTSP line', () => {
  test('says whether a login is needed, never what it is', () => {
    assert.match(tileDetailsHtml(camera(), { ...where, rtsp: { enabled: true, login: true } }), /Login required \(rtsp\.username/);
    assert.match(tileDetailsHtml(camera(), { ...where, rtsp: { enabled: true, login: false } }), /No login: anyone on the LAN can watch/);
  });

  test('says when RTSP is off the network, with no address to copy', () => {
    const html = tileDetailsHtml(camera(), { ...where, rtsp: { enabled: false, login: false } });
    assert.match(html, /Off: not on the network/);
    assert.doesNotMatch(html, /rtsp:\/\//);
  });
});

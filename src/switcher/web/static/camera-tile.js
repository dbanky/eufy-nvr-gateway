// One camera on the page, in the stream overlay's design language: the picture first, the name on
// it, then one status capsule (icon chip, state, detail), the battery and the one action that fits.
// Stream details (address, codec, size) wait behind a disclosure.
//
// tileHtml builds a tile once; tileStatusHtml and tileDetailsHtml are refreshed in place, so the
// picture doesn't flicker and an opened disclosure stays open. Pure: data in, HTML out.

import { esc } from './escape.js';
import { icon } from './icons.js';

const LOW_BATTERY = 20;   // %

// "2880x1616" -> "2880 / 1616", for CSS aspect-ratio: the tile has the camera's own shape.
export const aspectRatio = (resolution) => {
  const [w, h] = String(resolution).split('x').map(Number);
  return w && h ? `${w} / ${h}` : '16 / 9';
};

const streamUrl = (camera, { host, rtspPort }) => `rtsp://${host}:${rtspPort}/${camera.name}`;
const id = (camera) => 'cam-' + esc(camera.name);

export function tileHtml(camera, where) {
  return `<article class="tile" id="${id(camera)}" data-kind="${esc(camera.display.kind)}">
  <div class="tile-media" style="aspect-ratio: ${aspectRatio(camera.resolution)}">
    <img alt="What ${esc(camera.name)}'s stream shows" src="api/cameras/${encodeURIComponent(camera.name)}/snapshot.jpg?t=${Date.now()}">
    <span class="tile-name"><span class="dot"></span>${esc(camera.name)}</span>
  </div>
  <div class="tile-status" data-part="status">${tileStatusHtml(camera)}</div>
  <details class="tile-details">
    <summary>Stream details</summary>
    <div data-part="details">${tileDetailsHtml(camera, where)}</div>
  </details>
</article>`;
}

export function tileStatusHtml(camera) {
  const { kind, title, detail } = camera.display;
  const awake = camera.state === 'LIVE' || camera.state === 'WAKING';
  const action = awake
    ? `<button type="button" class="action" data-act="idle">Stop</button>`
    : `<button type="button" class="action primary" data-act="live">Wake up</button>`;
  return `<span class="capsule ${esc(kind)}"><span class="chip">${icon(kind)}</span>`
    + `<span class="capsule-text"><strong>${esc(title)}</strong><span>${esc(detail)}</span></span></span>`
    + batteryHtml(camera.battery) + action;
}

function batteryHtml(battery) {
  if (battery == null) return '';
  const low = battery < LOW_BATTERY;
  return `<span class="battery${low ? ' low' : ''}" title="${low ? 'battery low' : 'battery'}">`
    + `${icon('battery')}${battery} %${low ? '<span class="visually-hidden"> battery low</span>' : ''}</span>`;
}

export function tileDetailsHtml(camera, where) {
  const url = streamUrl(camera, where);
  const [w, h] = String(camera.resolution).split('x');
  return `<dl>
    <dt>Stream</dt>
    <dd class="copy-row"><input readonly value="${esc(url)}" aria-label="RTSP address of ${esc(camera.name)}">`
    + `<button type="button" class="icon-button" data-copy="${esc(url)}" aria-label="Copy the RTSP address">${icon('copy')}</button></dd>
    <dt>Video</dt><dd>${esc(camera.video?.text ?? '')}</dd>
    <dt>Size</dt><dd>${esc(w)} × ${esc(h)}</dd>
  </dl>`;
}

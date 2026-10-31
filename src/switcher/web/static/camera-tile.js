// One camera on the page, in the stream overlay's design language: the picture first, the name on
// it, then one status capsule (icon chip, state, detail), the battery and the one action that fits.
// Stream and ONVIF details wait behind a disclosure.
//
// Every tile has the same 16:9 picture area, so a row of tiles lines up: a camera of another shape
// (a 4:3 doorbell) is shown whole over a blurred copy of itself — the stream's sleeping look.
//
// tileHtml builds a tile once; tileStatusHtml and tileDetailsHtml are refreshed in place, so the
// picture doesn't flicker and an opened disclosure stays open. Pure: data in, HTML out.

import { esc } from './escape.js';
import { icon } from './icons.js';
import { onvifTagHtml, onvifDetailsHtml } from './onvif-info.js';

const LOW_BATTERY = 20;   // %

const snapshotUrl = (camera) => `api/cameras/${encodeURIComponent(camera.name)}/snapshot.jpg?t=${Date.now()}`;
const streamUrl = (camera, { host, rtspPort }) => `rtsp://${host}:${rtspPort}/${camera.name}`;
const id = (camera) => 'cam-' + esc(camera.name);

export function tileHtml(camera, where) {
  const src = snapshotUrl(camera);   // one URL for both: the picture is downloaded once
  return `<article class="tile" id="${id(camera)}" data-kind="${esc(camera.display.kind)}">
  <div class="tile-media">
    <img class="backdrop" alt="" aria-hidden="true" src="${src}">
    <img class="picture" alt="What ${esc(camera.name)}'s stream shows" src="${src}">
    <span class="tile-name"><span class="dot"></span>${esc(camera.name)}</span>
  </div>
  <div class="tile-status" data-part="status">${tileStatusHtml(camera)}</div>
  <details class="tile-details">
    <summary>Stream details ${onvifTagHtml(camera.onvif)}</summary>
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
  const [w, h] = String(camera.resolution).split('x');
  return `<h3 class="details-heading">Stream</h3>
  <dl>
    <dt>RTSP</dt>${rtspHtml(camera, where)}
    <dt>Video</dt><dd>${esc(camera.video?.text ?? '')}</dd>
    <dt>Size</dt><dd>${esc(w)} × ${esc(h)}</dd>
  </dl>
  <h3 class="details-heading">ONVIF</h3>
  ${onvifDetailsHtml(camera.onvif, camera.name)}`;
}

// The address to copy, and whether NVRs need a login for it; or that RTSP is off.
function rtspHtml(camera, where) {
  const rtsp = where.rtsp ?? { enabled: true, login: false };
  if (!rtsp.enabled) return '<dd>Off: not on the network ("rtsp.enabled": false)</dd>';
  const url = streamUrl(camera, where);
  return `<dd><div class="copy-row"><input readonly value="${esc(url)}" aria-label="RTSP address of ${esc(camera.name)}">`
    + `<button type="button" class="icon-button" data-copy="${esc(url)}" aria-label="Copy the RTSP address">${icon('copy')}</button></div>`
    + `<span class="sub">${rtsp.login ? 'Login required (rtsp.username / rtsp.password)' : 'No login: anyone on the LAN can watch'}</span></dd>`;
}

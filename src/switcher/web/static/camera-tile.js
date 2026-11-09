// One camera on the page, in the stream overlay's design language: the picture first, the name on
// it, then one status capsule (icon chip, state, detail), the battery and the one action that fits.
// Stream and ONVIF details wait behind a disclosure.
//
// Every tile has the same 16:9 picture area, so a row of tiles lines up: a camera of another shape
// (a 4:3 doorbell) is shown whole over a blurred copy of itself — the stream's sleeping look.
//
// Until its first picture has arrived (making it can take a few seconds after a start), a tile shows
// a placeholder in the stream's style instead of a broken image: tiles.js loads the picture.
//
// tileHtml builds a tile once; tileStatusHtml and tileDetailsHtml are refreshed in place, so the
// picture doesn't flicker and an opened disclosure stays open. Pure: data in, HTML out.

import { esc } from './escape.js';
import { icon } from './icons.js';
import { onvifTagHtml, onvifDetailsHtml } from './onvif-info.js';

const LOW_BATTERY = 20;   // %

export const snapshotUrl = (camera) => `api/cameras/${encodeURIComponent(camera.name)}/snapshot.jpg?t=${Date.now()}`;
const streamUrl = (camera, { host, rtspPort }) => `rtsp://${host}:${rtspPort}/${camera.name}`;
const id = (camera) => 'cam-' + esc(camera.name);

export function tileHtml(camera, where) {
  return `<article class="tile" id="${id(camera)}" data-kind="${esc(camera.display.kind)}" data-picture="waiting">
  <div class="tile-media">
    ${PICTURE_WAIT}
    <img class="backdrop" alt="" aria-hidden="true">
    <img class="picture" alt="What ${esc(camera.name)}'s stream shows">
    <span class="tile-name"><span class="dot"></span>${esc(camera.name)}</span>
  </div>
  <div class="tile-status" data-part="status">${tileStatusHtml(camera)}</div>
  <details class="tile-details">
    <summary>Stream details ${onvifTagHtml(camera.onvif)}</summary>
    <div data-part="details">${tileDetailsHtml(camera, where)}</div>
  </details>
</article>`;
}

// Like the stream's own pictures: a round chip in the middle (here a spinner), title and detail under it.
const PICTURE_WAIT = `<div class="picture-wait" role="status">
      <span class="wait-chip"><span class="spinner"></span></span>
      <strong>Getting the picture</strong><span>The first one takes a few seconds</span>
    </div>`;

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
    ${eufyModeRow(camera.eufyMode)}
    <dt>Audio</dt><dd>${camera.audio ? `${esc(camera.audio)}<span class="sub">The camera's sound while live, silence while it sleeps</span>`
      : 'Off<span class="sub"><code>"audio": true</code> adds the camera\'s sound</span>'}</dd>
    <dt>Size</dt><dd>${esc(w)} × ${esc(h)}</dd>
  </dl>
  <h3 class="details-heading">ONVIF</h3>
  ${onvifDetailsHtml(camera.onvif, camera.name)}`;
}

// The address to copy, and whether NVRs need a login for it.
function rtspHtml(camera, where) {
  const rtsp = where.rtsp ?? { login: false };
  const url = streamUrl(camera, where);
  return `<dd><div class="copy-row"><input readonly value="${esc(url)}" aria-label="RTSP address of ${esc(camera.name)}">`
    + `<button type="button" class="icon-button" data-copy="${esc(url)}" aria-label="Copy the RTSP address">${icon('copy')}</button></div>`
    + `<span class="sub">${rtsp.login ? 'Login required (rtsp.username / rtsp.password)' : 'No login: anyone on the LAN can watch'}</span></dd>`;
}

// The camera's eufy mode (its station's guard mode), switched in the eufy app or over the API.
function eufyModeRow(eufyMode) {
  if (!eufyMode?.mode) return '';
  const where = eufyMode.shared ? `<span class="sub">Set on ${esc(eufyMode.station.name ?? eufyMode.station.serial)}, for every device on it</span>` : '';
  return `<dt>eufy mode</dt><dd>${esc(eufyMode.label ?? eufyMode.mode)}${where}</dd>`;
}

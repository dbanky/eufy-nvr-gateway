// A camera's ONVIF side, for the tile's details: is it published, where, what NVRs discover, and is
// an NVR talking to it. onvif (from /api/status): null, or see onvifStatus() in src/onvif/index.mjs.
// Never shows the password, only whether there is one. Pure.

import { esc } from './escape.js';
import { icon } from './icons.js';

const DOCS = 'https://github.com/dbanky/eufy-nvr-gateway/blob/main/docs/onvif.md';

// 4 -> "4 s ago", 300 -> "5 min ago", 7200 -> "2 h ago"
export function ago(seconds) {
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

// The small tag on the details' summary line.
export const onvifTagHtml = (onvif) => (onvif ? '<span class="tag onvif">ONVIF</span>' : '<span class="tag">RTSP only</span>');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function discoveryText(d) {
  if (d.listening && !d.error) return 'On · NVRs find it by themselves (WS-Discovery, UDP 3702)';
  if (d.listening) return `Partly on: ${d.error}`;
  return d.error ? `Off: ${d.error}` : 'Starting…';
}

function nvrText(onvif) {
  const c = onvif.lastContact;
  if (!c) return 'No NVR has connected yet';
  const subs = onvif.subscriptions ? ` · ${plural(onvif.subscriptions, 'motion event subscription')}` : '';
  return `Last request ${ago(c.secondsAgo)} from ${c.from} (${c.op})${subs}`;
}

export function onvifDetailsHtml(onvif, cameraName) {
  if (!onvif) {
    return `<p class="details-note">Not published as an ONVIF device. NVRs that adopt only ONVIF cameras (UniFi Protect)
      need an <code>onvif</code> section for this camera in <code>config.json</code> — <a href="${DOCS}" target="_blank" rel="noopener">how</a>.</p>`;
  }
  const d = onvif.discovery ?? {};
  return `<dl>
    <dt>Device</dt>
    <dd class="copy-row"><input readonly value="${esc(onvif.deviceService)}" aria-label="ONVIF address of ${esc(cameraName)}">`
    + `<button type="button" class="icon-button" data-copy="${esc(onvif.deviceService)}" aria-label="Copy the ONVIF address">${icon('copy')}</button></dd>
    <dt>Address</dt><dd>${esc(onvif.address)} · port ${esc(onvif.port)}${onvif.mac ? ` · MAC ${esc(onvif.mac)}` : ''}</dd>
    <dt>Login</dt><dd>${onvif.login ? 'Required (onvif.username / onvif.password)'
      : `<span class="warn">${icon('nowake')}None: anyone on the LAN can adopt it</span>`}</dd>
    <dt>Discovery</dt><dd>${esc(discoveryText(d))}<span class="sub">as “${esc(d.name)}” · ${esc(d.hardware)} · <code>${esc(d.uuid)}</code></span></dd>
    <dt>NVR</dt><dd>${esc(nvrText(onvif))}</dd>
  </dl>`;
}

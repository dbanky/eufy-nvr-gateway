// The gateway itself: its version, whether a newer one is out, and where the project lives.
// gateway (from /api/status): { version, update: { project, enabled, checked, newer, error } }. Pure.

import { esc } from './escape.js';
import { icon } from './icons.js';

const PROJECT = 'https://github.com/dbanky/eufy-nvr-gateway';
const ONVIF_DOCS = `${PROJECT}/blob/main/docs/onvif.md`;
const project = (gateway) => gateway.update?.project ?? PROJECT;
export const howToUpdate = (gateway) => `${project(gateway)}#updating`;

// 'newer' | 'current' | 'checking' | 'failed' | 'off'
export function updateState(gateway) {
  const u = gateway.update;
  if (!u || u.enabled === false) return 'off';
  if (u.newer) return 'newer';
  if (u.checked) return 'current';
  return u.error ? 'failed' : 'checking';
}

// The header's reminder: stays as long as an update is out, even after the banner was put away.
export function updatePillHtml(gateway) {
  if (updateState(gateway) !== 'newer') return '';
  const { version, url } = gateway.update.newer;
  return `<a class="pill update" href="${esc(url)}" target="_blank" rel="noopener">${icon('update')}Update to ${esc(version)}</a>`;
}

// The banner above the cameras when a newer version is out.
// ONVIF cameras configured, but the container is on a bridge network: nothing ONVIF can work.
// Not dismissible: it stays until the container is on host networking.
export function onvifBannerHtml(gateway) {
  if (!gateway.onvifProblem) return '';
  return `<section class="panel banner problem" role="alert" aria-labelledby="onvifProblemTitle">
  <span class="chip">${icon('nowake')}</span>
  <div class="banner-text">
    <h2 id="onvifProblemTitle">ONVIF can’t work: switch the container to host networking</h2>
    <p>${esc(gateway.onvifProblem)}.</p>
  </div>
  <div class="row">
    <a class="action primary" href="${esc(ONVIF_DOCS)}#1-give-each-camera-its-own-address" target="_blank" rel="noopener">How to set it up</a>
  </div>
</section>`;
}

export function updateBannerHtml(gateway) {
  if (updateState(gateway) !== 'newer') return '';
  const { version, url, prerelease } = gateway.update.newer;
  return `<section class="panel banner" aria-labelledby="updateTitle">
  <span class="chip">${icon('update')}</span>
  <div class="banner-text">
    <h2 id="updateTitle">Version ${esc(version)} is available${prerelease ? ' <span class="tag">beta</span>' : ''}</h2>
    <p class="muted">This gateway runs ${esc(gateway.version)}. Updating keeps your folder: config, eufy login and pictures.</p>
  </div>
  <div class="row">
    <a class="action primary" href="${esc(url)}" target="_blank" rel="noopener">What’s new</a>
    <a class="action" href="${esc(howToUpdate(gateway))}" target="_blank" rel="noopener">How to update</a>
    <button type="button" class="action quiet" data-dismiss="${esc(version)}">Later</button>
  </div>
</section>`;
}

export function footerHtml(gateway) {
  const state = updateState(gateway);
  const status = {
    newer: `<a href="${esc(gateway.update?.newer?.url)}" target="_blank" rel="noopener" class="foot-update">${icon('update')}${esc(gateway.update?.newer?.version)} is available</a>`,
    current: `<span class="foot-ok">${icon('ok')}Latest version</span>`,
    checking: '<span>Checking for updates…</span>',
    failed: `<span title="${esc(gateway.update?.error)}">Couldn’t check for updates</span>`,
    off: '<span>Update check off</span>',
  }[state];
  return `<span>Eufy NVR Gateway <strong>${esc(gateway.version)}</strong></span>${status}`
    + `<a href="${esc(project(gateway))}" target="_blank" rel="noopener">${icon('code')}GitHub</a>`
    + `<a href="${esc(project(gateway))}/issues" target="_blank" rel="noopener">Report a problem</a>`;
}

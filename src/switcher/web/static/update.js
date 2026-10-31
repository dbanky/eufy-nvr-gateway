// The ONVIF network warning, the update banner and header reminder. "Later" puts the banner away for that version (in this
// browser); the header reminder stays until the gateway is updated.

import { updatePillHtml, updateBannerHtml, onvifBannerHtml, footerHtml } from './gateway.js';

const $ = (id) => document.getElementById(id);
const KEY = 'dismissedUpdate';
const dismissed = () => { try { return localStorage.getItem(KEY); } catch { return null; } };

let shown = '';
let shownOnvif = '';
export function showGateway(gateway) {
  const html = gateway.update?.newer?.version === dismissed() ? '' : updateBannerHtml(gateway);
  if (html !== shown) $('updateBanner').innerHTML = shown = html;   // untouched while unchanged
  const onvif = onvifBannerHtml(gateway);
  if (onvif !== shownOnvif) $('onvifBanner').innerHTML = shownOnvif = onvif;
  $('updatePill').innerHTML = updatePillHtml(gateway);
  $('footer').innerHTML = footerHtml(gateway);
}

$('updateBanner').addEventListener('click', (e) => {
  const button = e.target.closest('[data-dismiss]');
  if (!button) return;
  try { localStorage.setItem(KEY, button.dataset.dismiss); } catch { /* shown again next time */ }
  $('updateBanner').innerHTML = shown = '';
});

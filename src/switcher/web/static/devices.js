// The devices on the eufy account: a collapsed list, mainly needed once, to copy serial numbers.

import { esc } from './escape.js';

export function devicesSummary(devices) {
  if (!devices.length) return 'none found';
  const notAdded = devices.filter((d) => !d.configured).length;
  return `${devices.length} device${devices.length === 1 ? '' : 's'}` + (notAdded ? ` · ${notAdded} not added` : '');
}

export function devicesRowsHtml(devices) {
  if (!devices.length) return '<tr><td colspan="4" class="muted">No devices found.</td></tr>';
  return devices.map((d) => `<tr>
    <td>${esc(d.name)}<div class="muted">${esc([d.model, d.modelName].filter(Boolean).join(' · '))}</div></td>
    <td><code>${esc(d.serial)}</code></td>
    <td>${d.battery != null ? esc(d.battery) + ' %' : ''}</td>
    <td>${d.configured ? '<span class="tag added">Added</span>' : '<span class="tag">Not added</span>'}</td>
  </tr>`).join('');
}

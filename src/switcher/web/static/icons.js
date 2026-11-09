// The stream overlay's icons (24x24 strokes), plus a few for the page itself, as inline SVG.

const PATHS = {
  // states, as on the stream
  asleep: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  disarmed: '<path d="M12 3 5 6v5c0 4.4 2.9 8.1 7 9.5 1.4-.5 2.7-1.3 3.8-2.3"/><path d="M19 14.7c.3-1.2.5-2.4.5-3.7V6L12 3"/><path d="M3 3l18 18"/>',
  waking: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
  live: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
  lowbattery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2"/><path d="M5.5 10v4"/>',
  nowake: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4.5"/><path d="M12 17.2h.01"/>',
  offline: '<path d="M3 3l18 18"/><path d="M8.5 6.6A6 6 0 0 1 17.6 10a4.2 4.2 0 0 1 3 5.6"/><path d="M17 18H7a4.5 4.5 0 0 1-1.6-8.7"/>',
  nopicture: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/><path d="M3 3l18 18"/>',
  // page
  battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2"/><path d="M5.5 10v4M9 10v4M12.5 10v4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  ok: '<path d="M20 6 9 17l-5-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  update: '<circle cx="12" cy="12" r="9"/><path d="M12 16V8M8.5 11.5 12 8l3.5 3.5"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
  signout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>',
};

export const icon = (name, label) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
  + ' stroke-linecap="round" stroke-linejoin="round"' + (label ? ` role="img" aria-label="${label}"` : ' aria-hidden="true"') + '>'
  + (PATHS[name] || '') + '</svg>';

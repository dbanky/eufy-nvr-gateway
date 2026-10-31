// The stream overlay's icons (24x24 strokes), plus a few for the page itself, as inline SVG.

const PATHS = {
  // states, as on the stream
  asleep: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
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
};

export const icon = (name, label) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
  + ' stroke-linecap="round" stroke-linejoin="round"' + (label ? ` role="img" aria-label="${label}"` : ' aria-hidden="true"') + '>'
  + (PATHS[name] || '') + '</svg>';

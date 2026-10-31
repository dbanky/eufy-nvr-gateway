// The same state icons as the stream overlay (24x24 stroke paths), as inline SVG.

const PATHS = {
  asleep: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  waking: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
  live: '<circle cx="12" cy="12" r="5" fill="currentColor"/>',
  lowbattery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2"/><path d="M5.5 10v4"/>',
  nowake: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4.5"/><path d="M12 17.2h.01"/>',
  offline: '<path d="M3 3l18 18"/><path d="M8.5 6.6A6 6 0 0 1 17.6 10a4.2 4.2 0 0 1 3 5.6"/><path d="M17 18H7a4.5 4.5 0 0 1-1.6-8.7"/>',
  nopicture: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/><path d="M3 3l18 18"/>',
};

export const icon = (kind) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'
  + ' stroke-linejoin="round" aria-hidden="true">' + (PATHS[kind] || '') + '</svg>';

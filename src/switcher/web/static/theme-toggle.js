// The light/dark switch in the header (the page and the sign-in page).

import { icon } from './icons.js';

const root = document.documentElement;
const system = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : system.matches);

export function bindThemeToggle(button) {
  if (root.hasAttribute('data-theme-fixed')) {   // set in config.json
    button.hidden = true;
    return;
  }
  const show = () => {
    const label = isDark() ? 'Switch to the light theme' : 'Switch to the dark theme';
    button.innerHTML = icon(isDark() ? 'sun' : 'moon');
    button.setAttribute('aria-label', label);
    button.title = label;
  };
  button.addEventListener('click', () => {
    root.dataset.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch { /* not remembered */ }
    show();
  });
  system.addEventListener('change', show);
  show();
}

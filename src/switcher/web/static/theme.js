// Runs before the page paints, so it never flashes the other theme. A theme picked with the toggle
// is remembered in this browser; until then the system's light or dark setting decides.
// "web.theme" in config.json fixes it (the server writes data-theme-fixed into the page): then
// there is no switch, and an earlier choice in this browser no longer counts.
try {
  const theme = document.documentElement.hasAttribute('data-theme-fixed') ? null : localStorage.getItem('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* storage blocked: follow the system */ }

// Runs before the page paints, so it never flashes the other theme. A theme picked with the toggle
// is remembered in this browser; until then the system's light or dark setting decides.
try {
  const theme = localStorage.getItem('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* storage blocked: follow the system */ }

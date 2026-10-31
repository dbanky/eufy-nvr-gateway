// The sign-in page: shown when "web" in config.json asks for a login.

import { bindThemeToggle } from './theme-toggle.js';
import { icon } from './icons.js';

const $ = (id) => document.getElementById(id);
const home = () => location.replace('./');

bindThemeToggle($('theme'));
$('brandMark').innerHTML = icon('asleep');

// Already signed in, or no login configured: straight to the page.
fetch('api/session').then((r) => r.json()).then((s) => { if (s.signedIn) home(); }).catch(() => {});

$('signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.submitter ?? $('signin').querySelector('button');
  if (!$('username').value || !$('password').value) {
    $('signinMsg').textContent = 'Enter the username and the password.';
    return;
  }
  button.disabled = true;
  $('signinMsg').textContent = '';
  try {
    const res = await fetch('api/signin', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    if (res.ok) return home();
    $('signinMsg').textContent = (await res.json()).error ?? 'Not signed in.';
    $('password').select();
  } catch {
    $('signinMsg').textContent = 'The gateway can’t be reached.';
  } finally {
    button.disabled = false;
  }
});

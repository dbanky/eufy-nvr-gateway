// Signing in and out of the web page, and what a request that isn't signed in gets.

import { sendJson, readJson, serveStatic } from './http.mjs';
import { signedOutCookie } from './auth.mjs';

// What the sign-in page needs before anyone is signed in.
const OPEN_FILES = /^\/(signin\.html|signin\.js|theme\.js|theme-toggle\.js|icons\.js|style\.css|fonts\/[^/]+)$/;
const FAILED_SIGNIN_DELAY_MS = 1000;   // slows down guessing

export async function signIn(req, res, auth) {
  if (!auth) return sendJson(res, 200, { ok: true });   // nothing to sign in to
  const { username, password } = await readJson(req);
  if (!auth.matches(username, password)) {
    await new Promise((resolve) => setTimeout(resolve, FAILED_SIGNIN_DELAY_MS));
    return sendJson(res, 401, { ok: false, error: 'Wrong username or password.' });
  }
  res.setHeader('set-cookie', auth.sessionCookie());
  sendJson(res, 200, { ok: true });
}

export function signOut(res) {
  res.setHeader('set-cookie', signedOutCookie);
  sendJson(res, 200, { ok: true });
}

// Not signed in: the sign-in page's own files are open, pages lead to it, everything else is 401.
// Browsers (they send Sec-Fetch-Mode) get no Basic challenge, so they never show a login dialog;
// other clients (curl, NVRs fetching snapshots) do, so they can answer it.
export function refuse(req, res, path, page) {
  if (req.method === 'GET' && OPEN_FILES.test(path) && serveStatic(res, path, page)) return;
  if (req.method === 'GET' && (path === '/' || path.endsWith('.html'))) {
    res.writeHead(302, { location: 'signin.html' });
    return res.end();
  }
  if (!req.headers['sec-fetch-mode']) res.setHeader('www-authenticate', 'Basic realm="Eufy NVR Gateway", charset="UTF-8"');
  sendJson(res, 401, { error: 'sign in first' });
}

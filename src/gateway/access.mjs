// Who may reach what: the logins (the web page's; one for the streams, RTSP and ONVIF), HTTPS and
// the theme of the web page, and a summary of what is still open to the LAN. Pure: settings in, settings or messages out.

const THEMES = ['auto', 'light', 'dark'];

// The web page: optional login, theme, optional HTTPS (own certificate, or a generated self-signed one).
export function webSettings(web = {}) {
  const theme = web.theme ?? 'auto';
  if (!THEMES.includes(theme)) throw new Error(`"web.theme" must be ${THEMES.map((t) => `"${t}"`).join(', ')}`);
  if (web.https != null && typeof web.https !== 'boolean') throw new Error('"web.https" must be true or false');
  if (!web.certFile !== !web.keyFile) throw new Error('"web.certFile" and "web.keyFile" go together (your own HTTPS certificate and its key)');
  const allowedHosts = web.allowedHosts ?? [];
  if (!Array.isArray(allowedHosts) || allowedHosts.some((h) => typeof h !== 'string' || !h.trim())) {
    throw new Error('"web.allowedHosts" must be a list of host names, e.g. ["nvr.example.com", "*.example.com"]');
  }
  return {
    login: login(web, 'web', 'the login for the web page'),
    theme,
    https: web.https === true,
    certFile: web.certFile ?? null,
    keyFile: web.keyFile ?? null,
    allowedHosts,   // without a login: host names besides addresses and local names (security/web-requests.mjs)
  };
}

// The streams NVRs read, always on the network, and one optional login for them. ONVIF uses the same login: an NVR that adopts an ONVIF camera (UniFi Protect)
// opens its RTSP stream with the ONVIF login, so two different logins could never work.
// v0.4.0-beta.1 had it as "onvif.username" / "onvif.password": still accepted.
export function rtspSettings(rtsp = {}, oldOnvif = undefined) {
  // "rtsp.enabled" (until 0.4.0-beta.4): the streams are the gateway's whole point, so there is no off
  // switch any more. A config that turned them off gets told, rather than its streams appearing.
  if (rtsp.enabled === false) {
    throw new Error('"rtsp.enabled" is gone: the RTSP streams are always on. Remove it, and set "rtsp.username" / "rtsp.password" so only your NVR can watch');
  }
  const own = login(rtsp, 'rtsp', 'the login NVRs use for the RTSP streams and ONVIF cameras');
  const old = login(oldOnvif, 'onvif', 'the old place of the stream login: use "rtsp.username" / "rtsp.password"');
  if (own && old && (own.username !== old.username || own.password !== old.password)) {
    throw new Error('one login covers RTSP and ONVIF: keep "rtsp.username" / "rtsp.password" and remove "onvif.username" / "onvif.password"');
  }
  return { login: own ?? old, oldKeys: !!old };
}

// What is open to anyone on the LAN, for the log at startup: [] when everything asks for a login.
export function openToTheLan({ web, rtsp, cameras }) {
  const open = [];
  if (!web.login) open.push('web page and API without login (set "web.username" / "web.password")');
  else if (!web.https) open.push('web page login over plain HTTP (set "web.https": true)');
  const onvif = cameras.some((c) => c.onvif);
  if (!rtsp.login) open.push(`RTSP streams${onvif ? ' and ONVIF cameras' : ''} without login (set "rtsp.username" / "rtsp.password")`);
  return open;
}

// Things that work but probably not as meant.
export function configWarnings({ rtsp }) {
  return rtsp.oldKeys ? ['"onvif.username" / "onvif.password" are now "rtsp.username" / "rtsp.password" (one login for RTSP and ONVIF): please move them'] : [];
}

// A { username, password } section: both or neither (null).
export function login(section, key, what) {
  if (!section?.username && !section?.password) return null;
  if (!section.username) throw new Error(`"${key}.username" is missing (${what})`);
  if (!section.password) throw new Error(`"${key}.password" is missing (${what})`);
  return { username: String(section.username), password: String(section.password) };
}

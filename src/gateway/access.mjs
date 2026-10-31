// Who may reach what: the logins (web page, RTSP, ONVIF), HTTPS and the theme of the web page, and
// a summary of what is still open to the LAN. Pure: settings in, settings or messages out.

const THEMES = ['auto', 'light', 'dark'];

// The web page: optional login, theme, optional HTTPS (own certificate, or a generated self-signed one).
export function webSettings(web = {}) {
  const theme = web.theme ?? 'auto';
  if (!THEMES.includes(theme)) throw new Error(`"web.theme" must be ${THEMES.map((t) => `"${t}"`).join(', ')}`);
  if (web.https != null && typeof web.https !== 'boolean') throw new Error('"web.https" must be true or false');
  if (!web.certFile !== !web.keyFile) throw new Error('"web.certFile" and "web.keyFile" go together (your own HTTPS certificate and its key)');
  return {
    login: login(web, 'web', 'the login for the web page'),
    theme,
    https: web.https === true,
    certFile: web.certFile ?? null,
    keyFile: web.keyFile ?? null,
  };
}

// The RTSP streams NVRs read: on the network (default) or only inside the container, optional login.
export function rtspSettings(rtsp = {}) {
  if (rtsp.enabled != null && typeof rtsp.enabled !== 'boolean') throw new Error('"rtsp.enabled" must be true or false');
  return { enabled: rtsp.enabled !== false, login: login(rtsp, 'rtsp', 'the login NVRs use for the RTSP streams') };
}

// What is open to anyone on the LAN, for the log at startup: [] when everything asks for a login.
export function openToTheLan({ web, rtsp, onvif, cameras }) {
  const open = [];
  if (!web.login) open.push('web page and API without login (set "web.username" / "web.password")');
  else if (!web.https) open.push('web page login over plain HTTP (set "web.https": true)');
  if (rtsp.enabled && !rtsp.login) open.push('RTSP streams without login (set "rtsp.username" / "rtsp.password", or "rtsp.enabled": false)');
  if (cameras.some((c) => c.onvif) && !onvif) open.push('ONVIF cameras without login (set "onvif.username" / "onvif.password")');
  return open;
}

// Things that work but probably not as meant.
export function configWarnings({ rtsp, onvif, cameras }) {
  const warnings = [];
  if (cameras.some((c) => c.onvif) && rtsp.login && (!onvif || onvif.username !== rtsp.login.username || onvif.password !== rtsp.login.password)) {
    warnings.push('the RTSP login differs from the ONVIF login: NVRs that adopt ONVIF cameras (UniFi Protect) use the ONVIF login for the stream too');
  }
  return warnings;
}

// A { username, password } section: both or neither (null).
export function login(section, key, what) {
  if (!section?.username && !section?.password) return null;
  if (!section.username) throw new Error(`"${key}.username" is missing (${what})`);
  if (!section.password) throw new Error(`"${key}.password" is missing (${what})`);
  return { username: String(section.username), password: String(section.password) };
}

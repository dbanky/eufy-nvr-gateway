// The configuration each bundled service gets, derived from the settings. Pure functions.

// go2rtc: one empty stream per camera (the switcher publishes into it), RTSP only.
// Its web UI/API, WebRTC, SRTP and RTMP are not needed and stay closed.
// Its login applies to the network only: go2rtc lets localhost in, so the switcher needs none.
export function go2rtcYaml({ ports, cameras, rtsp = { login: null } }) {
  const q = JSON.stringify;   // JSON strings are valid YAML scalars
  const login = rtsp.login ? `\n  username: ${q(rtsp.login.username)}\n  password: ${q(rtsp.login.password)}` : '';
  return [
    '# Generated at container start. Edit config.json instead.',
    `rtsp:\n  listen: ${q(':' + ports.rtsp)}${login}`,
    'api:\n  listen: ""',
    'webrtc:\n  listen: ""',
    'srtp:\n  listen: ""',
    'rtmp:\n  listen: ""',
    'log:\n  level: warn',
    'streams:' + (cameras.length ? '' : ' {}'),
    ...cameras.map((c) => `  ${q(c.name)}:`),
    '',
  ].join('\n');
}

// What the switcher process reads (it never sees the user's config.json directly).
export function switcherConfig({ ports, timeZone, cameras, onvif = null, web = {}, rtsp = { login: null }, checkForUpdates = true }, dataDir) {
  return {
    bridgeWs: `ws://127.0.0.1:${ports.bridge}/ws`,
    bridgeHttp: `http://127.0.0.1:${ports.bridge}`,
    output: `rtsp://127.0.0.1:${ports.rtsp}/{name}`,
    rtspPort: ports.rtsp,
    webPort: ports.web,
    dataDir: `${dataDir}/switcher`,
    timeZone,
    cameras,
    onvif,   // the ONVIF login, if any; cameras carry their own onvif address
    web: {   // the web page: login (if any), theme, HTTPS certificate files (if HTTPS)
      login: web.login ?? null,
      theme: web.theme ?? 'auto',
      tls: web.https ? { cert: web.certFile ?? `${dataDir}/web/cert.pem`, key: web.keyFile ?? `${dataDir}/web/key.pem` } : null,
    },
    rtsp: { login: !!rtsp.login },   // for the web page: never the password
    checkForUpdates,
  };
}

// Environment of the bundled eufy bridge (ha-eufy-sdk-bridge).
export function bridgeEnv({ eufy, ports, bridgeEnv: extra }, dataDir, env) {
  return {
    EUFY_EMAIL: eufy.email,
    EUFY_PASSWORD: eufy.password,
    EUFY_COUNTRY: eufy.country,
    BRIDGE_HOST: '127.0.0.1',   // never on the network: its /stream URLs wake cameras
    BRIDGE_PORT: String(ports.bridge),
    GO2RTC_ENABLE: '0',         // only the switcher may consume camera streams
    GO2RTC_CONFIG: `${dataDir}/bridge/go2rtc.yaml`,
    EUFY_SESSION: `${dataDir}/bridge/.eufy-session.json`,
    // The switcher ends every session itself; the SDK's 45 s battery cut-off would only interrupt
    // it. 0, empty or values above 2^31-1 silently fall back to 45 s.
    STREAM_BATTERY_BUDGET_MS: env.STREAM_BATTERY_BUDGET_MS ?? '86400000',
    ...extra,
  };
}

// The configuration each bundled service gets, derived from the settings. Pure functions.

import { jpegSize } from '../onvif/media-model.mjs';

// The MJPEG variant: RFC 2435 (JPEG over RTP) needs ffmpeg's standard Huffman tables and both
// quantisation tables, which ffmpeg's encoder leaves out by default.
const MJPEG = '-huffman default -force_duplicated_matrix 1 -q:v 5';

// The variants of one camera's stream that ONVIF clients may choose (media-model.mjs): MJPEG and,
// with sound, G711. Each runs an ffmpeg only while someone watches it.
export function streamVariants(cam) {
  const { width, height } = jpegSize(cam);
  const mjpeg = `#video=mjpeg#width=${width}#height=${height}#raw=${MJPEG}`;
  return cam.audio
    ? { [`${cam.name}~mjpeg`]: `ffmpeg:${cam.name}${mjpeg}#audio=copy`, [`${cam.name}~g711`]: `ffmpeg:${cam.name}#video=copy#audio=pcmu`,
      [`${cam.name}~mjpeg~g711`]: `ffmpeg:${cam.name}${mjpeg}#audio=pcmu` }
    : { [`${cam.name}~mjpeg`]: `ffmpeg:${cam.name}${mjpeg}` };
}

// go2rtc: one empty stream per camera (the switcher publishes into it) and its variants, RTSP on
// 127.0.0.1 only: NVRs connect to the gateway's RTSP front (src/rtsp/), which checks the login.
// Its web UI/API, WebRTC, SRTP and RTMP are not needed and stay closed.
export function go2rtcYaml({ ports, cameras }) {
  const q = JSON.stringify;   // JSON strings are valid YAML scalars
  const streams = cameras.flatMap((c) => [`  ${q(c.name)}:`, ...Object.entries(streamVariants(c)).map(([name, source]) => `  ${q(name)}: ${q(source)}`)]);
  return [
    '# Generated at container start. Edit config.json instead.',
    `rtsp:\n  listen: ${q('127.0.0.1:' + ports.go2rtc)}`,
    'api:\n  listen: ""',
    'webrtc:\n  listen: ""',
    'srtp:\n  listen: ""',
    'rtmp:\n  listen: ""',
    'log:\n  level: warn',
    'streams:' + (cameras.length ? '' : ' {}'),
    ...streams,
    '',
  ].join('\n');
}

// What the switcher process reads (it never sees the user's config.json directly).
export function switcherConfig({ ports, timeZone, cameras, onvif = null, web = {}, rtsp = { login: null }, checkForUpdates = true }, dataDir) {
  return {
    bridgeWs: `ws://127.0.0.1:${ports.bridge}/ws`,
    bridgeHttp: `http://127.0.0.1:${ports.bridge}`,
    output: `rtsp://127.0.0.1:${ports.go2rtc}/{name}`,
    rtspPort: ports.rtsp,      // the RTSP front NVRs use
    go2rtcPort: ports.go2rtc,  // where the front finds the streams
    webPort: ports.web,
    dataDir: `${dataDir}/switcher`,
    timeZone,
    cameras,
    onvif,   // the RTSP/ONVIF login, if any; cameras carry their own onvif address
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

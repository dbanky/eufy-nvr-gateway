# Configuration reference

The gateway reads `config.json` from the data folder (`/data/config.json` in the container) at start.
Change it, then restart the container. A file mounted at `/config/config.json` takes precedence (older
setups); `CONFIG_FILE` overrides the path entirely. A complete example:
[`examples/config.full.example.json`](../examples/config.full.example.json).

## eufy account

| Environment variable | `config.json` | Meaning |
|---|---|---|
| `EUFY_EMAIL` | `eufy.email` | Account e-mail. Use a dedicated account the cameras are shared with. |
| `EUFY_PASSWORD` | `eufy.password` | Account password. Prefer the environment variable over the file. |
| `EUFY_COUNTRY` | `eufy.country` | Two-letter country the account was registered in (`GB`, `DE`, `US`, …). Default `GB`. |

Environment variables win over `config.json`.

## Top level

| Key | Default | Meaning |
|---|---|---|
| `timezone` | `TZ` or `UTC` | Time zone for the times on the stream labels (`since 18:33`) |
| `cameras` | `[]` | The cameras to publish (below) |
| `defaults` | `{}` | Any camera setting, applied to every camera unless the camera sets it itself |
| `ports` | see below | Network ports |
| `web` | see below | The web page: login, theme, HTTPS |
| `rtsp` | see below | The RTSP streams: login, or off the network |
| `onvif` | — | The login NVRs use for ONVIF cameras: `{ "username", "password" }` ([onvif.md](onvif.md)) |
| `checkForUpdates` | `true` | Ask GitHub for new releases every 6 h and show them on the web page. `false`: no request leaves the gateway |
| `bridge.env` | `{}` | Extra environment variables for the bridge (see the [bridge docs](https://github.com/mega-yfue/ha-eufy-sdk-bridge)) |

## Web page (`web`)

| Key | Default | Meaning |
|---|---|---|
| `web.username`, `web.password` | — | A login for the web page and API (both or neither). Browsers get a sign-in page and a 30-day session cookie; scripts and NVRs send HTTP Basic. Changing the password ends every session. Without it, anyone on the LAN can use the page |
| `web.theme` | `"auto"` | `"auto"`: the system's light or dark setting, with a switch in the header (remembered per browser). `"light"` or `"dark"`: always that, no switch |
| `web.https` | `false` | `true`: the page and API over HTTPS on the same port; plain `http://` redirects to `https://`, and the session cookie is never sent unencrypted |
| `web.certFile`, `web.keyFile` | — | Your own certificate and key (PEM, paths inside the container, e.g. `/data/web/my-cert.pem`). Without them, `https` makes a self-signed certificate once (`/data/web/cert.pem`, `key.pem`, valid 10 years, for the host's name and addresses); browsers warn about it the first time |

```json
"web": { "username": "admin", "password": "choose-a-password", "theme": "light", "https": true }
```

## RTSP streams (`rtsp`)

| Key | Default | Meaning |
|---|---|---|
| `rtsp.username`, `rtsp.password` | — | A login for the RTSP streams (both or neither): `rtsp://user:password@host:8554/<name>`. The gateway's own publishing inside the container needs none |
| `rtsp.enabled` | `true` | `false`: the streams stay inside the container, nothing on the network can read them. Not possible together with ONVIF cameras, which point NVRs at their stream |

UniFi Protect reads the stream with the ONVIF login, so with ONVIF cameras give `rtsp` the same
login as `onvif`. The log notes it when they differ.

## What is open to your LAN

At every start the log says either *Every web page, API, stream and ONVIF camera asks for a login*,
or names each open part with the setting that closes it, e.g.
`Open to anyone on your LAN: RTSP streams without login (set "rtsp.username" / "rtsp.password", or "rtsp.enabled": false)`.

## Cameras

| Key | Default | Meaning |
|---|---|---|
| `name` | — | Required. Letters, digits, `-`, `_`. RTSP path and display name |
| `serial` | — | Required. Serial number from the web page's device list |
| `width`, `height` | — | Required. The camera's native live resolution: the size of the sleeping picture, and of live video when converting |
| `fps` | `15` | Output frame rate. When passing through it must match the camera's real frame rate (eufy cameras: 15) |
| `bitrateKbps` | `4400` | Bitrate ceiling for what the gateway encodes: the sleeping picture (which uses far less) and live video when converting (~`6600` for 3K) |
| `holdMs` | `30000` | Stay live until this long after the last detection (at least this long after the first live frame). Continuing motion keeps the stream live |
| `ringHoldMs` | `120000` | Same, after a doorbell press |
| `maxLiveMs` | `0` | Optional cap per session, from the first live frame; repeated detections cannot extend past it. `0` = no cap. Set it (e.g. `600000`) if constant motion would drain the battery |
| `firstFrameTimeoutMs` | `60000` | Give up waking the camera if no video arrives by then |
| `restartGapMs` | `15000` | Minimum pause between two sessions. A doorbell press and *Wake up* on the web page ignore it |
| `maxReconnects` | `2` | Reconnect attempts if the live feed drops mid-session |
| `minBatteryPct` | `15` | Below this, only a doorbell press or *Wake up* on the web page wakes the camera |
| `transcode` | `false` | Pass the camera's own H.264 or H.265 through. `true` converts live video to H.264 instead (see below) |
| `triggers` | see below | Bridge events that wake the camera |
| `onvif` | — | Publish the camera as an ONVIF device: `{ "address", "port", "mac" }`, its own IP on the LAN ([onvif.md](onvif.md)) |

Default `triggers`: `motion`, `personDetected`, `vehicleDetected`, `petDetection`,
`strangerDetected`, `doorbellPress`. Which ones a camera sends depends on the model and its
detection settings in the eufy app — a camera set to person-only detection sends `personDetected`
rather than `motion`.

## Ports

| Key | Default | Meaning |
|---|---|---|
| `ports.web` | `8099` | Web page and API, HTTP or HTTPS (also `WEB_PORT`) |
| `ports.rtsp` | `8554` | RTSP output |

## Passing through or converting (`transcode`)

By default a camera's own video is passed through: a few percent CPU while live, and the camera's
original quality. Converting it instead (`"transcode": true`) decodes and re-encodes it as H.264, which
every NVR accepts, but for a 3K H.265 camera that is the most expensive thing the gateway does: up to
two CPU cores on a small NAS.

- **Your NVR must accept the camera's format.** Many eufy cameras send H.265 (e.g. the SoloCam S340);
  not every NVR records H.265 from third-party cameras. If yours shows no picture for a camera, set
  `"transcode": true` for that camera.
- **The first live session after setup is still converted:** it tells the gateway which format the
  camera sends (saved in `/data/switcher/codec-<name>.txt`). From then on the stream, including the
  sleeping picture, uses the camera's format.
- **The stream restarts once (~2 s)** when it first switches to the camera's format, after that
  first session. Otherwise it never drops.
- **`fps` should match the camera's real frame rate** (eufy cameras: 15), because the stream is
  played out at that rate.
- **The resolution is whatever the camera sends.** `width` and `height` should be its native size, or
  the picture size changes between the sleeping picture and live video. A camera that starts a
  session at a lower resolution (the SoloCam S340: 720p for the first ~8 s) sends that too; if your
  NVR doesn't cope with the size change, use `"transcode": true` for that camera.

## Files in `/data`

| Path | What |
|---|---|
| `config.json` | Your configuration (cameras etc.) — the only file you edit |
| `bridge/.eufy-session.json` | eufy login session — delete it to force a fresh login |
| `switcher/last-<name>.jpg` | Last live frame per camera, shown after a restart |
| `switcher/codec-<name>.txt` | The format a camera sends (`h264` / `hevc`), learned in its first live session for passing it through |
| `web/cert.pem`, `web/key.pem` | The self-signed HTTPS certificate, made once when `web.https` is on without own files — delete both to make a new one |
| `go2rtc/go2rtc.yaml`, `switcher/config.json` | Generated at every start from `config.json` — don't edit (they contain the logins) |

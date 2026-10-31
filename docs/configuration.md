# Configuration reference

The gateway reads `config.json` from the data folder (`/data/config.json` in the container) at start.
Change it, then restart the container. A file mounted at `/config/config.json` takes precedence (older
setups); `CONFIG_FILE` overrides the path entirely. A complete example: [`examples/config.full.example.json`](../examples/config.full.example.json).

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
| `bridge.env` | `{}` | Extra environment variables for the bridge (see the [bridge docs](https://github.com/mega-yfue/ha-eufy-sdk-bridge)) |

## Cameras

| Key | Default | Meaning |
|---|---|---|
| `name` | — | Required. Letters, digits, `-`, `_`. RTSP path and display name |
| `serial` | — | Required. Serial number from the web page's device list |
| `width`, `height` | — | Required. The camera's native live resolution |
| `fps` | `15` | Output frame rate |
| `bitrateKbps` | `4400` | Bitrate ceiling for live video (~`6600` for 3K). The sleeping picture uses far less |
| `holdMs` | `30000` | Stay live until this long after the last detection (at least this long after the first live frame). Continuing motion keeps the stream live |
| `ringHoldMs` | `120000` | Same, after a doorbell press |
| `maxLiveMs` | `0` | Optional cap per session, from the first live frame; repeated detections cannot extend past it. `0` = no cap. Set it (e.g. `600000`) if constant motion would drain the battery |
| `firstFrameTimeoutMs` | `60000` | Give up waking the camera if no video arrives by then |
| `restartGapMs` | `15000` | Minimum pause between two sessions. A doorbell press and *Go live* ignore it |
| `maxReconnects` | `2` | Reconnect attempts if the live feed drops mid-session |
| `minBatteryPct` | `15` | Below this, only a doorbell press or *Go live* wakes the camera |
| `triggers` | see below | Bridge events that wake the camera |

Default `triggers`: `motion`, `personDetected`, `vehicleDetected`, `petDetection`,
`strangerDetected`, `doorbellPress`. Which ones a camera sends depends on the model and its
detection settings in the eufy app — a camera set to person-only detection sends `personDetected`
rather than `motion`.

## Ports

| Key | Default | Meaning |
|---|---|---|
| `ports.web` | `8099` | Web page and API (also `WEB_PORT`; the Docker health check uses `WEB_PORT`) |
| `ports.rtsp` | `8554` | RTSP output |

## Files in `/data`

| Path | What |
|---|---|
| `config.json` | Your configuration (cameras etc.) — the only file you edit |
| `bridge/.eufy-session.json` | eufy login session — delete it to force a fresh login |
| `switcher/last-<name>.jpg` | Last live frame per camera, shown after a restart |
| `go2rtc/go2rtc.yaml`, `switcher/config.json` | Generated at every start from `config.json` — don't edit |

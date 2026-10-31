# Eufy NVR Gateway

[![Docker Hub](https://img.shields.io/docker/v/dbanky/eufy-nvr-gateway?sort=semver&label=Docker%20Hub)](https://hub.docker.com/r/dbanky/eufy-nvr-gateway)
[![Image size](https://img.shields.io/docker/image-size/dbanky/eufy-nvr-gateway?sort=semver)](https://hub.docker.com/r/dbanky/eufy-nvr-gateway/tags)
[![Platforms](https://img.shields.io/badge/platforms-amd64%20%7C%20arm64-blue)](https://hub.docker.com/r/dbanky/eufy-nvr-gateway/tags)

**Always-on RTSP streams for battery-powered eufy cameras — without keeping them awake.**

Network video recorders (Synology Surveillance Station, Frigate, Blue Iris, …) hold
a camera's stream open around the clock. A battery-powered eufy camera (SoloCam, battery
doorbells, eufyCam) cannot stream around the clock: it has no RTSP at all, and keeping its live view
open would drain the battery in days.

This gateway sits in between and runs as **one Docker container**:

- Every camera gets an **RTSP stream that never ends**, in the camera's own format (H.264 or H.265) by
  default, or converted to H.264 for NVRs that need it. The NVR always has a picture to show.
- While nothing happens, the stream shows the **last frame, blurred and dimmed, with a moon** and a
  `Sleeping · since 18:33` label — and the camera **sleeps**.
- When the camera detects motion or a person, or the doorbell is pressed, the gateway **wakes the
  camera and switches the stream to live video** — until there has been no motion for 30 seconds —
  then shows the sleeping picture again.

```mermaid
flowchart LR
  cam["eufy battery camera<br>(asleep most of the time)"] -- "P2P, only during events" --> bridge
  cloud["eufy cloud<br>(push events)"] -- "motion · person · ring" --> bridge
  subgraph container ["eufy-nvr-gateway (one container)"]
    bridge["eufy bridge"] -- "events + live video" --> switcher["switcher<br>sleeping picture ⇄ live"]
    switcher -- "one unbroken stream" --> go2rtc
  end
  go2rtc -- "RTSP :8554" --> nvr["NVR / VLC / Home Assistant"]
```

## Features

- **One image, one config file.** The eufy bridge, go2rtc and the switcher run together under a
  small supervisor that restarts anything that crashes.
- **Battery-friendly by design.** A camera only streams during an event; the raw camera stream is
  never reachable from the network, so nothing can keep a camera awake by accident.
- **Full resolution and quality.** By default the camera's own video reaches the NVR unchanged (e.g.
  2880×1616 for a 3K SoloCam). Converted video keeps that size, at SSIM 0.993–0.997 against the
  camera's own stream.
- **Light on CPU.** By default the camera's own video is passed through, at a few percent of a CPU
  core. If your NVR doesn't accept a camera's format (some don't take H.265), set
  `"transcode": true` for it: its video is then converted to H.264, which every NVR accepts.
- **Clear states on the stream.** Sleeping, waking up, low battery, didn't wake up, offline: each
  has its own icon and a short label, readable even in a small NVR tile. Live video stays clean.
- **Almost free while idle.** The sleeping picture is encoded once and replayed: well under 1 % of
  a CPU core and ~0.1–0.6 Mbit/s per camera.
- **ONVIF, for UniFi Protect** and other NVRs that only adopt ONVIF cameras: each camera can be
  published as an ONVIF device with motion events, pointing at the same stream (nothing is encoded
  twice). See [docs/onvif.md](docs/onvif.md).
- **Web page** for the eufy login (2FA code / captcha), live status, stream URLs, each stream's codec
  and whether it is converted, each camera's ONVIF side (address, discovery, whether an NVR is
  connected), manual *Wake up* / *Stop*, and the list of devices on your account (to copy serial
  numbers from). Light and dark theme, an optional login, and a notice when a newer version is out.

## Requirements

- A Docker host on your LAN, 64-bit x86 or ARM (developed on a Synology DS923+ with Container Manager).
  A live camera costs a few percent of a CPU core when passed through (the default); converting a 3K
  H.265 camera to H.264 (`"transcode": true`) needs one to two cores while it is live.
- A **separate eufy account** for the gateway. eufy allows one active session per account; if the
  gateway and your phone app share an account, they keep logging each other out. Create a second
  account and share your cameras with it from the eufy app (with admin rights).
- The cameras must be **armed** in a mode that detects motion/persons — a disarmed camera sends no
  events, so it never goes live.

## Installation

Ready-made images for 64-bit x86 (`amd64`) and ARM (`arm64`) are published for every release:

| Registry | Image |
|---|---|
| [Docker Hub](https://hub.docker.com/r/dbanky/eufy-nvr-gateway) | `dbanky/eufy-nvr-gateway` |
| [GitHub Container Registry](https://github.com/dbanky/eufy-nvr-gateway/pkgs/container/eufy-nvr-gateway) | `ghcr.io/dbanky/eufy-nvr-gateway` |

| Tag | Meaning |
|---|---|
| `latest` | The newest stable release |
| `0.2.1`, … | One exact version — pin it to update only when you choose to |
| `0.3.0-beta.1`, … | Pre-releases for testing; never become `latest` |

The container needs one folder, mounted at `/data`. It holds your `config.json` (the camera list),
the eufy login session and the last frame of every camera, so all of it survives updates.

### Synology (Container Manager)

The image is on Docker Hub, Container Manager's built-in registry — nothing needs to be added.

1. **Download the image**: *Container Manager → Registry*, search for `eufy-nvr-gateway`, select
   `dbanky/eufy-nvr-gateway`, *Download*, tag `latest`.
2. **Create the container**: *Container Manager → Image*, select the image, *Run*:
   - Container name `eufy-nvr-gateway`, tick *Enable auto-restart*.
   - **Volume**: add a folder (e.g. create `docker/eufy-nvr-gateway`) with mount path `/data`.
   - **Network**: `host` (recommended: nothing to map). If you use the default `bridge` network
     instead, map the ports under *Port Settings*, local port = container port: `8099` TCP and
     `8554` TCP — see [Ports](#ports). ONVIF needs `host`.
   - **Environment**: `EUFY_EMAIL`, `EUFY_PASSWORD`, `EUFY_COUNTRY` (the two-letter code of the
     country the account was registered in, e.g. `GB`, `DE`, `US`) and `TZ` (e.g. `Europe/London`).
3. **Log in**: open `http://<nas>:8099`. If eufy asks for a verification code (usually e-mailed) or a
   captcha, enter it there.
4. **Add your cameras**: the page lists every device on the account with its serial number. Write
   your [`config.json`](#configuration), put it into the folder from step 2 (e.g. with File
   Station), then restart the container (*Container → Action → Restart*).
5. **Watch**: `rtsp://<nas>:8554/<camera-name>` in VLC, or add that URL to your NVR.

### Updating

The web page tells you when a newer version is out. On a Synology, download the tag again in
*Registry* (it fetches the newest image), then stop the container and use *Action → Reset* to
recreate it from the new image. Elsewhere: `docker pull dbanky/eufy-nvr-gateway:latest` and recreate
the container (`docker compose up -d`). The folder is kept: config, eufy login and pictures.

### Other Docker hosts

```sh
docker run -d --name eufy-nvr-gateway --restart unless-stopped --network host \
  -e EUFY_EMAIL=you@example.com -e EUFY_PASSWORD='your-eufy-password' \
  -e EUFY_COUNTRY=GB -e TZ=Europe/London \
  -v "$PWD/data:/data" dbanky/eufy-nvr-gateway:latest
```

or with Compose: [`examples/docker-compose.yml`](examples/docker-compose.yml). Then continue with
steps 3–5 above; `config.json` goes into `./data`.

## Configuration

`config.json` in the data folder (`/data/config.json` in the container):

```json
{
  "timezone": "Europe/London",
  "cameras": [
    { "name": "front-door", "serial": "T81XXXXXXXXXXXXX", "width": 2048, "height": 1536 },
    { "name": "garden", "serial": "T81XXXXXXXXXXXXX", "width": 2880, "height": 1616, "bitrateKbps": 6600 }
  ]
}
```

Per camera:

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | Letters, digits, `-`, `_`. Becomes the RTSP path: `rtsp://<host>:8554/<name>` |
| `serial` | yes | The camera's serial number (shown on the web page after login) |
| `width`, `height` | yes | The camera's **native live resolution**. The sleeping picture has this size; passed-through video has the camera's own size, so they must match (converted video is scaled to it). See [known resolutions](#known-live-resolutions) |
| `fps` | | Output frame rate. Default `15` (what eufy cameras send); when passing through it must match the camera |
| `bitrateKbps` | | Upper bitrate limit for what the gateway encodes: the sleeping picture, and live video when converting. Default `4400`; use ~`6600` for 3K |
| `holdMs` | | Stay live until this long after the last detection: continuing motion keeps the stream live. Default `30000` (30 s) |
| `ringHoldMs` | | Same, after a doorbell press. Default `120000` (2 min) |
| `maxLiveMs` | | Optional cap per session, from the first live frame, to save battery when motion never stops (e.g. a busy street). Default `0` (no cap) |
| `restartGapMs` | | Minimum pause between sessions (a doorbell press ignores it). Default `15000` |
| `minBatteryPct` | | Below this battery level, only a doorbell press or a manual *Go live* wakes the camera. Default `15` |
| `transcode` | | `false`: the camera's own H.264 or H.265 is passed through, a few % CPU; your NVR must accept that format. `true`: converted to H.264, which every NVR accepts, up to two cores while live. Default `false` |
| `triggers` | | Events that wake the camera. Default: `motion`, `personDetected`, `vehicleDetected`, `petDetection`, `strangerDetected`, `doorbellPress` |

Top level: `timezone` (for the `since 18:33` label), `defaults` (any per-camera key, applied to all
cameras), `web` (a login for the web page), `onvif` (the login NVRs use for ONVIF), `checkForUpdates`,
`ports`, `bridge`. Everything is described in
[docs/configuration.md](docs/configuration.md), with a complete example in
[`examples/config.full.example.json`](examples/config.full.example.json).

Environment variables: `EUFY_EMAIL`, `EUFY_PASSWORD`, `EUFY_COUNTRY` (required), `TZ`, `WEB_PORT`.

### Known live resolutions

Measured on real devices; other models: start with 1920×1080 and check the web page snapshot.

| Model | Camera | Live stream |
|---|---|---|
| T8170 | SoloCam S340 | 2880×1616, H.265, 15 fps (steps up from 720p during the first ~8 s) |
| T8210 | Video Doorbell (battery, via HomeBase) | 2048×1536, H.264, 15 fps |

## Ports

With host networking (recommended) the gateway listens on the host directly and nothing needs to
be mapped. With a `bridge` network, map these from the host to the same port in the container
(Synology: *Container → Edit → Port Settings*; Docker: `-p 8099:8099 -p 8554:8554`):

| Port | Protocol | What | Map with `bridge` |
|---|---|---|---|
| `8099` | TCP | Web page and API | yes |
| `8554` | TCP | RTSP streams — `rtsp://<host>:8554/<name>` | yes |
| `8000` | TCP | ONVIF, only on the addresses of cameras published as ONVIF devices ([docs/onvif.md](docs/onvif.md)); one port per camera (`onvif.port`) | — ONVIF needs host networking |
| `3702` | UDP | ONVIF discovery, only when cameras are published as ONVIF devices | — ONVIF needs host networking |

ONVIF works only with host networking: each camera's ONVIF device listens on its own LAN address
(`onvif.address`), which a container on a `bridge` network doesn't have, and discovery is multicast,
which a bridge doesn't pass on.

Change the first two under `"ports"` in `config.json` if something else on the host already uses
one (and map the new numbers instead); the ONVIF port is set per camera (`onvif.port`).

## API

| Request | What |
|---|---|
| `GET /api/status` | Login state, the gateway's version and whether a newer one is out, and every camera's state (`IDLE` / `WAKING` / `LIVE`), battery, last seen, its video (codec, converted or passed through) and its ONVIF side |
| `GET /api/health` | `{ "ok": true }`; always open (Docker's health check) |
| `GET /api/devices` | Devices on the eufy account, with serial numbers |
| `GET /api/cameras/<name>/snapshot.jpg` | What the stream shows right now |
| `POST /api/cameras/<name>/live` | Wake the camera and go live (e.g. from a Home Assistant button) |
| `POST /api/cameras/<name>/idle` | End the live session now |
| `POST /api/login` | `{ "code": "123456" }` or `{ "captcha": "AB3D" }` |

With a [`web` login](#security), send it as HTTP Basic, e.g.
`curl -u admin:password http://<host>:8099/api/cameras/garden/live -X POST`.

## How it works

The short version: per camera, one never-ending stream feeds go2rtc. While the camera sleeps it
replays a picture that was encoded once; during an event the camera's own video takes over (or, with
`"transcode": true`, a live encoder), spliced in at a keyframe, so the NVR sees one unbroken stream.
Details, measurements and the problems solved along the way:
[docs/how-it-works.md](docs/how-it-works.md).

## Roadmap

- **ONVIF with a real UniFi Protect console:** tested with the ONVIF client library Protect uses,
  not yet with Protect itself.
- Ideas: show each camera's detected source resolution on the web page; Home Assistant MQTT
  discovery for the *Wake up* buttons.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Web page says `require_2fa` / `require_captcha` | Enter the code or captcha on the page. Avoid repeated wrong attempts — eufy may block the account for a while. |
| Login keeps failing, `Email address or password incorrect` | Check `EUFY_EMAIL`, `EUFY_PASSWORD` and `EUFY_COUNTRY` — the country must be where the account was registered. |
| The gateway gets logged out now and then | Another login on the same account (phone app, Home Assistant, another bridge) took over the session. Use a dedicated account. |
| A camera never goes live on motion | It is disarmed, or detection is off in the eufy app. A disarmed camera sends no events. Test with the *Go live* button. |
| Live video takes 10–60 s to appear | Normal for battery cameras: waking takes 3–12 s, deep sleep longer. The stream shows `Waking up` meanwhile. |
| The first seconds of live video look soft, or the size changes | Some cameras change their resolution during a session (the SoloCam S340: 1080p → 1296p → 3K over ~20 s, and down again at the end). Passed through, the NVR gets those size changes too. VLC resizes its window with them unless you untick *Preferences → Interface → Resize interface to video size*; most NVRs scale to their tile. If yours can't cope, set `"transcode": true` for the camera (fixed size, more CPU). |
| Picture is stretched or letterboxed | `width`/`height` don't match the camera's native resolution. |
| No picture in the NVR from one camera (often after its first live session) | Your NVR probably doesn't accept that camera's format (usually H.265). Set `"transcode": true` for it and restart: its video is then converted to H.264. |
| High CPU on the host | A camera with `"transcode": true` is converted while live, which is expensive for 3K H.265 (one to two cores). Leave `transcode` off if your NVR accepts the camera's format; otherwise lower `width`/`height` to trade detail for CPU. |
| Port already in use | Change it under `"ports"` in `config.json`. |

Logs: `docker logs eufy-nvr-gateway` (every line is prefixed with `[bridge]`, `[go2rtc]` or
`[switcher]`).

## Security

- **Web page login.** Without one, anyone on your LAN can use the web page and API. To require one:

  ```json
  "web": { "username": "admin", "password": "choose-a-password" }
  ```

  Browsers get a sign-in page (the session lasts 30 days, and changing the password signs everyone
  out); scripts send the login as HTTP Basic. The page is served over plain HTTP, so keep port 8099
  on your LAN and never forward it to the internet — a reverse proxy with HTTPS if you need it
  from outside.
- The RTSP streams (port 8554) and ONVIF snapshots have no login, as with most cameras: keep them on
  your LAN.
- ONVIF cameras are protected by the `onvif.username` / `onvif.password` login (if set).
- The update check asks GitHub for the project's releases every 6 hours; nothing about your setup is
  sent. `"checkForUpdates": false` turns it off.
- The eufy password is passed as an environment variable and used only by the bundled bridge to log
  in to eufy. The login session is stored in `data/bridge/`.

## Development

```sh
npm test            # unit tests: Node 22+, no dependencies (node:test)
npm run check       # syntax check of every file
docker build -t eufy-nvr-gateway:dev .
```

The code is split by concern; the tests in `test/` mirror it and read as a description of the
behaviour:

| Folder | What |
|---|---|
| `src/main.mjs`, `src/gateway/` | Container entrypoint: reads `config.json`, writes the configs for the bundled services, runs and restarts them |
| `src/switcher/` | One process for all cameras: when to wake and sleep (`policy.mjs`), what the stream says (`labels.mjs`), wiring (`main.mjs`, `create-camera.mjs`) |
| `src/switcher/camera/` | One camera's states (`camera.mjs`), its live video (`live-feed.mjs`: converting or passing through) and its picture when not live (`sleeping-picture.mjs`) |
| `src/switcher/bridge/` | The eufy bridge: the WebSocket (`socket.mjs`) and what it says (`client.mjs`: login, devices, events) |
| `src/switcher/web/` | The web page (`static/`) and the JSON API |
| `src/video/` | The never-ending stream: the publisher, what it plays next (`feed.mjs`), live encoder, decoder and pass-through, H.264/H.265 helpers |
| `src/overlay/` | The sleeping-state picture: the design in numbers (`design.mjs`), layout, drawing, encoding it into a loop |
| `assets/icons/` | State icons (SVG), rasterised when the image is built |

## Changelog

What changed in each version: [CHANGELOG.md](CHANGELOG.md).

## Credits and licenses

This project is MIT licensed (see [LICENSE](LICENSE)). It builds on, and the Docker image bundles:

- [ha-eufy-sdk-bridge](https://github.com/mega-yfue/ha-eufy-sdk-bridge) and
  [eufy-sdk](https://github.com/mega-yfue/eufy-sdk) by mega-yfue — Apache-2.0
- [go2rtc](https://github.com/AlexxIT/go2rtc) by AlexxIT — MIT
- [FFmpeg](https://ffmpeg.org) with x264 and x265 (Alpine packages) — LGPL/GPL
- [Inter](https://github.com/rsms/inter) typeface by Rasmus Andersson — SIL Open Font License 1.1

See [NOTICE.md](NOTICE.md). Not affiliated with Anker, eufy or any NVR vendor.

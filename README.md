# Eufy NVR Gateway

[![Docker Hub](https://img.shields.io/docker/v/dbanky/eufy-nvr-gateway?sort=semver&label=Docker%20Hub)](https://hub.docker.com/r/dbanky/eufy-nvr-gateway)
[![Image size](https://img.shields.io/docker/image-size/dbanky/eufy-nvr-gateway?sort=semver)](https://hub.docker.com/r/dbanky/eufy-nvr-gateway/tags)
[![Platforms](https://img.shields.io/badge/platforms-amd64%20%7C%20arm64-blue)](https://hub.docker.com/r/dbanky/eufy-nvr-gateway/tags)

**Always-on RTSP/ONVIF streams for battery-powered eufy cameras — without keeping them awake.**

Network video recorders — **UniFi Protect**, Synology Surveillance Station, Frigate, Blue Iris, … —
hold a camera's stream open around the clock. A battery-powered eufy camera (SoloCam, battery
doorbells, eufyCam) can't do that: it has no RTSP or ONVIF at all, and keeping its live view open
would drain the battery in days.

This gateway sits in between and runs as **one Docker container**:

- Every camera gets an **RTSP stream that never ends**, in the camera's own format (H.264 or H.265),
  or converted to H.264 for NVRs that need it. The NVR always has a picture to show.
- Every camera can also be an **ONVIF camera with motion events**, so **UniFi Protect** (which only
  adopts ONVIF cameras) can adopt it and record only while something happens.
- While nothing happens, the stream shows the **last frame, blurred and dimmed, with a moon** and a
  `Sleeping · since 18:33` label — and the camera **sleeps**.
- When the camera detects motion or a person, or the doorbell is pressed, the gateway **wakes the
  camera and switches the stream to live video** — until there has been no motion for 30 seconds —
  then shows the sleeping picture again.

```mermaid
flowchart LR
  cam["eufy battery camera<br>(asleep most of the time)"] -- "P2P video, only during events" --> bridge
  cloud["eufy cloud<br>(push events)"] -- "motion · person · ring" --> bridge
  subgraph container ["eufy-nvr-gateway (one container)"]
    bridge["eufy bridge"] -- "events + live video" --> switcher["switcher<br>sleeping picture ⇄ live"]
    switcher -- "one unbroken stream" --> go2rtc["go2rtc<br>RTSP server"]
    switcher -- "motion on / off" --> onvif["ONVIF device<br>per camera"]
    web["web page + API"]
  end
  go2rtc -- "RTSP :8554" --> nvr["NVR · VLC · Home Assistant"]
  onvif -- "ONVIF :8000<br>discovery · motion events" --> protect["UniFi Protect"]
  protect -- "RTSP :8554" --> go2rtc
  browser["your browser"] -- "HTTP(S) :8099" --> web
```

## Contents

- [Features](#features) · [Requirements](#requirements)
- [Setup in five steps](#setup-in-five-steps) · [Updating](#updating)
- [The eufy account and its two-factor login](#the-eufy-account-and-its-two-factor-login)
- [Configuration](#configuration) · [Security](#security) · [Ports](#ports) · [API](#api)
- [UniFi Protect and ONVIF](docs/onvif.md) · [How it works](docs/how-it-works.md) ·
  [Troubleshooting](#troubleshooting)

## Features

- **One image, one config file.** The eufy bridge, go2rtc and the switcher run together under a
  small supervisor that restarts anything that crashes.
- **Battery-friendly by design.** A camera only streams during an event; the raw camera stream is
  never reachable from the network, so nothing can keep a camera awake by accident.
- **RTSP and ONVIF.** Any NVR reads the RTSP streams; NVRs that only adopt ONVIF cameras (UniFi
  Protect) get one ONVIF device per camera, with WS-Discovery and motion events, pointing at the same
  stream — nothing is encoded twice. See [docs/onvif.md](docs/onvif.md).
- **Full resolution and quality.** By default the camera's own video reaches the NVR unchanged (e.g.
  2880×1616 for a 3K SoloCam). Converted video keeps that size, at SSIM 0.993–0.997 against the
  camera's own stream.
- **Light on CPU.** Passing the camera's video through costs a few percent of a CPU core. If your NVR
  doesn't accept a camera's format (some don't take H.265), set `"transcode": true` for it: its video
  is then converted to H.264, which every NVR accepts.
- **Almost free while idle.** The sleeping picture is encoded once and replayed: well under 1 % of
  a CPU core and ~0.1–0.6 Mbit/s per camera.
- **Clear states on the stream.** Sleeping, waking up, low battery, didn't wake up, offline: each
  has its own icon and a short label, readable even in a small NVR tile. Live video stays clean.
- **Web page** for the eufy login (2FA code / captcha), each camera's state, battery, stream and
  ONVIF details (address, discovery, whether an NVR is connected), *Wake up* / *Stop*, and the
  devices on your account. Light or dark, and it tells you when a newer version is out.
- **Locked down if you want it.** Optional logins for the web page and for the streams (RTSP and
  ONVIF), HTTPS for the web page, and RTSP off the network entirely. At startup the log names
  anything still open to your LAN. See [Security](#security).

## Requirements

- A Docker host on your LAN, 64-bit x86 or ARM (developed on a Synology DS923+ with Container
  Manager). A live camera costs a few percent of a CPU core when passed through (the default);
  converting a 3K H.265 camera to H.264 (`"transcode": true`) needs one to two cores while it is live.
- A **second eufy account** just for the gateway, with your cameras shared to it — see
  [the eufy account](#the-eufy-account-and-its-two-factor-login). Plan five minutes for its first
  login: eufy e-mails a verification code that you enter on the gateway's web page.
- The cameras must be **armed** in a mode that detects motion or persons. A disarmed camera sends no
  events, so it never goes live.
- For ONVIF / UniFi Protect: host networking, and one IP address on your LAN per camera
  ([docs/onvif.md](docs/onvif.md)).

## Setup in five steps

### 1. Prepare a eufy account for the gateway

Create a second eufy account and share your cameras with it — the details, and why it matters, are
in [the eufy account](#the-eufy-account-and-its-two-factor-login). Note its e-mail, password and the
country it was registered in.

### 2. Run the container

Images for 64-bit x86 (`amd64`) and ARM (`arm64`) are published for every release on
[Docker Hub](https://hub.docker.com/r/dbanky/eufy-nvr-gateway) (`dbanky/eufy-nvr-gateway`) and the
[GitHub Container Registry](https://github.com/dbanky/eufy-nvr-gateway/pkgs/container/eufy-nvr-gateway)
(`ghcr.io/dbanky/eufy-nvr-gateway`).

| Tag | Meaning |
|---|---|
| `latest` | The newest stable release |
| `0.4.0`, … | One exact version — pin it to update only when you choose to |
| `0.4.0-beta.1`, … | Pre-releases for testing; never become `latest` |

The container needs **one folder**, mounted at `/data`. It holds your `config.json`, the eufy login
session and the last frame of every camera, so all of it survives updates.

**Synology (Container Manager).** The image is on Docker Hub, Container Manager's built-in registry:

1. *Container Manager → Registry*, search for `eufy-nvr-gateway`, select `dbanky/eufy-nvr-gateway`,
   *Download*, tag `latest`.
2. *Container Manager → Image*, select the image, *Run*:
   - Container name `eufy-nvr-gateway`, tick *Enable auto-restart*.
   - **Volume**: add a folder (e.g. create `docker/eufy-nvr-gateway`) with mount path `/data`.
   - **Network**: `host` (recommended: nothing to map, and ONVIF needs it). With the default `bridge`
     network instead, map `8099` and `8554` TCP under *Port Settings*, same number on both sides —
     see [Ports](#ports).
   - **Environment**: `EUFY_EMAIL`, `EUFY_PASSWORD`, `EUFY_COUNTRY` (the two-letter code of the
     country the account was registered in, e.g. `GB`, `DE`, `US`) and `TZ` (e.g. `Europe/London`).

**Other Docker hosts:**

```sh
docker run -d --name eufy-nvr-gateway --restart unless-stopped --network host \
  -e EUFY_EMAIL=you@example.com -e EUFY_PASSWORD='your-eufy-password' \
  -e EUFY_COUNTRY=GB -e TZ=Europe/London \
  -v "$PWD/data:/data" dbanky/eufy-nvr-gateway:latest
```

or with Compose: [`examples/docker-compose.yml`](examples/docker-compose.yml). `config.json` then
goes into `./data`.

### 3. Log in to eufy on the web page

Open `http://<host>:8099`. The header says *Connecting to eufy…*, then usually *Login needs a code*:
eufy has e-mailed a verification code to the gateway's account. Type it into the card that appears
and press *Submit*. If eufy shows a captcha instead, type the characters from the picture. When the
header says *Connected to eufy*, the login is saved and won't be asked again on restarts or updates.
More in [the eufy account](#the-eufy-account-and-its-two-factor-login).

### 4. Add your cameras

Open *Devices on your eufy account* at the bottom of the page: it lists every device with its serial
number. Create `config.json` in the folder from step 2 (e.g. with File Station on a Synology):

```json
{
  "timezone": "Europe/London",
  "cameras": [
    { "name": "front-door", "serial": "T81XXXXXXXXXXXXX", "width": 2048, "height": 1536 },
    { "name": "garden", "serial": "T81XXXXXXXXXXXXX", "width": 2880, "height": 1616, "bitrateKbps": 6600 }
  ]
}
```

`width` and `height` are the camera's native live resolution (see
[known resolutions](#known-live-resolutions)). Restart the container (Synology: *Container → Action
→ Restart*). Each camera now has a tile on the web page.

### 5. Add the streams to your NVR

- **Any NVR or player:** `rtsp://<host>:8554/<camera-name>`, e.g. `rtsp://192.168.1.10:8554/garden`.
  Each tile's *Stream details* has the address to copy.
- **UniFi Protect:** publish the cameras as ONVIF devices and adopt them — follow
  [docs/onvif.md](docs/onvif.md).

Then, optionally, [lock it down](#security): a login for the page, one for the streams (RTSP and ONVIF), and HTTPS.

## Updating

The web page tells you when a newer version is out. On a Synology, download the tag again in
*Registry* (it fetches the newest image), then stop the container and use *Action → Reset* to
recreate it from the new image. Elsewhere: `docker pull dbanky/eufy-nvr-gateway:latest` and recreate
the container (`docker compose up -d`). The folder is kept: config, eufy login and pictures.

## The eufy account and its two-factor login

eufy is the part of the setup that needs patience. The gateway logs in to eufy like the eufy app
does: with an e-mail, a password, and usually a verification code. A few rules save a lot of
trouble.

**Use a second account, only for the gateway.** eufy allows **one active session per account**.
If the gateway and your phone share an account, each login throws the other out — the gateway loses
its events, your app asks you to log in again, and eufy may start asking for codes every time. The
same goes for Home Assistant, Homebridge or another bridge: each needs an account of its own.

1. Sign up for a new eufy account with a second e-mail address (in the eufy Security app: log out,
   *Sign up*). Remember the **country** you choose: the gateway must use the same one
   (`EUFY_COUNTRY`), or eufy answers as if the password were wrong.
2. Log back in with your main account and **share the cameras** with the new account (the app's
   sharing / family members feature), with **admin rights** where the app offers them — without
   them eufy may refuse live video. Accept the invitation on the new account.
3. Don't use the new account in the app afterwards: that would end the gateway's session.

**The first login (two-factor).** When the gateway logs in from somewhere eufy hasn't seen before,
eufy asks for proof:

- **A verification code**, usually by e-mail to the gateway's account. The web page shows *Login
  needs a code*; type it in and press *Submit*. Codes expire after a few minutes — if yours did, or
  none arrived (check the spam folder), press *Send a new code*.
- **A captcha**, sometimes before the code. The page shows the picture; type its characters.
- Keep the container running until the header says *Connected to eufy*. Restarting in between starts
  over, and eufy sends yet another code.

**After that, it stays logged in.** The session is saved in `/data/bridge/.eufy-session.json`, so
restarts and updates don't ask again. eufy asks for a code again only when the session ends: the
account was used elsewhere, its password changed, the `/data` folder was lost, or eufy simply
decided so (it happens now and then). The page then shows the card again, and the stream labels say
`Offline · eufy login needed`.

**Things that make it worse.** Repeated wrong passwords or codes can get the account locked for a
while — wait before trying again rather than restarting in a loop. A wrong `EUFY_COUNTRY` looks
exactly like a wrong password. To force a completely fresh login, stop the container, delete
`/data/bridge/.eufy-session.json` and start it again.

**What the gateway does with the account.** The bundled
[eufy bridge](https://github.com/mega-yfue/ha-eufy-sdk-bridge) uses it to receive push events
(motion, person, doorbell) and, only during an event, to open the camera's live video over P2P. The
password stays in the container (an environment variable, or `config.json`); nothing else is sent
anywhere.

## Configuration

Everything lives in `config.json` in the data folder (`/data/config.json` in the container).
Change it, then restart the container. The full reference is
[docs/configuration.md](docs/configuration.md); a complete example is
[`examples/config.full.example.json`](examples/config.full.example.json).

Per camera:

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | Letters, digits, `-`, `_`. Becomes the RTSP path: `rtsp://<host>:8554/<name>` |
| `serial` | yes | The camera's serial number (listed on the web page after login) |
| `width`, `height` | yes | The camera's **native live resolution**. The sleeping picture has this size; passed-through video has the camera's own size, so they must match (converted video is scaled to it). See [known resolutions](#known-live-resolutions) |
| `fps` | | Output frame rate. Default `15` (what eufy cameras send); when passing through it must match the camera |
| `bitrateKbps` | | Upper bitrate limit for what the gateway encodes: the sleeping picture, and live video when converting. Default `4400`; use ~`6600` for 3K |
| `holdMs` | | Stay live until this long after the last detection: continuing motion keeps the stream live. Default `30000` (30 s) |
| `ringHoldMs` | | Same, after a doorbell press. Default `120000` (2 min) |
| `maxLiveMs` | | Optional cap per session, from the first live frame, to save battery when motion never stops (e.g. a busy street). Default `0` (no cap) |
| `restartGapMs` | | Minimum pause between sessions (a doorbell press ignores it). Default `15000` |
| `minBatteryPct` | | Below this battery level, only a doorbell press or *Wake up* on the web page wakes the camera. Default `15` |
| `transcode` | | `false`: the camera's own H.264 or H.265 is passed through, a few % CPU; your NVR must accept that format. `true`: converted to H.264, which every NVR accepts, up to two cores while live. Default `false` |
| `triggers` | | Events that wake the camera. Default: `motion`, `personDetected`, `vehicleDetected`, `petDetection`, `strangerDetected`, `doorbellPress` |
| `onvif` | | Publish the camera as an ONVIF device: `{ "address", "port", "mac" }` ([docs/onvif.md](docs/onvif.md)) |

Top level:

| Key | Meaning |
|---|---|
| `timezone` | Time zone for the stream labels (`since 18:33`). Default: `TZ`, else UTC |
| `defaults` | Any per-camera key, applied to every camera unless the camera sets it |
| `eufy` | `{ "email", "password", "country" }` — instead of the environment variables |
| `web` | The web page: `username` / `password` (a login), `theme` (`"auto"`, `"light"`, `"dark"`), `https` (`true`/`false`), `certFile` / `keyFile` (your own certificate) |
| `rtsp` | The streams: `username` / `password` (one login for RTSP and the ONVIF cameras), `enabled` (`false`: not on the network) |
| `checkForUpdates` | `false` stops the gateway asking GitHub for new releases. Default `true` |
| `ports` | `web` (8099), `rtsp` (8554) |
| `bridge.env` | Extra environment variables for the eufy bridge |

Environment variables: `EUFY_EMAIL`, `EUFY_PASSWORD`, `EUFY_COUNTRY`, `TZ`, `WEB_PORT`. They win
over `config.json`.

### Known live resolutions

Measured on real devices; other models: start with 1920×1080 and check the web page snapshot.

| Model | Camera | Live stream |
|---|---|---|
| T8170 | SoloCam S340 | 2880×1616, H.265, 15 fps (steps up from 720p during the first ~8 s) |
| T8210 | Video Doorbell (battery, via HomeBase) | 2048×1536, H.264, 15 fps |

## Security

Out of the box the gateway behaves like a typical camera on a home network: the web page, the RTSP
streams and the ONVIF cameras answer anyone on your LAN. Each of them can ask for a login instead,
and the web page can use HTTPS:

```json
{
  "web":   { "username": "admin",   "password": "choose-a-password", "https": true },
  "rtsp":  { "username": "protect", "password": "choose-another-password" },
  "cameras": [ … ]
}
```

| What | Without a login | With one |
|---|---|---|
| **Web page and API** (8099) | Anyone on the LAN | `web.username` / `web.password`: browsers get a sign-in page and a 30-day session; scripts send HTTP Basic (`curl -u admin:…`). Changing the password signs everybody out |
| **HTTPS** for the web page | Plain HTTP | `"web.https": true`: the gateway makes a self-signed certificate once (in `/data/web/`; browsers warn about it the first time), or uses yours (`web.certFile`, `web.keyFile`). Plain `http://` on the same port redirects to `https://` |
| **RTSP streams** (8554) and **ONVIF cameras** (8000) | Anyone on the LAN can watch and adopt them | `rtsp.username` / `rtsp.password`, one login for both: players and NVRs need `rtsp://user:password@host:8554/<name>`; ONVIF uses WS-UsernameToken, the snapshot HTTP Digest/Basic. Or `"rtsp.enabled": false` keeps the streams inside the container (not possible with ONVIF cameras, which point NVRs at them) |

Notes:

- **One login for the streams**, because UniFi Protect opens the RTSP stream with the ONVIF login.
  The old `onvif.username` / `onvif.password` (0.4.0-beta.1) still work; the log asks you to move them.
- At startup the log either confirms *Every web page, API, stream and ONVIF camera asks for a login*
  or names what is still open, with the setting that closes it.
- Always closed: the eufy bridge listens inside the container only (its raw camera streams would keep
  cameras awake), and go2rtc's web UI, API, WebRTC and RTMP are off. ONVIF discovery (UDP 3702)
  answers with names and addresses only.
- `/api/health` stays open (it says `{ "ok": true }` and nothing else) for Docker's health check.
- Keep the gateway on your LAN; never forward its ports to the internet. To reach it from outside,
  use a VPN.
- The update check asks GitHub for the list of releases every 6 hours; nothing about your setup is
  sent. `"checkForUpdates": false` turns it off.
- The eufy password is used only by the bundled bridge to log in to eufy; the login session is
  stored in `/data/bridge/`.

## Ports

With host networking (recommended) the gateway listens on the host directly and nothing needs to be
mapped. With a `bridge` network, map these from the host to the same port in the container
(Synology: *Container → Edit → Port Settings*; Docker: `-p 8099:8099 -p 8554:8554`):

| Port | Protocol | What | Map with `bridge` |
|---|---|---|---|
| `8099` | TCP | Web page and API (HTTP, or HTTPS with `"web.https": true`) | yes |
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
| `GET /api/status` | The eufy login state, the gateway's version and whether a newer one is out, and every camera's state (`IDLE` / `WAKING` / `LIVE`), battery, last seen, its video (codec, converted or passed through) and its ONVIF side |
| `GET /api/health` | `{ "ok": true }`; always open (Docker's health check) |
| `GET /api/devices` | Devices on the eufy account, with serial numbers |
| `GET /api/cameras/<name>/snapshot.jpg` | What the stream shows right now |
| `POST /api/cameras/<name>/live` | Wake the camera and go live (e.g. from a Home Assistant button) |
| `POST /api/cameras/<name>/idle` | End the live session now |
| `POST /api/login` | `{ "code": "123456" }` or `{ "captcha": "AB3D" }` — the eufy verification |

With a `web` login, send it as HTTP Basic, e.g.
`curl -u admin:password http://<host>:8099/api/cameras/garden/live -X POST` (add `-k` and use
`https://` with a self-signed certificate).

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
| Web page says *Login needs a code* / *captcha* | eufy's two-factor check: enter the code from the e-mail (or the captcha) on the page. See [the eufy account](#the-eufy-account-and-its-two-factor-login). |
| No verification code arrives | Check the spam folder of the gateway's account, then press *Send a new code*. Don't restart the container meanwhile. |
| Login keeps failing, `Email address or password incorrect` | Check `EUFY_EMAIL`, `EUFY_PASSWORD` and `EUFY_COUNTRY` — the country must be the one the account was registered in. |
| The gateway gets logged out now and then | Another login on the same account (phone app, Home Assistant, Homebridge, another bridge) took over the session. Use an account only for the gateway. |
| A camera never goes live on motion | It is disarmed, or detection is off in the eufy app. A disarmed camera sends no events. Test with *Wake up* on the web page. |
| Live video takes 10–60 s to appear | Normal for battery cameras: waking takes 3–12 s, deep sleep longer. The stream shows `Waking up` meanwhile. |
| The first seconds of live video look soft, or the size changes | Some cameras change their resolution during a session (the SoloCam S340: 1080p → 1296p → 3K over ~20 s, and down again at the end). Passed through, the NVR gets those size changes too. VLC resizes its window with them unless you untick *Preferences → Interface → Resize interface to video size*; most NVRs scale to their tile. If yours can't cope, set `"transcode": true` for the camera (fixed size, more CPU). |
| Picture is stretched or letterboxed | `width`/`height` don't match the camera's native resolution. |
| No picture in the NVR from one camera (often after its first live session) | Your NVR probably doesn't accept that camera's format (usually H.265). Set `"transcode": true` for it and restart: its video is then converted to H.264. |
| The NVR or VLC says *401 Unauthorized* | The RTSP streams have a login (`rtsp.username`): use `rtsp://user:password@host:8554/<name>`. In UniFi Protect, enter the same login when adopting. |
| A camera's ONVIF details say *Not on the network yet: … is not an address of this machine* | The machine doesn't have that camera's `onvif.address` (yet). If the address comes up later (a second network port, a macvlan boot script), the gateway finds it within 30 s by itself; otherwise see [ONVIF troubleshooting](docs/onvif.md#troubleshooting). |
| The browser warns about the certificate | Expected with `"web.https": true` and the generated self-signed certificate: accept it once, or set your own (`web.certFile`, `web.keyFile`). |
| High CPU on the host | A camera with `"transcode": true` is converted while live, which is expensive for 3K H.265 (one to two cores). Leave `transcode` off if your NVR accepts the camera's format; otherwise lower `width`/`height` to trade detail for CPU. |
| Port already in use | Change it under `"ports"` in `config.json`. |
| ONVIF cameras aren't found by the NVR | See [docs/onvif.md](docs/onvif.md#things-to-know): host networking, one address per camera, and the host can't reach its own macvlan addresses. |

Logs: `docker logs eufy-nvr-gateway` (every line is prefixed with `[start]`, `[bridge]`, `[go2rtc]`
or `[switcher]`).

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
| `src/main.mjs`, `src/gateway/` | Container entrypoint: reads `config.json` (`config.mjs`, logins and HTTPS in `access.mjs`), writes the configs for the bundled services, makes the HTTPS certificate, runs and restarts everything |
| `src/switcher/` | One process for all cameras: when to wake and sleep (`policy.mjs`), what the stream says (`labels.mjs`), the update check (`updates.mjs`), wiring (`main.mjs`, `create-camera.mjs`) |
| `src/switcher/camera/` | One camera's states (`camera.mjs`), its live video (`live-feed.mjs`: converting or passing through) and its picture when not live (`sleeping-picture.mjs`) |
| `src/switcher/bridge/` | The eufy bridge: the WebSocket (`socket.mjs`) and what it says (`client.mjs`: login, devices, events) |
| `src/switcher/web/` | The JSON API (`server.mjs`), sign-in (`auth.mjs`, `signin-routes.mjs`), HTTP/HTTPS (`listen.mjs`) and the page (`static/`: pure views with node tests, plus the browser glue) |
| `src/onvif/` | ONVIF devices: device and media services, motion events (PullPoint), WS-Discovery, logins |
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

See [NOTICE.md](NOTICE.md). Not affiliated with Anker, eufy, Ubiquiti or any NVR vendor.

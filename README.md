# <img src="https://raw.githubusercontent.com/dbanky/eufy-nvr-gateway/main/docs/logo.png" alt="" width="48" height="48" align="absmiddle"> Eufy NVR Gateway

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
    switcher -- "one unbroken stream" --> rtsp["RTSP server"]
    switcher -- "motion on / off" --> onvif["ONVIF device<br>per camera"]
    web["web page + API"]
  end
  rtsp -- "RTSP :8554" --> nvr["NVR · VLC · Home Assistant"]
  onvif -- "ONVIF :8000<br>motion events" --> protect["UniFi Protect"]
  protect -- "RTSP :8554" --> rtsp
  browser["your browser"] -- "HTTP(S) :8099" --> web
```

## Contents

- [Features](#features) · [Requirements](#requirements)
- [Setup in five steps](#setup-in-five-steps) · [Updating](#updating)
- [The eufy account and its two-factor login](#the-eufy-account-and-its-two-factor-login)
- [Configuration](#configuration) · [Security](#security) · [Ports](#ports) · [API](#api)
- [UniFi Protect](docs/unifi-protect.md) · [ONVIF](docs/onvif.md) · [How it works](docs/how-it-works.md) ·
  [Troubleshooting](#troubleshooting)

## Features

- **One image, one config file.** The eufy bridge and the switcher (with its own RTSP, ONVIF and web
  servers) run together under a small supervisor that restarts anything that crashes.
- **Battery-friendly by design.** A camera only streams during an event; the raw camera stream is
  never reachable from the network, so nothing can keep a camera awake by accident.
- **RTSP and ONVIF.** Any NVR reads the RTSP streams; NVRs that only adopt ONVIF cameras (UniFi
  Protect) get one ONVIF device per camera, built to ONVIF Profile S, with motion events, pointing
  at the same stream — nothing is encoded twice. See [the UniFi Protect guide](docs/unifi-protect.md) and
  [docs/onvif.md](docs/onvif.md).
- **Full resolution and quality.** By default the camera's own video reaches the NVR unchanged (e.g.
  2880×1616 for a 3K SoloCam). Converted video keeps that size, at SSIM 0.993–0.997 against the
  camera's own stream.
- **Light on CPU.** Passing the camera's video through costs a few percent of a CPU core. If your NVR
  doesn't accept a camera's format (some don't take H.265), set `"transcode": true` for it: its video
  is then converted to H.264, which every NVR accepts.
- **Sound, if you want it.** `"audio": true` adds an AAC track (16 kHz mono, what eufy cameras
  send): the camera's sound while it is live, silence while it sleeps, so the track never stops.
- **Almost free while idle.** The sleeping picture is encoded once and replayed: well under 1 % of
  a CPU core and ~0.1–0.6 Mbit/s per camera.
- **Clear states on the stream.** Sleeping, waking up, low battery, didn't wake up, offline: each
  has its own icon and a short label, readable even in a small NVR tile. Live video stays clean.
- **Web page** for the eufy login (2FA code / captcha), each camera's state, battery, stream and
  ONVIF details (address, login, whether an NVR is connected), *Wake up* / *Stop*, and the
  devices on your account. Light or dark, and it tells you when a newer version is out.
- **Locked down if you want it.** Optional logins for the web page and for the streams (RTSP and
  ONVIF), and HTTPS for the web page. At startup the log names
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

**Running a pre-release?** Then update by its exact tag (e.g. `0.4.1-beta.9`), never `latest`:
`latest` is the newest *stable* release, which can be older than the beta you run and lacks its
features (e.g. `"audio"`). The web page's footer shows the version that is running.

The container needs **one folder**, mounted at `/data`. It holds your `config.json`, the eufy login
session and the last frame of every camera, so all of it survives updates.

**Synology (Container Manager).** The image is on Docker Hub, Container Manager's built-in registry.
In the *Run* wizard there are only three things to get right, and then everything works:

> 1. **Ports**: accept the ports the wizard lists (the image declares them); there is nothing to
>    change or map.
> 2. **Volume**: mount one folder at `/data`, for your `config.json`.
> 3. **Network**: switch to `host`.
>
> Plus your eufy login in *Environment*. The steps in detail:

1. *Container Manager → Registry*, search for `eufy-nvr-gateway`, select `dbanky/eufy-nvr-gateway`,
   *Download*, tag `latest`.
2. *Container Manager → Image*, select the image, *Run*:
   - Container name `eufy-nvr-gateway`, tick *Enable auto-restart*.
   - **Volume**: add a folder (e.g. create `docker/eufy-nvr-gateway`) with mount path `/data`.
   - **Network**: `host` (recommended: nothing to map, and ONVIF needs it). With the default `bridge`
     network instead, map `8099` and `8554` TCP under *Port Settings*, same number on both sides —
     see [Ports](#ports).
   - **Firewall**: with host networking nothing is mapped, but if DSM's firewall is on, allow the
     gateway's ports: TCP `8099` (web page) and `8554` (streams), UDP `40000`–`40003` per camera
     (`40000`–`40007` for two), and each camera's ONVIF port if you use Protect. Which and why:
     [The Synology firewall](#the-synology-firewall).
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

Each camera also gets four fixed UDP ports for viewers that use RTP over UDP: `40000`–`40003` for
the first camera in the list, `40004`–`40007` for the second. To choose them yourself, add
`"udpPort": 40000` (the first of the four) to a camera. If the NAS's firewall is on, these are the
UDP ports to allow ([why four](#why-four-udp-ports-per-camera)).

### 5. Add the streams to your NVR

- **Any NVR or player:** `rtsp://<host>:8554/<camera-name>`, e.g. `rtsp://192.168.1.10:8554/garden`.
  Each tile's *Stream details* has the address to copy.
- **UniFi Protect:** publish the cameras as ONVIF devices and add them with *Advanced Adoption*
  (Protect doesn't discover them by itself). Set `"transcode": true` for every camera Protect
  records, or its recordings come out broken. With playback issues (especially in a web browser),
  also set the camera's *Stream Compatibility Mode* to *Improved*. Step by step: [docs/unifi-protect.md](docs/unifi-protect.md).

Then, optionally, [lock it down](#security): a login for the page, one for the streams (RTSP and ONVIF), and HTTPS.

## Updating

The web page tells you when a newer version is out. On a Synology, download the tag again in
*Registry* (it fetches the newest image), then stop the container and use *Action → Reset* to
recreate it from the new image. On a pre-release, download its exact tag instead of `latest`
(see [tags](#2-run-the-container)); afterwards, check the version in the web page's footer. Elsewhere: `docker pull dbanky/eufy-nvr-gateway:latest` and recreate
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
| `holdMs` | | Stay live until this long after the last detection or the last movement in the picture. Default `30000` (30 s) |
| `ringHoldMs` | | Same, after a doorbell press. Default `120000` (2 min) |
| `motionInPicture` | | Stay live while the live picture keeps moving, also when the camera sends no new detection (eufy cameras don't during continuing motion). Default `true` |
| `motionInPictureMaxMs` | | Movement in the picture alone keeps a session live at most this long after the camera's last detection. Default `300000` (5 min) |
| `maxLiveMs` | | Optional cap per session, from the first live frame, to save battery when motion never stops (e.g. a busy street). Default `0` (no cap) |
| `restartGapMs` | | Minimum pause between sessions (a doorbell press ignores it). Default `15000` |
| `minBatteryPct` | | Below this battery level, only a doorbell press or *Wake up* on the web page wakes the camera. Default `15` |
| `transcode` | | `false`: the camera's own H.264 or H.265 is passed through, a few % CPU; your NVR must accept that format and the video settings changing between the sleeping picture and live video. `true`: converted to H.264 with one set of settings, which every NVR accepts, up to two cores while live. **Use `true` for UniFi Protect** ([why](docs/unifi-protect.md#1-publish-the-cameras-as-onvif-devices)). Default `false` |
| `audio` | | `true`: the stream carries an AAC track (AAC-LC, 16 kHz, mono): the camera's sound while it is live, silence while it sleeps. Costs next to nothing. Default `false` (video only) |
| `triggers` | | Events that wake the camera. Default: `motion`, `personDetected`, `vehicleDetected`, `petDetection`, `strangerDetected`, `doorbellPress` |
| `onvif` | | Publish the camera as an ONVIF device: `{ "address", "port", "mac" }` ([docs/onvif.md](docs/onvif.md)) |

Top level:

| Key | Meaning |
|---|---|
| `timezone` | Time zone for the stream labels (`since 18:33`). Default: `TZ`, else UTC |
| `defaults` | Any per-camera key, applied to every camera unless the camera sets it |
| `eufy` | `{ "email", "password", "country" }` — instead of the environment variables |
| `web` | The web page: `username` / `password` (a login), `theme` (`"auto"`, `"light"`, `"dark"`), `https` (`true`/`false`), `certFile` / `keyFile` (your own certificate) |
| `rtsp` | The streams: `username` / `password` (one login for RTSP and the ONVIF cameras) |
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
| **RTSP streams** (8554) and **ONVIF cameras** (8000) | Anyone on the LAN can watch and adopt them | `rtsp.username` / `rtsp.password`, one login for both: players and NVRs need `rtsp://user:password@host:8554/<name>`; ONVIF uses WS-UsernameToken, the snapshot HTTP Digest/Basic. |

Notes:

- **One login for the streams**, because UniFi Protect opens the RTSP stream with the ONVIF login.
- At startup the log either confirms *Every web page, API, stream and ONVIF camera asks for a login*
  or names what is still open, with the setting that closes it.
- Always closed: the eufy bridge listens inside the container only (its raw camera streams would keep
  cameras awake).
- `/api/health` stays open (it says `{ "ok": true }` and nothing else) for Docker's health check.
- Keep the gateway on your LAN; never forward its ports to the internet. To reach it from outside,
  use a VPN.
- The update check asks GitHub for the list of releases every 6 hours; nothing about your setup is
  sent. `"checkForUpdates": false` turns it off.
- The eufy password is used only by the bundled bridge to log in to eufy; the login session is
  stored in `/data/bridge/`.

## Ports

With host networking (recommended, and needed for ONVIF) the gateway listens on the host directly:
**nothing is mapped** in Container Manager. What matters then is the **firewall**: if the NAS's
firewall is on, allow the ports below (Synology: [step by step](#the-synology-firewall)).

| Port | Protocol | What | Needed for |
|---|---|---|---|
| `8099` | TCP | Web page and API (HTTP, or HTTPS with `"web.https": true`) | you, in a browser |
| `8554` | TCP | RTSP streams — `rtsp://<host>:8554/<name>`, also RTSP over HTTP | every NVR and player |
| `udpPort` to `udpPort` + 3 (`40000`–`40003` for the first camera, `40004`–`40007` for the second, …) | UDP | RTP over UDP: picture and sound for viewers that ask for UDP ([why four](#why-four-udp-ports-per-camera)) | viewers that use UDP |
| `onvif.port` (e.g. `8000`, `8001`) | TCP | ONVIF, on each camera's own address ([docs/onvif.md](docs/onvif.md)) | UniFi Protect and other ONVIF NVRs |

### Why four UDP ports per camera

An RTSP viewer chooses how the picture and sound reach it:

- **Over TCP** (many NVRs): everything travels inside the one RTSP connection on port `8554`. No
  other port is used.
- **Over UDP** (VLC by default, unless *Use RTP over RTSP (TCP)* is ticked in its preferences; it
  falls back to TCP when no UDP arrives): picture and sound come as separate streams of UDP packets, and each needs **two**
  ports: one for the media itself (RTP) and one for its timing and keep-alive reports (RTCP, which
  players use to keep picture and sound in sync and to tell the gateway they are still watching).
  Picture and sound are two tracks, so that's **2 × 2 = 4 ports per camera**:

  | Port | Carries |
  |---|---|
  | `udpPort` (e.g. `40000`) | video (RTP) |
  | `udpPort` + 1 (`40001`) | video timing reports (RTCP) |
  | `udpPort` + 2 (`40002`) | sound (RTP), with `"audio": true` |
  | `udpPort` + 3 (`40003`) | sound timing reports (RTCP) |

The four ports are fixed per camera, set in advance and **shared by every viewer** of that camera:
an NVR, a phone and VLC watching the same camera all get their packets from the same four ports.
So the list never grows. Each camera's ports are its `udpPort` setting
([configuration](docs/configuration.md#cameras)); without it, the first camera in `config.json`
gets `40000`–`40003`, the second `40004`–`40007`, and so on. The log lists them at startup
(`garden RTP over UDP from UDP ports 40004–40007`).

Do you need them? Only for viewers that use UDP. A viewer that asks for UDP and gets nothing
usually falls back to TCP after a few seconds, which delays the picture. Opening them avoids that.

### The Synology firewall

Only if the firewall is on (*Control Panel → Security → Firewall*, *Enable firewall* ticked).
Example for two cameras published to UniFi Protect, with the defaults:

| Ports | Protocol | Why |
|---|---|---|
| `8099` | TCP | the web page |
| `8554` | TCP | the RTSP streams |
| `40000`–`40007` | UDP | RTP over UDP for the two cameras: 4 per camera, see above |
| `8000`, `8001` | TCP | the two cameras' ONVIF ports (`onvif.port`) |

In DSM: *Control Panel → Security → Firewall → Edit Rules → Create*, *Ports*: *Custom*, *Type*:
*Destination port*, then the protocol and the ports. One rule per protocol is enough (TCP `8099`,
`8554`, `8000`, `8001`; UDP `40000-40007`). Under *Source IP* you can limit them to your LAN or to
the NVR's address. Keep the rule above any *Deny all* rule.

No WS-Discovery port (UDP `3702`) is needed: cameras are added by address
([UniFi Protect guide](docs/unifi-protect.md)).

### With a `bridge` network instead

Map `8099` and `8554` TCP from the host to the same port in the container (Synology: *Container →
Edit → Port Settings*; Docker: `-p 8099:8099 -p 8554:8554`). RTP over UDP and ONVIF need host
networking: each camera's ONVIF device listens on its own LAN address (`onvif.address`), which a
container on a `bridge` network doesn't have, so mapping `8000` doesn't help. If ONVIF cameras are
configured on a bridge network, the log says so in a `WARNING` framed with `!!!`, and the web page
shows a red banner until the container is switched to host networking.

Change `8099` or `8554` under `"ports"` in `config.json` if something else on the host already uses
one; the ONVIF and UDP ports are set per camera (`onvif.port`, `udpPort`).

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

The short version: per camera, one never-ending stream, served by the gateway's own RTSP server. While the camera sleeps it
replays a picture that was encoded once; during an event the camera's own video takes over (or, with
`"transcode": true`, a live encoder), spliced in at a keyframe, so the NVR sees one unbroken stream.
Details, measurements and the problems solved along the way:
[docs/how-it-works.md](docs/how-it-works.md).

## Roadmap

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
| Red banner *ONVIF can't work: switch the container to host networking* | The container is on a bridge network. Synology Container Manager: stop the container → *Edit* → *Network*: `host`; Compose: `network_mode: host`. Port mappings aren't needed then. |
| UniFi Protect doesn't find the cameras | Expected: add each with *Advanced Adoption* (IP address and the `rtsp` login). See [docs/unifi-protect.md](docs/unifi-protect.md). |
| Protect's recordings are broken (smeared or frozen blocks, wrong size), or its live view stalls during events | Set `"transcode": true` for the camera. Protect keeps only the first video settings of a stream, and a passed-through stream changes them during every event ([details](docs/unifi-protect.md#1-publish-the-cameras-as-onvif-devices)). |
| Live view or playback flickers, is black or stutters in Protect (especially in a browser) | `"transcode": true` for the camera, and its *Stream Compatibility Mode* set to *Improved* in Protect. |

Logs: `docker logs eufy-nvr-gateway` (every line is prefixed with `[start]`, `[bridge]` or
`[switcher]`).

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
| `src/switcher/` | One process for all cameras: when to wake and sleep (`policy.mjs`), movement in the live picture (`picture-motion.mjs`), what the stream says (`labels.mjs`), the update check (`updates.mjs`), wiring (`main.mjs`, `create-camera.mjs`) |
| `src/switcher/camera/` | One camera's states (`camera.mjs`), its live video (`live-feed.mjs`: converting or passing through) and its picture when not live (`sleeping-picture.mjs`) |
| `src/switcher/bridge/` | The eufy bridge: the WebSocket (`socket.mjs`) and what it says (`client.mjs`: login, devices, events) |
| `src/switcher/web/` | The JSON API (`server.mjs`), sign-in (`auth.mjs`, `signin-routes.mjs`), HTTP/HTTPS (`listen.mjs`) and the page (`static/`: pure views with node tests, plus the browser glue) |
| `src/onvif/` | ONVIF devices: device and media services, motion events (PullPoint), logins |
| `src/video/` | The never-ending stream: the publisher (`publisher.mjs`, `rtp.mjs`), what it plays next (`feed.mjs`), live encoder, decoder and pass-through, H.264/H.265 helpers |
| `src/audio/` | The camera's sound: AAC frames (`adts.mjs`), the live sound from the bridge (`live-audio.mjs`), silence while asleep |
| `src/rtsp/` | The RTSP server viewers connect to: the streams in memory (`stream-hub.mjs`), the JPEG and G.711 versions (`transcoder.mjs`), login (`client-connection.mjs`), one session (`session.mjs`) and its tracks over TCP or UDP (`track-binding.mjs`), fixed UDP ports, sender reports, RTSP over HTTP |
| `src/overlay/` | The sleeping-state picture: the design in numbers (`design.mjs`), layout, drawing, encoding it into a loop |
| `assets/icons/` | State icons (SVG), rasterised when the image is built |

## Changelog

What changed in each version: [CHANGELOG.md](CHANGELOG.md).

## Credits and licenses

This project is MIT licensed (see [LICENSE](LICENSE)). It builds on, and the Docker image bundles:

- [ha-eufy-sdk-bridge](https://github.com/mega-yfue/ha-eufy-sdk-bridge) and
  [eufy-sdk](https://github.com/mega-yfue/eufy-sdk) by mega-yfue — Apache-2.0. The image installs
  eufy-sdk 0.5.0 over the bridge's own 0.4.0 and adds one route to the bridge, for live audio
  ([patches/bridge-live-audio.patch](patches/bridge-live-audio.patch))
- [FFmpeg](https://ffmpeg.org) with x264 and x265 (Alpine packages) — LGPL/GPL
- [Inter](https://github.com/rsms/inter) typeface by Rasmus Andersson — SIL Open Font License 1.1

See [NOTICE.md](NOTICE.md). Not affiliated with Anker, eufy, Ubiquiti or any NVR vendor.

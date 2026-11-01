# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Images: `dbanky/eufy-nvr-gateway:<version>` on Docker Hub
and `ghcr.io/dbanky/eufy-nvr-gateway:<version>`.

## [Unreleased]

### Changed

- **A sleeping camera's picture opens faster**: the sleeping picture now has a keyframe every
  second instead of every 4 s, so a viewer (UniFi Protect's live view, VLC, an NVR) that opens a
  sleeping camera sees it within a second. Still pictures make small keyframes, so the stream
  grows only slightly; the gateway still encodes the picture just once. The camera's own live
  video is unchanged: passed through as the camera sends it, never re-encoded.

## [0.4.1-beta.7] - 2026-11-01

### Fixed

- **UniFi Protect's live view stalled for H.264 cameras** (seen with the video doorbell, after
  ~20 s, without sound): the gateway's own H.264 (the sleeping picture, and live video with
  `transcode: true`) cut every picture into one slice per CPU thread (x264 `tune=zerolatency`).
  Protect's live player took each slice for a frame, never closed its fragments and dropped the
  sound. Every picture is now one slice. H.265 cameras were not affected.

## [0.4.1-beta.6] - 2026-11-01

### Fixed

- **H.264 cameras in UniFi Protect's live view** (since 0.4.1-beta.4): the stream's description
  lacked H.264's `profile-level-id`, which ffmpeg used to add and which browsers set up their
  decoder from. It is back, taken from the camera's own parameters. H.265 cameras were not affected.

## [0.4.1-beta.5] - 2026-11-01

### Changed

- **Fixed UDP ports per camera, set in advance:** RTP over UDP goes out from four ports per camera
  (`udpPort` to `udpPort` + 3: video and sound, each media plus its timing reports), shared by every
  viewer. Default: `40000`–`40003` for the first camera, `40004`–`40007` for the second, and so on;
  set `"udpPort"` per camera to choose. Before, every viewer got a random pair from
  `40000`–`49998`. If a camera's ports are taken by another program, a viewer asking for UDP is told
  to use TCP (it no longer fails). The README and the UniFi Protect guide explain which ports to
  allow in the NAS's firewall, and why.

## [0.4.1-beta.4] - 2026-11-01

### Changed

- **Picture and sound go out the moment they arrive, and nothing is cut.** The gateway now publishes
  each camera's stream into go2rtc itself, instead of through an ffmpeg:
  - Every live frame and every sound frame is sent as soon as it arrives, stamped with its arrival
    time on one clock for both. Picture and sound never wait for each other.
  - Nothing is held back or dropped: live video is no longer re-paced to 15 fps, and bursts are no
    longer trimmed. Sound has no quarter-second buffer anymore, and is no longer trimmed either.
  - The sound starts as soon as the camera sends it, while it is still waking up and before the
    first picture, and lasts as long as the camera's live video is on the stream (it used to start
    with the first picture and stop at the end of the hold time).
  - Sound that arrives in a burst after a network hiccup fills the pause it belongs to, so it no
    longer drifts behind the picture.
  - The camera's AAC goes through untouched (it used to be re-encoded), and there is one ffmpeg
    fewer per camera.
  - If the connection to go2rtc drops, it is reopened at once and everything since the last
    keyframe is sent again.
  - RTCP sender reports for the gateway's own streams are now exact.

### Fixed

- **Streams with sound stopped for good after a live session** (`"audio": true`): NVRs then got
  *404* / go2rtc logged `streams: unknown error` every few seconds, and only a container restart
  helped. ffmpeg stopped reading the picture while it waited for sound, and the gateway sent sound
  only as the picture went out, so both waited for each other. The new publisher has no such link.

## [0.4.1-beta.3] - 2026-11-01

### Fixed

- **VLC kept asking for the RTSP password.** VLC reads the Digest login request with a fixed
  pattern (realm, then nonce) and couldn't read ours, which had other fields in between. The order
  is now the one VLC expects; other players and NVRs are unaffected.

## [0.4.1-beta.2] - 2026-11-01

### Fixed

- **No picture and no live video when Home Assistant runs on the same machine** (host networking):
  0.4.1-beta.1 put the internal go2rtc on `127.0.0.1:18554`, the port Home Assistant's own go2rtc
  uses. Our go2rtc couldn't start its RTSP server, the streams went to Home Assistant's go2rtc,
  which refused them, and every RTSP request got *404 Not Found*. The internal port is now `28554`,
  and if an internal port (go2rtc or the eufy bridge) is already taken, the gateway uses the next
  free one and says so in the log.

## [0.4.1-beta.1] - 2026-11-01

### Added

- **Sound** (optional, per camera): `"audio": true` adds an AAC track to the stream (AAC-LC, 16 kHz,
  mono, the format eufy cameras send). The camera's sound while it is live, silence while it sleeps,
  so the track never stops; it shares the picture's timeline. The ONVIF device reports the audio
  track, and the tile details show it. The bundled eufy bridge gets one added route for live audio
  (`patches/bridge-live-audio.patch`), on the same camera session as the video.
- **ONVIF Profile S** for the ONVIF devices ([what is covered](docs/onvif.md#onvif-profile-s)):
  - Device service: everything Profile S requires — network settings (host name, DNS, NTP, default
    gateway; the address and ports stay in `config.json`), date and time, scopes, users (the one
    login), reboot and factory default, `GetWsdlUrl`, capabilities per category.
  - Media service: create and delete profiles, add and remove configurations, change encoders,
    video source, audio and metadata configurations with their options. A profile can switch to
    MJPEG (640 pixels wide) and, with sound, to G711; those streams run an ffmpeg only while watched.
  - Events: pushed notifications (WS-BaseNotification `Subscribe` / `Notify`) besides PullPoint,
    and topic and message content filters for both.
  - Errors as ONVIF fault codes (`ter:InvalidArgVal/ter:NoProfile` …), HTTP Digest or Basic as a
    login on ONVIF requests too.
- **Media2** for cameras that pass their H.265 through, which describes H.265 properly (Media ver10
  can't). H.264 cameras don't list it, so NVRs keep using Media ver10 for them.
- **RTSP over UDP and over HTTP**, and RTCP sender reports (audio/video sync), on the same RTSP port:
  the gateway's own RTSP front now sits in front of go2rtc and checks the login.

### Changed

- go2rtc listens on `127.0.0.1:18554` only (`ports.go2rtc`); NVRs connect to the RTSP front on
  `ports.rtsp` (8554) as before. RTP over UDP is sent from ports 40000–49998 (host networking).
- The ONVIF scopes no longer claim Profile T, and claim Profile S (`Profile/Streaming`) only for
  cameras that stream H.264.
- Docs: *Stream Compatibility Mode: Improved* in UniFi Protect is now described as the general fix
  for playback issues with any camera (especially in web browsers), not only for H.265 cameras.

## [0.4.0] - 2026-10-31

The first stable release since 0.2.1. It brings everything from the 0.3.0 and 0.4.0 pre-releases
below: ONVIF for UniFi Protect, H.265 pass-through, a redesigned web page with a light and dark
theme, optional logins and HTTPS for everything on the network, and a step-by-step
[UniFi Protect guide](docs/unifi-protect.md).

### Added

- **[UniFi Protect guide](docs/unifi-protect.md)**, from a real Protect setup: one IP per camera,
  adding each camera with *Advanced Adoption*, and *Stream Compatibility Mode: Improved* for H.265
  cameras that flicker or turn black in Protect's live view.

### Changed

- The README shows the logo next to the title (`docs/logo.png`, rendered from the web page's
  `logo.svg`, so Docker Hub shows it too).

### Removed

- **`"rtsp": { "enabled": false }`.** The RTSP streams are what NVRs record, so they are always on;
  `rtsp.username` / `rtsp.password` keep others from watching. A config that still turns them off
  is refused at startup, with this in the message (`"enabled": true` is ignored).
- **ONVIF WS-Discovery (UDP 3702).** UniFi Protect didn't find the cameras with it in practice;
  cameras are added by IP (*Advanced Adoption*). Port 3702 is no longer used, and the camera details
  show how the camera appears in NVRs (*Shows as*) instead of a discovery state.

### Fixed

- **No broken image while a tile's first picture is being made**: the tile shows a placeholder in
  the stream's style (a spinner in the round chip, *Getting the picture*). Pictures are downloaded in
  the background and swapped in only once complete, so a slow or failed refresh keeps the last one.

## [0.4.0-beta.4] - 2026-10-31

Pre-release for testing: a loud warning when ONVIF can't work because the container isn't on host
networking.

### Added

- **A loud warning when ONVIF can't work because of the network**: ONVIF cameras are configured, but
  the container is on a Docker bridge network instead of host networking. The log shows a `WARNING`
  framed with `!!!`, and the web page a red banner with how to switch (Synology Container Manager,
  Docker Compose). A camera's own message also names the bridge network.

## [0.4.0-beta.3] - 2026-10-31

Pre-release for testing: a logo, equal tile heights when details open, and ONVIF cameras whose
address comes up late (with plain-word network errors).

### Changed

- **A logo**: a camera asleep (its lens is the stream's moon) with its stream still on (the live dot),
  in the page header and as the browser tab's icon. It replaces the plain moon, which looked like a
  second theme switch.

### Fixed

- Opening a tile's *Stream details* no longer stretches the other tiles in its row.
- **ONVIF cameras whose address comes up late** (a second network port, a macvlan address made
  after the container started) are no longer lost until a restart: the device and discovery try
  again every 30 s and come on by themselves.
- **ONVIF network errors in plain words**: `addMembership ENODEV` / `EADDRNOTAVAIL` now read
  *192.168.1.51 is not an address of this machine (it has …)*, with what to do; a taken port names
  the port. The web page shows it per camera (*Not on the network yet*), and discovery is reported
  per camera instead of one combined *Partly on* line. docs/onvif.md has a troubleshooting section.

## [0.4.0-beta.2] - 2026-10-31

Pre-release for testing: logins and HTTPS for everything on the network, one login for RTSP and
ONVIF, a light theme, and a version and update check on the web page.

### Added

- **Login for the web page** (optional): `"web": { "username", "password" }` in `config.json`.
  Browsers get a sign-in page and a 30-day session; scripts send HTTP Basic. `/api/health` stays
  open for Docker's health check.
- **HTTPS for the web page** (optional): `"web": { "https": true }`. Uses your certificate
  (`web.certFile`, `web.keyFile`) or makes a self-signed one once in `/data/web/`; plain `http://`
  on the same port redirects to `https://`.
- **Login for the RTSP streams** (optional): `"rtsp": { "username", "password" }`, the same login
  for the ONVIF cameras (UniFi Protect opens the stream with the ONVIF login, so they can't differ). Or
  `"rtsp": { "enabled": false }` keeps the streams off the network (not with ONVIF cameras).
- **The ONVIF snapshot needs the login** (HTTP Digest or Basic) when one is set.
- **Theme in `config.json`**: `"web": { "theme": "light" }` (or `"dark"`) fixes the page's theme;
  `"auto"` (the default) follows the system, with the switch in the header.
- **Security summary at startup**: the log names whatever is still open to the LAN and the setting
  that closes it.
- The tile details say whether the RTSP stream needs a login, or is off the network.
- **Light and dark theme**: follows the system until you pick one with the header's switch (the
  choice is remembered in that browser).
- **Version and updates**: the footer shows the version and links the GitHub project; when a newer
  release is out (or a newer beta, for someone on a beta), a banner and a header reminder say so,
  with what's new and how to update. `"checkForUpdates": false` turns the check off.
- **ONVIF on the web page**: each camera's details say whether it is published as an ONVIF device
  (*ONVIF* / *RTSP only*), its device address, IP, port and MAC, whether a login is required (never
  the password), what discovery tells NVRs (name, model, UUID), and whether an NVR is talking to it.

### Changed

- **The ONVIF login moved to `rtsp.username` / `rtsp.password`**: one login for RTSP and ONVIF.
  `onvif.username` / `onvif.password` from 0.4.0-beta.1 still work and now lock the RTSP streams
  too (players then need `rtsp://user:password@…`); the log asks you to move them.
- **All camera tiles are the same size.** The picture area is 16:9 for every camera; a camera of
  another shape (a 4:3 doorbell) is shown whole over a blurred copy of itself.
- *Live until* shows seconds (`until 19:42:35`): the live hold is counted in seconds.
- The ONVIF snapshot is served on the camera's ONVIF port (`/onvif/snapshot.jpg`), so it stays
  reachable for NVRs when the web page has a login.
- **Documentation**: RTSP/ONVIF and UniFi Protect named up front; setup in five steps; a section
  on the eufy account and its two-factor login (second account, sharing, codes, captcha, what ends
  a session); a Security section; every new option in docs/configuration.md; the diagram shows
  ONVIF, UniFi Protect and the web page.
- Docker's health check is a small Node script that follows the web page to HTTPS.
- README: which ports to map when the container uses a `bridge` network instead of `host`
  (`8099` and `8554` TCP), and that ONVIF (`8000` TCP, `3702` UDP) needs host networking.

## [0.4.0-beta.1] - 2026-10-31

Pre-release for testing: ONVIF for UniFi Protect, and a redesigned web page.

### Added

- **ONVIF, for UniFi Protect** and other NVRs that only adopt ONVIF cameras. A camera with an
  `onvif` section (its own IP on the LAN) is published as an ONVIF device: device and media
  services pointing at its existing RTSP stream and snapshot (nothing is encoded for ONVIF),
  motion events while it is waking up or live (PullPoint, two motion topics), WS-Discovery, and a
  login (`onvif.username` / `onvif.password`). `examples/onvif-addresses.sh` gives each camera its
  own IP and MAC (macvlan). Tested with the ONVIF client library UniFi Protect uses; not yet with a
  Protect console. See docs/onvif.md.

### Changed

- **Redesigned web page**, in the stream overlay's design language (dark, Inter, one accent colour
  and icon per state). Camera tiles are mostly picture, in each camera's own shape, with the name on
  it; underneath, one status line, the battery and the one action that fits (*Wake up* or *Stop*).
  Stream address (with a copy button), codec and size are behind *Stream details*; the devices on
  the account are a collapsed list that opens by itself during the first setup. Live pictures
  refresh every 2 s.

## [0.3.0-beta.2] - 2026-10-31

Pre-release for testing: the camera's own video is now passed through by default.

### Fixed

- **"Waking up" now appears the moment a camera is triggered.** It is prepared while the camera
  sleeps; rendering it only on the trigger was too slow for H.265 on a NAS, so the stream kept
  showing "Sleeping" until the camera went live.

### Changed

- **Passing the camera's own video through is now the default** (`transcode` defaults to `false`):
  a live 3K H.265 camera needs a few percent of a CPU core instead of up to two. If your NVR shows no
  picture for a camera (some NVRs don't accept H.265), set `"transcode": true` for it to convert its
  video to H.264 as before.
- Docs follow the new default throughout: what passing through and converting each mean for
  resolution, frame rate, bitrate and quality, and what to do if an NVR can't handle a camera's
  format or its size changes. NOTICE lists x265.

### Added

- The web page shows each camera's video: the stream's codec, and whether it is converted
  (e.g. `H.264 · converted from H.265`) or passed through (`H.265 · passed through, no conversion`).
  `/api/status` has it as `video`.

## [0.3.0-beta.1] - 2026-10-31

Pre-release for testing: conversion can be turned off per camera.

### Added

- **`transcode: false` per camera:** pass the camera's own H.264 or H.265 through instead of
  converting it. A live 3K H.265 camera then needs ~5 % of a CPU core instead of ~60 % (up to two
  cores on a small NAS), in the camera's original quality. The NVR must accept the camera's format.
  The first live session is still converted, to learn the format; the sleeping picture then uses it
  too. Default: `true` (convert, as before).

### Changed

- README and docs: the stream is H.264 by default, or the camera's own format with
  `transcode: false` (no longer described as "always H.264").
- **Less CPU while a camera is live:** the encoder uses a cheaper motion search, ~30 % less encoder
  CPU on 3K. To keep the quality where it was, the default bitrate limit is 10 % higher:
  `bitrateKbps` 4400 (was 4000), and ~6600 is recommended for 3K cameras (was ~6000). If your
  `config.json` sets `bitrateKbps`, raise it by 10 % too.
- Releases publish only the full version tag (`0.2.1`) and `latest`, no longer a short `0.2` as well.

## [0.2.1] - 2026-10-31

### Changed

- **The stream stays live while there is motion.** A session ends 30 seconds after the last detection,
  however long the motion goes on. Before, every session ended after 2 minutes.
- `holdMs` defaults to 30 s (was 2 min). After a doorbell press the stream still stays live for
  2 minutes (`ringHoldMs`).
- `maxLiveMs` is now an optional cap, `0` (none) by default (was 2 min). Set it if constant motion in
  front of a camera would drain its battery.
- Only the web page (8099) and RTSP (8554) are reachable from the network. go2rtc's web UI/API and
  WebRTC are switched off, and the eufy bridge always listens on localhost.

### Internal

- The code is split into modules (`gateway`, `switcher`, `video`, `overlay`) with 128 tests;
  CI runs them before every build.

## [0.2.0] - 2026-10-30

### Added

- **A clear sleeping state on the stream:** the last frame blurred and dimmed, a moon in the centre
  and a `Sleeping · since 18:33` label. Further states: waking up (with the reason), low battery,
  didn't wake up, offline, and no picture yet. Live video stays clean, with no overlay.
- The web page shows the same states, icons and colours.

### Changed

- **Near-zero CPU while idle:** the sleeping picture is encoded once and replayed instead of being
  re-encoded 15 times a second (well under 1 % of a core per camera, down from ~15 % or more).
- `config.json` is read from the data folder (`/data/config.json`), so one folder is all an install
  needs. A mounted `/config/config.json` still takes precedence.

### Removed

- `idleBlur`: the blur is part of the design now (fixed at 10). An existing value is ignored.
- The `LAST SEEN` label, replaced by the sleeping-state design.

## [0.1.2-rc.1] - 2026-10-30

Pre-release: first build that reads `config.json` from the data folder.

## [0.1.1-rc.1] - 2026-10-30

Pre-release to test the updated build pipeline.

## [0.1.0] - 2026-10-30

First release: always-on H.264 RTSP streams for battery-powered eufy cameras, without keeping them
awake. One container with the eufy bridge, go2rtc and the switcher; frozen last frame while idle,
live video on motion, person detection or a doorbell press; web page for the eufy login and status.

[Unreleased]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.4.1-beta.7...HEAD
[0.4.1-beta.7]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.4.1-beta.6...v0.4.1-beta.7
[0.4.1-beta.6]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.4.1-beta.5...v0.4.1-beta.6
[0.4.1-beta.5]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.4.1-beta.4...v0.4.1-beta.5
[0.4.1-beta.4]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.4.1-beta.3...v0.4.1-beta.4
[0.4.1-beta.3]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.4.1-beta.2...v0.4.1-beta.3
[0.4.1-beta.2]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.4.1-beta.1...v0.4.1-beta.2
[0.4.1-beta.1]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.4.0...v0.4.1-beta.1
[0.4.0]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.4.0-beta.4...v0.4.0
[0.4.0-beta.4]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.4.0-beta.3...v0.4.0-beta.4
[0.4.0-beta.3]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.4.0-beta.2...v0.4.0-beta.3
[0.4.0-beta.2]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.4.0-beta.1...v0.4.0-beta.2
[0.4.0-beta.1]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.3.0-beta.2...v0.4.0-beta.1
[0.3.0-beta.2]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.3.0-beta.1...v0.3.0-beta.2
[0.3.0-beta.1]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.2.1...v0.3.0-beta.1
[0.2.1]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.1.0...v0.2.0
[0.1.2-rc.1]: https://github.com/dbanky/eufy-nvr-gateway/releases/tag/v0.1.2-rc.1
[0.1.1-rc.1]: https://github.com/dbanky/eufy-nvr-gateway/releases/tag/v0.1.1-rc.1
[0.1.0]: https://github.com/dbanky/eufy-nvr-gateway/releases/tag/v0.1.0

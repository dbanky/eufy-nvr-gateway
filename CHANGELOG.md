# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Images: `dbanky/eufy-nvr-gateway:<version>` on Docker Hub
and `ghcr.io/dbanky/eufy-nvr-gateway:<version>`.

## [Unreleased]

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

[Unreleased]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.4.0-beta.2...HEAD
[0.4.0-beta.2]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.4.0-beta.1...v0.4.0-beta.2
[0.4.0-beta.1]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.3.0-beta.2...v0.4.0-beta.1
[0.3.0-beta.2]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.3.0-beta.1...v0.3.0-beta.2
[0.3.0-beta.1]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.2.1...v0.3.0-beta.1
[0.2.1]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.1.0...v0.2.0
[0.1.2-rc.1]: https://github.com/dbanky/eufy-nvr-gateway/releases/tag/v0.1.2-rc.1
[0.1.1-rc.1]: https://github.com/dbanky/eufy-nvr-gateway/releases/tag/v0.1.1-rc.1
[0.1.0]: https://github.com/dbanky/eufy-nvr-gateway/releases/tag/v0.1.0

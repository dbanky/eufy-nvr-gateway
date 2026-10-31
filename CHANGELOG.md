# Changelog

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Images: `dbanky/eufy-nvr-gateway:<version>` on Docker Hub
and `ghcr.io/dbanky/eufy-nvr-gateway:<version>`.

## [Unreleased]

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

[Unreleased]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/dbanky/eufy-nvr-gateway/compare/v0.1.0...v0.2.0
[0.1.2-rc.1]: https://github.com/dbanky/eufy-nvr-gateway/releases/tag/v0.1.2-rc.1
[0.1.1-rc.1]: https://github.com/dbanky/eufy-nvr-gateway/releases/tag/v0.1.1-rc.1
[0.1.0]: https://github.com/dbanky/eufy-nvr-gateway/releases/tag/v0.1.0

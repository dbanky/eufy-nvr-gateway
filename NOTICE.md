# Third-party software

The Docker image built from this repository downloads and bundles the following software. Each keeps
its own license; nothing from them is copied into this repository.

| Component | Version in the image | License | Source |
|---|---|---|---|
| ha-eufy-sdk-bridge | 0.6.0 (commit `6b3ccbc`) | Apache-2.0 | https://github.com/mega-yfue/ha-eufy-sdk-bridge |
| eufy-sdk (dependency of the bridge) | as locked by the bridge | Apache-2.0 | https://github.com/mega-yfue/eufy-sdk |
| go2rtc | 1.9.15 | MIT | https://github.com/AlexxIT/go2rtc |
| Node.js | 24 (Alpine image) | MIT | https://nodejs.org |
| FFmpeg, x264 | Alpine packages | LGPL-2.1+ / GPL-2.0+ | https://ffmpeg.org |
| DejaVu fonts | Alpine package | Bitstream Vera / public domain | https://dejavu-fonts.github.io |

Because the image contains FFmpeg built with x264 (GPL), redistributing the built image is subject
to the GPL; the source of every component is available at the links above.

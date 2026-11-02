# Third-party software

The Docker image built from this repository downloads and bundles the following software. Each keeps
its own license; nothing from them is copied into this repository.

**Modified:** ha-eufy-sdk-bridge is built with one addition, an `/audio/<serial>` route for a camera's
live audio. The change is [patches/bridge-live-audio.patch](patches/bridge-live-audio.patch), applied
at image build; it is under the bridge's license (Apache-2.0), and the changed file says so in place.

| Component | Version in the image | License | Source |
|---|---|---|---|
| ha-eufy-sdk-bridge | 0.6.0 (commit `6b3ccbc`) | Apache-2.0 | https://github.com/mega-yfue/ha-eufy-sdk-bridge |
| eufy-sdk (dependency of the bridge) | as locked by the bridge | Apache-2.0 | https://github.com/mega-yfue/eufy-sdk |
| Node.js | 24 (Alpine image) | MIT | https://nodejs.org |
| FFmpeg, x264, x265 | Alpine packages | LGPL-2.1+ / GPL-2.0+ | https://ffmpeg.org |
| Inter typeface | 4.1 | SIL Open Font License 1.1 | https://github.com/rsms/inter |

Because the image contains FFmpeg built with x264 and x265 (GPL), redistributing the built image is
subject to the GPL; the source of every component is available at the links above.

# eufy-nvr-gateway: one image with everything needed to turn battery-powered eufy cameras into
# always-on RTSP/ONVIF cameras for an NVR (UniFi Protect included), without keeping them awake.
#
# Every bundled component is pinned, so a rebuild cannot silently change behaviour.

# Overlay assets: icons rasterised from assets/icons/*.svg, and the Inter typeface (OFL-1.1).
FROM node:24-alpine AS assets
ARG INTER_VERSION=4.1
ARG INTER_SHA256=9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e
RUN apk add --no-cache rsvg-convert curl unzip
COPY assets/icons /src/icons
RUN mkdir -p /out/icons /out/fonts \
 && for f in /src/icons/*.svg; do rsvg-convert -w 256 -h 256 "$f" -o "/out/icons/$(basename "$f" .svg).png"; done \
 && curl -fsSL -o /tmp/inter.zip "https://github.com/rsms/inter/releases/download/v${INTER_VERSION}/Inter-${INTER_VERSION}.zip" \
 && echo "${INTER_SHA256}  /tmp/inter.zip" | sha256sum -c - \
 && unzip -j /tmp/inter.zip extras/ttf/Inter-Regular.ttf extras/ttf/Inter-SemiBold.ttf LICENSE.txt -d /out/fonts

FROM node:24-alpine

# ha-eufy-sdk-bridge 0.6.0 (Apache-2.0) — eufy login, events and on-demand P2P video
ARG BRIDGE_REPO=https://github.com/mega-yfue/ha-eufy-sdk-bridge.git
ARG BRIDGE_COMMIT=6b3ccbc09293da019e6f91db516856644501dbd2
# The bridge pins @mega-yfue/eufy-sdk 0.4.0; 0.5.0 (Apache-2.0) is installed over it. None of its
# breaking changes touches what the bridge or our audio patch use.
ARG EUFY_SDK_VERSION=0.5.0

RUN apk add --no-cache ffmpeg tzdata curl git openssl

# eufy bridge, with one addition: /audio/<serial>, the live audio of a camera that is streaming
COPY patches/bridge-live-audio.patch /tmp/
RUN git clone "$BRIDGE_REPO" /opt/bridge && cd /opt/bridge && git checkout "$BRIDGE_COMMIT" \
 && git apply /tmp/bridge-live-audio.patch && rm /tmp/bridge-live-audio.patch \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm install --omit=dev --no-audit --no-fund --save-exact "@mega-yfue/eufy-sdk@${EUFY_SDK_VERSION}" \
 && grep -q "\"version\": \"${EUFY_SDK_VERSION}\"" node_modules/@mega-yfue/eufy-sdk/package.json \
 && rm -rf .git test docs

# This project
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY --from=assets /out ./assets

ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8099 8554
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node /app/src/healthcheck.mjs

CMD ["node", "/app/src/main.mjs"]

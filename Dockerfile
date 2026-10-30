# eufy-nvr-gateway: one image with everything needed to turn battery-powered eufy cameras into
# always-on RTSP cameras for an NVR, without keeping them awake.
#
# Every bundled component is pinned, so a rebuild cannot silently change behaviour.

FROM node:24-alpine

ARG TARGETARCH
ARG GO2RTC_VERSION=1.9.15
# ha-eufy-sdk-bridge 0.6.0 (Apache-2.0) — eufy login, events and on-demand P2P video
ARG BRIDGE_REPO=https://github.com/mega-yfue/ha-eufy-sdk-bridge.git
ARG BRIDGE_COMMIT=6b3ccbc09293da019e6f91db516856644501dbd2

RUN apk add --no-cache ffmpeg font-dejavu tzdata curl git

# go2rtc (MIT): a single static binary
RUN case "${TARGETARCH:-amd64}" in \
      amd64) g2=go2rtc_linux_amd64 ;; arm64) g2=go2rtc_linux_arm64 ;; arm) g2=go2rtc_linux_arm ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" && exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/go2rtc "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/${g2}" \
 && chmod +x /usr/local/bin/go2rtc

# eufy bridge
RUN git clone "$BRIDGE_REPO" /opt/bridge && cd /opt/bridge && git checkout "$BRIDGE_COMMIT" \
 && npm ci --omit=dev --no-audit --no-fund && rm -rf .git test docs

# This project
WORKDIR /app
COPY package.json ./
COPY src ./src

ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8099 8554 1984 8555/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${WEB_PORT:-8099}/api/status" || exit 1

CMD ["node", "/app/src/start.mjs"]

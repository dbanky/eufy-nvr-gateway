// A camera's live audio from the bridge (/audio/<serial>, see patches/bridge-live-audio.patch) into
// its AudioFeed. The bridge only serves audio for a camera whose video is already streaming, and
// ends it with the video; until then (or after a hiccup) this asks again every retryMs.

import { AdtsSplitter, adtsHeader } from './adts.mjs';

// Returns { stop }. Stopping ends the request, and the feed goes back to silence.
export function openLiveAudio({ name, url, audioFeed, log, retryMs = 2000, fetchImpl = fetch }) {
  let stopped = false, controller = null, warnedFormat = false, warnedMissing = false;
  audioFeed.startLive();

  const onFrame = (frame) => {
    if (audioFeed.pushLive(frame) || warnedFormat || stopped) return;
    warnedFormat = true;
    const h = adtsHeader(frame);
    log(name, `audio: the camera sends ${h ? `${h.profile} ${h.sampleRate} Hz, ${h.channels} channel(s)` : 'an unknown format'}; the stream carries AAC-LC 16 kHz mono only, so it stays silent`);
  };

  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const split = new AdtsSplitter(onFrame);
      for await (const chunk of res.body) split.push(Buffer.from(chunk));
    } catch (e) {
      if (stopped) return;
      if (!warnedMissing) log(name, `audio: not available yet (${e.message}), trying again`);
      warnedMissing = true;
    }
    if (!stopped) setTimeout(connect, retryMs).unref?.();
  };
  connect();

  return {
    stop() {
      stopped = true;
      controller?.abort();
      audioFeed.stopLive();
    },
  };
}

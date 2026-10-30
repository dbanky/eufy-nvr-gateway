# How it works

## The problem

NVRs expect cameras to stream continuously. Battery eufy cameras are built for the opposite: they
sleep, wake on a detection, record a clip, and go back to sleep. They have no RTSP; live video exists
only as a P2P session opened through the eufy cloud, and every minute of it costs battery.

Pointing an NVR at an on-demand stream doesn't work either. The NVR never lets go, so the camera
never sleeps; and the eufy SDK cuts battery streams after about 55 seconds, so the NVR sees the
stream drop, reconnects, and wakes the camera again — all day.

## The approach: never switch streams, switch pictures

Each camera has **one ffmpeg encoder that runs forever** and publishes to go2rtc. The NVR connects
to go2rtc and sees an unbroken H.264 stream at a fixed resolution and frame rate.

The switcher decides what goes into that encoder:

| State | Picture | Camera |
|---|---|---|
| `IDLE` | Last frame, frozen, slightly blurred, `LAST SEEN hh:mm:ss` label | Asleep |
| `WAKING` | Frozen frame with a `CONNECTING…` label | Waking up (3–60 s) |
| `LIVE` | Live video, scaled to the fixed output size | Streaming over P2P |

Events (`motion`, `personDetected`, `doorbellPress`, …) come from the bundled
[ha-eufy-sdk-bridge](https://github.com/mega-yfue/ha-eufy-sdk-bridge) over its WebSocket. On an
event the switcher opens the bridge's `/stream/<serial>`, decodes it to raw frames and hands them to
the encoder. When the hold time ends it closes the stream — the bridge then ends the P2P session at
once (measured: ~0.1 s) and the camera sleeps.

There is no "motion ended" event, so sessions are timed: by default two minutes from the first live
frame, extended by further detections up to `maxLiveMs`.

## Details that matter

- **Frame pacing.** Raw 3K frames are 7 MB. Writing 15 of them per second while the picture is frozen
  cost most of a CPU core. Frames are now written only when the picture changes (plus a 1 s
  heartbeat), with wall-clock timestamps; ffmpeg repeats the last frame to a constant 15 fps
  (`-use_wallclock_as_timestamps 1 … -fps_mode cfr`).
- **Static pictures with x264.** With plain CRF, x264 keeps "refining" a frozen frame with ever lower
  quantizers: ~1.6 Mbit/s for a still image. `qpmin=19` stops that; together with the blur the frozen
  picture costs 0.1–0.6 Mbit/s.
- **Quality.** `crf 20`, High profile, keyframe every 4 s, no B-frames. Measured against the camera's
  own stream: SSIM 0.997 (2048×1536 doorbell), 0.993 (3K SoloCam).
- **H.265.** Some cameras (e.g. the SoloCam S340) only send H.265. The decoder converts everything;
  the output is always H.264. ffmpeg logs reference errors until the first keyframe of each session —
  harmless, those frames are dropped, never shown.
- **Variable resolution.** Some cameras start a session at 720p and step up to their full
  resolution within seconds. The output size is fixed, so early frames are scaled up.
- **The bridge's battery budget.** The SDK stops battery streams after 45 s (+10 s grace) unless told
  otherwise. The gateway sets `STREAM_BATTERY_BUDGET_MS` to 24 h, because it ends every session
  itself. Note: `0` or values above 2147483647 silently fall back to 45 s.
- **No accidental wake-ups.** The bridge listens on localhost only and its own go2rtc is disabled. The
  raw camera streams are therefore unreachable from the LAN; only the switcher can open them.
- **Snapshots.** The switcher serves `/api/cameras/<name>/snapshot.jpg` itself, from the picture
  currently being streamed — no extra decoding, and it never wakes a camera.


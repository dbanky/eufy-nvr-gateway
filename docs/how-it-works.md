# How it works

## The problem

NVRs expect cameras to stream continuously. Battery eufy cameras are built for the opposite: they
sleep, wake on a detection, record a clip, and go back to sleep. They have no RTSP; live video exists
only as a P2P session opened through the eufy cloud, and every minute of it costs battery.

Pointing an NVR at an on-demand stream doesn't work either. The NVR never lets go, so the camera
never sleeps; and the eufy SDK cuts battery streams after about 55 seconds, so the NVR sees the
stream drop, reconnects, and wakes the camera again — all day.

## The approach: never switch streams, switch pictures

Each camera has **one publisher that runs forever**: an `ffmpeg -c copy` that sends H.264 frames to
go2rtc at exactly 15 fps. The NVR connects to go2rtc and sees an unbroken stream at a fixed
resolution and frame rate. What the publisher is fed depends on the state:

| State | Picture | Camera |
|---|---|---|
| `IDLE` | The last frame, blurred and dimmed, with a moon and `Sleeping · since 18:33` | Asleep |
| `WAKING` | The same picture with a spinning ring and `Waking up · Person detected` | Waking up (3–60 s) |
| `LIVE` | Live video, scaled to the fixed output size, no overlay | Streaming over P2P |

While asleep the label can also read *low battery*, *didn't wake up* or *offline*, and a fresh
install shows *no picture yet* instead of a black frame.

**Sleeping costs (almost) nothing.** Each state's picture is drawn once and encoded once into an 8 s
loop (two keyframe intervals); the publisher replays those encoded frames without touching x264.
Only during a live session does an encoder run. Live and loop use identical x264 settings, so their
parameter sets match and the publisher can switch between them at any keyframe.

Events (`motion`, `personDetected`, `doorbellPress`, …) come from the bundled
[ha-eufy-sdk-bridge](https://github.com/mega-yfue/ha-eufy-sdk-bridge) over its WebSocket. On an
event the switcher opens the bridge's `/stream/<serial>`, decodes it to raw frames and hands them to
the encoder. When the hold time ends it closes the stream — the bridge then ends the P2P session at
once (measured: ~0.1 s) and the camera sleeps.

There is no "motion ended" event, so "no more motion" means "no new detection for `holdMs`" (30
seconds by default; 2 minutes after a doorbell press). Every detection while live pushes the end back;
the session ends 30 seconds after the last one. An optional `maxLiveMs` caps a session for places where motion never stops.

## Converting or passing through

By default live video is converted: decoded, then encoded again as H.264 with the same settings as the
sleeping loops, so the two splice seamlessly. With `transcode: false` a camera's own H.264 or H.265 is
passed through instead, and its sleeping loops are encoded in the same format. A side output decodes
only the camera's keyframes into JPEGs, for snapshots and for the next sleeping picture. On a 3K H.265
camera this takes a live session from ~60 % of a core (converting) to ~5 %.

Splicing someone else's stream needs care: every frame must start with exactly one access unit
delimiter, and every keyframe must carry its parameter sets. The pass-through removes the stream's own
delimiters, adds parameter sets in front of keyframes, then adds one delimiter per frame.

## Details that matter

- **Idle CPU.** Re-encoding an unchanging 3K picture 15 times a second cost ~15 % of a fast core per
  camera, more on a NAS. Replaying a pre-encoded loop costs well under 1 %.
- **Frame pacing while live.** Raw 3K frames are 7 MB. The live encoder only gets a frame when the
  picture changes (plus a 1 s heartbeat), with wall-clock timestamps; ffmpeg repeats the last frame
  to a constant 15 fps (`-use_wallclock_as_timestamps 1 … -fps_mode cfr`).
- **Static pictures with x264.** With plain CRF, x264 keeps "refining" a still frame with ever lower
  quantizers: ~1.6 Mbit/s. `qpmin=19` stops that; with the blur the sleeping picture costs
  0.1–0.6 Mbit/s.
- **Live CPU.** Converting 3K H.265 to H.264 is the expensive part of a live session (decoder plus
  encoder). The encoder uses a cheaper motion search (`me=dia:subme=1`, ~30 % less CPU) with 10 % more
  bitrate headroom, which keeps the quality where it was. Other settings (threads, lookahead, one
  combined decode+encode process) were measured and brought nothing.
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
- **No accidental wake-ups.** Only the web page and the RTSP streams are reachable from the network.
  The raw camera streams are not, so nothing but the switcher can wake a camera.
- **Snapshots.** The switcher serves `/api/cameras/<name>/snapshot.jpg` itself, from the picture
  currently being streamed — no extra decoding, and it never wakes a camera.


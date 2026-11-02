# How it works

## The problem

NVRs expect cameras to stream continuously. Battery eufy cameras are built for the opposite: they
sleep, wake on a detection, record a clip, and go back to sleep. They have no RTSP; live video exists
only as a P2P session opened through the eufy cloud, and every minute of it costs battery.

Pointing an NVR at an on-demand stream doesn't work either. The NVR never lets go, so the camera
never sleeps; and the eufy SDK cuts battery streams after about 55 seconds, so the NVR sees the
stream drop, reconnects, and wakes the camera again — all day.

## The approach: never switch streams, switch pictures

Each camera has **one publisher that runs forever**: it sends encoded frames to go2rtc over RTSP
itself (no ffmpeg, nothing re-encoded) — the camera's own H.264/H.265, or H.264 with
`transcode: true`, and with `"audio": true` the camera's AAC sound. The sleeping picture plays at
exactly 15 fps; every live frame and every sound frame goes out the moment it arrives, stamped with
its arrival time, so nothing waits, is held back or dropped, and picture and sound never wait for
each other. The NVR sees one unbroken stream. What the publisher is fed depends on the state:

| State | Picture | Camera |
|---|---|---|
| `IDLE` | The last frame, blurred and dimmed, with a moon and `Sleeping · since 18:33` | Asleep |
| `WAKING` | The same picture with a spinning ring and `Waking up · Person detected` | Waking up (3–60 s) |
| `LIVE` | The camera's own video, passed through (or converted to H.264), no overlay | Streaming over P2P |

While asleep the label can also read *low battery*, *didn't wake up* or *offline*, and a fresh
install shows *no picture yet* instead of a black frame.

**The RTSP front.** Viewers don't talk to go2rtc directly (it listens on `127.0.0.1` only); they
connect to the gateway's own RTSP server on `8554`, which relays to go2rtc and adds what go2rtc
lacks: the login, RTP over UDP from fixed ports per camera, RTCP sender reports, and RTSP over
HTTP. It also covers two gaps that would otherwise cut viewers off: once a stream plays, go2rtc
never answers the keep-alive requests `GET_PARAMETER` and `SET_PARAMETER` (nor `TEARDOWN`), so the
front answers them; and go2rtc drops a connection it hears nothing on for 60 s, which is what a
viewer on UDP looks like, so the front sends it an `OPTIONS` after 20 s of silence.

**Sleeping costs (almost) nothing.** Each state's picture is drawn once and encoded once into an 8 s
loop with a keyframe every second, in the stream's format; the publisher replays those encoded frames
without encoding anything. A viewer can only start at a keyframe, so one that opens a sleeping
camera sees the picture within a second; the camera's own live video keeps its own keyframes
(every 4 s on eufy cameras) and is never re-encoded for this. The switch to live video and back happens at a keyframe, so the stream
never breaks.

**The live picture starts at the camera's first keyframe.** Both readers of `/stream/<serial>` (the
pass-through and the decoder for `transcode: true`) probe only a few kilobytes and keep what they read
while probing. ffmpeg's `-fflags nobuffer` threw that away, and with it the first keyframe, so the live
picture waited for the next one: about 4 s longer on every wake.

Events (`motion`, `personDetected`, `doorbellPress`, …) come from the bundled
[ha-eufy-sdk-bridge](https://github.com/mega-yfue/ha-eufy-sdk-bridge) over its WebSocket. On an
event the switcher opens the bridge's `/stream/<serial>` and either passes the camera's video through
or converts it (see below). When the session ends it closes the stream — the bridge then ends the P2P
session at once (measured: ~0.1 s) and the camera sleeps.

There is no "motion ended" event, and during continuing motion a eufy camera sends no new detection
until its own re-trigger interval is over. So the gateway also watches the live picture: it compares
the camera's consecutive keyframes (every 4 s) as 32×24 grey thumbnails, made by the decoder that
already runs for snapshots. A change in at least 2 % of the picture (after taking out an overall
brightness shift, such as the camera adjusting its exposure) counts as movement. A doorbell
standing still measured 0 changed cells out of 768.

"No more motion" means no new detection and no movement for `holdMs` (30 seconds by default;
2 minutes after a doorbell press). Movement alone keeps a session live at most
`motionInPictureMaxMs` (5 minutes) after the camera's last detection, so leaves in the wind can't
keep a battery camera awake for ever; each new detection allows another 5 minutes. An optional
`maxLiveMs` caps every session for places where motion never stops.

## Converting or passing through

**Passing through (the default).** The camera's own H.264 or H.265 goes to the NVR as it is, and its
sleeping loops are encoded in the same format. A side output decodes only the camera's keyframes into
JPEGs, for snapshots and for the next sleeping picture. On a 3K H.265 camera a live session costs ~5 %
of a core this way. The first live session of a camera is converted, to learn which format it sends.

**Converting (`transcode: true`).** Live video is decoded, then encoded again as H.264 with the same
settings as the sleeping loops, so the two splice seamlessly. Every NVR accepts it, but for a 3K H.265
camera it costs ~60 % of a fast core, up to two cores on a small NAS.

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
- **Live CPU when converting.** Converting 3K H.265 to H.264 is the expensive part of a converted
  session (decoder plus encoder). The encoder uses a cheaper motion search (`me=dia:subme=1`, ~30 %
  less CPU) with 10 % more bitrate headroom, which keeps the quality where it was. Other settings
  (threads, lookahead, one combined decode+encode process) were measured and brought nothing.
- **Quality.** Passed through, it is the camera's own picture. Converted: `crf 20`, High profile,
  keyframe every 4 s, no B-frames; measured against the camera's own stream: SSIM 0.997 (2048×1536
  doorbell), 0.993 (3K SoloCam).
- **H.265.** Some cameras (e.g. the SoloCam S340) only send H.265. Passed through (the default) the
  stream stays H.265; with `transcode: true` it is always H.264. ffmpeg logs reference errors until the
  first keyframe of each session — harmless, those frames are dropped, never shown.
- **Variable resolution.** Some cameras start a session at 720p and step up to their full resolution
  within seconds (the SoloCam S340 within ~8 s). Passed through, the NVR receives those size changes;
  converted, the output size is fixed and early frames are scaled up.
- **The bridge's battery budget.** The SDK stops battery streams after 45 s (+10 s grace) unless told
  otherwise. The gateway sets `STREAM_BATTERY_BUDGET_MS` to 24 h, because it ends every session
  itself. Note: `0` or values above 2147483647 silently fall back to 45 s.
- **No accidental wake-ups.** Only the web page and the RTSP streams are reachable from the network.
  The raw camera streams are not, so nothing but the switcher can wake a camera.
- **Snapshots.** The switcher serves `/api/cameras/<name>/snapshot.jpg` itself, from the picture
  currently on the stream (while passing through: the camera's newest keyframe), and it never wakes a
  camera.


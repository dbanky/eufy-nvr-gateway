# Battery eufy cameras in UniFi Protect

UniFi Protect adopts third-party cameras over ONVIF, but battery eufy cameras have neither ONVIF
nor RTSP. With the gateway, each eufy camera becomes an ONVIF camera that Protect can adopt. It
shows the sleeping picture while the camera sleeps, and live video with ONVIF motion events while
the camera is awake.

This guide is the path that worked on a real Protect console. The general ONVIF reference is
[onvif.md](onvif.md).

## What you need

- The gateway running, logged in to eufy, with your cameras on its web page
  ([setup](../README.md#setup-in-five-steps)).
- **Host networking** for the container (Synology Container Manager: *Network* `host`; Compose:
  `network_mode: host`). On a bridge network ONVIF can't work, and the gateway says so in red.
- If the NAS's firewall is on: a few ports allowed in it. Which ones, and why: step 1 below.
- **One IP address on your LAN per camera**, on the machine the gateway runs on. Protect tells
  cameras apart by address. That can be a second network port (a Synology with two ports, each with
  its own IP) or a macvlan address per camera ([onvif.md, step 1](onvif.md#1-give-each-camera-its-own-address)).
- A UniFi Protect version that supports third-party cameras. See Ubiquiti's
  [Third-Party Cameras in UniFi Protect](https://help.ui.com/hc/en-us/articles/26301104828439-Third-Party-Cameras-in-UniFi-Protect).

## 1. Publish the cameras as ONVIF devices

In `config.json`, choose one login for the streams. Protect uses it for ONVIF and for the RTSP
stream, so it is one login for both. Then give every camera an `onvif` section with its own address:

```json
{
  "rtsp": { "username": "protect", "password": "choose-a-password" },
  "cameras": [
    { "name": "front-door", "serial": "T81XXXXXXXXXXXXX", "width": 1600, "height": 1200, "udpPort": 40000,
      "transcode": true, "onvif": { "address": "192.168.1.51", "port": 8000 } },
    { "name": "garden", "serial": "T81XXXXXXXXXXXXX", "width": 2880, "height": 1616, "udpPort": 40004,
      "transcode": true, "onvif": { "address": "192.168.1.52", "port": 8001 } }
  ]
}
```

**Use `"transcode": true` for every camera that Protect records.** Without it, the gateway passes
the camera's own video through, and the stream's video settings (the H.264/H.265 parameter sets)
change during every event: the sleeping picture is made by the gateway, the live video by the
camera, and some cameras (the SoloCam S340) also change resolution in the first seconds. Protect
keeps only the settings it saw first and removes all later ones from what it records, so it decodes
the camera's live video with the wrong settings: recordings come out broken (smeared or frozen
blocks, wrong size), and the live view can stall. With `"transcode": true`, the gateway makes the
whole stream itself, sleeping picture and live video, with one set of H.264 settings: recordings
decode cleanly. It costs CPU on the gateway while a camera is live (a 3K camera: up to two cores
on a small NAS); asleep, still almost nothing. Other viewers (VLC, Home Assistant, most NVRs) handle
the passed-through stream, so leave it off for cameras Protect doesn't record.

`udpPort` can be left out: the first camera gets `40000`, the second `40004` anyway. Writing it
down makes the firewall rule in the next step easy to read off.

Restart the container. Open each camera's *Stream details* on the web page: the ONVIF part shows the
device address to copy. If it says *Not on the network yet*, the reason and the fix are right there,
and in [onvif.md → Troubleshooting](onvif.md#troubleshooting).

### Open the ports in the NAS's firewall

With host networking nothing is mapped in Container Manager. But if the NAS's firewall is on
(Synology: *Control Panel → Security → Firewall*), Protect can only reach what it allows. For the
two cameras above:

| Ports | Protocol | Why Protect needs it |
|---|---|---|
| `8000`, `8001` | TCP | each camera's ONVIF port: adoption, the stream address, motion events, snapshots |
| `8554` | TCP | the RTSP stream itself |
| `40000`–`40007` | UDP | picture and sound over UDP, if Protect asks for UDP: four per camera, `udpPort` to `udpPort` + 3 |
| `8099` | TCP | not for Protect: the gateway's web page, for you |

Why four UDP ports per camera: over UDP, the picture and the sound each come as their own stream of
packets, and each needs one port for the media (RTP) and one for its timing and keep-alive reports
(RTCP): 2 tracks × 2 ports. All viewers of a camera share its four, so the list doesn't grow with
more viewers. Over TCP, everything goes through `8554` and the UDP ports aren't used; opening them
just avoids a slow start if Protect tries UDP first. More in the
[README → Ports](../README.md#why-four-udp-ports-per-camera).

In DSM: *Control Panel → Security → Firewall → Edit Rules → Create*, *Ports*: *Custom*, *Type*:
*Destination port*: one rule for TCP `8000,8001,8554,8099`, one for UDP `40000-40007`. Under
*Source IP* you can limit both to your LAN, or to the Protect console's address. Keep them above
any *Deny all* rule.

## 2. Adopt each camera with *Advanced Adoption*

**Don't wait for Protect to discover the cameras: it doesn't find them.** Add each one by hand:

1. In UniFi Protect, go to adopting devices. When the camera isn't listed, open the help link (**?**)
   and choose **Advanced Adoption**.
2. Enter the camera's **IP address** (its `onvif.address`) and, if Protect asks for one, its ONVIF
   **port** (`onvif.port`, 8000 by default).
3. Enter the **username and password** from `rtsp.username` / `rtsp.password`.
4. Adopt. The camera appears with its eufy name and model; the picture is the gateway's sleeping
   picture until the camera wakes.

Repeat for every camera. On the gateway's web page, the camera's ONVIF details now show *Last
request … from* the Protect console's address.

## 3. Playback issues: set *Stream Compatibility Mode* to *Improved*

If a camera's live view or playback in Protect **flickers, turns black, stutters or behaves
strangely** — especially in a web browser — change the camera's **Stream Compatibility Mode** to
**Improved** in its settings in Protect. This is a general option for any camera, H.264 or H.265,
and the first thing to try with playback issues.

It matters most for cameras that send H.265, like the SoloCam S340 (3K), when they are passed
through: browsers handle H.265 poorly. With `"transcode": true` (step 1) the stream is H.264 anyway.

If the live view still spins now and then while the stream itself is fine, look at the Protect
console's load: a small console (e.g. a Cloud Key Gen2+) recording several 4K UniFi cameras and
running face or licence-plate recognition can fall behind, and its intake of a third-party camera
can get stuck until the console restarts.

## Sound

Battery eufy cameras send their sound as AAC (16 kHz, mono). With `"audio": true` for a camera, its
stream carries it, and the ONVIF device reports the audio track to Protect:

```json
{ "name": "front-door", "serial": "T81XXXXXXXXXXXXX", "width": 1600, "height": 1200, "audio": true,
  "onvif": { "address": "192.168.1.51", "port": 8000 } }
```

Restart the container, then remove and adopt the camera again in Protect, so it reads the new
profile. While the camera sleeps the track is silent; when it wakes you hear the camera.

Ubiquiti's [Third-Party Cameras in UniFi Protect](https://help.ui.com/hc/en-us/articles/26301104828439-Third-Party-Cameras-in-UniFi-Protect)
lists audio among the features that may not be supported for third-party cameras, so whether Protect
plays it depends on your Protect version. Other NVRs and VLC play it either way.

## 4. Record events

The gateway sends ONVIF motion events exactly while a camera is waking up or live, and none while it
sleeps. Set the cameras to record on motion (detections) in Protect, so the recordings are the live
sessions and not hours of the sleeping picture.

The first seconds of each event are missing. A battery camera needs 3–8 seconds to wake (longer from
deep sleep), and only then is there live video.

## Troubleshooting

| What you see | What to do |
|---|---|
| Protect doesn't discover the cameras | Expected: use **Advanced Adoption** (step 2). |
| Adoption fails with a login error | Use `rtsp.username` / `rtsp.password`, one login for ONVIF and the stream. |
| Adoption can't reach the camera | Check the camera's ONVIF details on the web page: it must not say *Not on the network yet*. The Protect console must be able to reach that IP and port. Note: the machine running the gateway can't reach its own macvlan addresses, so test from another device. |
| Recordings of a camera are broken (smeared or frozen blocks, wrong size), or its live view stalls during events | `"transcode": true` for that camera (step 1): Protect can't follow the video settings changing in a passed-through stream. |
| Live view or playback flickers, is black, stutters or acts strangely (any camera, especially in a browser) | `"transcode": true` (step 1), and *Stream Compatibility Mode*: **Improved** (step 3). |
| Live view spins, but only one camera shows nothing at all, even after the gateway restarts | Protect's intake of that camera is stuck: restart the Protect console. A heavily loaded console makes this more likely. |
| Picture only, no live video in Protect when something happens | The camera has to wake up first: check on the gateway's web page that it goes *Live*. Disarmed eufy cameras send no events. |
| Recordings are all sleeping pictures | Record on motion instead of continuously (step 4). |

## Limits

- The doorbell is a plain camera in Protect: no ring event, no chime, no two-way audio.
- Each live session costs camera battery; the gateway ends it 30 s after the last detection.
- Third-party cameras have fewer features in Protect than UniFi cameras. See Ubiquiti's
  [Third-Party Cameras in UniFi Protect](https://help.ui.com/hc/en-us/articles/26301104828439-Third-Party-Cameras-in-UniFi-Protect)
  for the current list.

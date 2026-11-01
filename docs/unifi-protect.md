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
    { "name": "front-door", "serial": "T81XXXXXXXXXXXXX", "width": 1600, "height": 1200,
      "onvif": { "address": "192.168.1.51", "port": 8000 } },
    { "name": "garden", "serial": "T81XXXXXXXXXXXXX", "width": 2880, "height": 1616,
      "onvif": { "address": "192.168.1.52", "port": 8001 } }
  ]
}
```

Restart the container. Open each camera's *Stream details* on the web page: the ONVIF part shows the
device address to copy. If it says *Not on the network yet*, the reason and the fix are right there,
and in [onvif.md → Troubleshooting](onvif.md#troubleshooting).

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

It matters most for cameras that send H.265, like the SoloCam S340 (3K): the gateway passes their
H.265 through by default to save CPU, and browsers handle H.265 poorly. *Improved* fixed this
completely in our setup.

If your Protect version doesn't have that setting, or it doesn't help with an H.265 camera, let the
gateway convert that camera to H.264 instead: `"transcode": true` for the camera in `config.json`.
That costs CPU on the gateway while the camera is live.

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
| Live view or playback flickers, is black, stutters or acts strangely (any camera, especially in a browser) | *Stream Compatibility Mode*: **Improved** (step 3); for an H.265 camera also `"transcode": true`. |
| Picture only, no live video in Protect when something happens | The camera has to wake up first: check on the gateway's web page that it goes *Live*. Disarmed eufy cameras send no events. |
| Recordings are all sleeping pictures | Record on motion instead of continuously (step 4). |

## Limits

- The doorbell is a plain camera in Protect: no ring event, no chime, no two-way audio.
- Each live session costs camera battery; the gateway ends it 30 s after the last detection.
- Third-party cameras have fewer features in Protect than UniFi cameras. See Ubiquiti's
  [Third-Party Cameras in UniFi Protect](https://help.ui.com/hc/en-us/articles/26301104828439-Third-Party-Cameras-in-UniFi-Protect)
  for the current list.

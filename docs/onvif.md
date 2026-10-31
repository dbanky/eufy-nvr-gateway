# ONVIF (UniFi Protect and other ONVIF-only NVRs)

**Using UniFi Protect?** Follow the step-by-step [UniFi Protect guide](unifi-protect.md); this page is
the general ONVIF reference.

Some NVRs adopt only ONVIF cameras — UniFi Protect most notably. The gateway can publish each camera
as an ONVIF device as well. Nothing is encoded for this: ONVIF only describes the camera and points
the NVR at the camera's existing RTSP stream (`rtsp://<address>:8554/<name>`), plus motion events
so the NVR can record only while the camera is awake.

| What the NVR sees | |
|---|---|
| Device | Manufacturer `eufy`, the camera's model and serial, one stream profile |
| Stream | The gateway's RTSP stream of that camera — H.264, or the camera's own H.265 when passed through |
| Snapshot | What the stream shows, as a JPEG on the camera's ONVIF port (`/onvif/snapshot.jpg`), behind the login (`rtsp.username`) |
| Motion | `true` while the camera is waking up or live, `false` when it sleeps (ONVIF PullPoint events, topics `RuleEngine/CellMotionDetector/Motion` and `VideoSource/MotionAlarm`) |
| Adding | By IP address and port, with the login (UniFi Protect: *Advanced Adoption*). There is no WS-Discovery: Protect didn't find the cameras with it in practice |

## 1. Give each camera its own address

UniFi Protect tells cameras apart by IP and MAC address: several cameras on the gateway's own IP
would collapse into one. So each published camera needs its own IP (and MAC) on your LAN. On Linux
hosts — Synology included — that is a *macvlan* interface per camera.

[`examples/onvif-addresses.sh`](../examples/onvif-addresses.sh) creates them. Edit the camera list
at the top (one line per camera: interface name, MAC starting with `02:`, a free IP outside your
router's DHCP range), and run it as root at every boot, before the gateway starts. On a Synology:
*Control Panel → Task Scheduler → Create → Triggered Task → User-defined script*, user `root`,
event *Boot-up*. On DSM with Open vSwitch the parent interface is `ovs_eth0` instead of `eth0`.

The container must use **host networking** (Synology: *Network* `host`), so it can listen on
these addresses directly. Nothing needs to be mapped then: the ONVIF port (`8000` TCP per camera)
is open on the host. On a `bridge` network ONVIF can't work: the container doesn't have the
cameras' addresses.

Note: a host can't reach its own macvlan addresses. Test from another machine, or from the NVR.

NVRs that accept several ONVIF cameras on one IP don't need this: give every camera the host's IP
and a different `onvif.port`.

## 2. Configure the cameras

In `config.json`, the login your NVR will use, and an `onvif` section for every camera to publish:

```json
{
  "rtsp": { "username": "protect", "password": "choose-a-password" },
  "cameras": [
    { "name": "garden", "serial": "T81XXXXXXXXXXXXX", "width": 2880, "height": 1616,
      "onvif": { "address": "192.168.1.51", "mac": "02:00:00:00:00:01" } }
  ]
}
```

| Key | Default | Meaning |
|---|---|---|
| `rtsp.username`, `rtsp.password` | — | Top level. The one login the NVR uses, for ONVIF (WS-UsernameToken; HTTP Digest or Basic for the snapshot) and the RTSP stream. Without it, anyone on the LAN can use the cameras. |
| `cameras[].onvif.address` | — | Required to publish the camera: its own IPv4 address (step 1) |
| `cameras[].onvif.port` | `8000` | ONVIF port on that address |
| `cameras[].onvif.mac` | — | The interface's MAC, reported to the NVR as the camera's |

Restart the container. The log shows `ONVIF device on http://192.168.1.51:8000/onvif/device_service`
for every published camera.

The web page shows it too, under each camera's *Stream details*: the device address (to copy), IP,
port and MAC, whether a login is required, how it shows in NVRs (name, model, UUID) and whether
an NVR is talking to the camera (its address, last request and motion-event subscriptions). Cameras
without an `onvif` section are marked *RTSP only*.

### One login for ONVIF and the stream

The ONVIF services and the RTSP stream share `rtsp.username` / `rtsp.password`: UniFi Protect opens
the stream with the login it adopted the camera with, so two different logins could never work.

## 3. Adopt them in the NVR

UniFi Protect: add each camera with **Advanced Adoption**, with its IP address (and port, if asked)
and the login from step 2. Details, including the H.265 setting that matters: the
[UniFi Protect guide](unifi-protect.md). Other NVRs: add an ONVIF camera by IP and port.

To record only events, set the cameras to record on motion: the gateway reports motion exactly
while a camera is awake.

## Things to know

- **Codec.** A camera passed through as H.265 (the SoloCam S340, for example) is reported as H.265.
  UniFi Protect takes it; if its live view flickers or is black, set the camera's *Stream
  Compatibility Mode* to *Improved* in Protect, or `"transcode": true` for that camera.
- **The first seconds of an event are missing** from recordings: the camera needs 3–8 seconds to
  wake (longer from deep sleep), and only then is there live video.
- **The doorbell is a plain camera** in Protect: no ring event, no chime, no audio.
- Without an `rtsp` login, anyone on the LAN can watch the RTSP stream; see "One login for ONVIF and the
  stream" above, and [Security](../README.md#security).

## Troubleshooting

Each camera's *Stream details* on the web page show its ONVIF side; the log says the same at
startup.

### *Not on the network yet: 192.168.1.51 is not an address of this machine*

The camera's ONVIF device listens on its own address (`onvif.address`), and the machine the
container runs on doesn't have that address. The message lists the addresses it does have. Linux
calls this `EADDRNOTAVAIL`; the gateway says it in words instead.

| Cause | Fix |
|---|---|
| The address comes up **after** the container started: a second network port whose DHCP lease arrives late, or a macvlan address created by a boot script that ran too late | Nothing: the gateway tries again every 30 s, and the camera comes on by itself once the address is there. To have it from the start, give the port a fixed IP (DSM: *Control Panel → Network → Network Interface → Edit → Use manual configuration*) and run `onvif-addresses.sh` before the container starts. |
| The address belongs to another device, or has a typo | Use an address of this machine (one per camera), or create it (step 1). |
| *it has none*, or *this container is on a Docker bridge network* | The container isn't on host networking: set *Network* to `host` (Compose: `network_mode: host`). With no camera address present and only bridge addresses, the gateway says so loudly at startup and in a red banner on the web page. Mapping port `8000` doesn't help on a bridge. |

To see which addresses the machine has, run `ip -4 addr` on it (Synology: over SSH).

### *Port 8000 on 192.168.1.51 is already used by another program*

Another program on the machine listens on that address and port. Choose another `onvif.port` for
the camera.


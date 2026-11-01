// One SETUP of a session: a track, the interleaved channels it has towards go2rtc, and how its
// packets reach the client: interleaved on the RTSP connection, or over UDP from the camera's
// shared port pair. Also its sender-report statistics.

import { formatFrame } from './messages.mjs';
import { interleavedTransport, udpTransport } from './transport.mjs';
import { RtpTrackStats, isRtcp } from './sender-report.mjs';

const plainAddress = (address) => address?.replace(/^::ffff:/, '');

// The interleaved channels for a new SETUP: the ones the client asked for (TCP) if they are free,
// else the first free pair.
export function chooseChannels(taken, wanted) {
  const used = new Set(taken);
  if (wanted && !used.has(wanted[0]) && !used.has(wanted[1])) return wanted;
  let c = 0;
  while (used.has(c) || used.has(c + 1)) c += 2;
  return [c, c + 1];
}

export class TrackBinding {
  constructor({ channels, clockRate = 90000 }) {
    this.channels = channels;   // towards go2rtc (and the client, when interleaved)
    this.stats = new RtpTrackStats(clockRate);
    this.udp = null;            // { rtp, rtcp, ports, onRtcp, close } when over UDP
    this.clientPort = null;     // [rtp, rtcp] on the client, when over UDP
  }

  // Over UDP: the camera's port pair, shared by all its viewers. onAlive() runs for RTCP from this
  // viewer only (its address and RTCP port), which keeps its session alive.
  async openUdp({ openUdp, localAddress, uri, media, clientPort, clientAddress, onAlive }) {
    this.clientPort = clientPort;
    this.udp = await openUdp(localAddress, { uri, media });
    this.udp.onRtcp((packet, from) => {
      if (from?.port === clientPort[1] && plainAddress(from?.address) === clientAddress() && isRtcp(packet)) onAlive();
    });
  }

  // The Transport header the client gets for this SETUP.
  transport() {
    return this.udp ? udpTransport({ clientPort: this.clientPort, serverPort: this.udp.ports }) : interleavedTransport(this.channels);
  }

  // writeFrame(bytes): the client's RTSP connection, for interleaved packets.
  sendRtp(data, address, writeFrame) {
    if (this.udp) return this.udp.rtp.send(data, this.clientPort[0], address);
    writeFrame(formatFrame(this.channels[0], data));
  }

  sendRtcp(data, address, writeFrame) {
    if (this.udp) return this.udp.rtcp.send(data, this.clientPort[1], address);
    writeFrame(formatFrame(this.channels[1], data));
  }

  close() {
    this.udp?.close();
  }
}

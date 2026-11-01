// The RTSP Transport header (RFC 2326 section 12.39): what a client asks for in SETUP, and what the
// server answers. Pure.
//
//   RTP/AVP;unicast;client_port=5000-5001            RTP over UDP
//   RTP/AVP/TCP;unicast;interleaved=0-1              RTP inside the RTSP connection

// The client's choices, best first: [{ protocol: 'udp' | 'tcp' | 'other', multicast, clientPort, interleaved, raw }].
export function parseTransport(value) {
  return String(value ?? '').split(',').map((spec) => spec.trim()).filter(Boolean).map((raw) => {
    const [profile, ...params] = raw.split(';').map((p) => p.trim());
    const get = (name) => params.find((p) => p.toLowerCase().startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
    const pair = (v) => {
      if (v == null) return null;
      const [a, b] = v.split('-').map(Number);
      return Number.isInteger(a) ? [a, Number.isInteger(b) ? b : a + 1] : null;
    };
    const upper = profile.toUpperCase();
    const protocol = upper === 'RTP/AVP' || upper === 'RTP/AVP/UDP' ? 'udp' : upper === 'RTP/AVP/TCP' ? 'tcp' : 'other';
    return { protocol, multicast: params.some((p) => p.toLowerCase() === 'multicast'), clientPort: pair(get('client_port')),
      interleaved: pair(get('interleaved')), raw };
  });
}

// The first choice this server can do: unicast UDP with client ports, or interleaved TCP.
export function chooseTransport(choices) {
  return choices.find((c) => !c.multicast && ((c.protocol === 'udp' && c.clientPort) || c.protocol === 'tcp')) ?? null;
}

export const interleavedTransport = ([rtp, rtcp]) => `RTP/AVP/TCP;unicast;interleaved=${rtp}-${rtcp}`;

export const udpTransport = ({ clientPort, serverPort, ssrc }) =>
  `RTP/AVP;unicast;client_port=${clientPort[0]}-${clientPort[1]};server_port=${serverPort[0]}-${serverPort[1]}${ssrc ? `;ssrc=${ssrc}` : ''}`;

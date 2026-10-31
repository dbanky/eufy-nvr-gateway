// The machine's own addresses, and network errors in plain words for the log and the web page.
//
// Every ONVIF camera listens on its own address (device service, discovery). If the machine doesn't
// have that address, Linux answers with codes that mean nothing to a user: EADDRNOTAVAIL for a
// server, ENODEV for joining the discovery multicast group on it.

import { networkInterfaces } from 'node:os';

// The machine's IPv4 LAN addresses, as the container sees them.
export function hostAddresses(interfaces = networkInterfaces()) {
  return Object.values(interfaces).flat()
    .filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal)
    .map((i) => i.address);
}

// error: from listen/bind/addMembership. where: { address, port, udp?, addresses (the machine's) }.
export function explainNetworkError(error, { address, port, udp = false, addresses = hostAddresses() }) {
  if (error.code === 'ENODEV' || error.code === 'EADDRNOTAVAIL') {
    const has = addresses.length ? `it has ${addresses.join(', ')}` : 'it has none: is the container on host networking?';
    return `${address} is not an address of this machine (${has}). `
      + 'Give the machine this address (a second network port, or a macvlan address) and run the container with host networking';
  }
  if (error.code === 'EADDRINUSE') {
    return udp
      ? `UDP port ${port} is already used by another program (another ONVIF server or discovery tool on this machine)`
      : `port ${port} on ${address} is already used by another program: choose another "onvif.port"`;
  }
  return error.message;
}

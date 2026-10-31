// The machine's own addresses, and network errors in plain words for the log and the web page.
//
// Every ONVIF camera listens on its own address. If the machine doesn't have that address, Linux
// answers with a code that means nothing to a user (EADDRNOTAVAIL).

import { networkInterfaces } from 'node:os';

// The machine's IPv4 LAN addresses, as the container sees them.
export function hostAddresses(interfaces = networkInterfaces()) {
  return Object.values(interfaces).flat()
    .filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal)
    .map((i) => i.address);
}

// Docker's default bridge networks (172.16.0.0/12): a container with only such addresses is not on
// host networking.
const inDockerBridgeRange = (address) => {
  const [a, b] = address.split('.').map(Number);
  return a === 172 && b >= 16 && b <= 31;
};

// Why ONVIF can't work at all, or null. It needs host networking: each camera listens on its own
// LAN address, which a container on Docker's bridge doesn't have (mapping ports doesn't help).
// Says so only when it's clear: none of the cameras' addresses are here, and the container has
// nothing but bridge addresses. Otherwise each camera explains its own address.
export function onvifNetworkProblem(cameraAddresses, addresses = hostAddresses()) {
  if (!cameraAddresses.length || cameraAddresses.some((a) => addresses.includes(a))) return null;
  if (!addresses.every(inDockerBridgeRange)) return null;
  return `ONVIF needs host networking, and this container is on a Docker bridge network`
    + ` (${addresses.length ? `its address: ${addresses.join(', ')}` : 'no LAN address'}): it can't listen on the cameras' own`
    + ' addresses. Switch the container\'s network to "host"'
    + ' (Synology Container Manager: stop the container, Edit, Network: host; Docker Compose: network_mode: host).'
    + ' Port mappings aren\'t needed then: every port is on the NAS directly';
}

// error: from listen. where: { address, port, addresses (the machine's) }.
export function explainNetworkError(error, { address, port, addresses = hostAddresses() }) {
  if (error.code === 'ENODEV' || error.code === 'EADDRNOTAVAIL') {
    if (addresses.length && addresses.every(inDockerBridgeRange)) {
      return `${address} is not an address of this container: it is on a Docker bridge network (it has ${addresses.join(', ')}). `
        + 'ONVIF needs host networking: switch the container\'s network to "host"';
    }
    const has = addresses.length ? `it has ${addresses.join(', ')}` : 'it has none: is the container on host networking?';
    return `${address} is not an address of this machine (${has}). `
      + 'Give the machine this address (a second network port, or a macvlan address) and run the container with host networking';
  }
  if (error.code === 'EADDRINUSE') {
    return `port ${port} on ${address} is already used by another program: choose another "onvif.port"`;
  }
  return error.message;
}

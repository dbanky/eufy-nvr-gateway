// WS-Discovery: NVRs find ONVIF cameras by multicasting a Probe (UDP 239.255.255.250:3702); each
// camera answers with a ProbeMatch naming its device service. UniFi Protect tells cameras apart by
// the address an answer comes from, so each camera answers from its own IP.

import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { operation, valueOf, xmlEscape as x } from './xml.mjs';
import { baseUrl, scopes } from './device.mjs';
import { explainNetworkError, hostAddresses } from './network.mjs';

const GROUP = '239.255.255.250';
const PORT = 3702;
const RETRY_MS = 30_000;

// The ProbeMatch for this device, or null if the message isn't a probe for a video device.
export function probeMatch(message, device) {
  if (operation(message) !== 'Probe') return null;
  const types = valueOf(message, 'Types') ?? '';
  if (types && !/NetworkVideoTransmitter|\bDevice\b/.test(types)) return null;
  const relatesTo = valueOf(message, 'MessageID') ?? '';
  return '<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
    + 'xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" '
    + 'xmlns:dn="http://www.onvif.org/ver10/network/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">'
    + `<s:Header><wsa:MessageID>uuid:${randomUUID()}</wsa:MessageID><wsa:RelatesTo>${x(relatesTo)}</wsa:RelatesTo>`
    + '<wsa:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:To>'
    + '<wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action></s:Header>'
    + `<s:Body><d:ProbeMatches><d:ProbeMatch><wsa:EndpointReference><wsa:Address>urn:uuid:${device.uuid}</wsa:Address></wsa:EndpointReference>`
    + `<d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types><d:Scopes>${scopes(device).map(x).join(' ')}</d:Scopes>`
    + `<d:XAddrs>${baseUrl(device)}/onvif/device_service</d:XAddrs><d:MetadataVersion>1</d:MetadataVersion>`
    + '</d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>';
}

// Listens for probes and answers for every device, each from its own address.
//
// Per address: join the multicast group on it and bind a socket to answer from. If the machine
// doesn't have the address yet (a second network port whose DHCP lease comes after the container
// started), it is tried again every retryMs, and the web page says why in the meantime.
//
// Returns { state, stop }. state.listening: the shared UDP 3702 listener is up; state.error: why it
// isn't; state.addresses[address]: null when NVRs can find the cameras on it, otherwise why not
// (undefined: not tried yet).
export function startDiscovery(devices, log, { dgram: udp = dgram, retryMs = RETRY_MS, addresses = hostAddresses } = {}) {
  const state = { listening: false, error: null, addresses: {} };
  const wanted = [...new Set(devices.map((d) => d.address))];
  const joined = new Set();      // multicast group joined on these addresses
  const senders = new Map();     // address -> socket bound to it (answers come from the camera's address)
  const binding = new Set();
  const listener = udp.createSocket({ type: 'udp4', reuseAddr: true });

  const report = (address, error) => {
    const why = error ? explainNetworkError(error, { address, port: PORT, udp: true, addresses: addresses() }) : null;
    if (state.addresses[address] === why) return;
    state.addresses[address] = why;
    if (why) log(`ONVIF discovery on ${address}: ${why}. Trying again every ${Math.round(retryMs / 1000)} s.`);
    else log(`ONVIF discovery on ${address}: on`);
  };

  const join = (address) => {
    try {
      if (!joined.has(address)) {
        listener.addMembership(GROUP, address);
        joined.add(address);
      }
    } catch (e) {
      return report(address, e);
    }
    if (senders.has(address) || binding.has(address)) return;
    binding.add(address);
    const sender = udp.createSocket('udp4');
    sender.on('error', (e) => {
      binding.delete(address);
      senders.delete(address);
      sender.close();
      report(address, e);
    });
    sender.bind(0, address, () => {
      binding.delete(address);
      senders.set(address, sender);
      report(address, null);
    });
  };

  listener.on('message', (message, from) => {
    for (const device of devices) {
      const sender = senders.get(device.address);
      const answer = sender && probeMatch(String(message), device);
      if (answer) sender.send(answer, from.port, from.address);
    }
  });
  listener.on('error', (e) => {
    Object.assign(state, { listening: false, error: explainNetworkError(e, { address: '0.0.0.0', port: PORT, udp: true, addresses: addresses() }) });
    log(`ONVIF discovery: ${state.error}`);
  });
  let retry = null;
  listener.bind(PORT, () => {
    Object.assign(state, { listening: true, error: null });
    wanted.forEach(join);
    retry = setInterval(() => wanted.filter((a) => state.addresses[a] !== null).forEach(join), retryMs);
    retry.unref?.();
  });
  const stop = () => {
    clearInterval(retry);
    listener.close();
    for (const sender of senders.values()) sender.close();
  };
  return { state, stop };
}

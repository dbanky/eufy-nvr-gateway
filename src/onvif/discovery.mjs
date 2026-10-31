// WS-Discovery: NVRs find ONVIF cameras by multicasting a Probe (UDP 239.255.255.250:3702); each
// camera answers with a ProbeMatch naming its device service. UniFi Protect tells cameras apart by
// the address an answer comes from, so each camera answers from its own IP.

import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { operation, valueOf, xmlEscape as x } from './xml.mjs';
import { baseUrl, scopes } from './device.mjs';

const GROUP = '239.255.255.250';
const PORT = 3702;

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
// Returns { state, stop }: state.listening / state.error say whether NVRs can find the devices.
export function startDiscovery(devices, log) {
  const state = { listening: false, error: null };
  const listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const senders = new Map();   // device -> socket bound to its address
  for (const device of devices) {
    const sender = dgram.createSocket('udp4');
    sender.on('error', (e) => log(device.name, `ONVIF discovery can't send from ${device.address}: ${e.message}`));
    sender.bind(0, device.address);
    senders.set(device, sender);
  }
  listener.on('message', (message, from) => {
    for (const [device, sender] of senders) {
      const answer = probeMatch(String(message), device);
      if (answer) sender.send(answer, from.port, from.address);
    }
  });
  listener.on('error', (e) => {
    Object.assign(state, { listening: false, error: e.message });
    log(`ONVIF discovery: ${e.message}`);
  });
  listener.bind(PORT, () => {
    const problems = [];
    for (const address of new Set(devices.map((d) => d.address))) {
      try {
        listener.addMembership(GROUP, address);
      } catch (e) {
        problems.push(`${address}: ${e.message}`);
        log(`ONVIF discovery: can't listen on ${address}: ${e.message}`);
      }
    }
    Object.assign(state, { listening: true, error: problems.join('; ') || null });
  });
  const stop = () => {
    listener.close();
    for (const sender of senders.values()) sender.close();
  };
  return { state, stop };
}

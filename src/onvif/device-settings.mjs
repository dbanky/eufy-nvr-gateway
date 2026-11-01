// What an NVR may change on a camera's ONVIF device (Profile S requires the Set operations): host
// name, DNS, NTP, default gateway, date and time, scopes. They live in memory and start from
// config.json at every start, like a camera after SetSystemFactoryDefault.
//
// They describe the virtual device only: the gateway's own network and clock never change. The
// device's address and ports are not here: they come from config.json and can't be changed over ONVIF.

import { OnvifFault } from './xml.mjs';

export const MAX_SCOPES = 20;
const HOSTNAME = /^(?=.{1,63}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:.]+$/;
// POSIX TZ ("UTC0", "GMT0BST,M3.5.0/1,M10.5.0", "<+01>-1"), which is what ONVIF uses.
const POSIX_TZ = /^(?:[A-Za-z]{3,}|<[A-Za-z0-9+-]{1,}>)[+-]?\d{1,2}(?::\d{2}){0,2}(?:(?:[A-Za-z]{3,}|<[A-Za-z0-9+-]{1,}>)(?:[+-]?\d{1,2}(?::\d{2}){0,2})?(?:,[MJ]?[\d.]+(?:\/[+-]?\d{1,3}(?::\d{2}){0,2})?,[MJ]?[\d.]+(?:\/[+-]?\d{1,3}(?::\d{2}){0,2})?)?)?$/;

// A hostname from the camera name: letters, digits and dashes.
export const hostnameFor = (name) => String(name).replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'camera';

export class DeviceSettings {
  constructor(device, now = Date.now) {
    Object.assign(this, { device, now });
    this.reset();
  }

  reset() {
    this.hostname = hostnameFor(this.device.name);
    this.dns = { fromDhcp: false, searchDomains: [], servers: [] };   // servers: [{ type: 'IPv4' | 'IPv6', address }]
    this.ntp = { fromDhcp: false, servers: [] };                       // [{ type: 'IPv4' | 'IPv6' | 'DNS', address }]
    this.gateways = [];                                                // IPv4 addresses
    this.time = { type: 'NTP', daylightSavings: false, timeZone: 'UTC0', offsetMs: 0 };
    this.scopes = [];                                                  // the configurable ones
  }

  // The device's clock: the gateway's, moved by a manual SetSystemDateAndTime.
  clock() {
    return this.now() + this.time.offsetMs;
  }

  setHostname(name, fromDhcp = false) {
    if (fromDhcp) throw new OnvifFault('ter:InvalidArgVal/ter:InvalidHostname', 'the device has no DHCP: its address is set in config.json');
    if (!HOSTNAME.test(name ?? '')) throw new OnvifFault('ter:InvalidArgVal/ter:InvalidHostname', `"${name}" is not a valid host name`);
    this.hostname = name;
  }

  setDns({ fromDhcp, searchDomains, servers }) {
    if (fromDhcp) throw new OnvifFault('ter:InvalidArgVal/ter:InvalidIPv4Address', 'the device has no DHCP: set DNS servers by hand');
    this.dns = { fromDhcp: false, searchDomains, servers: servers.map(checkAddress) };
  }

  setNtp({ fromDhcp, servers }) {
    if (fromDhcp) throw new OnvifFault('ter:InvalidArgVal/ter:InvalidIPv4Address', 'the device has no DHCP: set NTP servers by hand');
    for (const s of servers) {
      if (s.type === 'DNS' && !/^[A-Za-z0-9.-]{1,253}$/.test(s.address)) throw new OnvifFault('ter:InvalidArgVal/ter:InvalidDnsName', `"${s.address}" is not a valid name`);
      if (s.type !== 'DNS') checkAddress(s);
    }
    this.ntp = { fromDhcp: false, servers };
  }

  setGateways(addresses) {
    for (const address of addresses) checkAddress({ type: 'IPv4', address });
    this.gateways = addresses;
  }

  // type 'Manual' with utc (ms), or 'NTP'. timeZone: POSIX TZ, or null to keep it.
  setDateTime({ type, daylightSavings, timeZone, utc }) {
    if (timeZone != null && !POSIX_TZ.test(timeZone)) throw new OnvifFault('ter:InvalidArgVal/ter:InvalidTimeZone', `"${timeZone}" is not a POSIX time zone`);
    if (type === 'Manual' && (utc == null || Number.isNaN(utc))) throw new OnvifFault('ter:InvalidArgVal/ter:InvalidDateTime', 'Manual needs a valid UTCDateTime');
    if (type !== 'Manual' && type !== 'NTP') throw new OnvifFault('ter:InvalidArgVal', `DateTimeType "${type}" is not Manual or NTP`);
    this.time = {
      type, daylightSavings: !!daylightSavings, timeZone: timeZone ?? this.time.timeZone,
      offsetMs: type === 'Manual' ? utc - this.now() : 0,
    };
  }

  // Scopes the device always has (from config.json, and what it is).
  fixedScopes() {
    const d = this.device;
    return [
      'onvif://www.onvif.org/type/video_encoder',
      'onvif://www.onvif.org/type/Network_Video_Transmitter',
      // Profile S has no H.265: a camera whose own H.265 is passed through doesn't claim it.
      ...(d.codec?.() !== 'hevc' ? ['onvif://www.onvif.org/Profile/Streaming'] : []),
      ...(d.audio?.() ? ['onvif://www.onvif.org/type/audio_encoder'] : []),
      `onvif://www.onvif.org/name/${encodeURIComponent(d.name)}`,
      `onvif://www.onvif.org/hardware/${encodeURIComponent(d.model)}`,
    ];
  }

  setScopes(items) {
    if (items.length > MAX_SCOPES) throw new OnvifFault('ter:Action/ter:TooManyScopes', `at most ${MAX_SCOPES} scopes`);
    const fixed = new Set(this.fixedScopes());
    this.scopes = unique(items.filter((s) => !fixed.has(s)));
  }

  addScopes(items) {
    const next = unique([...this.scopes, ...items.filter((s) => !this.fixedScopes().includes(s))]);
    if (next.length > MAX_SCOPES) throw new OnvifFault('ter:Action/ter:TooManyScopes', `at most ${MAX_SCOPES} scopes`);
    this.scopes = next;
  }

  removeScopes(items) {
    const fixed = this.fixedScopes();
    const isFixed = items.find((s) => fixed.includes(s));
    if (isFixed) throw new OnvifFault('ter:OperationProhibited/ter:FixedScope', `${isFixed} is a fixed scope`);
    const missing = items.find((s) => !this.scopes.includes(s));
    if (missing) throw new OnvifFault('ter:InvalidArgVal/ter:NoScope', `${missing} is not a scope of this device`);
    this.scopes = this.scopes.filter((s) => !items.includes(s));
    return items;
  }
}

const unique = (list) => [...new Set(list)];

function checkAddress(server) {
  const ok = server.type === 'IPv6' ? IPV6.test(server.address ?? '') : IPV4.test(server.address ?? '');
  if (!ok) throw new OnvifFault(`ter:InvalidArgVal/ter:Invalid${server.type === 'IPv6' ? 'IPv6' : 'IPv4'}Address`, `"${server.address}" is not a valid address`);
  return server;
}

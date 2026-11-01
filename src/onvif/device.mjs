// The ONVIF device service: who the camera is, its clock, network settings, scopes and users, and
// where its other services are. Everything Profile S requires of it, except WS-Discovery itself:
// NVRs add the cameras by address (the gateway's choice, see index.mjs).
//
// deviceResponse(op, xml, { device, settings, credentials, onReboot }) -> response body, or null for
// operations it doesn't support. Throws OnvifFault for requests it refuses.
//
// device: { name, serial, manufacturer, model, firmware, uuid, mac, address, port, rtspPort, … } (index.mjs)
// settings: DeviceSettings (device-settings.mjs)

import { xmlEscape as x, valueOf, valuesOf, elementsOf, OnvifFault } from './xml.mjs';
import { mediaCapabilities } from './media.mjs';
import { media2Capabilities } from './media2.mjs';
import { eventCapabilities } from './events.mjs';

export const baseUrl = (device) => `http://${device.address}:${device.port}`;
const PREFIX_LENGTH = 24;

function dateTime(t) {
  const d = new Date(t);
  return `<tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time>`
    + `<tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date>`;
}

const version = (major, minor) => `<tds:Version><tt:Major>${major}</tt:Major><tt:Minor>${minor}</tt:Minor></tds:Version>`;

const deviceCapabilities = () => '<tds:Capabilities><tds:Network IPFilter="false" ZeroConfiguration="false" IPVersion6="false" DynDNS="false" '
  + 'HostnameFromDHCP="false" NTP="1"/><tds:Security TLS1.0="false" TLS1.1="false" TLS1.2="false" OnboardKeyGeneration="false" '
  + 'AccessPolicyConfig="false" DefaultAccessPolicy="false" Dot1X="false" RemoteUserHandling="false" X.509Token="false" SAMLToken="false" '
  + 'KerberosToken="false" UsernameToken="true" HttpDigest="true" RELToken="false" MaxUsers="1"/>'
  + '<tds:System DiscoveryResolve="false" DiscoveryBye="false" RemoteDiscovery="false" SystemBackup="false" SystemLogging="false" '
  + 'FirmwareUpgrade="false" HttpFirmwareUpgrade="false" HttpSystemBackup="false" HttpSystemLogging="false" HttpSupportInformation="false"/>'
  + '</tds:Capabilities>';

// [namespace, path, version, capabilities] of each service.
// Media2 is listed only for a camera that streams H.265: clients that see it use it for everything
// (the npm "onvif" library, UniFi Protect's client, does), and only Media2 can describe H.265.
// H.264 cameras stay on Media ver10, the Profile S service.
function services(device) {
  const list = [
    ['http://www.onvif.org/ver10/device/wsdl', 'device_service', version(2, 5), deviceCapabilities()],
    ['http://www.onvif.org/ver10/media/wsdl', 'media_service', version(2, 5), mediaCapabilities()],
    ...(device.codec?.() === 'hevc' ? [['http://www.onvif.org/ver20/media/wsdl', 'media2_service', version(2, 5), media2Capabilities()]] : []),
    ['http://www.onvif.org/ver10/events/wsdl', 'events_service', version(2, 5), eventCapabilities()],
  ];
  return list.map(([namespace, path, v, capabilities]) => ({ namespace, xaddr: `${baseUrl(device)}/onvif/${path}`, version: v, capabilities }));
}

// GetCapabilities (the older form): one section per category.
function capabilities(device, category) {
  const base = baseUrl(device);
  const sections = {
    Device: `<tt:Device><tt:XAddr>${base}/onvif/device_service</tt:XAddr>`
      + '<tt:Network><tt:IPFilter>false</tt:IPFilter><tt:ZeroConfiguration>false</tt:ZeroConfiguration><tt:IPVersion6>false</tt:IPVersion6><tt:DynDNS>false</tt:DynDNS></tt:Network>'
      + '<tt:System><tt:DiscoveryResolve>false</tt:DiscoveryResolve><tt:DiscoveryBye>false</tt:DiscoveryBye><tt:RemoteDiscovery>false</tt:RemoteDiscovery>'
      + '<tt:SystemBackup>false</tt:SystemBackup><tt:SystemLogging>false</tt:SystemLogging><tt:FirmwareUpgrade>false</tt:FirmwareUpgrade>'
      + '<tt:SupportedVersions><tt:Major>2</tt:Major><tt:Minor>5</tt:Minor></tt:SupportedVersions></tt:System>'
      + '<tt:IO><tt:InputConnectors>0</tt:InputConnectors><tt:RelayOutputs>0</tt:RelayOutputs></tt:IO>'
      + '<tt:Security><tt:TLS1.1>false</tt:TLS1.1><tt:TLS1.2>false</tt:TLS1.2><tt:OnboardKeyGeneration>false</tt:OnboardKeyGeneration>'
      + '<tt:AccessPolicyConfig>false</tt:AccessPolicyConfig><tt:X.509Token>false</tt:X.509Token><tt:SAMLToken>false</tt:SAMLToken>'
      + '<tt:KerberosToken>false</tt:KerberosToken><tt:RELToken>false</tt:RELToken></tt:Security></tt:Device>',
    Events: `<tt:Events><tt:XAddr>${base}/onvif/events_service</tt:XAddr><tt:WSSubscriptionPolicySupport>false</tt:WSSubscriptionPolicySupport>`
      + '<tt:WSPullPointSupport>true</tt:WSPullPointSupport><tt:WSPausableSubscriptionManagerInterfaceSupport>false</tt:WSPausableSubscriptionManagerInterfaceSupport></tt:Events>',
    Media: `<tt:Media><tt:XAddr>${base}/onvif/media_service</tt:XAddr><tt:StreamingCapabilities><tt:RTPMulticast>false</tt:RTPMulticast>`
      + '<tt:RTP_TCP>false</tt:RTP_TCP><tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP></tt:StreamingCapabilities>'
      + '<tt:Extension><tt:ProfileCapabilities><tt:MaximumNumberOfProfiles>4</tt:MaximumNumberOfProfiles></tt:ProfileCapabilities></tt:Extension></tt:Media>',
  };
  const wanted = category && category !== 'All' ? [category] : ['Device', 'Events', 'Media'];
  const missing = wanted.find((c) => !sections[c]);
  if (missing) throw new OnvifFault('ter:ActionNotSupported/ter:NoSuchService', `this device has no ${missing} service`);
  // Analytics, Device, Events, Imaging, Media, PTZ: the schema's order.
  return wanted.map((c) => sections[c]).join('');
}

const addressXml = ({ type, address }) => (type === 'DNS' ? `<tt:Type>DNS</tt:Type><tt:DNSname>${x(address)}</tt:DNSname>`
  : `<tt:Type>${type}</tt:Type><tt:${type}Address>${x(address)}</tt:${type}Address>`);

// <tt:Type>IPv4</tt:Type><tt:IPv4Address>…</tt:IPv4Address> blocks of a request.
const readAddresses = (blocks) => blocks.map((b) => {
  const type = valueOf(b, 'Type') ?? 'IPv4';
  return { type, address: type === 'DNS' ? valueOf(b, 'DNSname') : valueOf(b, `${type}Address`) };
});

const bool = (v) => v === 'true' || v === '1';

export function deviceResponse(op, xml, { device, settings, credentials = null, onReboot = () => {} }) {
  const r = (body = '') => `<tds:${op}Response>${body}</tds:${op}Response>`;
  switch (op) {
    // ---- capabilities and services ----
    case 'GetServices': {
      const include = bool(valueOf(xml, 'IncludeCapability'));
      return r(services(device).map((s) => `<tds:Service><tds:Namespace>${s.namespace}</tds:Namespace><tds:XAddr>${s.xaddr}</tds:XAddr>`
        + (include ? `<tds:Capabilities>${s.capabilities}</tds:Capabilities>` : '') + `${s.version}</tds:Service>`).join(''));
    }
    case 'GetServiceCapabilities': return r(deviceCapabilities());
    case 'GetCapabilities': return r(`<tds:Capabilities>${capabilities(device, valuesOf(xml, 'Category')[0])}</tds:Capabilities>`);
    case 'GetWsdlUrl': return r('<tds:WsdlUrl>https://www.onvif.org/profiles/specifications/</tds:WsdlUrl>');

    // ---- system ----
    case 'GetDeviceInformation':
      return r(`<tds:Manufacturer>${x(device.manufacturer)}</tds:Manufacturer><tds:Model>${x(device.model)}</tds:Model>`
        + `<tds:FirmwareVersion>${x(device.firmware)}</tds:FirmwareVersion><tds:SerialNumber>${x(device.serial)}</tds:SerialNumber>`
        + `<tds:HardwareId>${x(device.model)}</tds:HardwareId>`);
    case 'GetSystemDateAndTime': {
      const t = settings.time;
      return r(`<tds:SystemDateAndTime><tt:DateTimeType>${t.type}</tt:DateTimeType><tt:DaylightSavings>${t.daylightSavings}</tt:DaylightSavings>`
        + `<tt:TimeZone><tt:TZ>${x(t.timeZone)}</tt:TZ></tt:TimeZone><tt:UTCDateTime>${dateTime(settings.clock())}</tt:UTCDateTime></tds:SystemDateAndTime>`);
    }
    case 'SetSystemDateAndTime': {
      const utc = elementsOf(xml, 'UTCDateTime')[0];
      const n = (name) => Number(valueOf(utc, name));
      settings.setDateTime({
        type: valueOf(xml, 'DateTimeType'), daylightSavings: bool(valueOf(xml, 'DaylightSavings')), timeZone: valueOf(xml, 'TZ'),
        utc: utc == null ? null : Date.UTC(n('Year'), n('Month') - 1, n('Day'), n('Hour'), n('Minute'), n('Second')),
      });
      return r();
    }
    case 'SetSystemFactoryDefault':
      settings.reset();
      onReboot('factory default');
      return r();
    case 'SystemReboot':
      onReboot('reboot');
      return r('<tds:Message>The camera\'s ONVIF device restarted; the stream keeps running.</tds:Message>');

    // ---- network ----
    case 'GetHostname':
      return r(`<tds:HostnameInformation><tt:FromDHCP>false</tt:FromDHCP><tt:Name>${x(settings.hostname)}</tt:Name></tds:HostnameInformation>`);
    case 'SetHostname':
      settings.setHostname(valueOf(xml, 'Name'));
      return r();
    case 'SetHostnameFromDHCP':
      settings.setHostname(null, bool(valueOf(xml, 'FromDHCP')));
      return r('<tds:RebootNeeded>false</tds:RebootNeeded>');
    case 'GetDNS': {
      const dns = settings.dns;
      return r(`<tds:DNSInformation><tt:FromDHCP>false</tt:FromDHCP>${dns.searchDomains.map((s) => `<tt:SearchDomain>${x(s)}</tt:SearchDomain>`).join('')}`
        + `${dns.servers.map((s) => `<tt:DNSManual>${addressXml(s)}</tt:DNSManual>`).join('')}</tds:DNSInformation>`);
    }
    case 'SetDNS':
      settings.setDns({ fromDhcp: bool(valueOf(xml, 'FromDHCP')), searchDomains: valuesOf(xml, 'SearchDomain'), servers: readAddresses(elementsOf(xml, 'DNSManual')) });
      return r();
    case 'GetNTP': {
      const ntp = settings.ntp;
      return r(`<tds:NTPInformation><tt:FromDHCP>false</tt:FromDHCP>${ntp.servers.map((s) => `<tt:NTPManual>${addressXml(s)}</tt:NTPManual>`).join('')}</tds:NTPInformation>`);
    }
    case 'SetNTP':
      settings.setNtp({ fromDhcp: bool(valueOf(xml, 'FromDHCP')), servers: readAddresses(elementsOf(xml, 'NTPManual')) });
      return r();
    case 'GetNetworkDefaultGateway':
      return r(`<tds:NetworkGateway>${settings.gateways.map((a) => `<tt:IPv4Address>${x(a)}</tt:IPv4Address>`).join('')}</tds:NetworkGateway>`);
    case 'SetNetworkDefaultGateway':
      settings.setGateways(valuesOf(xml, 'IPv4Address'));
      return r();
    case 'GetNetworkInterfaces':
      return r('<tds:NetworkInterfaces token="eth0"><tt:Enabled>true</tt:Enabled>'
        + `<tt:Info><tt:Name>eth0</tt:Name><tt:HwAddress>${x(device.mac ?? '')}</tt:HwAddress><tt:MTU>1500</tt:MTU></tt:Info>`
        + `<tt:IPv4><tt:Enabled>true</tt:Enabled><tt:Config><tt:Manual><tt:Address>${x(device.address)}</tt:Address><tt:PrefixLength>${PREFIX_LENGTH}</tt:PrefixLength></tt:Manual>`
        + '<tt:DHCP>false</tt:DHCP></tt:Config></tt:IPv4></tds:NetworkInterfaces>');
    case 'SetNetworkInterfaces':
      checkNetworkInterface(xml, device);
      return r('<tds:RebootNeeded>false</tds:RebootNeeded>');
    case 'GetNetworkProtocols':
      return r(protocols(device).map((p) => `<tds:NetworkProtocols><tt:Name>${p.name}</tt:Name><tt:Enabled>true</tt:Enabled><tt:Port>${p.port}</tt:Port></tds:NetworkProtocols>`).join(''));
    case 'SetNetworkProtocols':
      checkProtocols(xml, device);
      return r();
    case 'GetDiscoveryMode': return r('<tds:DiscoveryMode>NonDiscoverable</tds:DiscoveryMode>');
    case 'SetDiscoveryMode':
      if (valueOf(xml, 'DiscoveryMode') !== 'NonDiscoverable') {
        throw new OnvifFault('ter:InvalidArgVal', 'this gateway has no WS-Discovery: add the camera to the NVR by its address');
      }
      return r();

    // ---- scopes ----
    case 'GetScopes': {
      const scope = (def, item) => `<tds:Scopes><tt:ScopeDef>${def}</tt:ScopeDef><tt:ScopeItem>${x(item)}</tt:ScopeItem></tds:Scopes>`;
      return r([...settings.fixedScopes().map((s) => scope('Fixed', s)), ...settings.scopes.map((s) => scope('Configurable', s))].join(''));
    }
    case 'SetScopes':
      settings.setScopes(valuesOf(xml, 'Scopes'));
      return r();
    case 'AddScopes':
      settings.addScopes(valuesOf(xml, 'ScopeItem'));
      return r();
    case 'RemoveScopes':
      return r(settings.removeScopes(valuesOf(xml, 'ScopeItem')).map((s) => `<tds:ScopeItem>${x(s)}</tds:ScopeItem>`).join(''));

    // ---- users: the one login from config.json ----
    case 'GetUsers':
      return r(credentials ? `<tds:User><tt:Username>${x(credentials.username)}</tt:Username><tt:UserLevel>Administrator</tt:UserLevel></tds:User>` : '');
    case 'CreateUsers':
      throw new OnvifFault('ter:Action/ter:TooManyUsers', 'the device has one login, set in config.json ("rtsp.username" / "rtsp.password")');
    case 'DeleteUsers':
    case 'SetUser': {
      const name = valuesOf(xml, 'Username')[0];
      if (credentials && name === credentials.username) {
        throw new OnvifFault('ter:InvalidArgVal/ter:FixedUser', 'the login is set in config.json ("rtsp.username" / "rtsp.password")');
      }
      throw new OnvifFault('ter:InvalidArgVal/ter:UsernameMissing', `no user "${name}"`);
    }

    case 'GetRelayOutputs': return r();
    default: return null;
  }
}

const protocols = (device) => [{ name: 'HTTP', port: device.port }, { name: 'RTSP', port: device.rtspPort }];

// The address comes from config.json: a request may only confirm it.
function checkNetworkInterface(xml, device) {
  const token = valueOf(xml, 'InterfaceToken');
  if (token !== 'eth0') throw new OnvifFault('ter:InvalidArgVal/ter:InvalidNetworkInterface', `no network interface "${token}"`);
  const address = valueOf(elementsOf(xml, 'Manual')[0], 'Address');
  const prefix = valueOf(elementsOf(xml, 'Manual')[0], 'PrefixLength');
  const dhcp = valueOf(elementsOf(xml, 'IPv4')[0], 'DHCP');
  if ((address && address !== device.address) || (prefix && Number(prefix) !== PREFIX_LENGTH) || bool(dhcp) || valueOf(xml, 'Enabled') === 'false') {
    throw new OnvifFault('ter:InvalidArgVal/ter:InvalidIPv4Address', 'the camera\'s address is set in config.json ("onvif.address")');
  }
}

function checkProtocols(xml, device) {
  for (const block of elementsOf(xml, 'NetworkProtocols')) {
    const name = valueOf(block, 'Name');
    const known = protocols(device).find((p) => p.name === name);
    if (!known) throw new OnvifFault('ter:InvalidArgVal/ter:ServiceNotSupported', `${name} is not available`);
    const port = valuesOf(block, 'Port');
    if (valueOf(block, 'Enabled') === 'false' || port.some((p) => Number(p) !== known.port)) {
      throw new OnvifFault('ter:InvalidArgVal/ter:PortAlreadyInUse', `${name} stays on port ${known.port}: ports are set in config.json`);
    }
  }
}

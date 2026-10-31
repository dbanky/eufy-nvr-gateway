// The ONVIF device service: who the camera is, what time it is, where its other services are.
// Pure: operation + device -> response body, or null for operations it doesn't support.
//
// device: { name, serial, manufacturer, model, firmware, uuid, mac, address, port, … } (index.mjs)

import { xmlEscape as x } from './xml.mjs';

export const baseUrl = (device) => `http://${device.address}:${device.port}`;
const version = '<tds:Version><tt:Major>2</tt:Major><tt:Minor>5</tt:Minor></tds:Version>';

function dateTime(t) {
  const d = new Date(t);
  return `<tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time>`
    + `<tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date>`;
}

const scope = (item) => `<tds:Scopes><tt:ScopeDef>Fixed</tt:ScopeDef><tt:ScopeItem>${x(item)}</tt:ScopeItem></tds:Scopes>`;
export const scopes = (device) => [
  'onvif://www.onvif.org/type/video_encoder',
  'onvif://www.onvif.org/type/Network_Video_Transmitter',
  'onvif://www.onvif.org/Profile/Streaming',
  'onvif://www.onvif.org/Profile/T',
  `onvif://www.onvif.org/name/${encodeURIComponent(device.name)}`,
  `onvif://www.onvif.org/hardware/${encodeURIComponent(device.model)}`,
];

export function deviceResponse(op, device, now = Date.now()) {
  const base = baseUrl(device);
  switch (op) {
    case 'GetSystemDateAndTime':
      return '<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType>'
        + '<tt:DaylightSavings>false</tt:DaylightSavings><tt:TimeZone><tt:TZ>UTC0</tt:TZ></tt:TimeZone>'
        + `<tt:UTCDateTime>${dateTime(now)}</tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`;
    case 'GetServices':
      return '<tds:GetServicesResponse>'
        + ['device', 'media', 'events'].map((s) => `<tds:Service><tds:Namespace>http://www.onvif.org/ver10/${s}/wsdl</tds:Namespace>`
          + `<tds:XAddr>${base}/onvif/${s}_service</tds:XAddr>${version}</tds:Service>`).join('')
        + '</tds:GetServicesResponse>';
    case 'GetCapabilities':
      return '<tds:GetCapabilitiesResponse><tds:Capabilities>'
        + `<tt:Device><tt:XAddr>${base}/onvif/device_service</tt:XAddr></tt:Device>`
        + `<tt:Events><tt:XAddr>${base}/onvif/events_service</tt:XAddr><tt:WSSubscriptionPolicySupport>false</tt:WSSubscriptionPolicySupport>`
        + '<tt:WSPullPointSupport>true</tt:WSPullPointSupport><tt:WSPausableSubscriptionManagerInterfaceSupport>false</tt:WSPausableSubscriptionManagerInterfaceSupport></tt:Events>'
        + `<tt:Media><tt:XAddr>${base}/onvif/media_service</tt:XAddr><tt:StreamingCapabilities><tt:RTPMulticast>false</tt:RTPMulticast>`
        + '<tt:RTP_TCP>false</tt:RTP_TCP><tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP></tt:StreamingCapabilities></tt:Media>'
        + '</tds:Capabilities></tds:GetCapabilitiesResponse>';
    case 'GetServiceCapabilities':
      return '<tds:GetServiceCapabilitiesResponse><tds:Capabilities><tds:Network IPFilter="false" ZeroConfiguration="false" IPVersion6="false" DynDNS="false"/>'
        + '<tds:Security UsernameToken="true" HttpDigest="false"/><tds:System DiscoveryResolve="true" DiscoveryBye="false" RemoteDiscovery="false" SystemBackup="false" SystemLogging="false" FirmwareUpgrade="false"/>'
        + '</tds:Capabilities></tds:GetServiceCapabilitiesResponse>';
    case 'GetDeviceInformation':
      return `<tds:GetDeviceInformationResponse><tds:Manufacturer>${x(device.manufacturer)}</tds:Manufacturer><tds:Model>${x(device.model)}</tds:Model>`
        + `<tds:FirmwareVersion>${x(device.firmware)}</tds:FirmwareVersion><tds:SerialNumber>${x(device.serial)}</tds:SerialNumber>`
        + `<tds:HardwareId>${x(device.model)}</tds:HardwareId></tds:GetDeviceInformationResponse>`;
    case 'GetScopes':
      return `<tds:GetScopesResponse>${scopes(device).map(scope).join('')}</tds:GetScopesResponse>`;
    case 'GetNetworkInterfaces':
      return '<tds:GetNetworkInterfacesResponse><tds:NetworkInterfaces token="eth0"><tt:Enabled>true</tt:Enabled>'
        + `<tt:Info><tt:Name>eth0</tt:Name><tt:HwAddress>${x(device.mac ?? '')}</tt:HwAddress><tt:MTU>1500</tt:MTU></tt:Info>`
        + `<tt:IPv4><tt:Enabled>true</tt:Enabled><tt:Config><tt:Manual><tt:Address>${x(device.address)}</tt:Address><tt:PrefixLength>24</tt:PrefixLength></tt:Manual>`
        + '<tt:DHCP>false</tt:DHCP></tt:Config></tt:IPv4></tds:NetworkInterfaces></tds:GetNetworkInterfacesResponse>';
    case 'GetHostname':
      return `<tds:GetHostnameResponse><tds:HostnameInformation><tt:FromDHCP>false</tt:FromDHCP><tt:Name>${x(device.name)}</tt:Name></tds:HostnameInformation></tds:GetHostnameResponse>`;
    case 'GetNetworkProtocols':
      return `<tds:GetNetworkProtocolsResponse><tds:NetworkProtocols><tt:Name>HTTP</tt:Name><tt:Enabled>true</tt:Enabled><tt:Port>${device.port}</tt:Port></tds:NetworkProtocols>`
        + `<tds:NetworkProtocols><tt:Name>RTSP</tt:Name><tt:Enabled>true</tt:Enabled><tt:Port>${new URL(device.rtspUrl).port}</tt:Port></tds:NetworkProtocols></tds:GetNetworkProtocolsResponse>`;
    case 'GetDNS': return '<tds:GetDNSResponse><tds:DNSInformation><tt:FromDHCP>false</tt:FromDHCP></tds:DNSInformation></tds:GetDNSResponse>';
    case 'GetNTP': return '<tds:GetNTPResponse><tds:NTPInformation><tt:FromDHCP>false</tt:FromDHCP></tds:NTPInformation></tds:GetNTPResponse>';
    case 'GetNetworkDefaultGateway': return '<tds:GetNetworkDefaultGatewayResponse><tds:NetworkGateway/></tds:GetNetworkDefaultGatewayResponse>';
    case 'GetDiscoveryMode': return '<tds:GetDiscoveryModeResponse><tds:DiscoveryMode>Discoverable</tds:DiscoveryMode></tds:GetDiscoveryModeResponse>';
    case 'GetRelayOutputs': return '<tds:GetRelayOutputsResponse/>';
    case 'GetUsers': return '<tds:GetUsersResponse/>';
    default: return null;
  }
}

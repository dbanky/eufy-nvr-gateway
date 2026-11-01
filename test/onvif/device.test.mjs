import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deviceResponse } from '../../src/onvif/device.mjs';
import { DeviceSettings } from '../../src/onvif/device-settings.mjs';
import { device, body } from './fixtures.mjs';

const NOW = Date.parse('2026-10-31T12:34:56Z');
function service(over = {}, { credentials = { username: 'protect', password: 'secret' } } = {}) {
  const d = device(over);
  const settings = new DeviceSettings(d, () => NOW);
  const restarts = [];
  const call = (op, inner = '') => deviceResponse(op, body(op, inner), { device: d, settings, credentials, onReboot: (why) => restarts.push(why) });
  return { call, settings, restarts };
}
const faultOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  assert.fail('expected a fault');
};

describe('the device service: capabilities and services', () => {
  test('lists device, media and events services at the camera\'s own address', () => {
    const xml = service().call('GetServices', '<IncludeCapability>false</IncludeCapability>');
    for (const s of ['ver10/device', 'ver10/media', 'ver10/events']) assert.match(xml, new RegExp(`${s}/wsdl`));
    assert.match(xml, /http:\/\/192\.168\.1\.51:8000\/onvif\/device_service/);
    assert.doesNotMatch(xml, /<tds:Capabilities>/);
  });

  test('Media2 only for a camera that streams H.265: clients that see it use it for everything', () => {
    assert.doesNotMatch(service().call('GetServices'), /ver20\/media/);
    assert.match(service({ codec: () => 'hevc' }).call('GetServices'), /<tds:Namespace>http:\/\/www\.onvif\.org\/ver20\/media\/wsdl<\/tds:Namespace><tds:XAddr>http:\/\/192\.168\.1\.51:8000\/onvif\/media2_service/);
  });

  test('with IncludeCapability, each service carries its capabilities', () => {
    const xml = service().call('GetServices', '<IncludeCapability>true</IncludeCapability>');
    assert.match(xml, /<tds:Capabilities><tds:Capabilities><tds:Network /);
    assert.match(xml, /<tds:Capabilities><trt:Capabilities SnapshotUri="true"/);
    assert.match(xml, /<tds:Capabilities><tev:Capabilities WSSubscriptionPolicySupport="false" WSPullPointSupport="true"/);
  });

  test('GetCapabilities: RTSP over TCP, no multicast, where media and events are; one category at a time too', () => {
    const { call } = service();
    const all = call('GetCapabilities', '<Category>All</Category>');
    assert.match(all, /<tt:RTP_RTSP_TCP>true<\/tt:RTP_RTSP_TCP>/);
    assert.match(all, /<tt:Events><tt:XAddr>http:\/\/192\.168\.1\.51:8000\/onvif\/events_service/);
    const media = call('GetCapabilities', '<Category>Media</Category>');
    assert.match(media, /<tt:Media>/);
    assert.doesNotMatch(media, /<tt:Device>/);
    assert.equal(faultOf(() => call('GetCapabilities', '<Category>PTZ</Category>')), 'ter:ActionNotSupported/ter:NoSuchService');
  });

  test('one user at most: the login from config.json', () => {
    assert.match(service().call('GetServiceCapabilities'), /MaxUsers="1"/);
  });

  test('a WSDL URL', () => {
    assert.match(service().call('GetWsdlUrl'), /<tds:WsdlUrl>https:\/\/www\.onvif\.org\//);
  });
});

describe('the device service: system', () => {
  test('identity: manufacturer, model, and the camera serial (unique per camera)', () => {
    const xml = service().call('GetDeviceInformation');
    assert.match(xml, /<tds:Manufacturer>eufy<\/tds:Manufacturer>/);
    assert.match(xml, /<tds:Model>T8170<\/tds:Model>/);
    assert.match(xml, /<tds:SerialNumber>T81XXXXXXXXXXXXX<\/tds:SerialNumber>/);
  });

  test('tells the time in UTC: clients sign their login with it', () => {
    const xml = service().call('GetSystemDateAndTime');
    assert.match(xml, /<tt:UTCDateTime><tt:Time><tt:Hour>12<\/tt:Hour><tt:Minute>34<\/tt:Minute><tt:Second>56<\/tt:Second>/);
    assert.match(xml, /<tt:Year>2026<\/tt:Year><tt:Month>10<\/tt:Month><tt:Day>31<\/tt:Day>/);
    assert.match(xml, /<tt:DateTimeType>NTP<\/tt:DateTimeType>/);
  });

  test('an NVR can set the time by hand and the time zone; the device\'s clock follows, the gateway\'s doesn\'t', () => {
    const { call, settings } = service();
    call('SetSystemDateAndTime', '<DateTimeType>Manual</DateTimeType><DaylightSavings>true</DaylightSavings><TimeZone><TZ>GMT0BST,M3.5.0/1,M10.5.0</TZ></TimeZone>'
      + '<UTCDateTime><Date><Year>2026</Year><Month>10</Month><Day>31</Day></Date><Time><Hour>13</Hour><Minute>0</Minute><Second>0</Second></Time></UTCDateTime>');
    const xml = call('GetSystemDateAndTime');
    assert.match(xml, /<tt:DateTimeType>Manual<\/tt:DateTimeType><tt:DaylightSavings>true<\/tt:DaylightSavings>/);
    assert.match(xml, /<tt:TZ>GMT0BST,M3\.5\.0\/1,M10\.5\.0<\/tt:TZ>/);
    assert.match(xml, /<tt:Hour>13<\/tt:Hour><tt:Minute>0<\/tt:Minute>/);
    assert.equal(settings.clock() - NOW, Date.parse('2026-10-31T13:00:00Z') - NOW);
  });

  test('a bad time zone or a manual time without a time is refused', () => {
    const { call } = service();
    assert.equal(faultOf(() => call('SetSystemDateAndTime', '<DateTimeType>NTP</DateTimeType><TimeZone><TZ>Not a zone!</TZ></TimeZone>')), 'ter:InvalidArgVal/ter:InvalidTimeZone');
    assert.equal(faultOf(() => call('SetSystemDateAndTime', '<DateTimeType>Manual</DateTimeType>')), 'ter:InvalidArgVal/ter:InvalidDateTime');
  });

  test('reboot and factory default restart the ONVIF device; factory default also forgets what NVRs set', () => {
    const { call, settings, restarts } = service();
    call('SetHostname', '<Name>porch</Name>');
    assert.match(call('SystemReboot'), /<tds:Message>/);
    assert.equal(settings.hostname, 'porch');
    call('SetSystemFactoryDefault', '<FactoryDefault>Soft</FactoryDefault>');
    assert.equal(settings.hostname, 'garden');
    assert.deepEqual(restarts, ['reboot', 'factory default']);
  });
});

describe('the device service: network', () => {
  test('its network interface: the camera\'s own MAC and address', () => {
    const xml = service().call('GetNetworkInterfaces');
    assert.match(xml, /<tt:HwAddress>02:00:00:00:00:01<\/tt:HwAddress>/);
    assert.match(xml, /<tt:Address>192\.168\.1\.51<\/tt:Address>/);
  });

  test('the address can be confirmed but not changed: it is set in config.json', () => {
    const { call } = service();
    const iface = (address) => `<InterfaceToken>eth0</InterfaceToken><NetworkInterface><Enabled>true</Enabled><IPv4><Enabled>true</Enabled><Manual><Address>${address}</Address><PrefixLength>24</PrefixLength></Manual><DHCP>false</DHCP></IPv4></NetworkInterface>`;
    assert.match(call('SetNetworkInterfaces', iface('192.168.1.51')), /<tds:RebootNeeded>false<\/tds:RebootNeeded>/);
    assert.equal(faultOf(() => call('SetNetworkInterfaces', iface('192.168.1.99'))), 'ter:InvalidArgVal/ter:InvalidIPv4Address');
    assert.equal(faultOf(() => call('SetNetworkInterfaces', '<InterfaceToken>wlan0</InterfaceToken>')), 'ter:InvalidArgVal/ter:InvalidNetworkInterface');
  });

  test('protocols: HTTP on the ONVIF port, RTSP on the RTSP port; confirmable, not changeable', () => {
    const { call } = service();
    assert.match(call('GetNetworkProtocols'), /<tt:Name>HTTP<\/tt:Name><tt:Enabled>true<\/tt:Enabled><tt:Port>8000<\/tt:Port>.*<tt:Name>RTSP<\/tt:Name><tt:Enabled>true<\/tt:Enabled><tt:Port>8554<\/tt:Port>/);
    call('SetNetworkProtocols', '<NetworkProtocols><Name>RTSP</Name><Enabled>true</Enabled><Port>8554</Port></NetworkProtocols>');
    assert.equal(faultOf(() => call('SetNetworkProtocols', '<NetworkProtocols><Name>RTSP</Name><Enabled>true</Enabled><Port>554</Port></NetworkProtocols>')), 'ter:InvalidArgVal/ter:PortAlreadyInUse');
    assert.equal(faultOf(() => call('SetNetworkProtocols', '<NetworkProtocols><Name>HTTPS</Name><Enabled>true</Enabled><Port>443</Port></NetworkProtocols>')), 'ter:InvalidArgVal/ter:ServiceNotSupported');
  });

  test('host name, DNS, NTP and default gateway: what an NVR sets is what it reads back', () => {
    const { call } = service();
    assert.match(call('GetHostname'), /<tt:Name>garden<\/tt:Name>/);
    call('SetHostname', '<Name>front-porch</Name>');
    assert.match(call('GetHostname'), /<tt:Name>front-porch<\/tt:Name>/);
    call('SetDNS', '<FromDHCP>false</FromDHCP><SearchDomain>home.arpa</SearchDomain><DNSManual><Type>IPv4</Type><IPv4Address>192.168.1.1</IPv4Address></DNSManual>');
    assert.match(call('GetDNS'), /<tt:SearchDomain>home\.arpa<\/tt:SearchDomain><tt:DNSManual><tt:Type>IPv4<\/tt:Type><tt:IPv4Address>192\.168\.1\.1<\/tt:IPv4Address>/);
    call('SetNTP', '<FromDHCP>false</FromDHCP><NTPManual><Type>DNS</Type><DNSname>pool.ntp.org</DNSname></NTPManual>');
    assert.match(call('GetNTP'), /<tt:NTPManual><tt:Type>DNS<\/tt:Type><tt:DNSname>pool\.ntp\.org<\/tt:DNSname>/);
    call('SetNetworkDefaultGateway', '<IPv4Address>192.168.1.1</IPv4Address>');
    assert.match(call('GetNetworkDefaultGateway'), /<tt:IPv4Address>192\.168\.1\.1<\/tt:IPv4Address>/);
  });

  test('invalid host names and addresses are refused', () => {
    const { call } = service();
    assert.equal(faultOf(() => call('SetHostname', '<Name>not valid!</Name>')), 'ter:InvalidArgVal/ter:InvalidHostname');
    assert.equal(faultOf(() => call('SetDNS', '<FromDHCP>false</FromDHCP><DNSManual><Type>IPv4</Type><IPv4Address>300.1.1.1</IPv4Address></DNSManual>')), 'ter:InvalidArgVal/ter:InvalidIPv4Address');
  });

  test('not discoverable (no WS-Discovery, the gateway\'s choice), and it can\'t be made so', () => {
    const { call } = service();
    assert.match(call('GetDiscoveryMode'), /NonDiscoverable/);
    call('SetDiscoveryMode', '<DiscoveryMode>NonDiscoverable</DiscoveryMode>');
    assert.equal(faultOf(() => call('SetDiscoveryMode', '<DiscoveryMode>Discoverable</DiscoveryMode>')), 'ter:InvalidArgVal');
  });
});

describe('the device service: scopes', () => {
  test('fixed: a Profile S video transmitter with the camera\'s name and model', () => {
    const xml = service().call('GetScopes');
    assert.match(xml, /<tt:ScopeDef>Fixed<\/tt:ScopeDef><tt:ScopeItem>onvif:\/\/www\.onvif\.org\/Profile\/Streaming<\/tt:ScopeItem>/);
    assert.match(xml, /onvif:\/\/www\.onvif\.org\/name\/garden/);
    assert.match(xml, /onvif:\/\/www\.onvif\.org\/hardware\/T8170/);
  });

  test('a camera whose H.265 is passed through doesn\'t claim Profile S (it has no H.265)', () => {
    assert.doesNotMatch(service({ codec: () => 'hevc' }).call('GetScopes'), /Profile\/Streaming/);
  });

  test('configurable scopes can be set, added and removed; fixed ones can\'t be removed', () => {
    const { call } = service();
    call('SetScopes', '<Scopes>onvif://www.onvif.org/location/garden</Scopes>');
    call('AddScopes', '<ScopeItem>onvif://www.onvif.org/location/house</ScopeItem>');
    assert.match(call('GetScopes'), /<tt:ScopeDef>Configurable<\/tt:ScopeDef><tt:ScopeItem>onvif:\/\/www\.onvif\.org\/location\/house<\/tt:ScopeItem>/);
    assert.match(call('RemoveScopes', '<ScopeItem>onvif://www.onvif.org/location/house</ScopeItem>'), /<tds:ScopeItem>onvif:\/\/www\.onvif\.org\/location\/house<\/tds:ScopeItem>/);
    assert.doesNotMatch(call('GetScopes'), /location\/house/);
    assert.equal(faultOf(() => call('RemoveScopes', '<ScopeItem>onvif://www.onvif.org/name/garden</ScopeItem>')), 'ter:OperationProhibited/ter:FixedScope');
    assert.equal(faultOf(() => call('RemoveScopes', '<ScopeItem>onvif://www.onvif.org/location/nowhere</ScopeItem>')), 'ter:InvalidArgVal/ter:NoScope');
  });
});

describe('the device service: users', () => {
  test('the one login from config.json, as an administrator; never its password', () => {
    const xml = service().call('GetUsers');
    assert.match(xml, /<tt:Username>protect<\/tt:Username><tt:UserLevel>Administrator<\/tt:UserLevel>/);
    assert.doesNotMatch(xml, /secret/);
    assert.match(service({}, { credentials: null }).call('GetUsers'), /<tds:GetUsersResponse><\/tds:GetUsersResponse>/);
  });

  test('users can\'t be added, changed or deleted over ONVIF: the login is in config.json', () => {
    const { call } = service();
    assert.equal(faultOf(() => call('CreateUsers', '<User><Username>x</Username><Password>y</Password><UserLevel>User</UserLevel></User>')), 'ter:Action/ter:TooManyUsers');
    assert.equal(faultOf(() => call('SetUser', '<User><Username>protect</Username><Password>y</Password><UserLevel>User</UserLevel></User>')), 'ter:InvalidArgVal/ter:FixedUser');
    assert.equal(faultOf(() => call('DeleteUsers', '<Username>protect</Username>')), 'ter:InvalidArgVal/ter:FixedUser');
    assert.equal(faultOf(() => call('DeleteUsers', '<Username>nobody</Username>')), 'ter:InvalidArgVal/ter:UsernameMissing');
  });
});

test('operations it doesn\'t know: null (the server answers with a fault)', () => {
  assert.equal(service().call('UpgradeSystemFirmware'), null);
});

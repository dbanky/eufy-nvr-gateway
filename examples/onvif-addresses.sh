#!/bin/sh
# Gives each ONVIF camera its own IP and MAC address on the LAN (a macvlan interface on the host),
# for NVRs that tell cameras apart by address, such as UniFi Protect. Not needed for NVRs that take
# several cameras on one IP.
#
# Run as root at every boot, before the gateway starts. Synology: Control Panel → Task Scheduler →
# Create → Triggered Task → User-defined script, user root, event Boot-up.
#
# Each line of CAMERAS: interface name, MAC (locally administered: starts with 02:), IP/prefix.
# Use free IPs outside your router's DHCP range, and the same IP as "onvif.address" in config.json.

PARENT=eth0   # the host's LAN interface; Synology with Open vSwitch: ovs_eth0
CAMERAS="
onvif1 02:00:00:00:00:01 192.168.1.51/24
onvif2 02:00:00:00:00:02 192.168.1.52/24
"

# Every interface would otherwise answer ARP for every address, and NVRs would see all cameras
# behind one MAC.
sysctl -q -w net.ipv4.conf.all.arp_ignore=1 net.ipv4.conf.all.arp_announce=2

table=100
echo "$CAMERAS" | while read -r name mac address; do
  [ -n "$name" ] || continue
  table=$((table + 1))
  ip link show "$name" >/dev/null 2>&1 && ip link delete "$name"
  ip link add "$name" link "$PARENT" address "$mac" type macvlan mode bridge
  ip addr add "$address" dev "$name"
  ip link set "$name" up
  # Answers from this address leave through this interface (with its MAC), not through $PARENT.
  subnet=$(ip -4 route show dev "$name" proto kernel | awk '{print $1; exit}')
  ip route replace "$subnet" dev "$name" src "${address%/*}" table "$table"
  ip rule del from "${address%/*}" table "$table" 2>/dev/null
  ip rule add from "${address%/*}" table "$table"
done

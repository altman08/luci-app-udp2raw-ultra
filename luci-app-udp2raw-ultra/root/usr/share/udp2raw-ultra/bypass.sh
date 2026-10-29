#!/bin/sh
# udp2raw-ultra: force DNS-resolver traffic to leave via the physical WAN,
# bypassing any proxy (WireGuard/etc.) regardless of whether the proxy uses
# fwmark policy routing or replaces the main-table default route.
#
# Mechanism: a dedicated routing table (DNS_TABLE) holds a default route via
# the physical WAN gateway/device. A high-priority (low pref) ip rule matches
# packets destined to the resolver DNS IP and sends them to that table, so the
# lookup happens before any proxy rule can catch them.
#
# This file is meant to be sourced by init.d and monitor.sh.

UDP2RAW_DNS_TABLE=993
UDP2RAW_DNS_PREF=100

# Return 0 if arg is an IPv6 literal (contains a colon)
_u2r_is_v6() {
	case "$1" in *:*) return 0 ;; *) return 1 ;; esac
}

# Interface (logical name) to treat as the physical WAN. Empty => "wan".
# Set by callers (init.d / monitor.sh) from the wan_iface UCI option.
UDP2RAW_WAN_IFACE=""

# Echo the effective IPv4 WAN logical interface name.
u2r_wan_iface() {
	if [ -n "$UDP2RAW_WAN_IFACE" ]; then
		echo "$UDP2RAW_WAN_IFACE"
	else
		echo "wan"
	fi
}

# Populate the dedicated table with a default route via the physical WAN.
# Uses OpenWrt network helpers; falls back gracefully if unavailable.
_u2r_refresh_wan_routes() {
	[ -f /lib/functions/network.sh ] || return 1
	. /lib/functions/network.sh
	network_flush_cache

	local gw dev gw6
	local ifc="$(u2r_wan_iface)"

	# The physical device is the same for IPv4 and IPv6 (one WAN port),
	# so look it up once. Only the gateway differs per family.
	network_get_device dev "$ifc"

	# IPv4 route via the physical WAN
	network_get_gateway gw "$ifc"
	if [ -n "$gw" ] || [ -n "$dev" ]; then
		ip route replace default ${gw:+via "$gw"} ${dev:+dev "$dev"} \
			table "$UDP2RAW_DNS_TABLE" 2>/dev/null
	fi

	# IPv6 route via the same physical WAN (only the v6 gateway differs)
	network_get_gateway6 gw6 "$ifc"
	if [ -n "$gw6" ] || [ -n "$dev" ]; then
		ip -6 route replace default ${gw6:+via "$gw6"} ${dev:+dev "$dev"} \
			table "$UDP2RAW_DNS_TABLE" 2>/dev/null
	fi
	return 0
}

# Add a high-priority rule so packets to the given DNS IP use the WAN table.
u2r_bypass_add() {
	local dns="$1"
	[ -n "$dns" ] || return 0

	_u2r_refresh_wan_routes

	if _u2r_is_v6 "$dns"; then
		ip -6 rule del to "$dns" table "$UDP2RAW_DNS_TABLE" pref "$UDP2RAW_DNS_PREF" 2>/dev/null
		ip -6 rule add to "$dns" table "$UDP2RAW_DNS_TABLE" pref "$UDP2RAW_DNS_PREF" 2>/dev/null
	else
		ip rule del to "$dns" table "$UDP2RAW_DNS_TABLE" pref "$UDP2RAW_DNS_PREF" 2>/dev/null
		ip rule add to "$dns" table "$UDP2RAW_DNS_TABLE" pref "$UDP2RAW_DNS_PREF" 2>/dev/null
	fi
}

# Remove the rule for a specific DNS IP.
u2r_bypass_del() {
	local dns="$1"
	[ -n "$dns" ] || return 0

	if _u2r_is_v6 "$dns"; then
		ip -6 rule del to "$dns" table "$UDP2RAW_DNS_TABLE" pref "$UDP2RAW_DNS_PREF" 2>/dev/null
	else
		ip rule del to "$dns" table "$UDP2RAW_DNS_TABLE" pref "$UDP2RAW_DNS_PREF" 2>/dev/null
	fi
}

# Flush everything (both rules for this DNS and the whole table).
u2r_bypass_flush() {
	local dns="$1"
	u2r_bypass_del "$dns"
	ip route flush table "$UDP2RAW_DNS_TABLE" 2>/dev/null
	ip -6 route flush table "$UDP2RAW_DNS_TABLE" 2>/dev/null
}

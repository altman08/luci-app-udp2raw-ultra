#!/bin/sh
# udp2raw-ultra: "server exception route" helper.
#
# For client rules with route_via_wan='1', add a /32 (/128) host route for
# the udp2raw server IP via the physical WAN interface, written as real UCI
# route/route6 sections in /etc/config/network (visible on LuCI Static Routes
# page, tagged udp2raw_<rule>_v4 / _v6). Applied to the kernel immediately.
#
# Sourced by init.d and monitor.sh.

U2R_ROUTE_STATE_DIR=/var/run/udp2raw-ultra

U2R_ROUTE_WAN_IFACE=""

_u2r_r_is_v6() {
	case "$1" in *:*) return 0 ;; *) return 1 ;; esac
}

_u2r_route_wan_iface() {
	if [ -n "$U2R_ROUTE_WAN_IFACE" ]; then echo "$U2R_ROUTE_WAN_IFACE"
	elif [ -n "$UDP2RAW_WAN_IFACE" ]; then echo "$UDP2RAW_WAN_IFACE"
	else echo "wan"; fi
}

_u2r_route_kernel_gw() {
	local fam="$1" dev="$2"
	[ -n "$dev" ] || return 0
	ip $fam route list default dev "$dev" 2>/dev/null | \
		awk '{ for (i=1;i<=NF;i++) if ($i=="via") { print $(i+1); exit } }' | head -1
}

_u2r_route_wan_info() {
	local ifc
	ifc="$(_u2r_route_wan_iface)"
	_U2R_DEV=""; _U2R_GW=""; _U2R_GW6=""

	if [ -f /lib/functions/network.sh ]; then
		. /lib/functions/network.sh
		network_flush_cache
		network_get_device _U2R_DEV "$ifc"
		network_get_gateway _U2R_GW "$ifc" 2>/dev/null
		network_get_gateway6 _U2R_GW6 "$ifc" 2>/dev/null
	fi
	[ -n "$_U2R_DEV" ] || _U2R_DEV="$ifc"
	[ -n "$_U2R_GW" ]  || _U2R_GW=$(_u2r_route_kernel_gw ""   "$_U2R_DEV")
	[ -n "$_U2R_GW6" ] || _U2R_GW6=$(_u2r_route_kernel_gw "-6" "$_U2R_DEV")
}

u2r_route_add() {
	local ip="$1" cfg="$2" name="$3"
	[ -n "$ip" ] && [ -n "$cfg" ] || return 0
	mkdir -p "$U2R_ROUTE_STATE_DIR" 2>/dev/null

	local ifc
	ifc="$(_u2r_route_wan_iface)"
	_u2r_route_wan_info

	if _u2r_r_is_v6 "$ip"; then
		local sec="udp2raw_${cfg}_v6"
		uci -q delete network."$sec" 2>/dev/null
		uci set network."$sec"="route6"
		uci set network."$sec".interface="$ifc"
		uci set network."$sec".target="${ip}/128"
		[ -n "$_U2R_GW6" ] && uci set network."$sec".gateway="$_U2R_GW6"
		uci set network."$sec".comment="udp2raw: ${name:-$cfg} (server exception route)"
		uci commit network
		ip -6 route replace "${ip}/128" ${_U2R_GW6:+via "$_U2R_GW6"} dev "$_U2R_DEV" 2>/dev/null
	else
		local sec="udp2raw_${cfg}_v4"
		uci -q delete network."$sec" 2>/dev/null
		uci set network."$sec"="route"
		uci set network."$sec".interface="$ifc"
		uci set network."$sec".target="$ip"
		uci set network."$sec".netmask="255.255.255.255"
		[ -n "$_U2R_GW" ] && uci set network."$sec".gateway="$_U2R_GW"
		uci set network."$sec".comment="udp2raw: ${name:-$cfg} (server exception route)"
		uci commit network
		ip route replace "${ip}/32" ${_U2R_GW:+via "$_U2R_GW"} dev "$_U2R_DEV" 2>/dev/null
	fi

	local f="$U2R_ROUTE_STATE_DIR/$cfg.route"
	grep -qxF "$ip" "$f" 2>/dev/null || echo "$ip" >> "$f"
	logger -t udp2raw "route: server exception $ip -> physical WAN ($ifc)"
}

u2r_route_del_cfg() {
	local cfg="$1"
	[ -n "$cfg" ] || return 0
	local changed=0 tgt

	if uci -q get network."udp2raw_${cfg}_v4" >/dev/null 2>&1; then
		tgt=$(uci -q get network."udp2raw_${cfg}_v4".target)
		uci -q delete network."udp2raw_${cfg}_v4"
		[ -n "$tgt" ] && ip route del "${tgt}/32" 2>/dev/null
		changed=1
	fi
	if uci -q get network."udp2raw_${cfg}_v6" >/dev/null 2>&1; then
		tgt=$(uci -q get network."udp2raw_${cfg}_v6".target)
		uci -q delete network."udp2raw_${cfg}_v6"
		[ -n "$tgt" ] && ip -6 route del "$tgt" 2>/dev/null
		changed=1
	fi
	[ "$changed" = "1" ] && uci commit network
	rm -f "$U2R_ROUTE_STATE_DIR/$cfg.route"
}

u2r_route_flush_all() {
	local changed=0 sec tgt

	for sec in $(uci show network 2>/dev/null | sed -n 's/^network\.\(udp2raw_[^.]*\)=route$/\1/p'); do
		tgt=$(uci -q get network."$sec".target)
		uci -q delete network."$sec"
		[ -n "$tgt" ] && ip route del "${tgt}/32" 2>/dev/null
		changed=1
	done
	for sec in $(uci show network 2>/dev/null | sed -n 's/^network\.\(udp2raw_[^.]*\)=route6$/\1/p'); do
		tgt=$(uci -q get network."$sec".target)
		uci -q delete network."$sec"
		[ -n "$tgt" ] && ip -6 route del "$tgt" 2>/dev/null
		changed=1
	done
	[ "$changed" = "1" ] && uci commit network
	rm -f "$U2R_ROUTE_STATE_DIR"/*.route 2>/dev/null
	return 0
}

case "$0" in
	*/route.sh|route.sh)
		case "$1" in
			flush_all) u2r_route_flush_all ;;
			"") : ;;
			*) echo "usage: $0 {flush_all}" >&2; exit 1 ;;
		esac
		;;
esac

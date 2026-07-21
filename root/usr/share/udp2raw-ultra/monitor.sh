#!/bin/sh
# udp2raw-ultra DDNS monitor
# Watches client rules whose address is a domain. When the resolved IP
# changes, it restarts the udp2raw service so the new IP takes effect.

. /lib/functions.sh

BYPASS=/usr/share/udp2raw-ultra/bypass.sh
[ -f "$BYPASS" ] && . "$BYPASS"

STATE_DIR=/var/run/udp2raw-ultra
mkdir -p "$STATE_DIR"

DNS_SERVER=""
CHECK_INTERVAL="60"
BYPASS_PROXY="1"

is_ip_literal() {
	local addr="$1"
	case "$addr" in
		*[!0-9.]*) ;;
		*.*.*.*) return 0 ;;
	esac
	case "$addr" in
		*:*) return 0 ;;
	esac
	return 1
}

resolve_addr() {
	local domain="$1" family="$2" dns="$3"
	local ip=""

	_a() {
		host -t A "$domain" $dns 2>/dev/null | \
			awk '/has address/ {print $NF; exit}'
	}
	_aaaa() {
		host -t AAAA "$domain" $dns 2>/dev/null | \
			awk '/has IPv6 address/ {print $NF; exit}'
	}

	case "$family" in
		ipv4) ip=$(_a) ;;
		ipv6) ip=$(_aaaa) ;;
		*)    ip=$(_a); [ -z "$ip" ] && ip=$(_aaaa) ;;
	esac
	echo "$ip"
}

# Collect domain-based client rules into a list
MONITORED=""

collect_rule() {
	local cfg="$1"
	local enabled mode address family name

	config_get_bool enabled "$cfg" enabled 0
	[ "$enabled" = "1" ] || return 0

	config_get mode "$cfg" mode "client"
	[ "$mode" = "client" ] || return 0

	config_get address "$cfg" address ""
	[ -n "$address" ] || return 0

	# Skip literal IPs, only domains need monitoring
	if is_ip_literal "$address"; then
		return 0
	fi

	config_get family "$cfg" family "auto"
	config_get name "$cfg" name "$cfg"

	MONITORED="$MONITORED $cfg|$address|$family|$name"
}

config_load udp2raw
config_get DNS_SERVER global dns_server ""
config_get CHECK_INTERVAL global check_interval "60"
config_get_bool BYPASS_PROXY global bypass_proxy 1
config_get UDP2RAW_WAN_IFACE global wan_iface ""
config_foreach collect_rule rule

# Nothing to monitor -> idle sleep loop (procd keeps us alive cheaply)
if [ -z "$MONITORED" ]; then
	while true; do sleep 3600; done
fi

# Seed initial IPs
for entry in $MONITORED; do
	cfg=$(echo "$entry" | cut -d'|' -f1)
	dom=$(echo "$entry" | cut -d'|' -f2)
	fam=$(echo "$entry" | cut -d'|' -f3)
	ip=$(resolve_addr "$dom" "$fam" "$DNS_SERVER")
	[ -n "$ip" ] && echo "$ip" > "$STATE_DIR/$cfg.ip"
done

while true; do
	sleep "$CHECK_INTERVAL"

	# Keep the WAN bypass route fresh (PPPoE re-dial can change the gateway).
	if [ "$BYPASS_PROXY" = "1" ] && [ -n "$DNS_SERVER" ]; then
		command -v _u2r_refresh_wan_routes >/dev/null 2>&1 && _u2r_refresh_wan_routes
	fi

	changed=0
	for entry in $MONITORED; do
		cfg=$(echo "$entry" | cut -d'|' -f1)
		dom=$(echo "$entry" | cut -d'|' -f2)
		fam=$(echo "$entry" | cut -d'|' -f3)
		name=$(echo "$entry" | cut -d'|' -f4)

		new_ip=$(resolve_addr "$dom" "$fam" "$DNS_SERVER")
		[ -n "$new_ip" ] || continue

		old_ip=""
		[ -f "$STATE_DIR/$cfg.ip" ] && old_ip=$(cat "$STATE_DIR/$cfg.ip")

		if [ "$new_ip" != "$old_ip" ]; then
			echo "$new_ip" > "$STATE_DIR/$cfg.ip"
			logger -t udp2raw "rule $name: IP changed $old_ip -> $new_ip"
			changed=1
		fi
	done

	if [ "$changed" = "1" ]; then
		logger -t udp2raw "restarting udp2raw due to peer IP change"
		/etc/init.d/udp2raw restart
	fi
done

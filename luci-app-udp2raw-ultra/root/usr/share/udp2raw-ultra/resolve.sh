#!/bin/sh
# Shared DNS lookup for service startup and DDNS monitoring.

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

# UCI must already be loaded. Only enabled clients with hostnames need DDNS.
u2r_rule_needs_monitor() {
	local cfg="$1" enabled mode address
	config_get_bool enabled "$cfg" enabled 0
	[ "$enabled" = "1" ] || return 1
	config_get mode "$cfg" mode "client"
	[ "$mode" = "client" ] || return 1
	config_get address "$cfg" address ""
	[ -n "$address" ] || return 1
	! is_ip_literal "$address"
}

_u2r_resolve_query() {
	local domain="$1" family="$2" dns="$3"
	# Avoid optional nslookup flags so BusyBox's small and full applets work.
	if [ -n "$dns" ]; then
		nslookup "$domain" "$dns" 2>/dev/null
	else
		nslookup "$domain" 2>/dev/null
	fi | awk -v family="$family" '
		# Ignore the resolver address, which appears before the answer name.
		$1 == "Server:" { answer = 0; next }
		$1 == "Name:" { answer = 1; next }
		answer && ($1 == "Address:" || ($1 == "Address" && $2 ~ /^[0-9]+:$/)) {
			ip = ($1 == "Address:") ? $2 : $3
			if (family == "ipv6") {
				if (index(ip, ":") && ip ~ /^[0-9a-fA-F:.]+$/) {
					print ip
					exit
				}
			} else if (ip ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) {
				print ip
				exit
			}
		}
	'
}

# Select the requested address family (IPv4 by default). Retry with the
# system resolver when the configured DNS yields no matching address.
resolve_addr() {
	local domain="$1" family="$2" dns="$3" ip
	ip=$(_u2r_resolve_query "$domain" "$family" "$dns")
	if [ -z "$ip" ] && [ -n "$dns" ]; then
		ip=$(_u2r_resolve_query "$domain" "$family" "")
	fi
	printf '%s\n' "$ip"
}

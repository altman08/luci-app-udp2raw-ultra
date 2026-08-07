#!/bin/sh
# udp2raw-ultra firewall helper (UCI-based, fw4, reload/reboot safe).
#
# SERVER rules: ACCEPT the listen port on wan zone (IPv4 + IPv6).
# CLIENT rules: DROP outbound TCP RST via nft output chain directly
#   (fw4 config rule does not support output chain or tcp_flags).
# TTL normalize: set TTL/hoplimit=64 on WAN egress (server-side option).

. /lib/functions.sh

TAG_PREFIX="udp2raw_"
NFT_TAG_COMMENT_PREFIX="udp2raw_rst_"

# ---- UCI-based server ACCEPT rules ----

fw_clear_all() {
	local changed=0
	while :; do
		local sid
		sid=$(uci show firewall 2>/dev/null | sed -n "s/^firewall\.\(@rule\[[0-9]*\]\)\.name='${TAG_PREFIX}.*/\1/p" | head -1)
		[ -n "$sid" ] || break
		uci -q delete "firewall.${sid}" || break
		changed=1
	done
	if [ "$changed" = "1" ]; then
		uci -q commit firewall
		CLEARED=1
	fi
	return 0
}

fw_add_accept() {
	local tag="$1" proto="$2" port="$3" fam="$4"
	local a
	a=$(uci add firewall rule)
	uci -q set "firewall.$a.name=${tag}"
	uci -q set "firewall.$a.src=wan"
	uci -q set "firewall.$a.proto=${proto}"
	uci -q set "firewall.$a.family=${fam}"
	[ -n "$port" ] && uci -q set "firewall.$a.dest_port=${port}"
	uci -q set "firewall.$a.target=ACCEPT"
	logger -t udp2raw "firewall: accept ${fam} ${proto}${port:+/}${port} (${tag})"
}

fw_add_server() {
	local name="$1" port="$2" raw_mode="$3"
	local tag="${TAG_PREFIX}${name}"
	case "$raw_mode" in
		udp)
			fw_add_accept "${tag}_sv4" "udp" "$port" "ipv4"
			fw_add_accept "${tag}_sv6" "udp" "$port" "ipv6"
			;;
		icmp)
			fw_add_accept "${tag}_sv4" "icmp"      "" "ipv4"
			fw_add_accept "${tag}_sv6" "ipv6-icmp" "" "ipv6"
			;;
		*)
			fw_add_accept "${tag}_sv4" "tcp" "$port" "ipv4"
			fw_add_accept "${tag}_sv6" "tcp" "$port" "ipv6"
			;;
	esac
}

# ---- nft output chain RST drop (client) ----

fw_add_rst_drop() {
	local name="$1" peer_ip="$2" peer_port="$3"
	local tag="${NFT_TAG_COMMENT_PREFIX}${name}"
	case "$peer_ip" in
		*:*)
			nft add rule inet fw4 output \
				ip6 daddr "${peer_ip}" tcp dport "${peer_port}" \
				tcp flags "& rst == rst" \
				counter drop comment "\"${tag}_v6\"" 2>/dev/null || true
			logger -t udp2raw "firewall: nft drop ipv6 RST -> ${peer_ip}:${peer_port}"
			;;
		*)
			nft add rule inet fw4 output \
				ip daddr "${peer_ip}" tcp dport "${peer_port}" \
				tcp flags "& rst == rst" \
				counter drop comment "\"${tag}_v4\"" 2>/dev/null || true
			logger -t udp2raw "firewall: nft drop ipv4 RST -> ${peer_ip}:${peer_port}"
			;;
	esac
}

fw_clear_rst_rules() {
	local handles
	handles=$(nft -a list chain inet fw4 output 2>/dev/null | \
		grep "comment.*${NFT_TAG_COMMENT_PREFIX}" | \
		awk '{for(i=1;i<=NF;i++) if($i=="handle") print $(i+1)}')
	local h
	for h in $handles; do
		nft delete rule inet fw4 output handle "$h" 2>/dev/null || true
	done
}

# ---- TTL/hoplimit normalization (server global option) ----

TTL_HANDLE_FILE=/var/run/udp2raw-ultra/ttl_handles

fw_apply_ttl() {
	local wan_iface="$1"
	[ -n "$wan_iface" ] || wan_iface="wan"

	local wan_dev=""
	if [ -f /lib/functions/network.sh ]; then
		. /lib/functions/network.sh
		network_flush_cache
		network_get_device wan_dev "$wan_iface"
	fi
	[ -n "$wan_dev" ] || wan_dev="$wan_iface"

	if command -v fw4 >/dev/null 2>&1; then
		# fw4 (nftables): write a persistent include file loaded on every reload.
		mkdir -p /etc/nftables.d 2>/dev/null
		cat > /etc/nftables.d/udp2raw-ttl.nft <<EOF
chain mangle_postrouting {
	oifname "${wan_dev}" ip ttl set 64
	oifname "${wan_dev}" ip6 hoplimit set 64
}
EOF
		logger -t udp2raw "firewall: TTL normalize (fw4) written for ${wan_dev}"
	else
		# fw3 (iptables): append to /etc/firewall.user executed on reload.
		# Remove any stale udp2raw TTL lines first.
		grep -v 'udp2raw.*ttl\|iptables.*ttl.*64\|ip6tables.*hop.*64' \
			/etc/firewall.user > /tmp/fw_user.tmp 2>/dev/null && \
			mv /tmp/fw_user.tmp /etc/firewall.user
		cat >> /etc/firewall.user <<EOF
# udp2raw TTL normalize
iptables  -t mangle -A POSTROUTING -o "${wan_dev}" -j TTL --ttl-set 64
ip6tables -t mangle -A POSTROUTING -o "${wan_dev}" -j HL  --hl-set  64
EOF
		# Apply immediately
		iptables  -t mangle -A POSTROUTING -o "${wan_dev}" -j TTL --ttl-set 64 2>/dev/null || true
		ip6tables -t mangle -A POSTROUTING -o "${wan_dev}" -j HL  --hl-set  64 2>/dev/null || true
		logger -t udp2raw "firewall: TTL normalize (fw3) written for ${wan_dev}"
	fi
}

fw_clear_ttl() {
	# fw4
	rm -f /etc/nftables.d/udp2raw-ttl.nft
	# fw3: remove the lines we added
	grep -v 'udp2raw TTL\|TTL --ttl-set 64\|HL --hl-set 64' \
		/etc/firewall.user > /tmp/fw_user.tmp 2>/dev/null && \
		mv /tmp/fw_user.tmp /etc/firewall.user
}

# ---- Collect rules ----

_want_server=""
_want_client=""
_do_ttl=0
_ttl_wan=""

collect_rule() {
	local cfg="$1"
	local enabled mode name raw_mode
	local listen_port peer_ip peer_port auto_fw

	config_get_bool enabled "$cfg" enabled 0
	[ "$enabled" = "1" ] || return 0
	config_get mode "$cfg" mode "client"
	config_get name "$cfg" name "$cfg"

	if [ "$mode" = "server" ]; then
		config_get_bool auto_fw "$cfg" auto_fw 1
		[ "$auto_fw" = "1" ] || return 0
		config_get listen_port "$cfg" listen_port ""
		[ -n "$listen_port" ] || return 0
		config_get raw_mode "$cfg" raw_mode "faketcp"
		_want_server="${_want_server} ${name}|${listen_port}|${raw_mode}"
	else
		local resolved_ip=""
		[ -f "/var/run/udp2raw-ultra/${name}.resolved" ] && \
			resolved_ip=$(cat "/var/run/udp2raw-ultra/${name}.resolved")
		[ -z "$resolved_ip" ] && config_get resolved_ip "$cfg" address ""
		[ -n "$resolved_ip" ] || return 0
		config_get peer_port "$cfg" port ""
		[ -n "$peer_port" ] || return 0
		config_get raw_mode "$cfg" raw_mode "faketcp"
		[ "$raw_mode" = "faketcp" ] || return 0
		_want_client="${_want_client} ${name}|${resolved_ip}|${peer_port}"
	fi
}

apply() {
	CLEARED=0
	fw_clear_all
	fw_clear_rst_rules
	fw_clear_ttl
	local cleared="$CLEARED"

	config_load udp2raw
	_want_server=""
	_want_client=""
	config_foreach collect_rule rule

	# Check global TTL normalize setting.
	local ttl_normalize wan_iface
	config_get_bool ttl_normalize global ttl_normalize 0
	config_get wan_iface global wan_iface ""

	local any=0 entry name rest port raw_mode peer_ip peer_port

	for entry in $_want_server; do
		name="${entry%%|*}"; rest="${entry#*|}"
		port="${rest%%|*}"; raw_mode="${rest##*|}"
		fw_add_server "$name" "$port" "$raw_mode"
		any=1
	done

	for entry in $_want_client; do
		name="${entry%%|*}"; rest="${entry#*|}"
		peer_ip="${rest%%|*}"; peer_port="${rest##*|}"
		fw_add_rst_drop "$name" "$peer_ip" "$peer_port"
		any=1
	done

	if [ "$ttl_normalize" = "1" ]; then
		fw_apply_ttl "$wan_iface"
		any=1
	fi

	if [ "$any" = "1" ]; then
		uci -q commit firewall
		/etc/init.d/firewall reload >/dev/null 2>&1
		logger -t udp2raw "firewall: committed + reloaded"
	elif [ "$cleared" = "1" ]; then
		/etc/init.d/firewall reload >/dev/null 2>&1
		logger -t udp2raw "firewall: cleared stale entries + reloaded"
	fi
	return 0
}

flush() {
	fw_clear_all
	fw_clear_rst_rules
	fw_clear_ttl
	/etc/init.d/firewall reload >/dev/null 2>&1
	return 0
}

case "$1" in
	apply) apply ;;
	flush) flush ;;
	*)     echo "usage: $0 {apply|flush}" >&2; exit 1 ;;
esac

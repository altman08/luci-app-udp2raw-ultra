#!/bin/sh
set -eu

src=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
. "$src/luci-app-udp2raw-ultra/root/usr/share/udp2raw-ultra/resolve.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM

custom_output=''
system_output=''
lookup_status=0
nslookup() {
	printf '%s\n' "$*" >> "$work/calls"
	if [ "$#" -eq 2 ]; then
		printf '%s\n' "$custom_output"
	else
		printf '%s\n' "$system_output"
	fi
	return "$lookup_status"
}
assert_equal() {
	if [ "$1" != "$2" ]; then
		printf 'FAIL: %s\nExpected: %s\nActual: %s\n' "$3" "$1" "$2" >&2
		exit 1
	fi
}

custom_output='Server: 192.0.2.53
Address: 192.0.2.53:53

Non-authoritative answer:
Name: peer.example
Address: 2001:db8::10
Name: peer.example
Address: 198.51.100.10
Address: 198.51.100.11'
assert_equal 198.51.100.10 "$(resolve_addr peer.example ipv4 192.0.2.53)" 'BusyBox IPv4 selection'
assert_equal 2001:db8::10 "$(resolve_addr peer.example ipv6 192.0.2.53)" 'BusyBox IPv6 selection'

custom_output='Server: 2001:db8::53
Address 1: 2001:db8::53 resolver.example

Name: peer.example
Address 1: 198.51.100.20 peer.example
Address 2: 2001:db8::20 peer.example'
assert_equal 198.51.100.20 "$(resolve_addr peer.example ipv4 2001:db8::53)" 'Numbered IPv4 answer'
assert_equal 2001:db8::20 "$(resolve_addr peer.example ipv6 2001:db8::53)" 'Numbered IPv6 answer'

custom_output='Server: 192.0.2.53
Address: 192.0.2.53#53

Non-authoritative answer:
peer.example canonical name = target.example.
Name: target.example
Address: 198.51.100.30
Name: target.example
Address: 2001:db8::30'
assert_equal 198.51.100.30 "$(resolve_addr peer.example ipv4 192.0.2.53)" 'BIND-style CNAME answer'
assert_equal 2001:db8::30 "$(resolve_addr peer.example ipv6 192.0.2.53)" 'CNAME IPv6 answer'

system_output="$custom_output"
custom_output='Server: 192.0.2.53
Address: 192.0.2.53:53

** server cannot find peer.example: NXDOMAIN'
: > "$work/calls"
assert_equal 198.51.100.30 "$(resolve_addr peer.example ipv4 192.0.2.53)" 'Failed custom DNS falls back to system DNS'
assert_equal 'peer.example 192.0.2.53
peer.example' "$(cat "$work/calls")" 'DNS server argument and fallback arguments'

# DNS returned an address, but not the selected family: still retry system DNS.
custom_output='Server: 192.0.2.53
Address: 192.0.2.53:53

Name: peer.example
Address: 198.51.100.40'
assert_equal 2001:db8::30 "$(resolve_addr peer.example ipv6 192.0.2.53)" 'Missing address family falls back'

system_output='Server: 2001:db8::53
Address 1: 2001:db8::53

** server cannot find peer.example: NXDOMAIN'
: > "$work/calls"
assert_equal '' "$(resolve_addr peer.example ipv6 '')" 'Resolver IPv6 address is not an answer'
assert_equal peer.example "$(cat "$work/calls")" 'Empty DNS uses system resolver once'
custom_output="$system_output"
assert_equal '' "$(resolve_addr peer.example ipv4 192.0.2.53)" 'No matching answer returns empty'

# BusyBox can report an error for one record type while returning the other.
system_output='Server: 192.0.2.53
Address: 192.0.2.53:53

Name: peer.example
Address: 198.51.100.50
*** Cannot find peer.example: No answer'
lookup_status=1
assert_equal 198.51.100.50 "$(resolve_addr peer.example ipv4 '')" 'Partial answer with nonzero exit status'

printf '%s\n' 'PASS: nslookup formats, address families, CNAME, DNS fallback and failed/partial answers'

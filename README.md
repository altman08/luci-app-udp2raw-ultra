# luci-app-udp2raw-ultra

LuCI web interface for [udp2raw](https://github.com/wangyu-/udp2raw) on OpenWrt / Kwrt / ImmortalWrt.

Turns UDP traffic into encrypted FakeTCP / UDP / ICMP traffic to bypass UDP QoS / blocking. Designed to pair with WireGuard / AmneziaWG.

> This is an alternative to the official `luci-app-udp2raw`, rewritten as a modern JS-based LuCI app (OpenWrt 24.10 / 25.12 client-side rendering) that the official package does not support well.

## Features

- **Rule list** — add multiple udp2raw instances, each independently a **server** or **client**, individually enable/disable.
- **Address = IP or domain** — enter an IP or a domain name; at startup the init script auto-detects. If it's a domain it is resolved automatically.
- **Address family** — `auto` (IPv4 first, then IPv6) / `IPv4 only` / `IPv6 only`.
- **DDNS monitor** — for client rules using a domain, a background daemon polls the resolved IP on an interval; when the peer's IP changes, the corresponding instance is restarted automatically.
- **Full parameter coverage** — password, raw-mode (faketcp/udp/icmp), cipher-mode (aes128cbc/xor/none), auth-mode, seq-mode, sock-buf, `-a` auto firewall rule, `--retry-on-error`, `--fix-gro`, log-level, plus a free-form extra arguments field.

## Dependencies

- `udp2raw` binary (bundled in Kwrt firmware, or install from your feed).

## Install

```sh
opkg install luci-app-udp2raw-ultra_*.ipk
# if it complains about the udp2raw dependency but the binary is already present:
opkg install --force-depends luci-app-udp2raw-ultra_*.ipk
```

Then refresh LuCI and open **Services → UDP2RAW Ultra**.

## Build (from an OpenWrt SDK)

```sh
cp -r luci-app-udp2raw-ultra <sdk>/package/
cd <sdk>
make package/luci-app-udp2raw-ultra/compile V=s
# output: bin/packages/<arch>/base/luci-app-udp2raw-ultra_*.ipk
```

## Layout

| Path | Purpose |
|------|---------|
| `root/etc/config/udp2raw` | UCI config (global options + rule list) |
| `root/etc/init.d/udp2raw` | procd service; one udp2raw instance per enabled rule |
| `root/usr/share/udp2raw-ultra/monitor.sh` | DDNS monitor daemon |
| `root/usr/share/luci/menu.d/*.json` | menu entry |
| `root/usr/share/rpcd/acl.d/*.json` | ACL |
| `htdocs/luci-static/resources/view/udp2raw-ultra/udp2raw.js` | web UI |

## License

Apache-2.0

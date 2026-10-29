#!/bin/bash
set -e

cd -- "$(dirname -- "$0")"

PACKAGE_DIR="luci-app-udp2raw-ultra"
PKG_NAME="luci-app-udp2raw-ultra"
PKG_VERSION="$(sed -n 's/^PKG_VERSION:=//p' "$PACKAGE_DIR/Makefile" | head -n1 | tr -d '\r[:space:]')"
PKG_RELEASE="$(sed -n 's/^PKG_RELEASE:=//p' "$PACKAGE_DIR/Makefile" | head -n1 | tr -d '\r[:space:]')"
MAINTAINER="Kwrt"
DESCRIPTION="LuCI support for udp2raw (Ultra, multi-rule with server firewall and route_via_wan)"
HOMEPAGE="https://github.com/altman08/luci-app-udp2raw-ultra"
LICENSE="Apache-2.0"
DIST_DIR="${DIST_DIR:-dist}"
WORK_DIR="$(mktemp -d)"
TAR="$(command -v gtar 2>/dev/null || command -v tar)"

trap 'rm -rf "$WORK_DIR"' EXIT

[ -n "$PKG_VERSION" ] || { echo "PKG_VERSION missing" >&2; exit 1; }
[ -n "$PKG_RELEASE" ] || { echo "PKG_RELEASE missing" >&2; exit 1; }

IPK_FILE="${PKG_NAME}_${PKG_VERSION}-${PKG_RELEASE}_all.ipk"

DATA_DIR="$WORK_DIR/data"
mkdir -p "$DATA_DIR"
mkdir -p "$DIST_DIR"
DIST_DIR="$(cd -- "$DIST_DIR" && pwd)"

cp -a "$PACKAGE_DIR/root/." "$DATA_DIR/"
if [ -d "$PACKAGE_DIR/htdocs" ]; then
    mkdir -p "$DATA_DIR/www"
    cp -a "$PACKAGE_DIR/htdocs/." "$DATA_DIR/www/"
fi
find "$DATA_DIR" -type f -name '*.sh' -exec chmod 755 {} +
find "$DATA_DIR/etc/init.d" -type f -exec chmod 755 {} + 2>/dev/null || true
INSTALLED_SIZE="$(du -sk "$DATA_DIR" | awk '{print $1}')"

ipk_dir="$WORK_DIR/ipk"
mkdir -p "$ipk_dir/control"

cat > "$ipk_dir/control/control" <<EOF
Package: $PKG_NAME
Version: ${PKG_VERSION}-${PKG_RELEASE}
Architecture: all
Maintainer: $MAINTAINER
Section: luci
Priority: optional
Installed-Size: $INSTALLED_SIZE
Depends: luci-base, udp2raw, firewall4, ip-full
Description: $DESCRIPTION
Homepage: $HOMEPAGE
License: $LICENSE
EOF

cat > "$ipk_dir/control/conffiles" <<'EOF'
/etc/config/udp2raw
EOF

cat > "$ipk_dir/control/postinst" <<'EOF'
#!/bin/sh
[ -n "$IPKG_INSTROOT" ] && exit 0
[ -x /etc/init.d/udp2raw ] && /etc/init.d/udp2raw enable 2>/dev/null
exit 0
EOF
chmod 755 "$ipk_dir/control/postinst"

cat > "$ipk_dir/control/postrm" <<'EOF'
#!/bin/sh
[ -n "$IPKG_INSTROOT" ] && exit 0
[ "$PKG_UPGRADE" = "1" ] && exit 0
[ -x /etc/init.d/udp2raw ] && /etc/init.d/udp2raw stop 2>/dev/null
[ -x /usr/share/udp2raw-ultra/route.sh ] && /usr/share/udp2raw-ultra/route.sh flush_all 2>/dev/null || true
rm -f /etc/config/udp2raw
rm -rf /var/run/udp2raw-ultra /var/log/udp2raw /usr/share/udp2raw-ultra
exit 0
EOF
chmod 755 "$ipk_dir/control/postrm"

printf '2.0\n' > "$ipk_dir/debian-binary"
(cd "$DATA_DIR" && "$TAR" --format=gnu --numeric-owner --owner=0 --group=0 -cf - . | gzip -n > "$ipk_dir/data.tar.gz")
(cd "$ipk_dir/control" && "$TAR" --format=gnu --numeric-owner --owner=0 --group=0 -cf - . | gzip -n > "$ipk_dir/control.tar.gz")
(cd "$ipk_dir" && "$TAR" --format=gnu --numeric-owner --owner=0 --group=0 -cf - ./debian-binary ./data.tar.gz ./control.tar.gz | gzip -n > "$DIST_DIR/$IPK_FILE")

echo "==> Built: $DIST_DIR/$IPK_FILE"
ls -lh "$DIST_DIR/$IPK_FILE"
tar -tzf "$DIST_DIR/$IPK_FILE" | grep -q './data.tar.gz' && echo "OK: data.tar.gz found"
tar -tzf "$DIST_DIR/$IPK_FILE" | grep -q './control.tar.gz' && echo "OK: control.tar.gz found"

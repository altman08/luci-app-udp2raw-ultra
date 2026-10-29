#!/bin/sh
# Build the JS/Shell-only LuCI package with apk-tools 3, without a toolchain.
set -eu
cd -- "$(dirname -- "$0")"

APK_TOOL=${APK_TOOL:-apk}
command -v "$APK_TOOL" >/dev/null 2>&1 || {
	echo 'Set APK_TOOL to an apk-tools 3 executable.' >&2
	exit 1
}
read_field() {
	sed -n "s/^$1:=//p" Makefile | tr -d '\r\n'
}
name=$(read_field PKG_NAME)
version=$(read_field PKG_VERSION)
release=$(read_field PKG_RELEASE)
description=$(read_field LUCI_DESCRIPTION)
url=$(read_field LUCI_URL)
maintainer=$(read_field LUCI_MAINTAINER)
license=$(read_field PKG_LICENSE)
depends=$(read_field LUCI_DEPENDS | tr -d '+')
test -n "$name"
test -n "$version"
test -n "$release"

dist_dir=${DIST_DIR:-dist}
mkdir -p "$dist_dir"
dist_dir=$(CDPATH='' cd -- "$dist_dir" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM
data="$work/data"
meta="$data/lib/apk/packages"
mkdir -p "$data/www" "$meta"
cp -R root/. "$data/"
cp -R htdocs/. "$data/www/"
chmod 0755 "$data/etc/init.d/udp2raw" "$data/usr/share/udp2raw-ultra/"*.sh

# Use the same bookkeeping files and lifecycle helpers as OpenWrt's APK build.
printf '%s\n' /etc/config/udp2raw > "$meta/$name.conffiles"
csum=$(sha256sum "$data/etc/config/udp2raw")
printf '/etc/config/udp2raw %s\n' "${csum%% *}" > "$meta/$name.conffiles_static"
(cd "$data" && find . -type f | sed 's|^\.||' | LC_ALL=C sort) > "$work/files"
cp "$work/files" "$meta/$name.list"

cat > "$work/post-install" <<'EOF'
#!/bin/sh
[ "$IPKG_NO_SCRIPT" = "1" ] && exit 0
[ -s "$IPKG_INSTROOT/lib/functions.sh" ] || exit 0
. "$IPKG_INSTROOT/lib/functions.sh"
export root="$IPKG_INSTROOT"
export pkgname="luci-app-udp2raw-ultra"
add_group_and_user
default_postinst
[ -n "$IPKG_INSTROOT" ] || {
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd reload 2>/dev/null
}
exit 0
EOF
{
	printf '#!/bin/sh\nexport PKG_UPGRADE=1\n'
	sed '1d' "$work/post-install"
} > "$work/post-upgrade"
cat > "$work/pre-deinstall" <<'EOF'
#!/bin/sh
[ -s "$IPKG_INSTROOT/lib/functions.sh" ] || exit 0
. "$IPKG_INSTROOT/lib/functions.sh"
export root="$IPKG_INSTROOT"
export pkgname="luci-app-udp2raw-ultra"
default_prerm
EOF
# Reuse the buildroot uninstall hook, expanding Make's escaped dollars.
awk -v hook_name="Package/$name/postrm" '
	$0 == "define " hook_name { hook=1; next }
	hook && /^endef$/ { exit }
	hook { gsub(/\$\$/, "$"); print }
' Makefile > "$work/post-deinstall"
test -s "$work/post-deinstall"
for hook in post-install post-upgrade pre-deinstall post-deinstall; do
	sh -n "$work/$hook"
done

output="$dist_dir/$name-$version-r$release.apk"
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-0} "$APK_TOOL" mkpkg \
	--info "name:$name" \
	--info "version:$version-r$release" \
	--info 'arch:noarch' \
	--info "description:$description" \
	--info "license:$license" \
	--info "origin:$name" \
	--info "url:$url" \
	--info "maintainer:$maintainer" \
	--info "depends:$depends" \
	--script "post-install:$work/post-install" \
	--script "post-upgrade:$work/post-upgrade" \
	--script "pre-deinstall:$work/pre-deinstall" \
	--script "post-deinstall:$work/post-deinstall" \
	--files "$data" --output "$output"
"$APK_TOOL" --allow-untrusted verify "$output"
sha256sum "$output"

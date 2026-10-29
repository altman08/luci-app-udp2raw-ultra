#!/bin/bash
# Publish only architecture independent LuCI packages from the selected SDK.
set -euo pipefail

: "${SDK:?Set SDK to the OpenWrt SDK version}"
: "${FORMAT:?Set FORMAT to apk or ipk}"
package_dir=bin/packages/x86_64/action
shopt -s nullglob
case "$FORMAT" in
    apk)
        frontend=("$package_dir"/luci-app-udp2raw-ultra-[0-9]*.apk)
        translations=("$package_dir"/luci-i18n-udp2raw-ultra-zh-cn-[0-9]*.apk)
        ;;
    ipk)
        frontend=("$package_dir"/luci-app-udp2raw-ultra_*.ipk)
        translations=("$package_dir"/luci-i18n-udp2raw-ultra-zh-cn_*.ipk)
        ;;
    *) echo "Unsupported package format: $FORMAT" >&2; exit 1 ;;
esac
if ((${#frontend[@]} != 1 || ${#translations[@]} != 1)); then
    echo "::error::Expected one frontend and one Chinese language $FORMAT package in $package_dir" >&2
    exit 1
fi
mkdir -p release
cp -- "${frontend[@]}" "${translations[@]}" release/
(
    cd release
    sha256sum -- "$(basename "${frontend[0]}")" "$(basename "${translations[0]}")" > "sha256sums_openwrt-${SDK}"
)

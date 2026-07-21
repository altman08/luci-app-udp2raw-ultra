#
# Copyright (C) 2026
#
# This is free software, licensed under the Apache License, Version 2.0 .
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for udp2raw (Ultra, multi-rule)
LUCI_DESCRIPTION:=Web UI for udp2raw with a rule list. Each rule is an independent server or client instance, with domain auto-resolve and DDNS monitoring.
LUCI_DEPENDS:=+udp2raw +bind-host
LUCI_PKGARCH:=all

PKG_NAME:=luci-app-udp2raw-ultra
PKG_VERSION:=1.1.2
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Kwrt

# Remove config files on real uninstall, but keep them on upgrade.
# NOTE: must be defined BEFORE including luci.mk, because luci.mk calls
# BuildPackage at its end and collects script hooks at that point.
define Package/luci-app-udp2raw-ultra/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
[ "$$PKG_UPGRADE" = "1" ] && exit 0
/etc/init.d/udp2raw stop 2>/dev/null
/etc/init.d/udp2raw disable 2>/dev/null
rm -f /etc/config/udp2raw /etc/config/udp2raw-opkg
rm -rf /var/run/udp2raw-ultra
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature

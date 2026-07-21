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
PKG_VERSION:=1.1.0
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Kwrt

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature

# luci-app-udp2raw-ultra

适用于 OpenWrt / Kwrt / ImmortalWrt 的 [udp2raw](https://github.com/wangyu-/udp2raw) LuCI 网页管理插件。

把 UDP 流量伪装成加密的 FakeTCP / UDP / ICMP 流量，用于绕过运营商对 UDP 的 QoS 限速或封锁。专为搭配 WireGuard / AmneziaWG 设计。

> 本插件是官方 `luci-app-udp2raw` 的替代品，采用新版 JS 客户端渲染的 LuCI 界面（适配 OpenWrt 24.10 / 25.12），解决官方包在新固件上不适配的问题。全中文界面，支持多规则列表。

## 界面预览

![功能概览](docs/overview.jpg)

![界面截图](docs/interface.jpg)

## 功能特性

- **规则列表** — 可添加多个 udp2raw 实例，每条独立作为**服务端**或**客户端**，可单独启用/停用。
- **地址填 IP 或域名** — 启动时自动判断，填域名会自动解析。
- **地址族选择** — 自动（优先 IPv4，其次 IPv6）/ 仅 IPv4 / 仅 IPv6。
- **DDNS 自动重连** — 客户端规则填域名时，后台守护进程按间隔轮询解析，对端 IP 变化时自动重启对应实例。
- **完整参数覆盖** — 密码、伪装模式（faketcp/udp/icmp）、加密方式（aes128cbc/xor/none）、认证方式、seq 模式、socket 缓冲区、`-a` 自动防火墙规则、`--retry-on-error`、`--fix-gro`、日志级别，以及自定义额外参数。

## 依赖

- `udp2raw` 二进制（Kwrt 固件已自带，或从软件源安装）
- `bind-host`（提供 `host` 命令用于域名解析，安装时会自动拉取）

## 安装

```sh
opkg install luci-app-udp2raw-ultra_*.ipk
# 若提示缺少 udp2raw 依赖但系统其实已自带：
opkg install --force-depends luci-app-udp2raw-ultra_*.ipk
```

安装后清一下 LuCI 缓存并刷新浏览器：

```sh
rm -f /tmp/luci-modulecache/* /tmp/luci-indexcache*
```

然后进入 **服务 → UDP2RAW Ultra**。

## 使用教程

udp2raw 的工作原理：**有公网 IP 的一方跑服务端，NAT 后面的一方跑客户端**。客户端把本地某个 UDP 端口的流量加密伪装后发给服务端，服务端解密还原后转发给真实的 UDP 服务（比如 WireGuard）。

### 典型场景：给 WireGuard/AmneziaWG 加一层伪装

假设 B 端路由器有公网、跑着 WireGuard（端口 51820），A 端在 NAT 后面要连它，但 UDP ��限速。用 udp2raw 把这条 WireGuard 隧道包一层 FakeTCP。

#### 服务端配置（B 端，有公网的路由器）

进入 **服务 → UDP2RAW Ultra**，点**添加规则**：

| 选项 | 填写 | 说明 |
|------|------|------|
| 启用 | ✅ | |
| 名称 | `server` | 任意备注名 |
| 模式 | 服务端 | |
| 监听端口 | `58881` | 对外暴露的 udp2raw 端口，客户端要连这个 |
| 转发到地址 | `127.0.0.1` | 本机的 WireGuard |
| 转发到端口 | `51820` | WireGuard 实际监听端口 |
| 密码 | `你的密码` | 两端必须一致 |
| 伪装模式 | `faketcp` | 两端必须一致 |
| 加密方式 | `aes128cbc` | 两端必须一致 |

保存并应用。别忘了在防火墙放行 TCP `58881`（faketcp 走 TCP）。

#### 客户端配置（A 端，NAT 后面）

同样**添加规则**：

| 选项 | 填写 | 说明 |
|------|------|------|
| 启用 | ✅ | |
| 名称 | `peerB` | 任意备注名 |
| 模式 | 客户端 | |
| 对端地址 | `b.example.com` | B 端的公网 IP 或域名（域名会自动解析+监控） |
| 对端端口 | `58881` | 对应服务端的监听端口 |
| 本地监听地址 | `127.0.0.1` | |
| 监听端口 | `51820` | 本地暴露的 UDP 端口，你的 WireGuard 对端 Endpoint 填这个 |
| 密码 / 伪装模式 / 加密方式 | 同服务端 | **必须和服务端完全一致** |

保存并应用。然后把 A 端 WireGuard 的对端 Endpoint 改成 `127.0.0.1:51820`（也就是本地的 udp2raw 客户端入口），流量就会经 udp2raw 伪装后发往 B 端。

### 地址族说明

一条隧道只能用一种地址族。填域名时：

- **自动** — 先查 A 记录（IPv4），没有再查 AAAA（IPv6）
- **仅 IPv4** — 只查 A 记录
- **仅 IPv6** — 只查 AAAA 记录

如果你的对端是 IPv6 动态地址（很多家宽只有 IPv6 公网），选**仅 IPv6**，并在全局设置里把**解析 DNS** 设成可用的 IPv6 DNS（默认 `2606:4700:4700::1111`）。

### DDNS 自动重连

客户端规则的对端地址填**域名**时，后台会按**全局设置 → 检测间隔**（默认 60 秒）定时解析该域名。一旦解析出的 IP 变了，自动重启对应的 udp2raw 客户端，无需手动干预。填 IP 则不监控。

## 常见问题

**Q：安装时提示 `resolve_conffiles ... /etc/config/udp2raw-opkg`？**
这是升级时的正常保护提示，不是错误——opkg 保留了你现有的配置，把新默认配置放到了 `-opkg` 旁边。想用���新配置就 `rm /etc/config/udp2raw` 后重装。

**Q：卸载后配置还在吗？**
本插件的 `postrm` 会在**真正卸载**（`opkg remove`）时自动删除 `/etc/config/udp2raw`；**升级**时则保留配置不动。

**Q：菜单不显示 / 界面空白？**
清缓存刷新：`rm -f /tmp/luci-modulecache/* /tmp/luci-indexcache*`，然后浏览器 Ctrl+F5。

**Q：连不上？**
- 两端的密码、伪装模式、加密方式、认证方式必须**完全一致**
- 服务端防火墙要放行对应端口（faketcp 走 TCP）
- 用 `logread | grep udp2raw` 看日志

## 从 SDK 编译

```sh
cp -r luci-app-udp2raw-ultra <sdk>/package/
cd <sdk>
make package/luci-app-udp2raw-ultra/compile V=s
# 产物：bin/packages/<arch>/base/luci-app-udp2raw-ultra_*.ipk
```

## 文件结构

| 路径 | 作用 |
|------|------|
| `root/etc/config/udp2raw` | UCI 配置（全局选项 + 规则列表） |
| `root/etc/init.d/udp2raw` | procd 服务，每条启用的规则起一个 udp2raw 实例 |
| `root/usr/share/udp2raw-ultra/monitor.sh` | DDNS 监控守护进程 |
| `root/usr/share/luci/menu.d/*.json` | 菜单注册 |
| `root/usr/share/rpcd/acl.d/*.json` | ACL 权限 |
| `htdocs/luci-static/resources/view/udp2raw-ultra/udp2raw.js` | 网页界面 |

## 许可

Apache-2.0

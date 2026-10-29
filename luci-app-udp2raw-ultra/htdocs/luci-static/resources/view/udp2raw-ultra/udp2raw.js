'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require poll';
'require network';
'require fs';
'require ui';

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} }
});

// ---- Shared status state, driven by a single poll ----
var statusCache = {};
var transient = {};
var rowUpdaters = [];
var resolvedCache = {};  // rule name -> resolved peer IP
var connCache = {};      // rule name -> established|handshaking|none
var pollStarted = false;

var INIT = '/etc/init.d/udp2raw';

function getStatus() {
	return L.resolveDefault(callServiceList('udp2raw'), {}).then(function (res) {
		var instances = {};
		try { instances = res['udp2raw']['instances'] || {}; } catch (e) { }
		return instances;
	});
}

function getRuleResolved(name) {
	return fs.exec(INIT, [ 'rule_resolved', name ]).then(function (res) {
		return ((res && res.stdout) ? res.stdout : '').trim();
	}).catch(function () { return ''; });
}

function getRuleConn(name) {
	return fs.exec(INIT, [ 'rule_conn', name ]).then(function (res) {
		return ((res && res.stdout) ? res.stdout : '').trim() || 'none';
	}).catch(function () { return 'none'; });
}

function getRuleLog(name) {
	return fs.exec(INIT, [ 'rule_log', name ]).then(function (res) {
		return ((res && res.stdout) ? res.stdout : '');
	}).catch(function () { return ''; });
}

function showRuleLogModal(name) {
	var logId = 'u2r_rule_log_' + name;
	var pre = E('pre', {
		'id': logId,
		'style': 'max-height:400px;overflow:auto;background:#1e1e1e;color:#d4d4d4;' +
			'padding:12px;border-radius:6px;font-size:12px;line-height:1.5;white-space:pre-wrap;margin:0'
	}, '加载中…');
	ui.showModal('规则日志：' + name, [
		E('p', { 'style': 'color:#666;font-size:12px;margin-top:0' },
			'最近 100 条有意义的日志事件（已过滤高频噪音）。'),
		pre,
		E('div', { 'class': 'right', 'style': 'margin-top:12px' }, [
			E('button', { 'class': 'cbi-button cbi-button-neutral', 'click': ui.hideModal }, '关闭')
		])
	]);
	getRuleLog(name).then(function (text) {
		var el = document.getElementById(logId);
		if (el) el.textContent = text || '（暂无相关日志）';
	});
}

// allRuleNames tracks names seen during render so the second-wave poll
// knows which rules to query diagnostics for.
var allRuleNames = [];

function refreshStatus() {
	return getStatus().then(function (inst) {
		statusCache = inst || {};
		rowUpdaters.forEach(function (fn) { try { fn(); } catch (e) { } });

		// Second wave: resolved IPs only, for running rules.
		var running = allRuleNames.filter(function (n) { return isRunning(n); });
		if (running.length) {
			Promise.all(running.map(function (name) {
				return getRuleResolved(name).then(function (ip) {
					resolvedCache[name] = ip;
				});
			})).then(function () {
				rowUpdaters.forEach(function (fn) { try { fn(); } catch (e) { } });
			});
		}
		return statusCache;
	});
}

// Register the single shared poll (runs once regardless of row count).
function ensurePoll() {
	if (pollStarted) return;
	pollStarted = true;
	poll.add(refreshStatus, 3);
}

function isRunning(name) {
	return !!(statusCache[name] && statusCache[name].running);
}

// Call a single-rule control command on the init script.
function ruleAction(action, name) {
	return fs.exec(INIT, [ action, name ]).then(function (res) {
		if (res && res.code !== 0)
			ui.addNotification(null, E('p', {}, '操作失败：%s'.format((res.stderr || res.stdout || '未知错误'))), 'error');
		return res;
	}).catch(function (e) {
		ui.addNotification(null, E('p', {}, '操作失败：%s'.format(e.message || e)), 'error');
	});
}

// Set enabled flag in UCI and save, then run an action.
// enabledVal: '1' to enable, '0' to disable, null to skip UCI change.
function ruleActionWithEnabled(action, name, section_id, enabledVal) {
	var p = Promise.resolve();
	if (enabledVal !== null) {
		p = uci.set('udp2raw', section_id, 'enabled', enabledVal)
			.then(function () { return uci.save(); })
			.then(function () { return uci.apply(); })
			.catch(function () {});
	}
	return p.then(function () { return ruleAction(action, name); });
}

// Run an action with visual feedback and UCI enabled-flag sync.
function runRuleAction(action, name, section_id) {
	var enabled = uci.get('udp2raw', section_id, 'enabled');
	var isEnabled = (enabled === '1' || enabled === undefined);

	transient[name] = (action === 'rule_stop') ? '停止中'
		: (action === 'rule_restart') ? '重启中' : '启动中';
	rowUpdaters.forEach(function (fn) { try { fn(); } catch (e) { } });

	var p;
	if (action === 'rule_stop') {
		// Stop: run stop first, then disable in UCI
		p = ruleAction('rule_stop', name).then(function () {
			return uci.set('udp2raw', section_id, 'enabled', '0');
		}).then(function () {
			return uci.save();
		}).then(function () {
			return uci.apply();
		}).catch(function () {});
	} else if (action === 'rule_start') {
		// Start: enable in UCI first, then start
		p = uci.set('udp2raw', section_id, 'enabled', '1')
			.then(function () { return uci.save(); })
			.then(function () { return uci.apply(); })
			.then(function () { return ruleAction('rule_start', name); })
			.catch(function () {});
	} else {
		// Restart: if already enabled just restart; if disabled, enable first
		if (isEnabled) {
			p = ruleAction('rule_restart', name);
		} else {
			p = uci.set('udp2raw', section_id, 'enabled', '1')
				.then(function () { return uci.save(); })
				.then(function () { return uci.apply(); })
				.then(function () { return ruleAction('rule_start', name); })
				.catch(function () {});
		}
	}

	return p.then(function () {
		return new Promise(function (resolve) {
			setTimeout(function () {
				refreshStatus().then(function () {
					delete transient[name];
					rowUpdaters.forEach(function (fn) { try { fn(); } catch (e) { } });
					setTimeout(refreshStatus, 1500);
					resolve();
				});
			}, 700);
		});
	});
}

return view.extend({
	load: function () {
		return Promise.all([
			uci.load('udp2raw'),
			network.getNetworks(),
			L.resolveDefault(network.getWANNetworks(), [])
		]);
	},

	render: function (data) {
		var m, s, o;
		var networks = (data && data[1]) || [];
		var wanNets = (data && data[2]) || [];

		// Reset per-render shared state so updaters don't accumulate on re-render.
		rowUpdaters = [];

		// Detect the current physical WAN logical interface.
		var curWanIface = 'wan';
		if (wanNets.length)
			curWanIface = wanNets[0].getName();
		var autoLabel = '自动（当前 %s）'.format(curWanIface);

		m = new form.Map('udp2raw', 'UDP2RAW',
			'将 UDP 流量伪装成 FakeTCP/UDP/ICMP，绕过 UDP QoS 限速或封锁。可添加多条规则，每条独立作为服务端或客户端。配合 WireGuard/AmneziaWG 使用效果最佳。');

		// ---- 全局设置 ----
		s = m.section(form.NamedSection, 'global', 'global', '全局设置');
		s.addremove = false;

		o = s.option(form.Value, 'dns_server', '解析 DNS',
			'用于解析对端域名的 DNS 服务器。建议填 IPv4 地址（如 1.1.1.1），同样能解析 IPv6（AAAA）记录；若填 IPv6 DNS，则本机必须有 IPv6 网络否则解析失败。留空则使用系统默认 DNS。解析失败时会自动降级到系统默认 DNS 重试。');
		o.default = '1.1.1.1';
		o.rmempty = false;

		o = s.option(form.Value, 'check_interval', '检测间隔（秒）',
			'多久重新解析一次客户端域名，若对端 IP 变化则自动重启隧道。');
		o.datatype = 'uinteger';
		o.default = '60';

		o = s.option(form.Value, 'log_max', '日志保留条数',
			'每条规则最多保留的日志行数。');
		o.datatype = 'uinteger';
		o.default = '100';

		o = s.option(form.Flag, 'bypass_proxy', 'DNS 解析绕过代理',
			'强制发往上面「解析 DNS」的查询走物理 WAN 出口，不经过任何代理（如 WireGuard）。避免隧道断开后因解析走隧道而无法重连的死锁。除非有特殊分流需求，建议保持开启。');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.ListValue, 'wan_iface', '外网接口',
			'「DNS 解析绕过代理」使用的物理外网接口。留空为自动检测（默认 wan 接口）。若外网口改过名或有多 WAN，请手动指定。');
		o.value('', autoLabel);
		networks.forEach(function (net) {
			var name = net.getName();
			if (name === 'loopback' || name.charAt(0) === '@') return;
			o.value(name, name);
		});
		o.default = '';
		o.depends('bypass_proxy', '1');

		o = s.option(form.Flag, 'ttl_normalize', 'TTL 归一化（服务端）',
			'将出口包的 TTL（IPv4）和 hoplimit（IPv6）强制设为 64，抹除隧道中转痕迹，' +
			'使出口流量看起来像本地直发，避免被运营商 DPI 识别为代理/隧道流量。' +
			'仅服务端出口需要，客户端开启无副作用。使用「外网接口」字段指定出口设备。');
		o.default = '1';
		o.rmempty = false;

		// ---- 规则列表 ----
		s = m.section(form.GridSection, 'rule', '隧道规则',
			'每条规则是一个独立的 udp2raw 实例。服务端 = 有公网 IP/IPv6 的一方；客户端 = 处于 NAT 后的一方。');
		s.addremove = true;
		s.anonymous = true;
		s.sortable = true;
		s.nodescriptions = true;
		s.addbtntitle = '添加规则';

		// --- 列表显示的列 ---
		o = s.option(form.Flag, 'enabled', '启用');
		o.editable = true;

		o = s.option(form.Value, 'name', '名称');
		o.rmempty = false;
		o.placeholder = 'peerA';

		o = s.option(form.ListValue, 'mode', '模式');
		o.value('server', '服务端');
		o.value('client', '客户端');
		o.default = 'client';

		o = s.option(form.DummyValue, '_target', '目标');
		o.modalonly = false;
		o.textvalue = function (section_id) {
			var mode = uci.get('udp2raw', section_id, 'mode') || 'client';
			var name = uci.get('udp2raw', section_id, 'name') || section_id;
			if (mode === 'server') {
				var lp = uci.get('udp2raw', section_id, 'listen_port') || '?';
				var fa = uci.get('udp2raw', section_id, 'forward_addr') || '127.0.0.1';
				var fp = uci.get('udp2raw', section_id, 'forward_port') || '?';
				return '监听 :%s → %s:%s'.format(lp, fa, fp);
			} else {
				var a = uci.get('udp2raw', section_id, 'address') || '?';
				var p = uci.get('udp2raw', section_id, 'port') || '?';
				var line1 = '%s:%s'.format(a, p);

				// For domain-based client rules, show the currently-resolved IP
				// underneath the address (from init.d's .resolved state file).
				var isDomain = a && !/^[0-9.]+$/.test(a) && !/:/.test(a) && a !== '?';
				if (!isDomain) return line1;

				var resId = 'res_' + section_id;
				var upd = function () {
					var el = document.getElementById(resId);
					if (!el) return;
					var ip = resolvedCache[name];
					el.textContent = ip ? ('当前解析：' + ip) : '当前解析：—';
				};
				rowUpdaters.push(upd);
				ensurePoll();
				requestAnimationFrame(upd);
				return E('div', {}, [
					E('div', {}, line1),
					E('div', { 'id': resId, 'style': 'font-size:12px;color:#666;margin-top:2px' }, '当前解析：—')
				]);
			}
		};

		o = s.option(form.DummyValue, '_status', '状态');
		o.modalonly = false;
		o.textvalue = function (section_id) {
			var name = uci.get('udp2raw', section_id, 'name') || section_id;
			if (allRuleNames.indexOf(name) === -1) allRuleNames.push(name);
			var stId  = 'st_'  + section_id;
			var cnId  = 'cn_'  + section_id;
			var actId = 'act_' + section_id;

			var mkBtn = function (label, cls, action, disabled) {
				var attrs = { 'class': 'cbi-button cbi-button-' + cls, 'style': 'margin:0 2px' };
				if (disabled) {
					attrs.disabled = 'disabled';
				} else {
					attrs.click = ui.createHandlerFn(this, function () {
						return runRuleAction(action, name, section_id);
					});
				}
				return E('button', attrs, label);
			};

			var connInfo = function (running) {
				if (!running) return null;
				// udp2raw uses raw sockets, conntrack has no TCP state for it.
				// Only show a log link, not a connection state.
				return { showLog: true };
			};

			var updater = function () {
				var stEl  = document.getElementById(stId);
				var cnEl  = document.getElementById(cnId);
				var actEl = document.getElementById(actId);
				if (!stEl && !cnEl && !actEl) return;
				var t       = transient[name];
				var running = isRunning(name);

				if (stEl) {
					if (t)
						stEl.innerHTML = '<span style="color:#ef6c00"><strong>' + t + '</strong></span>';
					else
						stEl.innerHTML = running
							? '<span style="color:#2e7d32"><strong>运行中</strong></span>'
							: '<span style="color:#999">已停止</span>';
				}

				if (cnEl) {
					cnEl.innerHTML = '';
					if (running && !t) {
						cnEl.appendChild(E('a', {
							'href': '#',
							'style': 'font-size:12px;color:#337ab7',
							'click': function (ev) { ev.preventDefault(); showRuleLogModal(name); }
						}, '查看日志'));
					}
				}

				if (actEl) {
					var busy = !!t;
					var btns = running
						? [ mkBtn('重启', 'action',   'rule_restart', busy),
						    mkBtn('停止', 'negative', 'rule_stop',    busy) ]
						: [ mkBtn('启动', 'positive', 'rule_start',   busy),
						    mkBtn('停止', 'neutral',  'rule_stop',    true) ];
					actEl.innerHTML = '';
					btns.forEach(function (b) { actEl.appendChild(b); });
				}
			};
			rowUpdaters.push(updater);
			ensurePoll();
			requestAnimationFrame(updater);

			return E('div', {}, [
				E('div', { 'id': stId }, '…'),
				E('div', { 'id': cnId, 'style': 'margin-top:2px' })
			]);
		};

		// --- 操作按钮列（内容由上面的 updater 统一填充）---
		o = s.option(form.DummyValue, '_actions', '操作');
		o.modalonly = false;
		o.textvalue = function (section_id) {
			return E('div', { 'id': 'act_' + section_id, 'style': 'display:flex;justify-content:center;white-space:nowrap' }, '...');
		};

		// ================= 详细（弹窗）选项 =================

		o = s.option(form.ListValue, 'family', '地址族',
			'仅客户端。解析对端域名时选择记录类型（IPv4=A 记录，IPv6=AAAA 记录）。对端为 IP 时忽略。');
		o.value('ipv4', '仅 IPv4');
		o.value('ipv6', '仅 IPv6');
		o.default = 'ipv4';
		o.depends('mode', 'client');
		o.modalonly = true;

		// --- 客户端专用：对端地址/端口 ---
		o = s.option(form.Value, 'address', '对端地址',
			'仅客户端。对端的 IP 或域名。填域名时会自动解析并监控其变化。');
		o.depends('mode', 'client');
		o.modalonly = true;
		o.rmempty = false;

		o = s.option(form.Value, 'port', '对端端口',
			'仅客户端。对端上的 udp2raw 端口（即服务端的监听端口）。');
		o.datatype = 'port';
		o.depends('mode', 'client');
		o.modalonly = true;
		o.rmempty = false;

		o = s.option(form.Value, 'listen_addr', '本地监听地址',
			'仅客户端。本地暴露隧道 UDP 端点的地址，通常为 127.0.0.1。');
		o.placeholder = '127.0.0.1';
		o.depends('mode', 'client');
		o.modalonly = true;

		o = s.option(form.Value, 'listen_port', '监听端口',
			'服务端：对外监听的 FakeTCP/UDP/ICMP 端口。客户端：本地应用（如 WireGuard 对端端点）连接的 UDP 端口。');
		o.datatype = 'port';
		o.modalonly = true;
		o.rmempty = false;

		// --- 服务端专用：转发目标 ---
		o = s.option(form.Value, 'forward_addr', '转发到地址',
			'仅服务端。要转发到的真实本地 UDP 服务地址（如本地 WireGuard 填 127.0.0.1）。');
		o.placeholder = '127.0.0.1';
		o.depends('mode', 'server');
		o.modalonly = true;

		o = s.option(form.Value, 'forward_port', '转发到端口',
			'仅服务端。真实 UDP 服务端口（如 WireGuard/AmneziaWG 的 51820）。');
		o.datatype = 'port';
		o.depends('mode', 'server');
		o.modalonly = true;
		o.rmempty = false;

		// --- 共享加密/混淆参数（两端必须一致）---
		o = s.option(form.Value, 'password', '密码',
			'预共享密码，两端必须完全一致。点击「生成」可自动创建随机密码。');
		o.password = true;
		o.modalonly = true;
		o.rmempty = false;
		o.renderWidget = function (section_id, option_index, cfgvalue) {
			var node = form.Value.prototype.renderWidget.apply(this, arguments);
			var self = this;
			var btn = E('button', {
				'class': 'cbi-button cbi-button-neutral',
				'style': 'margin-left:6px',
				'click': function (ev) {
					ev.preventDefault();
					var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
					var pw = '';
					var arr = new Uint32Array(16);
					(window.crypto || window.msCrypto).getRandomValues(arr);
					for (var i = 0; i < 16; i++)
						pw += chars.charAt(arr[i] % chars.length);
					var input = node.querySelector('input');
					if (input) {
						input.value = pw;
						input.dispatchEvent(new Event('input', { bubbles: true }));
						input.dispatchEvent(new Event('change', { bubbles: true }));
					}
					return false;
				}
			}, '生成');
			return E('div', { 'style': 'display:flex;align-items:center' }, [ node, btn ]);
		};

		o = s.option(form.ListValue, 'raw_mode', '伪装模式',
			'数据包伪装方式，两端必须一致。');
		o.value('faketcp', 'faketcp');
		o.value('udp', 'udp');
		o.value('icmp', 'icmp');
		o.default = 'faketcp';
		o.modalonly = true;

		o = s.option(form.ListValue, 'cipher_mode', '加密方式');
		o.value('aes128cbc', 'aes128cbc');
		o.value('xor', 'xor');
		o.value('none', 'none');
		o.default = 'aes128cbc';
		o.modalonly = true;

		o = s.option(form.ListValue, 'auth_mode', '认证方式');
		o.value('md5', 'md5');
		o.value('crc32', 'crc32');
		o.value('simple', 'simple');
		o.value('none', 'none');
		o.default = 'md5';
		o.modalonly = true;

		o = s.option(form.ListValue, 'seq_mode', 'Seq 模式',
			'faketcp 的 seq 模式（0-4）。3 模拟接近真实的 TCP 握手过程。');
		o.value('0', '0');
		o.value('1', '1');
		o.value('2', '2');
		o.value('3', '3');
		o.value('4', '4');
		o.default = '3';
		o.depends('raw_mode', 'faketcp');
		o.modalonly = true;

		o = s.option(form.Value, 'sock_buf', 'Socket 缓冲区（KB）',
			'Socket 缓冲区大小，范围 10-10240。并非越大越好，默认 1024。');
		o.datatype = 'range(10,10240)';
		o.default = '1024';
		o.modalonly = true;

		o = s.option(form.Flag, 'auto_fw', '自动防火墙（服务端）',
			'仅服务端。勾选后自动向系统防火墙写入放行规则（IPv4 + IPv6），无需手动配置。' +
			'规则会出现在系统「防火墙」页面，取消勾选并保存会自动清除。' +
			'使用 fw4 UCI 方式，兼容 iptables-nft 和 iptables-legacy 环境。');
		o.default = '1';
		o.rmempty = false;
		o.depends('mode', 'server');
		o.modalonly = true;

		o = s.option(form.Flag, 'route_via_wan', '服务端例外路由',
			'仅客户端。当本机默认路由整体指向隧道（如 WireGuard 全局代理）时，' +
			'去 udp2raw 服务端的流量会进入隧道，形成死锁。' +
			'勾选后自动为服务端 IP 写入走物理 WAN 的 /32(/128) 静态路由，绕过隧道。' +
			'规则可在「网络 → 静态路由」页面看到（udp2raw_ 前缀）。' +
			'仅全局代理场景需要；普通场景请保持关闭。');
		o.default = '0';
		o.depends('mode', 'client');
		o.modalonly = true;

		o = s.option(form.Flag, 'retry_on_error', '出错重试',
			'传入 --retry-on-error，让 udp2raw 出错时持续重试而非退出。');
		o.default = '1';
		o.modalonly = true;

		o = s.option(form.Flag, 'fix_gro', '修复 GRO',
			'启用 --fix-gro。大包传输异常时可尝试开启。');
		o.default = '0';
		o.modalonly = true;

		o = s.option(form.ListValue, 'log_level', '日志级别');
		o.value('0', '关闭');
		o.value('1', '致命');
		o.value('2', '错误');
		o.value('3', '警告');
		o.value('4', '信息');
		o.value('5', '调试');
		o.default = '4';
		o.modalonly = true;

		o = s.option(form.Value, 'extra_args', '额外参数',
			'传递给 udp2raw 的额外原始命令行参数。');
		o.modalonly = true;

		return m.render();
	}
});

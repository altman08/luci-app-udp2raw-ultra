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
	}, _("Loading…"));
	ui.showModal(_("Rule log: %s").format(name), [
		E('p', { 'style': 'color:#666;font-size:12px;margin-top:0' },
			_("Recent 100 relevant log events (frequent noise is filtered out).")),
		pre,
		E('div', { 'class': 'right', 'style': 'margin-top:12px' }, [
			E('button', { 'class': 'cbi-button cbi-button-neutral', 'click': ui.hideModal }, _("Close"))
		])
	]);
	getRuleLog(name).then(function (text) {
		var el = document.getElementById(logId);
		if (el) el.textContent = text || _("(No relevant logs yet)");
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
			ui.addNotification(null, E('p', {}, _("Operation failed: %s").format((res.stderr || res.stdout || _("Unknown error")))), 'error');
		return res;
	}).catch(function (e) {
		ui.addNotification(null, E('p', {}, _("Operation failed: %s").format(e.message || e)), 'error');
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

	transient[name] = (action === 'rule_stop') ? _("Stopping")
		: (action === 'rule_restart') ? _("Restarting") : _("Starting");
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
		var autoLabel = _("Automatic (currently %s)").format(curWanIface);

		m = new form.Map('udp2raw', _("UDP Traffic Obfuscation"),
			_("Encapsulate UDP traffic as FakeTCP/UDP/ICMP to bypass UDP throttling or blocking. Each rule runs as an independent server or client. Works best with WireGuard/AmneziaWG."));

		// ---- 全局设置 ----
		s = m.section(form.NamedSection, 'global', 'global', _("Global settings"));
		s.addremove = false;

		o = s.option(form.Value, 'dns_server', _("DNS server"),
			_("DNS server used to resolve peer hostnames. An IPv4 address (e.g. 1.1.1.1) can also resolve IPv6 (AAAA) records. An IPv6 DNS server requires working IPv6 connectivity. Leave empty to use system DNS. Failed queries fall back to system DNS."));
		o.default = '1.1.1.1';
		o.rmempty = false;

		o = s.option(form.Value, 'check_interval', _("Check interval (seconds)"),
			_("How often to resolve client peer hostnames again. The tunnel restarts automatically when the peer IP changes."));
		o.datatype = 'uinteger';
		o.default = '60';

		o = s.option(form.Value, 'log_max', _("Log line limit"),
			_("Maximum number of log lines retained for each rule."));
		o.datatype = 'uinteger';
		o.default = '100';

		o = s.option(form.Flag, 'bypass_proxy', _("Bypass proxy for DNS queries"),
			_("Send queries to the configured DNS server through the physical WAN, bypassing proxies such as WireGuard. This prevents a disconnected tunnel from blocking DNS resolution and reconnection. Keep enabled unless custom routing requires otherwise."));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.ListValue, 'wan_iface', _("WAN interface"),
			_("Physical WAN interface used to bypass proxies for DNS queries. Leave empty for automatic detection (wan by default). Select an interface if WAN was renamed or multiple WANs exist."));
		o.value('', autoLabel);
		networks.forEach(function (net) {
			var name = net.getName();
			if (name === 'loopback' || name.charAt(0) === '@') return;
			o.value(name, name);
		});
		o.default = '';
		o.depends('bypass_proxy', '1');

		o = s.option(form.Flag, 'ttl_normalize', _("Normalize TTL (server)"),
			_("Set outgoing IPv4 TTL and IPv6 hop limit to 64 to hide tunnel forwarding, making traffic appear locally originated to avoid proxy/tunnel detection by ISP DPI. Only needed on the server egress; harmless on clients. Select the egress device with WAN interface."));
		o.default = '1';
		o.rmempty = false;

		// ---- 规则列表 ----
		s = m.section(form.GridSection, 'rule', _("Tunnel rules"),
			_("Each rule is an independent udp2raw instance. The server has a public IP/IPv6 address; the client is behind NAT."));
		s.addremove = true;
		s.anonymous = true;
		s.sortable = true;
		s.nodescriptions = true;
		s.addbtntitle = _("Add rule");

		// --- 列表显示的列 ---
		o = s.option(form.Flag, 'enabled', _("Enable"));
		o.editable = true;

		o = s.option(form.Value, 'name', _("Name"));
		o.rmempty = false;
		o.placeholder = 'peerA';

		o = s.option(form.ListValue, 'mode', _("Mode"));
		o.value('server', _("Server"));
		o.value('client', _("Client"));
		o.default = 'client';

		o = s.option(form.DummyValue, '_target', _("Target"));
		o.modalonly = false;
		o.textvalue = function (section_id) {
			var mode = uci.get('udp2raw', section_id, 'mode') || 'client';
			var name = uci.get('udp2raw', section_id, 'name') || section_id;
			if (mode === 'server') {
				var lp = uci.get('udp2raw', section_id, 'listen_port') || '?';
				var fa = uci.get('udp2raw', section_id, 'forward_addr') || '127.0.0.1';
				var fp = uci.get('udp2raw', section_id, 'forward_port') || '?';
				return _("Listening :%s → %s:%s").format(lp, fa, fp);
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
					el.textContent = _("Resolved address: %s").format(ip || "—");
				};
				rowUpdaters.push(upd);
				ensurePoll();
				requestAnimationFrame(upd);
				return E('div', {}, [
					E('div', {}, line1),
					E('div', { 'id': resId, 'style': 'font-size:12px;color:#666;margin-top:2px' }, _("Resolved address: %s").format("—"))
				]);
			}
		};

		o = s.option(form.DummyValue, '_status', _("Status"));
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
							? '<span style="color:#2e7d32"><strong>' + _("Running") + '</strong></span>'
							: '<span style="color:#999">' + _("Stopped") + '</span>';
				}

				if (cnEl) {
					cnEl.innerHTML = '';
					if (running && !t) {
						cnEl.appendChild(E('a', {
							'href': '#',
							'style': 'font-size:12px;color:#337ab7',
							'click': function (ev) { ev.preventDefault(); showRuleLogModal(name); }
						}, _("View logs")));
					}
				}

				if (actEl) {
					var busy = !!t;
					var btns = running
						? [ mkBtn(_("Restart"), 'action',   'rule_restart', busy),
						    mkBtn(_("Stop"), 'negative', 'rule_stop',    busy) ]
						: [ mkBtn(_("Start"), 'positive', 'rule_start',   busy),
						    mkBtn(_("Stop"), 'neutral',  'rule_stop',    true) ];
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
		o = s.option(form.DummyValue, '_actions', _("Actions"));
		o.modalonly = false;
		o.textvalue = function (section_id) {
			return E('div', { 'id': 'act_' + section_id, 'style': 'display:flex;justify-content:center;white-space:nowrap' }, '...');
		};

		// ================= 详细（弹窗）选项 =================

		o = s.option(form.ListValue, 'family', _("Address family"),
			_("Client only. Select the DNS record type for peer hostnames (IPv4=A, IPv6=AAAA). Ignored for IP literals."));
		o.value('ipv4', _("IPv4 only"));
		o.value('ipv6', _("IPv6 only"));
		o.default = 'ipv4';
		o.depends('mode', 'client');
		o.modalonly = true;

		// --- 客户端专用：对端地址/端口 ---
		o = s.option(form.Value, 'address', _("Peer address"),
			_("Client only. Peer IP address or hostname. Hostnames are resolved automatically and monitored for changes."));
		o.depends('mode', 'client');
		o.modalonly = true;
		o.rmempty = false;

		o = s.option(form.Value, 'port', _("Peer port"),
			_("Client only. The remote udp2raw port (the server listening port)."));
		o.datatype = 'port';
		o.depends('mode', 'client');
		o.modalonly = true;
		o.rmempty = false;

		o = s.option(form.Value, 'listen_addr', _("Local listen address"),
			_("Client only. Address of the local UDP tunnel endpoint, usually 127.0.0.1."));
		o.placeholder = '127.0.0.1';
		o.depends('mode', 'client');
		o.modalonly = true;

		o = s.option(form.Value, 'listen_port', _("Listen port"),
			_("Server: public FakeTCP/UDP/ICMP port. Client: local UDP port used by applications such as WireGuard."));
		o.datatype = 'port';
		o.modalonly = true;
		o.rmempty = false;

		// --- 服务端专用：转发目标 ---
		o = s.option(form.Value, 'forward_addr', _("Forward address"),
			_("Server only. Address of the actual local UDP service (e.g. 127.0.0.1 for local WireGuard)."));
		o.placeholder = '127.0.0.1';
		o.depends('mode', 'server');
		o.modalonly = true;

		o = s.option(form.Value, 'forward_port', _("Forward port"),
			_("Server only. Port of the actual UDP service (e.g. 51820 for WireGuard/AmneziaWG)."));
		o.datatype = 'port';
		o.depends('mode', 'server');
		o.modalonly = true;
		o.rmempty = false;

		// --- 共享加密/混淆参数（两端必须一致）---
		o = s.option(form.Value, 'password', _("Password"),
			_("Pre-shared password; must match on both ends. Click Generate to create a random password."));
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
			}, _("Generate"));
			return E('div', { 'style': 'display:flex;align-items:center' }, [ node, btn ]);
		};

		o = s.option(form.ListValue, 'raw_mode', _("Raw mode"),
			_("Packet encapsulation mode; must match on both ends."));
		o.value('faketcp', 'faketcp');
		o.value('udp', 'udp');
		o.value('icmp', 'icmp');
		o.default = 'faketcp';
		o.modalonly = true;

		o = s.option(form.ListValue, 'cipher_mode', _("Cipher mode"));
		o.value('aes128cbc', 'aes128cbc');
		o.value('xor', 'xor');
		o.value('none', 'none');
		o.default = 'aes128cbc';
		o.modalonly = true;

		o = s.option(form.ListValue, 'auth_mode', _("Authentication mode"));
		o.value('md5', 'md5');
		o.value('crc32', 'crc32');
		o.value('simple', 'simple');
		o.value('none', 'none');
		o.default = 'md5';
		o.modalonly = true;

		o = s.option(form.ListValue, 'seq_mode', _("Sequence mode"),
			_("FakeTCP sequence mode (0-4). Mode 3 closely simulates a real TCP handshake."));
		o.value('0', '0');
		o.value('1', '1');
		o.value('2', '2');
		o.value('3', '3');
		o.value('4', '4');
		o.default = '3';
		o.depends('raw_mode', 'faketcp');
		o.modalonly = true;

		o = s.option(form.Value, 'sock_buf', _("Socket buffer (KB)"),
			_("Socket buffer size, 10-10240 KB. Larger is not always better. Default: 1024."));
		o.datatype = 'range(10,10240)';
		o.default = '1024';
		o.modalonly = true;

		o = s.option(form.Flag, 'auto_fw', _("Automatic firewall (server)"),
			_("Server only. Automatically add IPv4 and IPv6 allow rules to the system firewall. Rules appear on the Firewall page and are removed when this option is disabled and saved. Uses fw4 UCI configuration, compatible with iptables-nft and iptables-legacy environments."));
		o.default = '1';
		o.rmempty = false;
		o.depends('mode', 'server');
		o.modalonly = true;

		o = s.option(form.Flag, 'route_via_wan', _("Route server via WAN"),
			_("Client only. When the default route points into a tunnel (e.g. full-tunnel WireGuard), traffic to the udp2raw server can enter the tunnel and cause a routing deadlock. Add a /32 (IPv4) or /128 (IPv6) static route for the server IP through the physical WAN. Rules appear on Network → Static Routes with the udp2raw_ prefix. Only needed with full-tunnel routing; otherwise leave disabled."));
		o.default = '0';
		o.depends('mode', 'client');
		o.modalonly = true;

		o = s.option(form.Flag, 'retry_on_error', _("Retry on error"),
			_("Pass --retry-on-error so udp2raw keeps retrying instead of exiting on errors."));
		o.default = '1';
		o.modalonly = true;

		o = s.option(form.Flag, 'fix_gro', _("Fix GRO"),
			_("Enable --fix-gro. Try this if large packet transfers fail."));
		o.default = '0';
		o.modalonly = true;

		o = s.option(form.ListValue, 'log_level', _("Log level"));
		o.value('0', _("Close"));
		o.value('1', _("Fatal"));
		o.value('2', _("Error"));
		o.value('3', _("Warning"));
		o.value('4', _("Info"));
		o.value('5', _("Debug"));
		o.default = '4';
		o.modalonly = true;

		o = s.option(form.Value, 'extra_args', _("Extra arguments"),
			_("Additional raw command-line arguments passed to udp2raw."));
		o.modalonly = true;

		return m.render();
	}
});

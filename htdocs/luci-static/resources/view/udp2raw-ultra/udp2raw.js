'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require poll';
'require network';

var callServiceList = rpc.declare({
	object: 'service',
	method: 'list',
	params: [ 'name' ],
	expect: { '': {} }
});

function getStatus() {
	return L.resolveDefault(callServiceList('udp2raw'), {}).then(function (res) {
		var instances = {};
		try {
			instances = res['udp2raw']['instances'] || {};
		} catch (e) { }
		return instances;
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

		// Detect the current physical WAN logical interface.
		var curWanIface = 'wan';
		if (wanNets.length)
			curWanIface = wanNets[0].getName();
		var autoLabel = '自动（当前 %s）'.format(curWanIface);

		m = new form.Map('udp2raw', 'UDP2RAW Ultra',
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
			if (mode === 'server') {
				var lp = uci.get('udp2raw', section_id, 'listen_port') || '?';
				var fa = uci.get('udp2raw', section_id, 'forward_addr') || '127.0.0.1';
				var fp = uci.get('udp2raw', section_id, 'forward_port') || '?';
				return '监听 :%s → %s:%s'.format(lp, fa, fp);
			} else {
				var a = uci.get('udp2raw', section_id, 'address') || '?';
				var p = uci.get('udp2raw', section_id, 'port') || '?';
				return '%s:%s'.format(a, p);
			}
		};

		o = s.option(form.DummyValue, '_status', '状态');
		o.modalonly = false;
		o.textvalue = function (section_id) {
			var name = uci.get('udp2raw', section_id, 'name') || section_id;
			var id = 'st_' + section_id;
			poll.add(function () {
				return getStatus().then(function (inst) {
					var el = document.getElementById(id);
					if (!el) return;
					var running = inst[name] && inst[name].running;
					el.innerHTML = running
						? '<span style="color:green"><strong>运行中</strong></span>'
						: '<span style="color:#999">已停止</span>';
				});
			});
			return E('span', { 'id': id }, '...');
		};

		// ================= 详细（弹窗）选项 =================

		o = s.option(form.ListValue, 'family', '地址族',
			'自动模式优先 IPv4（A 记录），其次 IPv6（AAAA）。每条隧道只使用一种地址族。');
		o.value('auto', '自动（优先 IPv4）');
		o.value('ipv4', '仅 IPv4');
		o.value('ipv6', '仅 IPv6');
		o.default = 'auto';
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

		o = s.option(form.Flag, 'auto_rule', '自动防火墙规则',
			'添加 iptables 规则（-a）丢弃 RST 包。faketcp 模式推荐开启。');
		o.default = '1';
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

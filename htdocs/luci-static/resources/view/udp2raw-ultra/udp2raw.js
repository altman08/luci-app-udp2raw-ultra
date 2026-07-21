'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require poll';

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
			uci.load('udp2raw')
		]);
	},

	render: function () {
		var m, s, o;

		m = new form.Map('udp2raw', _('UDP2RAW Ultra'),
			_('Tunnel UDP traffic over FakeTCP/UDP/ICMP to bypass UDP QoS/blocking. Add multiple rules, each acting as a server or a client. Works well with WireGuard/AmneziaWG.'));

		// ---- Global settings ----
		s = m.section(form.NamedSection, 'global', 'global', _('Global Settings'));
		s.addremove = false;

		o = s.option(form.Value, 'dns_server', _('Resolver DNS'),
			_('DNS server used to resolve peer domains. Helps with unstable dynamic IPs. IPv6 DNS is fine here.'));
		o.default = '2606:4700:4700::1111';
		o.rmempty = false;

		o = s.option(form.Value, 'check_interval', _('Check Interval (s)'),
			_('How often to re-resolve client domains and restart the tunnel if the peer IP changed.'));
		o.datatype = 'uinteger';
		o.default = '60';

		o = s.option(form.Value, 'log_max', _('Log Lines Kept'),
			_('Maximum number of log lines kept per rule.'));
		o.datatype = 'uinteger';
		o.default = '100';

		// ---- Rules list ----
		s = m.section(form.GridSection, 'rule', _('Tunnel Rules'),
			_('Each rule is an independent udp2raw instance. Server = the side with a public IP/IPv6; Client = the side behind NAT.'));
		s.addremove = true;
		s.anonymous = true;
		s.sortable = true;
		s.nodescriptions = true;
		s.addbtntitle = _('Add rule');

		// --- Columns shown in the grid ---
		o = s.option(form.Flag, 'enabled', _('Enable'));
		o.editable = true;

		o = s.option(form.Value, 'name', _('Name'));
		o.rmempty = false;
		o.placeholder = 'peerA';

		o = s.option(form.ListValue, 'mode', _('Mode'));
		o.value('server', _('Server'));
		o.value('client', _('Client'));
		o.default = 'client';

		o = s.option(form.DummyValue, '_target', _('Target'));
		o.modalonly = false;
		o.textvalue = function (section_id) {
			var mode = uci.get('udp2raw', section_id, 'mode') || 'client';
			if (mode === 'server') {
				var lp = uci.get('udp2raw', section_id, 'listen_port') || '?';
				var fa = uci.get('udp2raw', section_id, 'forward_addr') || '127.0.0.1';
				var fp = uci.get('udp2raw', section_id, 'forward_port') || '?';
				return _('listen :%s → %s:%s').format(lp, fa, fp);
			} else {
				var a = uci.get('udp2raw', section_id, 'address') || '?';
				var p = uci.get('udp2raw', section_id, 'port') || '?';
				return _('%s:%s').format(a, p);
			}
		};

		o = s.option(form.DummyValue, '_status', _('Status'));
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
						? '<span style="color:green"><strong>' + _('running') + '</strong></span>'
						: '<span style="color:#999">' + _('stopped') + '</span>';
				});
			});
			return E('span', { 'id': id }, _('...'));
		};

		// ================= Detailed (modal) options =================

		o = s.option(form.ListValue, 'family', _('Address Family'),
			_('Auto prefers IPv4 (A record), then IPv6 (AAAA). Only one family is used per tunnel.'));
		o.value('auto', _('Auto (IPv4 first)'));
		o.value('ipv4', _('IPv4 only'));
		o.value('ipv6', _('IPv6 only'));
		o.default = 'auto';
		o.modalonly = true;

		// --- Client-only: peer address/port ---
		o = s.option(form.Value, 'address', _('Peer Address'),
			_('Client only. The peer IP or domain. If a domain is entered it is auto-resolved and monitored for changes.'));
		o.depends('mode', 'client');
		o.modalonly = true;
		o.rmempty = false;

		o = s.option(form.Value, 'port', _('Peer Port'),
			_('Client only. The udp2raw port on the peer (server listen port).'));
		o.datatype = 'port';
		o.depends('mode', 'client');
		o.modalonly = true;
		o.rmempty = false;

		o = s.option(form.Value, 'listen_addr', _('Local Listen Address'),
			_('Client only. Local address to expose the tunnel UDP endpoint. Usually 127.0.0.1.'));
		o.placeholder = '127.0.0.1';
		o.depends('mode', 'client');
		o.modalonly = true;

		o = s.option(form.Value, 'listen_port', _('Listen Port'),
			_('Server: the public FakeTCP/UDP/ICMP port to listen on. Client: local UDP port your app (e.g. WireGuard peer endpoint) connects to.'));
		o.datatype = 'port';
		o.modalonly = true;
		o.rmempty = false;

		// --- Server-only: forward target ---
		o = s.option(form.Value, 'forward_addr', _('Forward To Address'),
			_('Server only. The real local UDP service to forward to (e.g. 127.0.0.1 for local WireGuard).'));
		o.placeholder = '127.0.0.1';
		o.depends('mode', 'server');
		o.modalonly = true;

		o = s.option(form.Value, 'forward_port', _('Forward To Port'),
			_('Server only. The real UDP service port (e.g. 51820 for WireGuard/AmneziaWG).'));
		o.datatype = 'port';
		o.depends('mode', 'server');
		o.modalonly = true;
		o.rmempty = false;

		// --- Shared crypto/obfuscation (must match on both sides) ---
		o = s.option(form.Value, 'password', _('Password'),
			_('Pre-shared password. Must be identical on both sides.'));
		o.password = true;
		o.modalonly = true;
		o.rmempty = false;

		o = s.option(form.ListValue, 'raw_mode', _('Raw Mode'),
			_('Packet disguise. Must match on both sides.'));
		o.value('faketcp', 'faketcp');
		o.value('udp', 'udp');
		o.value('icmp', 'icmp');
		o.default = 'faketcp';
		o.modalonly = true;

		o = s.option(form.ListValue, 'cipher_mode', _('Cipher Mode'));
		o.value('aes128cbc', 'aes128cbc');
		o.value('xor', 'xor');
		o.value('none', 'none');
		o.default = 'aes128cbc';
		o.modalonly = true;

		o = s.option(form.ListValue, 'auth_mode', _('Auth Mode'));
		o.value('md5', 'md5');
		o.value('crc32', 'crc32');
		o.value('simple', 'simple');
		o.value('none', 'none');
		o.default = 'md5';
		o.modalonly = true;

		o = s.option(form.ListValue, 'seq_mode', _('Seq Mode'),
			_('faketcp seq mode (0-4). 3 simulates a near-real TCP handshake.'));
		o.value('0', '0');
		o.value('1', '1');
		o.value('2', '2');
		o.value('3', '3');
		o.value('4', '4');
		o.default = '3';
		o.depends('raw_mode', 'faketcp');
		o.modalonly = true;

		o = s.option(form.Value, 'sock_buf', _('Socket Buffer (KB)'),
			_('Socket buffer size, 10-10240. Bigger is not always better. Default 1024.'));
		o.datatype = 'range(10,10240)';
		o.default = '1024';
		o.modalonly = true;

		o = s.option(form.Flag, 'auto_rule', _('Auto Firewall Rule'),
			_('Add iptables rule (-a) to drop RST. Recommended for faketcp.'));
		o.default = '1';
		o.modalonly = true;

		o = s.option(form.Flag, 'retry_on_error', _('Retry On Error'),
			_('Pass --retry-on-error so udp2raw keeps retrying instead of exiting.'));
		o.default = '1';
		o.modalonly = true;

		o = s.option(form.Flag, 'fix_gro', _('Fix GRO'),
			_('Enable --fix-gro. Try if large packets misbehave.'));
		o.default = '0';
		o.modalonly = true;

		o = s.option(form.ListValue, 'log_level', _('Log Level'));
		o.value('0', _('never'));
		o.value('1', _('fatal'));
		o.value('2', _('error'));
		o.value('3', _('warn'));
		o.value('4', _('info'));
		o.value('5', _('debug'));
		o.default = '4';
		o.modalonly = true;

		o = s.option(form.Value, 'extra_args', _('Extra Arguments'),
			_('Additional raw command line arguments passed to udp2raw.'));
		o.modalonly = true;

		return m.render();
	}
});

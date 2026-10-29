#!/usr/bin/env python3
"""Exercise monitor lifecycle with mocked UCI/procd, without changing host routes."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
FILES = ROOT / 'luci-app-udp2raw-ultra/root'


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='udp2raw-monitor-')
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.events = self.work / 'events'
        self.events.touch()
        self.helpers = self.work / 'helpers'
        self.helpers.mkdir()
        for name in ['resolve.sh', 'monitor.sh']:
            source = (FILES / 'usr/share/udp2raw-ultra' / name).read_text()
            source = source.replace('/usr/share/udp2raw-ultra/', str(self.helpers) + '/')
            source = source.replace('/lib/functions.sh', str(self.work / 'functions.sh'))
            source = source.replace('/var/run/udp2raw-ultra', str(self.work / 'state'))
            path = self.helpers / name
            path.write_text(source)
            path.chmod(0o755)
        # Prevent the tests from touching host networking or the firewall.
        (self.helpers / 'bypass.sh').touch()
        (self.helpers / 'route.sh').touch()
        (self.helpers / 'nftrules.sh').write_text('#!/bin/sh\nexit 0\n')
        (self.helpers / 'nftrules.sh').chmod(0o755)
        source = (FILES / 'etc/init.d/udp2raw').read_text()
        source = source.replace('/usr/share/udp2raw-ultra/', str(self.helpers) + '/')
        source = source.replace('/var/log/udp2raw', str(self.work / 'logs'))
        self.init = self.work / 'init.sh'
        self.init.write_text(source)

    def configure(self, rules, bypass='1'):
        sections = ['rule%d' % n for n in range(len(rules))]
        values = {'global': {'dns_server': '1.1.1.1', 'bypass_proxy': bypass}}
        values.update(zip(sections, rules))
        cases = []
        for section, options in values.items():
            for option, value in options.items():
                cases.append('%s:%s) value=%s ;;' % (section, option, shlex.quote(value)))
        functions = '''
config_load() { :; }
config_get() {
    local dest="$1" value="${4-}"
    case "$2:$3" in
    %s
    esac
    export "$dest=$value"
}
config_get_bool() {
    config_get "$@"
}
config_foreach() {
    local section
    for section in %s; do "$1" "$section"; done
}
procd_open_instance() { printf 'instance %%s\\n' "$1" >> "$EVENTS"; }
procd_set_param() { :; }
procd_close_instance() { :; }
u2r_bypass_add() { printf 'bypass %%s\\n' "$1" >> "$EVENTS"; }
nslookup() { printf 'Name: peer.example\\nAddress: 198.51.100.5\\n'; }
# Reach the first polling sleep, then exit instead of leaving a test daemon.
sleep() { printf 'sleep %%s\\n' "$1" >> "$EVENTS"; exit 91; }
''' % ('\n    '.join(cases), ' '.join(sections))
        (self.work / 'functions.sh').write_text(functions)
        self.events.write_text('')

    def execute(self, mode):
        if mode == 'init':
            script = '. "$1/functions.sh"\n. "$1/init.sh"\nstart_rule() { :; }\nstart_service\n'
            args = ['sh', '-c', script, 'test', str(self.work)]
        else:
            args = ['sh', str(self.helpers / 'monitor.sh')]
        result = subprocess.run(args, env=dict(os.environ, EVENTS=str(self.events), LC_ALL='C'),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        return result.returncode, self.events.read_text().splitlines()

    def test_no_monitor_or_dns_bypass_without_enabled_hostname_clients(self):
        cases = [[],
                 [{'enabled': '0', 'address': 'peer.example'}],
                 [{'address': 'peer.example'}],
                 [{'enabled': '1', 'mode': 'server', 'address': 'peer.example'}],
                 [{'enabled': '1', 'address': '198.51.100.1'}],
                 [{'enabled': '1', 'address': '2001:db8::1'}],
                 [{'enabled': '1', 'address': '[2001:db8::1]'}],
                 [{'enabled': '1', 'address': ''}],
                 [{'enabled': '0', 'address': 'peer.example'},
                  {'enabled': '1', 'address': '198.51.100.1'}]]
        for rules in cases:
            with self.subTest(rules=rules):
                self.configure(rules)
                self.assertEqual(self.execute('init'), (0, []))
                # Direct monitor execution also exits instead of sleeping forever.
                self.assertEqual(self.execute('monitor'), (0, []))

    def test_enabled_hostname_clients_start_one_monitor(self):
        for rules in [[{'enabled': '1', 'address': 'peer.example'}],
                      [{'enabled': '1', 'mode': 'client', 'address': 'peer.example'},
                       {'enabled': '1', 'mode': 'client', 'address': 'other.example'}]]:
            with self.subTest(rules=rules):
                self.configure(rules)
                status, events = self.execute('init')
                self.assertEqual(status, 0)
                self.assertEqual(events, ['bypass 1.1.1.1', 'instance ddns-monitor'])
                self.events.write_text('')
                self.assertEqual(self.execute('monitor'), (91, ['sleep 60']))

    def test_disabling_all_rules_removes_monitor_from_next_service_start(self):
        self.configure([{'enabled': '1', 'address': 'peer.example'}])
        self.assertIn('instance ddns-monitor', self.execute('init')[1])
        self.configure([{'enabled': '0', 'address': 'peer.example'}])
        self.assertEqual(self.execute('init'), (0, []))
        self.assertEqual(self.execute('monitor'), (0, []))

    def test_monitor_does_not_require_dns_bypass(self):
        self.configure([{'enabled': '1', 'address': 'peer.example'}], bypass='0')
        self.assertEqual(self.execute('init'), (0, ['instance ddns-monitor']))


if __name__ == '__main__':
    unittest.main(verbosity=2)

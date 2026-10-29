#!/usr/bin/env python3
"""Check release selection and the UI/catalog contract without an SDK."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
COLLECT = ROOT / 'scripts/collect-packages.sh'
PACKAGE = ROOT / 'luci-app-udp2raw-ultra'


class ReleaseTests(unittest.TestCase):
    def collect(self, root, fmt, sdk):
        env = dict(os.environ, FORMAT=fmt, SDK=sdk)
        return subprocess.run(['bash', str(COLLECT)], cwd=str(root), env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_only_frontend_and_language_are_published(self):
        for fmt, sdk in [('apk', '25.12.5'), ('ipk', '24.10.5')]:
            with self.subTest(format=fmt), tempfile.TemporaryDirectory() as work:
                root = Path(work)
                packages = root / 'bin/packages/x86_64/action'
                packages.mkdir(parents=True)
                suffix = '-1.3.3-r16.apk' if fmt == 'apk' else '_1.3.3-16_all.ipk'
                expected = ['luci-app-udp2raw-ultra' + suffix,
                            'luci-i18n-udp2raw-ultra-zh-cn' + suffix]
                # A backend is not required for collecting frontend artifacts.
                for name in expected + ['luci-base' + suffix]:
                    (packages / name).write_text(name, encoding='utf-8')
                result = self.collect(root, fmt, sdk)
                self.assertEqual(result.returncode, 0, result.stderr)
                checksum = 'sha256sums_openwrt-' + sdk
                self.assertEqual(sorted(p.name for p in (root / 'release').iterdir()),
                                 sorted(expected + [checksum]))
                subprocess.check_call(['sha256sum', '-c', checksum],
                                      cwd=str(root / 'release'), stdout=subprocess.DEVNULL)
                # If a backend exists, it still must not enter the release.
                (packages / ('udp2raw' + suffix)).touch()
                self.assertEqual(self.collect(root, fmt, sdk).returncode, 0)
                self.assertEqual(sorted(p.name for p in (root / 'release').iterdir()),
                                 sorted(expected + [checksum]))

    def test_missing_language_package_fails(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            packages = root / 'bin/packages/x86_64/action'
            packages.mkdir(parents=True)
            (packages / 'luci-app-udp2raw-ultra-1.3.3-r16.apk').touch()
            self.assertNotEqual(self.collect(root, 'apk', '25.12.5').returncode, 0)
            self.assertFalse((root / 'release').exists())

    def test_chinese_catalog_covers_every_ui_translation(self):
        source = (PACKAGE / 'htdocs/luci-static/resources/view/udp2raw-ultra/udp2raw.js').read_text(encoding='utf-8')
        catalog = (PACKAGE / 'po/zh_Hans/udp2raw-ultra.po').read_text(encoding='utf-8')
        translated = dict((json.loads(key), json.loads(value)) for key, value in
                          re.findall(r'^msgid (".+")\nmsgstr (".*")$', catalog, re.M))
        keys = [json.loads(key) for key in re.findall(r'_\(("(?:[^"\\]|\\.)*")\)', source)]
        self.assertGreater(len(keys), 80)
        self.assertEqual(set(keys), set(translated))
        for key in keys:
            self.assertTrue(translated[key], key)
            self.assertEqual(re.findall(r'%s', key), re.findall(r'%s', translated[key]), key)
            self.assertEqual(key.endswith(' '), translated[key].endswith(' '), key)
        # Comments may be Chinese, but user-facing string literals must use i18n.
        code = re.sub(r'//[^\n]*|/\*.*?\*/', '', source, flags=re.S)
        self.assertIsNone(re.search(r'[\u4e00-\u9fff]', code))


if __name__ == '__main__':
    unittest.main(verbosity=2)

"""THIRD-PARTY-NOTICES.md's crate table names exactly the crates and versions the native binaries link."""
import re
import unittest

from native import ROOT


class NoticeTests(unittest.TestCase):
    def test_the_crate_table_matches_the_license_texts_and_cargo_lock(self):
        notices = (ROOT / 'THIRD-PARTY-NOTICES.md').read_text()
        table = re.findall(r'(?m)^\| `([\w-]+)` \| ([0-9][\w.+-]*) \| ([^|]+?) \|$', notices)
        self.assertGreater(len(table), 40)
        # cli-rs/THIRD-PARTY-LICENSES.txt is written from cargo's own list (scripts/cli_licenses.py --check keeps it so).
        licenses = (ROOT / 'cli-rs' / 'THIRD-PARTY-LICENSES.txt').read_text()
        written = re.findall(r'(?m)^([\w-]+) ([0-9][\w.+-]*) \(([^)]+)\)$', licenses)
        self.assertEqual(sorted(table), sorted(written))
        lock = (ROOT / 'cli-rs' / 'Cargo.lock').read_text()
        locked = set(re.findall(r'(?m)^name = "([\w-]+)"\nversion = "([^"]+)"$', lock))
        for name, version, _ in table:
            self.assertIn((name, version), locked, name)

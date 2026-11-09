"""Folder upload as one zip (docs/FOLDER-ZIP.md): tests/vectors/folder-zip/ against the reference implementation
scripts/folder_zip.py, which Python's zipfile and, where installed, Info-ZIP's unzip must accept."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import tempfile
import unittest
import zlib

from native import ROOT, load_script

VECTORS = ROOT / 'tests' / 'vectors' / 'folder-zip'
fz = load_script('folder_zip')
TREES = ('basic', 'names', 'times', 'lengths')


def load(name):
    return json.loads((VECTORS / f'{name}.json').read_text())


class TreeVectors(unittest.TestCase):
    def test_vectors_match_the_reference(self):
        for name in TREES:
            vector = load(name)
            with self.subTest(name):
                got = fz.expected(vector['root'], vector['tree'])
                self.assertEqual({k: vector[k] for k in got}, got)
                data = bytes.fromhex(vector['zip'])
                self.assertEqual((len(data), hashlib.sha256(data).hexdigest()), (vector['size'], vector['sha256']))

    def test_size_needs_no_bytes(self):
        # §6: the layout (and so the size passed to /api/upload/init) comes from paths and sizes alone.
        for name in TREES:
            vector = load(name)
            entries = [fz.Entry(e['path'], e['size'], e['mtime']) for e in vector['entries']]
            out = fz.layout(entries)
            self.assertEqual(out.size, vector['size'], name)
            self.assertEqual([r.offset for r in out.rows], [e['offset'] for e in vector['entries']], name)

    def test_readers_accept_the_zips(self):
        for name in TREES:
            vector = load(name)
            entries, _ = fz.gather(vector['root'], fz.tree_listdir(vector['tree']))
            with self.subTest(name):
                fz.readers_accept(bytes.fromhex(vector['zip']), entries, name, vector['disk'])

    def test_parts_regenerate_byte_for_byte(self):
        # Any range can be built on its own (parts in any order, resume), with a small test-only part size.
        for name in ('basic', 'names', 'times'):
            vector = load(name)
            entries, _ = fz.gather(vector['root'], fz.tree_listdir(vector['tree']))
            out, crcs, whole = fz.layout(entries), fz.crc_pass(entries), bytes.fromhex(vector['zip'])
            read = lambda i, o, n, entries=entries: fz.read_source(entries[i], o, n)  # noqa: E731
            for part in (1, 7, 64, 1000):
                slices = [fz.read_range(out, crcs, read, start, min(start + part, out.size)) for start in range(0, out.size, part)]
                self.assertEqual(b''.join(slices), whole, (name, part))
                self.assertTrue(all(len(s) == part for s in slices[:-1]), (name, part))

    def test_disk_walk_matches(self):
        # collect() on a real folder: symlinks and FIFOs are skipped, empty folders vanish, names arrive as bytes. By
        # directory handles, so `lengths` too, whose 4095-byte path is longer than PATH_MAX under the temporary folder;
        # its names over 255 bytes (NAME_MAX), which no file system holds, stay out.
        fits = lambda raw: all(len(part) <= 255 for part in raw.split(b'/'))  # noqa: E731
        for name in TREES:
            vector = load(name)
            tree = [node for node in vector['tree'] if fits(fz.node_raw(node))]
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                try:
                    folder = fz.materialise(tree, vector['root'], tmp)
                except OSError as error:  # e.g. macOS refuses names that aren't UTF-8
                    self.skipTest(f'{name}: this file system refuses the tree: {error}')
                if len(os.listdir(folder)) != len({fz.node_raw(n).split(b'/')[0] for n in tree}):
                    self.skipTest(f'{name}: this file system merges names (normalisation or case)')
                entries, skipped = fz.collect(folder)
                self.assertEqual([{'path': e.path, 'size': e.size, 'mtime': e.mtime} for e in entries],
                                 [{k: e[k] for k in ('path', 'size', 'mtime')} for e in vector['entries']])
                self.assertEqual([{**fz.show(raw), 'reason': reason} for raw, reason in skipped],
                                 [item for item in vector['skipped'] if fits(item['path'].encode() if 'path' in item else bytes.fromhex(item['pathHex']))])
                self.assertEqual(fz.zip_bytes(entries).hex(), vector['zip'])
                out = os.path.join(tmp, 'out.zip')
                fz.write_zip(entries, out)
                self.assertEqual(Path(out).read_bytes().hex(), vector['zip'], 'written in blocks')
                self.assertEqual(fz.fingerprint(entries), vector['fingerprint'])
                link = os.path.join(tmp, 'link-to-root')
                os.symlink(folder, link)
                self.assertEqual(fz.collect(link), (entries, skipped), 'a symlinked root is followed')

    def test_fingerprint_covers_path_size_and_mtime(self):
        vector = load('basic')
        entries = [fz.Entry(e['path'], e['size'], e['mtime']) for e in vector['entries']]
        self.assertEqual(fz.fingerprint(entries), vector['fingerprint'])
        self.assertEqual(len(vector['fingerprint']), 22)
        first = entries[0]
        for changed in (first.__class__(first.path + 'x', first.size, first.mtime), first.__class__(first.path, first.size + 1, first.mtime),
                        first.__class__(first.path, first.size, first.mtime + 1)):
            self.assertNotEqual(fz.fingerprint([changed, *entries[1:]]), vector['fingerprint'])
        self.assertNotEqual(fz.fingerprint(entries[1:]), vector['fingerprint'])


class Zip64(unittest.TestCase):
    def test_formula_cases(self):
        stored = load('zip64')
        self.assertEqual(stored['formula'], fz.zip64_cases())
        for case in stored['formula']:
            with self.subTest(case['name']):
                lengths = [len(bytes.fromhex(s['hex'])) if 'hex' in s else s['zeros'] for s in case['segments']]
                self.assertEqual(sum(lengths), case['size'])
                for e in case['entries']:
                    self.assertEqual(e['zip64Sizes'], e['size'] >= 0xFFFFFFFF)
                    self.assertEqual(e['zip64Offset'], e['offset'] >= 0xFFFFFFFF)
                    self.assertEqual(e['crc32'], f'{fz.crc32_zeros(e["size"]):08x}')
                tail = bytes.fromhex(case['segments'][-1]['hex'])
                eocd = struct.unpack('<IHHHHIIH', tail[-22:])
                self.assertEqual(case['zip64End'], case['centralOffset'] >= 0xFFFFFFFF or case['centralSize'] >= 0xFFFFFFFF)
                if case['zip64End']:
                    self.assertEqual(eocd[3:7], (0xFFFF, 0xFFFF, 0xFFFFFFFF, 0xFFFFFFFF))
                    record = struct.unpack('<IQHHIIQQQQ', tail[-98:-42])
                    self.assertEqual(record[6:], (len(case['entries']), len(case['entries']), case['centralSize'], case['centralOffset']))
                    self.assertEqual(struct.unpack('<IIQI', tail[-42:-22])[2], case['centralOffset'] + case['centralSize'])
                else:
                    self.assertEqual(eocd[5:7], (case['centralSize'], case['centralOffset']))
        by = {c['name']: c for c in stored['formula']}
        self.assertEqual([e['zip64Sizes'] for e in by['below']['entries'] + by['exact']['entries']], [False, True])
        self.assertTrue(by['below']['zip64End'])
        self.assertEqual([e['zip64Offset'] for e in by['offset-below']['entries']], [False, False])
        self.assertEqual([e['zip64Offset'] for e in by['offset-exact']['entries']], [False, True])
        self.assertEqual((by['5gib']['entries'][1]['zip64Sizes'], by['5gib']['entries'][1]['zip64Offset']), (False, True))
        self.assertEqual((by['limit']['size'], by['limit']['fits']), (fz.MAX_FILE_BYTES, {'raw': True, 'e2ee': False}))

    def test_entry_count_switches_the_end_record(self):
        built = load('zip64')['built']
        self.assertEqual(built, fz.count_cases())
        self.assertEqual([c['zip64End'] for c in built], [False, True])
        if shutil.which('unzip'):
            entries = fz.count_entries(0xFFFF)
            fz.readers_accept(fz.zip_bytes(entries), entries, 'count-65535', extract=False)

    def test_crc32_combine(self):
        cases = load('zip64')['crc32Combine']
        self.assertEqual(cases, fz.crc_cases())
        for c in cases:
            got = fz.crc32_combine(int(c['crc1'], 16), int(c['crc2'], 16), c['length'] - c['split'])
            self.assertEqual(f'{got:08x}', c['crc'], c['split'])
        for n in (0, 1, 2, 1000, 3 * 2**20 + 5):
            self.assertEqual(fz.crc32_zeros(n), zlib.crc32(bytes(n)), n)


class Refusals(unittest.TestCase):
    def test_refusals(self):
        stored = load('refusals')
        for case in stored['trees']:
            entries, _ = fz.gather(case['root'], fz.tree_listdir(case['tree']))
            with self.subTest(case['name']), self.assertRaises(fz.Refused) as refused:
                fz.check(entries)
            self.assertEqual((refused.exception.code, refused.exception.detail or None), (case['code'], case.get('detail')))
        for case in stored['counts']:
            entries = fz.count_entries(case['files'])
            if case['code']:
                with self.assertRaises(fz.Refused) as refused:
                    fz.check(entries)
                self.assertEqual(refused.exception.code, case['code'])
            else:
                fz.check(entries)
        for case in stored['sizes']:
            entries = [fz.Entry(case['root'] + '/' + f['path'], f['size'], fz.T_MIN) for f in case['files']]
            if case['code']:
                with self.assertRaises(fz.Refused) as refused:
                    fz.check(entries, case['limit'])
                self.assertEqual(refused.exception.code, case['code'])
            else:
                self.assertLessEqual(fz.check(entries, case['limit']).size, case['limit'])


if __name__ == '__main__':
    unittest.main()

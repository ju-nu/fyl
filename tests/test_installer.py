"""Exercise the installer and the CLI download layout: native binary selection, versioned paths, checksum
verification, shell safety and the generated index files."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tempfile
import unittest

from native import BUILDS, HOST, ROOT, VERSION, load_script as load

CLI = ROOT / 'dist' / 'cli'
INSTALL = 'curl -fsSL https://fyl.at/cli/install | sh'
NATIVE = list(BUILDS.values())
NATIVE_HOST = HOST is not None


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='fyl-installer-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bin, self.tools = self.root / 'bin', self.root / 'tools'
        self.bin.mkdir()
        self.tools.mkdir()
        self.profile = self.root / '.bashrc'
        self.log = self.root / 'requests.log'
        # Serve a dist/cli folder as if it were https://fyl.at/cli/ and log every URL; unversioned paths fail.
        curl = self.tools / 'curl'
        curl.write_text('#!/bin/sh\nset -eu\n[ "$1" = "-fsSL" ]\nprintf "%s\\n" "$2" >> "$FYL_TEST_LOG"\n'
                        'case "$2" in\n'
                        'https://fyl.at/cli/install) cat "$FYL_TEST_CLI/install" ;;\n'
                        'https://fyl.at/cli/latest) cat "$FYL_TEST_CLI/latest" ;;\n'
                        'https://fyl.at/cli/*/SHA256SUMS) [ "$3" = "-o" ]; cp "${FYL_TEST_SUMS:-$FYL_TEST_CLI/${2#https://fyl.at/cli/}}" "$4" ;;\n'
                        'https://fyl.at/cli/*/*) [ "$3" = "-o" ]; cp "$FYL_TEST_CLI/${2#https://fyl.at/cli/}" "$4" ;;\n'
                        '*) exit 1 ;;\nesac\n')
        curl.chmod(0o755)
        self.env = {**os.environ, 'PATH': os.pathsep.join([str(self.tools), str(self.bin), os.environ['PATH']]),
                    'FYL_INSTALL_DIR': str(self.bin), 'HOME': str(self.root), 'FYL_TEST_CLI': str(CLI), 'FYL_TEST_LOG': str(self.log)}

    def run_bash(self, script):
        return subprocess.run(['bash', '--noprofile', '--norc', '-c', script],
                              env=self.env, capture_output=True, text=True, timeout=30)

    def requests(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def fake_cpu(self, machine):
        real = subprocess.run(['sh', '-c', 'command -v uname'], capture_output=True, text=True, env={'PATH': os.environ['PATH']}).stdout.strip()
        uname = self.tools / 'uname'
        uname.write_text('#!/bin/sh\nif [ "$1" = -m ]; then echo {}; else exec {} "$@"; fi\n'.format(machine, real))
        uname.chmod(0o755)

    def fake_release(self, latest, reports=None):
        """A dist/cli folder whose `latest` says `latest`, with shell scripts as binaries that print `fyl <reports>`,
        next to an older release that must not be used. Runs on any host: the CPU is faked as x86_64."""
        cli = self.root / 'cli'
        for release, says in ((latest, reports or latest), ('1.0.0', '1.0.0')):
            folder = cli / release
            folder.mkdir(parents=True, exist_ok=True)
            sums = ''
            for name in NATIVE:
                (folder / name).write_text('#!/bin/sh\necho "fyl {}"\n'.format(says))
                sums += '{}  {}\n'.format(hashlib.sha256((folder / name).read_bytes()).hexdigest(), name)
            (folder / 'SHA256SUMS').write_text(sums)
        (cli / 'install').write_bytes((CLI / 'install').read_bytes())
        (cli / 'latest').write_text(latest + '\n')
        self.env['FYL_TEST_CLI'] = str(cli)
        self.fake_cpu('x86_64')
        return 'fyl-{}-x86_64'.format('macos' if platform.system() == 'Darwin' else 'linux')

    @unittest.skipUnless(NATIVE_HOST, 'no native fyl binary for this host')
    def test_installs_the_verified_native_binary_without_touching_the_profile(self):
        original = 'export FYL_EXISTING_SETTING=kept\n'
        self.profile.write_text(original)
        for _ in range(2):
            result = self.run_bash(INSTALL)
            self.assertEqual(result.returncode, 0, result.stderr)
        installed = (self.bin / 'fyl').read_bytes()
        self.assertTrue(installed.startswith((b'\x7fELF', b'\xcf\xfa\xed\xfe')), 'expected a native binary')
        self.assertEqual(self.profile.read_text(), original)
        self.assertIn('Installed fyl {} to {}/fyl'.format(VERSION, self.bin), result.stdout)
        self.assertIn('Try it: fyl ./archive.zip', result.stdout)
        self.assertEqual(self.run_bash('fyl --version').stdout, 'fyl {}\n'.format(VERSION))
        self.assertTrue(all(url == 'https://fyl.at/cli/install' or url == 'https://fyl.at/cli/latest'
                            or url.startswith('https://fyl.at/cli/{}/'.format(VERSION)) for url in self.requests()), self.requests())

    def test_binary_and_checksums_come_from_the_version_latest_names(self):
        asset = self.fake_release('9.9.9')
        result = self.run_bash(INSTALL)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Installed fyl 9.9.9 to', result.stdout)
        self.assertEqual(self.requests(), ['https://fyl.at/cli/install', 'https://fyl.at/cli/latest',
                                           'https://fyl.at/cli/9.9.9/' + asset, 'https://fyl.at/cli/9.9.9/SHA256SUMS'])
        self.assertEqual(self.run_bash('fyl --version').stdout, 'fyl 9.9.9\n')

    def test_a_binary_reporting_another_version_installs_nothing(self):
        self.fake_release('9.9.9', reports='9.9.8')
        result = self.run_bash(INSTALL)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('reports fyl 9.9.8 instead of fyl 9.9.9', result.stderr)
        self.assertFalse((self.bin / 'fyl').exists())

    def test_an_unusable_latest_installs_nothing(self):
        for latest in ('', '../../etc', '9.9.9/../1.0.0', '<html>', '9.9', 'v9.9.9'):
            self.fake_release('9.9.9')
            (self.root / 'cli' / 'latest').write_text(latest + '\n')
            self.log.unlink(missing_ok=True)
            result = self.run_bash(INSTALL)
            self.assertNotEqual(result.returncode, 0, latest)
            self.assertIn('Could not read the current fyl version', result.stderr, latest)
            self.assertEqual(self.requests(), ['https://fyl.at/cli/install', 'https://fyl.at/cli/latest'], latest)
            self.assertFalse((self.bin / 'fyl').exists(), latest)

    def test_an_installer_that_read_the_previous_latest_still_installs_after_a_release(self):
        # A release keeps the version before it, so a /cli/latest read just before the deploy, or served from a
        # cache for up to 60 s, still names files that exist.
        tree, cli = self.root / 'tree', self.root / 'tree' / 'dist' / 'cli'
        (tree / 'scripts').mkdir(parents=True)
        (tree / 'cli-rs').mkdir()
        for name in ('build_native.sh', 'build_cli.py'):
            shutil.copy(ROOT / 'scripts' / name, tree / 'scripts' / name)
        # The license texts need the real crates; faked, as cargo is below.
        (tree / 'scripts' / 'cli_licenses.py').write_text('print("Wrote cli-rs/THIRD-PARTY-LICENSES.txt.")\n')
        for release in ('9.9.7', '9.9.8', load('build_cli').BRIDGE):
            (cli / release).mkdir(parents=True)
            for name in NATIVE:
                (cli / release / name).write_text('#!/bin/sh\necho "fyl {}"\n'.format(release))
            (cli / release / 'SHA256SUMS').write_text(''.join('{}  {}\n'.format(hashlib.sha256((cli / release / name).read_bytes()).hexdigest(), name) for name in NATIVE))
        (cli / 'install').write_bytes((CLI / 'install').read_bytes())
        (cli / 'latest').write_text('9.9.8\n')
        (tree / 'package.json').write_text('{"version": "9.9.9"}')
        # cargo zigbuild ... --target T, faked: the "binary" is a script that reports the version.
        (self.tools / 'cargo').write_text('#!/bin/sh\nfor target; do :; done\nmkdir -p "target/$target/release"\n'
                                          'printf \'#!/bin/sh\\necho "fyl 9.9.9"\\n\' > "target/$target/release/fyl"\n')
        (self.tools / 'cargo').chmod(0o755)
        built = subprocess.run(['sh', str(tree / 'scripts' / 'build_native.sh')], env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(built.returncode, 0, built.stderr)
        self.assertIn('Removed dist/cli/9.9.7', built.stdout)
        self.assertEqual(sorted(path.name for path in cli.iterdir()), [load('build_cli').BRIDGE, '9.9.8', '9.9.9', 'install', 'latest'])
        for path, content in load('build_cli').render(tree).items():
            (tree / path).write_bytes(content)
        self.assertEqual((cli / 'latest').read_text(), '9.9.9\n')
        self.env['FYL_TEST_CLI'] = str(cli)
        self.fake_cpu('x86_64')
        for latest in ('9.9.8', '9.9.9'):
            (cli / 'latest').write_text(latest + '\n')
            result = self.run_bash(INSTALL)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Installed fyl {} to'.format(latest), result.stdout)

    def test_unsupported_cpu_gets_a_clear_message(self):
        self.fake_cpu('riscv64')
        result = self.run_bash(INSTALL)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('fyl runs on x86_64 and arm64', result.stderr)
        self.assertFalse((self.bin / 'fyl').exists())

    def test_install_directory_outside_path_prints_the_line_to_add(self):
        self.env['PATH'] = os.pathsep.join([str(self.tools), os.environ['PATH']])
        result = self.run_bash(INSTALL)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(self.bin) + ' is not on your PATH', result.stdout)
        self.assertIn('export PATH="' + str(self.bin) + ':$PATH"', result.stdout)
        self.assertFalse(self.profile.exists())

    def test_checksum_mismatch_installs_nothing(self):
        wrong = self.root / 'SHA256SUMS'
        wrong.write_text(''.join('{}  {}\n'.format('0' * 64, line.split()[1]) for line in (CLI / VERSION / 'SHA256SUMS').read_text().splitlines()))
        self.env['FYL_TEST_SUMS'] = str(wrong)
        result = self.run_bash(INSTALL)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('did not match its checksum', result.stderr)
        self.assertFalse((self.bin / 'fyl').exists())

    def test_sourced_install_never_changes_or_exits_the_caller(self):
        result = self.run_bash('''
trap ':' EXIT
before_options=$(set +o)
before_trap=$(trap -p EXIT)
source <(curl -fsSL https://fyl.at/cli/install) || exit 10
test "$(set +o)" = "$before_options" || exit 11
test "$(trap -p EXIT)" = "$before_trap" || exit 12
test "$(command -v fyl)" = "$FYL_INSTALL_DIR/fyl" || exit 13
fyl --version
export FYL_TEST_SUMS=/nonexistent
if source <(curl -fsSL https://fyl.at/cli/install); then exit 14; fi
printf 'caller-survived\\n'
''')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('fyl ' + VERSION, result.stdout)
        self.assertIn('caller-survived', result.stdout)


class LayoutTests(unittest.TestCase):
    def test_generated_files_are_committed_and_reproducible(self):
        build = load('build_cli')
        first, second = build.render(), build.render()
        self.assertEqual(first, second)
        self.assertEqual(sorted(first), sorted(['dist/cli/{}/SHA256SUMS'.format(VERSION), 'dist/cli/{}/SHA256SUMS'.format(build.BRIDGE), 'dist/cli/latest',
                                                'dist/cli/version.json', 'dist/cli/bridge.json', 'dist/_redirects']))
        for path, content in first.items():
            self.assertEqual((ROOT / path).read_bytes(), content, path + ' is stale; run npm run build:cli')
        self.assertEqual((CLI / 'latest').read_text(), VERSION + '\n')
        # version.json names this release; bridge.json, for the old CLIs, the last release of the old numbering.
        for name, version in (('version.json', VERSION), ('bridge.json', build.BRIDGE)):
            index = json.loads((CLI / name).read_text())
            self.assertEqual((index['name'], index['version'], index['path'], sorted(index['files'])), ('fyl', version, '/cli/{}/'.format(version), sorted(NATIVE)))
        self.assertNotEqual(VERSION, build.BRIDGE)
        self.assertFalse(build.legacy(VERSION))

    def test_only_the_current_and_the_previous_version_and_the_bridge_are_kept(self):
        build = load('build_cli')
        self.assertEqual(build.stale(CLI, VERSION), [])
        folders = [path.name for path in CLI.iterdir() if path.is_dir()]
        self.assertIn(VERSION, folders)
        self.assertIn(build.BRIDGE, folders)
        self.assertLessEqual(len(folders), 3)
        self.assertEqual(sorted(path.name for path in CLI.iterdir() if not path.is_dir()), ['bridge.json', 'install', 'latest', 'version.json'])
        for folder in folders:
            self.assertEqual(sorted(path.name for path in (CLI / folder).iterdir()), sorted(NATIVE + ['SHA256SUMS']), folder)

    def test_old_unversioned_paths_redirect_to_the_current_files(self):
        # Installers before 2.3.0 fetch /cli/<asset> and /cli/SHA256SUMS with curl -fsSL, which follows redirects.
        rules = [line.split() for line in (ROOT / 'dist' / '_redirects').read_text().splitlines() if line and not line.startswith('#')]
        self.assertEqual(sorted(rule[0] for rule in rules), sorted('/cli/' + name for name in NATIVE + ['SHA256SUMS']))
        for source, destination, status in rules:
            self.assertEqual((destination, status), ('/cli/{}/{}'.format(VERSION, source.split('/')[-1]), '302'))
            self.assertTrue((ROOT / 'dist' / destination.lstrip('/')).is_file(), destination)

    def test_versioned_files_are_immutable_and_the_pointers_short_lived(self):
        rules, current = {}, None
        for line in (ROOT / 'dist' / '_headers').read_text().splitlines():
            if line.startswith('  ! '):
                continue  # detaches a header a wider rule set (the vendored ChaCha20-Poly1305's Cache-Control)
            if line.startswith('  ') and current:
                name, value = line.strip().split(': ', 1)
                rules[current][name] = value
            elif line and not line.startswith('#'):
                current = line.strip()
                rules[current] = {}
        for pattern in ('/cli/:version/fyl-*', '/cli/:version/SHA256SUMS'):
            self.assertEqual(rules[pattern]['Cache-Control'], 'public, max-age=31536000, immutable', pattern)
        for pattern in ('/cli/latest', '/cli/bridge.json', '/cli/install'):
            self.assertEqual(rules[pattern]['Cache-Control'], 'public, max-age=60', pattern)
        # Its answer depends on the User-Agent (the Worker adds Vary): no shared cache keeps it.
        self.assertEqual(rules['/cli/version.json']['Cache-Control'], 'private, max-age=60')
        self.assertEqual(rules['/cli/:version/fyl-*']['Content-Disposition'], 'attachment; filename="fyl"')
        self.assertFalse([pattern for pattern in rules if pattern.startswith('/cli/fyl-') or pattern == '/cli/SHA256SUMS'])

    def test_render_refuses_missing_binaries_and_stale_versions(self):
        build = load('build_cli')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'package.json').write_text('{"version": "9.9.9"}')
            folder, bridge = root / 'dist' / 'cli' / '9.9.9', root / 'dist' / 'cli' / build.BRIDGE
            folder.mkdir(parents=True)
            bridge.mkdir()
            for name in NATIVE:
                (bridge / name).write_bytes(b'bridge ' + name.encode())
            with self.assertRaisesRegex(SystemExit, r'Missing native binaries in dist/cli/9\.9\.9'):
                build.render(root)
            for name in NATIVE:
                (folder / name).write_bytes(name.encode())
            self.assertEqual(build.render(root)['dist/cli/latest'], b'9.9.9\n')
            self.assertEqual(json.loads(build.render(root)['dist/cli/bridge.json'])['version'], build.BRIDGE)
            (bridge / NATIVE[0]).unlink()
            with self.assertRaisesRegex(SystemExit, 'Missing native binaries in dist/cli/' + re.escape(build.BRIDGE)):
                build.render(root)
            (bridge / NATIVE[0]).write_bytes(b'bridge')
            # Before the first older folder of the new numbering exists, the newest of the old numbering is the one
            # before (what /cli/latest named until then); once one exists, the old numbering goes, the bridge stays.
            for extra in ('2.5.0', '2.4.0', '2.0.0'):
                (root / 'dist' / 'cli' / extra).mkdir()
            self.assertEqual(build.stale(root / 'dist' / 'cli', '9.9.9'), ['2.0.0', '2.4.0'])
            (root / 'dist' / 'cli' / '1.0.0').mkdir()
            self.assertEqual(build.stale(root / 'dist' / 'cli', '1.0.1'), ['2.0.0', '2.4.0', '2.5.0', '9.9.9'])
            for extra in ('2.5.0', '2.4.0', '2.0.0', '1.0.0'):
                (root / 'dist' / 'cli' / extra).rmdir()
            self.assertEqual([build.legacy(name) for name in ('2.0.0', '2.5.1', '2.5.2', '1.0.0', '3.0.0', 'junk')], [True, True, False, False, False, False])
            # The newest older version stays, compared by number (2.10.0 is newer than 2.9.0, 10.0.0 than 9.9.9).
            (root / 'dist' / 'cli' / '2.10.0').mkdir()
            self.assertEqual(build.render(root)['dist/cli/latest'], b'9.9.9\n')
            for extra in ('2.9.0', '10.0.0', '9.9.9-rc.1', 'junk'):
                (root / 'dist' / 'cli' / extra).mkdir()
                with self.assertRaisesRegex(SystemExit, 'remove dist/cli/' + re.escape(extra) + r' \(git rm'):
                    build.render(root)
                self.assertEqual(build.stale(root / 'dist' / 'cli', '9.9.9'), [extra])
                (root / 'dist' / 'cli' / extra).rmdir()
            (root / 'dist' / 'cli' / '2.10.0').rmdir()
            (root / 'dist' / 'cli' / 'fyl-linux-x86_64').write_bytes(b'old')
            with self.assertRaisesRegex(SystemExit, 'remove dist/cli/fyl-linux-x86_64'):
                build.render(root)
            (root / 'package.json').write_text('{"version": "../9"}')
            with self.assertRaisesRegex(SystemExit, 'unusable version'):
                build.render(root)
            (root / 'package.json').write_text('{"version": "2.5.0"}')
            with self.assertRaisesRegex(SystemExit, 'of the old numbering'):
                build.render(root)


if __name__ == '__main__':
    unittest.main()

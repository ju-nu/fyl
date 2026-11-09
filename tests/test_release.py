"""The release gates: the deploy gate's fast-forward (scripts/promote.sh), when Checks runs the native CLI job
(scripts/cli_changed.sh), published CLI files staying as they are, the release itself (scripts/release.sh) and its
notes (scripts/release_notes.py)."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

from native import BUILDS, ROOT, VERSION, load_script as load

CLI = ROOT / 'dist' / 'cli'
NATIVE = list(BUILDS.values())


class GitTestCase(unittest.TestCase):
    """A temporary git repository at self.work, without the user's or the system's git configuration."""
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='fyl-git-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.env = {name: value for name, value in os.environ.items() if not name.startswith('GIT_')}
        self.env.update(HOME=str(self.root), GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1', GIT_AUTHOR_NAME='fyl test',
                        GIT_AUTHOR_EMAIL='test@fyl.invalid', GIT_COMMITTER_NAME='fyl test', GIT_COMMITTER_EMAIL='test@fyl.invalid')
        self.work = self.root / 'work'
        self.git(self.root, 'init', '--quiet', '-b', 'main', str(self.work))

    def git(self, cwd, *args):
        return subprocess.run(['git', *args], cwd=cwd, env=self.env, capture_output=True, text=True, check=True, timeout=30).stdout.strip()

    def commit(self, files):
        for name, content in files.items():
            (self.work / name).parent.mkdir(parents=True, exist_ok=True)
            (self.work / name).write_text(content)
        self.git(self.work, 'add', '--all')
        self.git(self.work, 'commit', '--quiet', '-m', ', '.join(files))
        return self.git(self.work, 'rev-parse', 'HEAD')

    def script(self, name, *args):
        return subprocess.run(['sh', str(ROOT / 'scripts' / name), *args], cwd=self.work, env=self.env, capture_output=True, text=True, timeout=30)


class DeployGateTests(GitTestCase):
    """scripts/promote.sh, the Deploy gate's step, against a local bare repository as origin."""
    def setUp(self):
        super().setUp()
        self.origin = self.root / 'origin.git'
        self.git(self.root, 'init', '--quiet', '--bare', '-b', 'main', str(self.origin))
        self.git(self.work, 'remote', 'add', 'origin', str(self.origin))

    def push(self, name, branch='main'):
        sha = self.commit({name: name})
        self.git(self.work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/' + branch)
        return sha

    def production(self):
        result = subprocess.run(['git', 'rev-parse', '--verify', '--quiet', 'refs/heads/production'], cwd=self.origin, env=self.env, capture_output=True, text=True)
        return result.stdout.strip() or None

    def test_production_follows_main_only_while_main_points_at_the_commit(self):
        first, second = self.push('a'), self.push('b')
        moved = self.script('promote.sh', first)
        self.assertEqual((moved.returncode, self.production()), (0, None), moved.stderr)
        self.assertIn('main moved on to ' + second, moved.stdout)
        created = self.script('promote.sh', second)
        self.assertEqual((created.returncode, self.production()), (0, second), created.stderr)
        self.assertIn('creating it', created.stdout)
        again = self.script('promote.sh', second)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn('already contains', again.stdout)
        third = self.push('c')
        self.assertEqual((self.script('promote.sh', third).returncode, self.production()), (0, third))

    def test_a_production_commit_that_is_not_on_main_is_never_overwritten(self):
        base = self.push('a')
        stray = self.push('hotfix', branch='production')
        self.git(self.work, 'reset', '--quiet', '--hard', base)
        head = self.push('b')
        result = self.script('promote.sh', head)
        self.assertEqual(result.returncode, 1)
        self.assertIn('GitHub refused the push: production has a commit that is not on main, or the deploy key (FYL_DEPLOY_KEY)', result.stderr)
        self.assertEqual(self.production(), stray)

    def test_an_origin_that_cannot_be_read_fails_the_run(self):
        # A green run that moved nothing would leave the merged commit undeployed with nothing pointing at it.
        sha = self.push('a')
        self.git(self.work, 'remote', 'set-url', 'origin', str(self.root / 'missing.git'))
        result = self.script('promote.sh', sha)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Could not read main from origin', result.stderr)
        self.assertIsNone(self.production())
        for wrong in ('', 'HEAD', sha[:12], sha.upper()):
            self.assertIn('Pass the commit id', self.script('promote.sh', wrong).stderr, wrong)


class NativeJobTests(GitTestCase):
    """scripts/cli_changed.sh: whether Checks runs the native CLI job (Rust tests, audit, rebuild and compare)."""
    def changed(self, *args):
        result = self.script('cli_changed.sh', *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def production(self, sha):
        self.git(self.work, 'update-ref', 'refs/remotes/origin/production', sha)

    def test_main_compares_with_what_production_has(self):
        base = self.commit({'README.md': '1', 'cli-rs/src/main.rs': '1'})
        self.assertEqual(self.changed('push'), 'true')
        self.production(base)
        self.commit({'README.md': '2'})
        self.assertEqual(self.changed('push'), 'false')
        # A CLI change whose native job failed stays in the diff of the next push, which only touches the docs.
        self.commit({'cli-rs/src/main.rs': '2'})
        docs = self.commit({'README.md': '3'})
        self.assertEqual(self.changed('push'), 'true')
        self.production(docs)
        self.assertEqual(self.changed('push'), 'false')
        self.assertEqual(self.changed('schedule'), 'true')
        self.commit({'tests/vectors/errors.json': '[]'})
        self.assertEqual(self.changed('push'), 'true')

    def test_pull_requests_compare_with_their_base(self):
        base = self.commit({'README.md': '1'})
        self.commit({'README.md': '2', 'src/index.ts': '2'})
        self.assertEqual(self.changed('pull_request', base), 'false')
        for name in ('cli-rs/Cargo.lock', 'dist/cli/9.9.9/fyl-linux-arm64', 'scripts/build_cli.py', 'scripts/cli_licenses.py', 'package.json', '.github/workflows/checks.yml'):
            self.commit({name: name})
            self.assertEqual(self.changed('pull_request', base), 'true', name)
            base = self.git(self.work, 'rev-parse', 'HEAD')
        self.assertEqual(self.changed('pull_request', '0' * 40), 'true')
        self.assertEqual(self.changed('pull_request', ''), 'true')

    def test_the_bridge_is_rebuilt_while_the_source_is_its_own_or_a_change_adds_it(self):
        bridge = load('build_cli').BRIDGE
        base = self.commit({'README.md': '1'})
        self.commit({'cli-rs/src/main.rs': '2'})
        self.assertEqual((self.changed('pull_request', base), self.changed('--bridge', 'pull_request', base)), ('true', 'false'))
        added = self.commit({'dist/cli/{}/fyl-linux-x86_64'.format(bridge): 'b'})
        # Built from this source: compared on every run, with or without a base (a history that starts here has none).
        for args in (('pull_request', base), ('push',), ('schedule',), ('pull_request', ''), ('pull_request', '0' * 40)):
            self.assertEqual(self.changed('--bridge', *args), 'true', args)
        self.production(added)
        self.commit({'README.md': '2', 'scripts/promote.sh': '2'})
        self.assertEqual(self.changed('--bridge', 'push'), 'true')
        # Once the source changed, it no longer builds the bridge byte for byte: never again, nor without a base.
        changed = self.commit({'cli-rs/src/main.rs': '3'})
        for args in (('push',), ('schedule',), ('pull_request', ''), ('pull_request', '0' * 40), ('pull_request', added)):
            self.assertEqual(self.changed('--bridge', *args), 'false', args)
        self.assertEqual(self.changed('push'), 'true')
        # A change that adds the bridge and then changes the source still compares it, and fails until it is rebuilt.
        self.commit({'dist/cli/{}/fyl-linux-x86_64'.format(bridge): 'c'})
        self.commit({'scripts/build_native.sh': '4'})
        self.assertEqual(self.changed('--bridge', 'pull_request', changed), 'true')
        self.assertEqual(self.changed('--bridge', 'schedule'), 'false')


class PublishedCliTests(GitTestCase):
    """scripts/cli_published.sh: files under dist/cli/<version>/ never change once the base (production, or a pull
    request's base) has them; a rebuild needs a new version."""
    def check(self, *args):
        return self.script('cli_published.sh', *args)

    def test_a_published_version_folder_never_changes(self):
        base = self.commit({'dist/cli/9.9.8/fyl-linux-x86_64': 'a', 'dist/cli/9.9.8/SHA256SUMS': 'a', 'dist/cli/latest': '9.9.8', 'package.json': '1'})
        for files in ({'dist/cli/9.9.8/fyl-linux-x86_64': 'rebuilt', 'package.json': '2'}, {'dist/cli/9.9.8/fyl-linux-arm64': 'new'}):
            self.git(self.work, 'reset', '--quiet', '--hard', base)
            self.commit(files)
            result = self.check('pull_request', base)
            self.assertEqual(result.returncode, 1, files)
            self.assertIn('Published CLI files changed in dist/cli/: 9.9.8.', result.stderr)
            self.assertIn('bump the version in package.json', result.stderr)
        self.git(self.work, 'reset', '--quiet', '--hard', base)
        self.git(self.work, 'rm', '--quiet', 'dist/cli/9.9.8/SHA256SUMS')
        self.commit({'README.md': 'x'})
        self.assertEqual(self.check('pull_request', base).returncode, 1)

    def test_a_new_version_may_be_added_and_an_old_one_removed(self):
        base = self.commit({'dist/cli/9.9.7/fyl-linux-x86_64': 'a', 'dist/cli/9.9.8/fyl-linux-x86_64': 'b', 'dist/cli/latest': '9.9.8'})
        self.git(self.work, 'rm', '--quiet', '-r', 'dist/cli/9.9.7')
        self.commit({'dist/cli/9.9.9/fyl-linux-x86_64': 'c', 'dist/cli/9.9.9/SHA256SUMS': 'c', 'dist/cli/latest': '9.9.9', 'dist/cli/install': 'x'})
        result = self.check('pull_request', base)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Published CLI files are unchanged.', result.stdout)

    def test_a_push_compares_with_production(self):
        first = self.commit({'dist/cli/9.9.8/fyl-linux-x86_64': 'a'})
        self.commit({'dist/cli/9.9.8/fyl-linux-x86_64': 'b'})
        # No production yet (and the weekly run): nothing is published to compare with.
        for args in (('push',), ('schedule',), ('pull_request', ''), ('pull_request', '0' * 40)):
            result = self.check(*args)
            self.assertEqual(result.returncode, 0, args)
            self.assertIn('No published base', result.stdout)
        self.git(self.work, 'update-ref', 'refs/remotes/origin/production', first)
        self.assertEqual(self.check('push').returncode, 1)


class ReleaseTests(GitTestCase):
    """scripts/release.sh, the Release workflow's step, with a fake gh, a fake fyl.at (curl) and a fake sleep."""
    def setUp(self):
        super().setUp()
        (self.work / 'scripts').mkdir()
        for name in ('build_cli.py', 'release_notes.py'):
            shutil.copy(ROOT / 'scripts' / name, self.work / 'scripts' / name)
        (self.work / 'package.json').write_text('{"version": "9.9.9"}')
        (self.work / 'CHANGELOG.md').write_text('# Changelog\n\n## 9.9.9 — 2026-10-30\n\nSee [the CLI](docs/CLI.md).\n\n## 9.9.8\n\nOld.\n')
        bridge = load('build_cli').BRIDGE
        for version in ('9.9.9', bridge):
            folder = self.work / 'dist' / 'cli' / version
            folder.mkdir(parents=True)
            for name in NATIVE:
                (folder / name).write_text('#!/bin/sh\necho "fyl {}"\n'.format(version))
                (folder / name).chmod(0o755)
        (self.work / 'cli-rs').mkdir()
        (self.work / 'cli-rs' / 'THIRD-PARTY-LICENSES.txt').write_text('Third-party licenses of the fyl CLI\n')
        for path, content in load('build_cli').render(self.work).items():
            (self.work / path).write_bytes(content)
        self.sha = self.commit({'README.md': 'fyl'})
        self.tools, self.temp, self.log = self.root / 'tools', self.root / 'runner', self.root / 'gh.log'
        self.tools.mkdir()
        self.temp.mkdir()
        (self.tools / 'gh').write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_GH_LOG"\ncase "$1 $2" in\n'
                                       '"api "*) [ -z "${FAKE_API_FAILS:-}" ] || exit 1; echo "$FAKE_PRODUCTION" ;;\n'
                                       '"release view") [ -f "$FAKE_RELEASES/$3" ] ;;\n'
                                       '"release download") tag=$3; while [ "$1" != --dir ]; do shift; done; cp "$FAKE_RELEASES/$tag" "$2/SHA256SUMS" ;;\n'
                                       '"release create") cp "$(while [ "$1" != --notes-file ]; do shift; done; echo "$2")" "$FAKE_GH_LOG.notes.$3" ;;\n'
                                       '*) exit 9 ;;\nesac\n')
        (self.tools / 'gh').chmod(0o755)
        # Call n of https://fyl.at/cli/latest answers line n of FAKE_SITE (the last line from then on); `fail` fails.
        (self.tools / 'curl').write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_CURL_LOG"\nn=$(($(wc -l < "$FAKE_CURL_LOG")))\n'
                                         'answer="$(sed -n "${n}p" "$FAKE_SITE")"\n[ -n "$answer" ] || answer="$(tail -n 1 "$FAKE_SITE")"\n'
                                         '[ "$answer" != fail ] || exit 22\nprintf "%s\\n" "$answer"\n')
        (self.tools / 'sleep').write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_SLEEP_LOG"\n')
        for name in ('curl', 'sleep'):
            (self.tools / name).chmod(0o755)
        self.curl_log, self.sleep_log, self.served = self.root / 'curl.log', self.root / 'sleep.log', self.root / 'site'
        # A file named after a tag is that release's SHA256SUMS; without one the release does not exist.
        self.releases, self.bridge = self.root / 'releases', bridge
        self.releases.mkdir()
        self.site('9.9.9')
        self.env.update(PATH=os.pathsep.join([str(self.tools), os.environ['PATH']]), FAKE_GH_LOG=str(self.log), FAKE_PRODUCTION=self.sha,
                        FAKE_CURL_LOG=str(self.curl_log), FAKE_SLEEP_LOG=str(self.sleep_log), FAKE_SITE=str(self.served), FAKE_RELEASES=str(self.releases),
                        GITHUB_REPOSITORY='ju-nu/fyl-at', GITHUB_SERVER_URL='https://github.com', RUNNER_TEMP=str(self.temp))

    def site(self, *answers):
        """What fyl.at/cli/latest answers, call by call; the last answer repeats."""
        self.served.write_text(''.join(answer + '\n' for answer in answers))
        for log in (self.curl_log, self.sleep_log):
            log.unlink(missing_ok=True)

    def lines(self, log):
        return log.read_text().splitlines() if log.exists() else []

    def release(self, sha=None):
        """One run of release.sh: its result and the gh calls it made."""
        self.log.unlink(missing_ok=True)
        result = self.script('release.sh', self.sha if sha is None else sha)
        return result, self.lines(self.log)

    def assets(self, version):
        return ' '.join(['dist/cli/{}/{}'.format(version, name) for name in NATIVE + ['SHA256SUMS']] + ['cli-rs/THIRD-PARTY-LICENSES.txt'])

    def publish(self, version):
        """The release of version exists with the committed SHA256SUMS."""
        (self.releases / ('v' + version)).write_bytes((self.work / 'dist' / 'cli' / version / 'SHA256SUMS').read_bytes())

    def test_a_new_version_is_released_from_the_commit_production_has(self):
        result, calls = self.release()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Released v9.9.9.', result.stdout)
        self.assertEqual(calls[:2], ['api repos/ju-nu/fyl-at/git/ref/heads/production --jq .object.sha', 'release view v9.9.9 --repo ju-nu/fyl-at'])
        self.assertEqual(calls[2], 'release create v9.9.9 {} --repo ju-nu/fyl-at --target {} --title fyl.at v9.9.9 --notes-file {}/notes.md'.format(
            self.assets('9.9.9'), self.sha, self.temp))
        self.assertEqual(Path(str(self.log) + '.notes.v9.9.9').read_text(),
                         'See [the CLI](https://github.com/ju-nu/fyl-at/blob/{}/docs/CLI.md).\n'.format(self.sha))
        self.assertEqual((self.lines(self.curl_log), self.lines(self.sleep_log)), (['-fs --max-time 15 https://fyl.at/cli/latest'], []))
        # Then the bridge, which every fyl 2.5.0 updates to, once and never as Latest.
        bridge = self.bridge
        self.assertEqual(calls[3:], ['release view v{} --repo ju-nu/fyl-at'.format(bridge),
                                     'release create v{0} {1} --repo ju-nu/fyl-at --target {2} --title fyl.at v{0} --notes-file {3}/bridge.md --latest=false'.format(
                                         bridge, self.assets(bridge), self.sha, self.temp)])
        self.assertIn('Released v{}.'.format(bridge), result.stdout)
        notes = Path(str(self.log) + '.notes.v' + bridge).read_text()
        self.assertIn('fyl {} is the bridge from the old version numbers'.format(bridge), notes)
        self.assertIn('(https://github.com/ju-nu/fyl-at/blob/{}/docs/CLI.md#install-and-update)'.format(self.sha), notes)
        # A later run finds both and creates nothing.
        self.publish('9.9.9')
        self.publish(bridge)
        result, calls = self.release()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse([call for call in calls if call.startswith('release create')])
        self.assertIn('Release v{} exists and carries the committed SHA256SUMS.'.format(bridge), result.stdout)

    def test_the_bridge_is_released_once_beside_an_existing_version(self):
        self.publish('9.9.9')
        result, calls = self.release()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call.split()[2] for call in calls if call.startswith('release create')], ['v' + self.bridge])
        self.assertEqual(self.lines(self.curl_log), [])
        # A bridge release with other checksums fails the run: published files never change.
        (self.releases / ('v' + self.bridge)).write_text('0' * 64 + '  fyl-linux-x86_64\n')
        result, calls = self.release()
        self.assertEqual(result.returncode, 1)
        self.assertIn('Release v{0} exists with other files than dist/cli/{0}/SHA256SUMS'.format(self.bridge), result.stderr)
        self.assertFalse([call for call in calls if call.startswith('release create')])
        # The bridge's binary must report its version, as this version's must.
        (self.releases / ('v' + self.bridge)).unlink()
        (self.work / 'dist' / 'cli' / self.bridge / 'fyl-linux-x86_64').write_text('#!/bin/sh\necho "fyl 9.9.9"\n')
        result, calls = self.release()
        self.assertEqual(result.returncode, 1)
        self.assertIn('does not report fyl ' + self.bridge, result.stderr)

    def test_a_release_waits_until_fyl_at_serves_the_version(self):
        # Workers Builds deploys production minutes after the Deploy gate moved it; until then fyl.at serves the old
        # version, or briefly nothing.
        self.site('fail', '9.9.8', '9.9.8', '9.9.9')
        result, calls = self.release()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((len(self.lines(self.curl_log)), self.lines(self.sleep_log)), (4, ['20'] * 3))
        self.assertIn('fyl.at serves nothing readable at /cli/latest, not 9.9.9 yet; waiting for the Workers Build.', result.stdout)
        self.assertIn('fyl.at serves 9.9.8 at /cli/latest, not 9.9.9 yet', result.stdout)
        self.assertTrue(result.stdout.endswith('Released v9.9.9.\nReleased v{}.\n'.format(self.bridge)), result.stdout)
        self.assertEqual(len([call for call in calls if call.startswith('release create v9.9.9 ')]), 1)

    def test_no_release_when_fyl_at_never_serves_the_version(self):
        # A failed Workers Build deploys nothing: after 20 minutes the run fails instead of releasing ahead of the site.
        self.site('9.9.8')
        result, calls = self.release()
        self.assertEqual(result.returncode, 1)
        self.assertIn('fyl.at still serves 9.9.8 at /cli/latest after 20 minutes, not 9.9.9. Check the Workers Build', result.stderr)
        self.assertEqual((len(self.lines(self.curl_log)), self.lines(self.sleep_log)), (60, ['20'] * 59))
        self.assertFalse([call for call in calls if call.startswith('release create')])
        # Only the exact version releases, and whatever else the site answers is never echoed into the job log.
        for answer in ('::warning::x', '<!doctype html>', '9.9.9-rc1', '9.9.9 ', 'fail'):
            self.site(answer)
            result, calls = self.release()
            self.assertEqual(result.returncode, 1, answer)
            self.assertEqual(set(re.findall(r'serves (.*) at /cli/latest', result.stdout + result.stderr)), {'nothing readable'}, answer)
            self.assertNotRegex(result.stdout + result.stderr, r'::|<!|rc1', answer)
            self.assertFalse([call for call in calls if call.startswith('release create')], answer)

    def test_nothing_is_released_unless_production_is_at_the_commit(self):
        self.env['FAKE_PRODUCTION'] = '1' * 40
        result, calls = self.release()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('production is at {}, not {}; nothing to release.'.format('1' * 40, self.sha), result.stdout)
        self.assertEqual((len(calls), self.lines(self.curl_log)), (1, []))
        self.env['FAKE_API_FAILS'] = '1'
        result, calls = self.release()
        self.assertEqual(result.returncode, 1)
        self.assertIn('Could not read production', result.stderr)
        for wrong in ('', 'HEAD', self.sha[:12]):
            self.assertIn('Pass the commit id', self.release(wrong)[0].stderr, wrong)

    def test_an_existing_release_must_carry_the_committed_checksums(self):
        self.publish('9.9.9')
        self.publish(self.bridge)
        sums = self.releases / 'v9.9.9'
        result, calls = self.release()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Release v9.9.9 exists and carries the committed SHA256SUMS.', result.stdout)
        self.assertFalse([call for call in calls if call.startswith('release create')])
        # Nothing is published, so nothing waits for fyl.at.
        self.assertEqual(self.lines(self.curl_log), [])
        # Binaries rebuilt in place under the same version: the release and fyl.at would disagree.
        sums.write_text('0' * 64 + '  fyl-linux-x86_64\n')
        result, calls = self.release()
        self.assertEqual(result.returncode, 1)
        self.assertIn('Release v9.9.9 exists with other files than dist/cli/9.9.9/SHA256SUMS', result.stderr)
        self.assertFalse([call for call in calls if call.startswith('release create')])

    def test_uncommitted_generated_files_are_never_released(self):
        # A stale generated file is written again by build_cli.py and then matches the commit.
        (self.work / 'dist' / 'cli' / 'latest').write_text('9.9.8\n')
        result, calls = self.release()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.git(self.work, 'reset', '--quiet', '--hard')
        (self.work / 'dist' / 'cli' / '9.9.9' / 'fyl-linux-x86_64').write_text('#!/bin/sh\necho "fyl 9.9.8"\n')
        result, _ = self.release()
        self.assertEqual(result.returncode, 1)
        self.assertIn('does not report fyl 9.9.9', result.stderr)
        self.git(self.work, 'reset', '--quiet', '--hard')
        (self.work / 'dist' / 'cli' / '9.9.9' / 'extra').write_text('x')
        result, _ = self.release()
        self.assertEqual(result.returncode, 1)
        self.assertIn('The generated CLI files differ from the committed ones', result.stderr)
        self.git(self.work, 'reset', '--quiet', '--hard')
        self.git(self.work, 'clean', '--quiet', '-fd')
        (self.work / 'cli-rs' / 'THIRD-PARTY-LICENSES.txt').unlink()
        result, calls = self.release()
        self.assertEqual(result.returncode, 1)
        self.assertIn('cli-rs/THIRD-PARTY-LICENSES.txt is missing', result.stderr)
        self.assertFalse([call for call in calls if call.startswith('release create')])


class ReleaseNotesTests(unittest.TestCase):
    CHANGELOG = ('# Changelog\n\n## 2.3.0 — 2026-10-30\n\nIntro with a [link](docs/CLI.md#install), [site](https://fyl.at) and [here](#x).\n\n'
                 '### Fixed\n\n- One.\n\n## 2.2.0 — 2026-10-28\n\nOlder.\n')

    def test_only_the_version_section_with_absolute_links(self):
        notes = load('release_notes')
        self.assertEqual(notes.section(self.CHANGELOG, '2.3.0'),
                         'Intro with a [link](docs/CLI.md#install), [site](https://fyl.at) and [here](#x).\n\n### Fixed\n\n- One.\n')
        self.assertEqual(notes.section(self.CHANGELOG, '2.2.0'), 'Older.\n')
        self.assertIsNone(notes.section(self.CHANGELOG, '2.3'))
        self.assertEqual(notes.absolute('[link](docs/CLI.md#install) [site](https://fyl.at) [here](#x)', 'https://github.com/o/r/blob/abc/'),
                         '[link](https://github.com/o/r/blob/abc/docs/CLI.md#install) [site](https://fyl.at) [here](#x)')

    def test_the_committed_changelog_has_this_version(self):
        result = subprocess.run(['python3', str(ROOT / 'scripts' / 'release_notes.py'), VERSION], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('\n## ', result.stdout)
        missing = subprocess.run(['python3', str(ROOT / 'scripts' / 'release_notes.py'), '0.0.0'], capture_output=True, text=True, timeout=30)
        self.assertNotEqual(missing.returncode, 0)


if __name__ == '__main__':
    unittest.main()

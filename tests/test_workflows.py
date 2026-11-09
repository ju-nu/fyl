"""Promises of the workflow files under .github/workflows/ and of the repository's scanning setup."""
import os
import re
import subprocess
import unittest

from native import ROOT


def step(workflow, name):
    """The `run: |` block of the step with this name, unindented."""
    match = re.search(r'(?m)^( *)- name: {}\n(?:\1  .*\n)*?\1  run: \|\n((?:\1    .*\n)+)'.format(re.escape(name)), workflow)
    return re.sub(r'(?m)^' + match[1] + '    ', '', match[2])


class WorkflowTests(unittest.TestCase):
    """Promises of the workflow files that actionlint cannot check."""
    def read(self, name):
        return (ROOT / '.github' / 'workflows' / name).read_text()

    def test_checks(self):
        checks = self.read('checks.yml')
        # Per event, so the weekly run never cancels the push run of main's head (the only one that deploys).
        self.assertIn('group: checks-${{ github.event_name }}-${{ github.ref }}', checks)
        self.assertIn('run: cd cli-rs && cargo test --locked', checks)
        self.assertIn('sh scripts/cli_changed.sh "$EVENT" "$PR_BASE"', checks)
        self.assertNotIn('--bridge', checks)
        self.assertIn('run: sh scripts/cli_published.sh "$EVENT" "$PR_BASE"', checks)
        self.assertIn('run: python3 scripts/cli_licenses.py --check', checks)
        for script in sorted((ROOT / 'scripts').glob('*.sh')):
            self.assertIn('scripts/' + script.name, checks, 'shellcheck ' + script.name)
        # Every downloaded tool is a pinned release checked by sha256; nothing is piped into a shell.
        self.assertNotRegex(checks, r'\| *(ba)?sh\b')
        self.assertNotIn('sh.rustup.rs', checks)
        for tool in ('RUSTUP', 'ZIG', 'GITLEAKS', 'ACTIONLINT'):
            self.assertRegex(checks, r'(?m)^      {}_SHA256: [0-9a-f]{{64}}$'.format(tool))
            self.assertIn('echo "${}_SHA256  '.format(tool), checks)

    def test_gitleaks_scans_the_tree_and_the_new_commits(self):
        checks = self.read('checks.yml')
        scan = step(checks, 'No secrets in the tree or the new commits (gitleaks)')
        self.assertIn('gitleaks dir . --redact', scan)
        self.assertIn('--log-opts="$base..HEAD"', scan)
        self.assertNotIn('${{', scan)
        # The fixtures the allowlist names by value are keys of the published test vectors, nothing else.
        config = (ROOT / '.gitleaks.toml').read_text()
        keys = (ROOT / 'tests' / 'vectors' / 'e2ee' / 'keys.json').read_text()
        named = re.findall(r"(?m)^  '''([A-Za-z0-9_-]{43}|AGE-SECRET-KEY-1[0-9A-Z]+)''',$", config)
        self.assertEqual(len(named), 3, config)
        for key in named:
            self.assertIn(key, keys)

    def test_the_deploy_gate_pushes_with_the_deploy_key(self):
        # GITHUB_TOKEN may not move production across changes to .github/workflows/, so it gets no write access;
        # the repository's write deploy key FYL_DEPLOY_KEY pushes, and without it the run fails before anything else.
        deploy = self.read('deploy.yml')
        self.assertIn('ssh-key: ${{ secrets.FYL_DEPLOY_KEY }}', deploy)
        self.assertNotIn('FYL_DEPLOY_TOKEN', deploy)
        self.assertNotIn('create-github-app-token', deploy)
        self.assertNotIn('FYL_DEPLOY_APP', deploy)
        self.assertNotRegex(deploy, r'(?m)^\s+contents: write')
        self.assertIn('run: sh scripts/promote.sh "$SHA"', deploy)
        self.assertLess(deploy.index('- name: The deploy key is configured'), deploy.index('uses: actions/checkout'))
        guard = step(deploy, 'The deploy key is configured')
        for has, code in (('true', 0), ('false', 1)):
            result = subprocess.run(['bash', '-e', '-c', guard], env={**os.environ, 'HAS_TOKEN': has}, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, code, has)
        self.assertIn('::error::Set FYL_DEPLOY_KEY in the environment production', result.stdout)
        # The key is a secret of the environment production, which admits main only; the promote job names it.
        self.assertRegex(deploy, r'(?m)^  promote:\n(?:    .*\n)*?    environment: production\n')

    def test_a_release_follows_the_deploy_gate(self):
        release = self.read('release.yml')
        self.assertIn('workflows: [Deploy gate]', release)
        self.assertNotIn('workflows: [Checks]', release)
        self.assertIn('run: sh scripts/release.sh "$RELEASE_SHA"', release)
        # The job outlives release.sh's 20-minute wait for fyl.at to serve the version.
        self.assertGreaterEqual(int(re.search(r'(?m)^    timeout-minutes: (\d+)$', release)[1]), 25)

    def test_the_monitor_runs_hourly_and_keeps_its_tokens_to_the_script(self):
        monitor = self.read('monitor.yml')
        self.assertRegex(monitor, r"(?m)^    - cron: '23 \* \* \* \*'$")
        # Its secrets and the alert variable live in the environment monitor, which admits main only.
        self.assertRegex(monitor, r'(?m)^  monitor:\n    environment: monitor\n')
        operations = (ROOT / 'docs' / 'OPERATIONS.md').read_text()
        self.assertIn('runs hourly (minute 23)', operations)
        self.assertIn('workflow_dispatch:', monitor)
        self.assertIn('60 days', monitor)
        # The billing alert (a variable of the environment monitor, 15 dollars without it), the monitor token and the admin host's Access
        # service token, handed to the script's step only.
        expressions = ["${{ vars.BILLING_ALERT_USD || '15' }}", '${{ secrets.MONITOR_TOKEN }}', '${{ secrets.FYL_ACCESS_CLIENT_ID }}',
                       '${{ secrets.FYL_ACCESS_CLIENT_SECRET }}']
        self.assertEqual(re.findall(r'\$\{\{[^}]*\}\}', monitor), expressions)
        self.assertIn("BILLING_ALERT_USD: ${{ vars.BILLING_ALERT_USD || '15' }}\n          MONITOR_TOKEN: ${{ secrets.MONITOR_TOKEN }}\n"
                      '          FYL_ACCESS_CLIENT_ID: ${{ secrets.FYL_ACCESS_CLIENT_ID }}\n'
                      '          FYL_ACCESS_CLIENT_SECRET: ${{ secrets.FYL_ACCESS_CLIENT_SECRET }}\n        run: python3 scripts/monitor.py\n', monitor)
        # The default matches the script's.
        script = (ROOT / 'scripts' / 'monitor.py').read_text()
        self.assertIn('ALERT_USD = "15"', script)
        # The job outlives three stalled requests (TRIES tries of up to 30 s each, PAUSE s apart) and the checkout, so a
        # slow run still prints its problems and mails them instead of being cancelled.
        tries, pause = (int(value) for value in re.search(r'(?m)^TRIES, PAUSE = (\d+), (\d+)$', script).groups())
        self.assertIn('timeout=30)', script)
        self.assertGreaterEqual(int(re.search(r'(?m)^    timeout-minutes: (\d+)$', monitor)[1]) * 60, 3 * (tries * 30 + (tries - 1) * pause) + 60)
        self.assertIn('permissions:\n  contents: read\n', monitor)

    def test_the_repository_is_named_fyl_at(self):
        # The repository's old name, fly-at, must not come back; workflows take the name from github.repository.
        for path in sorted([*(ROOT / '.github').rglob('*.yml'), *(ROOT / 'scripts').iterdir()]):
            if path.is_file():
                self.assertNotIn('fly-at', path.read_text(), path)


if __name__ == '__main__':
    unittest.main()

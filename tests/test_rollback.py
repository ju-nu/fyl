"""scripts/rollback.py against a fake wrangler."""
import contextlib
import io
import json
import os
import re
import subprocess
import unittest

from native import ROOT, load_script


VERSIONS = [
    {'id': 'old-2-1-2', 'metadata': {'created_on': '2026-10-28T09:00:00.123456Z'}, 'annotations': {}},
    {'id': 'deploy-2-2-0', 'metadata': {'created_on': '2026-10-28T20:18:00.456789Z'}, 'annotations': {}},
    {'id': 'secret-change', 'metadata': {'created_on': '2026-10-29T08:00:00Z'}, 'annotations': {'workers/triggered_by': 'secret'}},
    {'id': 'tagged-2-3-0', 'metadata': {'created_on': '2026-10-30T10:00:00Z'}, 'annotations': {'workers/tag': 'v2.3.0', 'workers/message': 'fyl 2.3.0'}},
    {'id': 'old-checkout', 'metadata': {'created_on': '2026-10-30T11:00:00Z'}, 'annotations': {'workers/tag': 'v2.1.2'}},
    {'id': 'tagged-2-4-0', 'metadata': {'created_on': '2026-10-30T11:30:00Z'}, 'annotations': {'workers/tag': 'v2.4.0', 'workers/message': 'fyl 2.4.0'}},
    {'id': 'tagged-2-5-1', 'metadata': {'created_on': '2026-11-09T10:00:00Z'}, 'annotations': {'workers/tag': 'v2.5.1', 'workers/message': 'fyl 2.5.1'}},
    {'id': 'tagged-1-0-0', 'metadata': {'created_on': '2026-11-10T10:00:00Z'}, 'annotations': {'workers/tag': 'v1.0.0', 'workers/message': 'fyl 1.0.0'}},
    {'id': 'tagged-1-0-1', 'metadata': {'created_on': '2026-11-10T12:00:00Z'}, 'annotations': {'workers/tag': 'v1.0.1', 'workers/message': 'fyl 1.0.1 4ba433e2b1c0d3f4a5b6c7d8e9f0a1b2c3d4e5f6'}},
    {'id': '32a6b7f1-55b2-42cc-918f-fbc1e69dd91b', 'metadata': {'created_on': '2026-11-10T11:00:00Z'}, 'annotations': {'workers/tag': 'v1.0.1', 'workers/message': 'fyl 1.0.1'}},
    {'id': 'hotfix-0-9-0', 'metadata': {'created_on': '2026-11-10T13:00:00Z'}, 'annotations': {'workers/tag': 'v0.9.0'}},
    {'id': 'uploaded-1-0-2', 'metadata': {'created_on': '2026-11-10T14:00:00Z'}, 'annotations': {'workers/tag': 'v1.0.2'}},
]
# wrangler deployments list --json, in no particular order; the newest one serves.
DEPLOYMENTS = [
    {'created_on': '2026-11-10T12:00:05.5Z', 'versions': [{'version_id': 'tagged-1-0-1', 'percentage': 100}]},
    {'created_on': '2026-11-10T10:00:05Z', 'versions': [{'version_id': 'tagged-1-0-0', 'percentage': 100}]},
    {'created_on': '2026-10-30T11:30:05Z', 'versions': [{'version_id': 'tagged-2-4-0', 'percentage': 100}]},
    {'created_on': '2026-10-28T20:18:05Z', 'versions': [{'version_id': 'deploy-2-2-0', 'percentage': 100}]},
    {'created_on': '2026-10-29T08:00:05Z', 'versions': [{'version_id': 'secret-change', 'percentage': 100}]},
    {'created_on': '2026-11-09T10:00:05Z', 'versions': [{'version_id': 'tagged-2-5-1', 'percentage': 100}]},
    {'created_on': '2026-10-30T10:00:05Z', 'versions': [{'version_id': 'tagged-2-3-0', 'percentage': 100}]},
    {'created_on': '2026-10-30T11:00:05Z', 'versions': [{'version_id': 'old-checkout', 'percentage': 100}]},
]


class RollbackTests(unittest.TestCase):
    def setUp(self):
        self.module = load_script('rollback')
        self.ran = []
        outputs = {'versions': json.dumps(VERSIONS), 'deployments': json.dumps(DEPLOYMENTS)}
        self.module.wrangler = lambda args: outputs[args[0]]
        self.module.run = lambda args: self.ran.append(args) or 0

    def rollback(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            try:
                self.module.main(list(args))
                code = 0
            except SystemExit as exit:
                code = exit.code
        return code, out.getvalue()

    def test_list_marks_the_targets(self):
        code, out = self.rollback()
        self.assertEqual(code, 0)
        lines = out.splitlines()
        self.assertEqual(lines[-1], 'Targets: versions tagged v1.0.0 or later; untagged versions and the old numbering (v2.0.0 to v2.5.1) are never targets.')
        verdicts = {line.split()[0]: line for line in lines[:-1]}
        for name in ('old-2-1-2', 'deploy-2-2-0', 'secret-change'):
            self.assertRegex(verdicts[name], r'  untagged  ', name)
        for name in ('old-checkout', 'tagged-2-3-0', 'tagged-2-4-0', 'tagged-2-5-1'):
            self.assertRegex(verdicts[name], r'  old numbering  ', name)
        self.assertRegex(verdicts['hotfix-0-9-0'], r'  below the floor  ')
        self.assertRegex(verdicts['32a6b7f1-55b2-42cc-918f-fbc1e69dd91b'], r'  withdrawn  ')
        self.assertRegex(verdicts['tagged-1-0-0'], r'  target  ')
        self.assertRegex(verdicts['tagged-1-0-1'], r'  serving  ')
        self.assertRegex(verdicts['uploaded-1-0-2'], r'  target, never served  ')
        self.assertEqual(self.ran, [])

    def test_deploy_names_the_commit_in_the_version_message(self):
        # Several builds share a tag (it names the package version): the message tells them apart by commit.
        deploy = json.loads((ROOT / 'package.json').read_text())['scripts']['deploy']
        message = re.search(r'--message ("[^"]*")', deploy)[1]
        self.assertIn('--tag v$npm_package_version ', deploy)
        for sha, expected in (('4ba433e2b1c0d3f4a5b6c7d8e9f0a1b2c3d4e5f6', 'fyl 1.0.1 4ba433e2b1c0d3f4a5b6c7d8e9f0a1b2c3d4e5f6'), (None, 'fyl 1.0.1 local')):
            env = {key: value for key, value in os.environ.items() if key != 'WORKERS_CI_COMMIT_SHA'}
            env.update({'npm_package_version': '1.0.1', **({'WORKERS_CI_COMMIT_SHA': sha} if sha else {})})
            result = subprocess.run(['sh', '-c', 'printf %s ' + message], env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.stdout, expected)
        # The listing shows that message beside the tag.
        code, out = self.rollback()
        self.assertEqual(code, 0)
        self.assertRegex(out, r'(?m)^tagged-1-0-1  2026-11-10 12:00 UTC  v1\.0\.1 +serving +fyl 1\.0\.1 4ba433e2b1c0d3f4a5b6c7d8e9f0a1b2c3d4e5f6$')

    def test_untagged_older_and_unknown_versions_are_refused(self):
        # The old numbering's releases came before 1.0.0, whatever their numbers say.
        for target, reason in (('old-2-1-2', 'no release tag'), ('deploy-2-2-0', 'no release tag'), ('secret-change', 'no release tag'),
                               ('tagged-2-3-0', 'v2.3.0 is of the old numbering (v2.0.0 to v2.5.1), from before v1.0.0'),
                               ('old-checkout', 'v2.1.2 is of the old numbering'), ('tagged-2-4-0', 'v2.4.0 is of the old numbering'),
                               ('tagged-2-5-1', 'v2.5.1 is of the old numbering'), ('hotfix-0-9-0', 'v0.9.0 is older than the floor v1.0.0'),
                               ('32a6b7f1-55b2-42cc-918f-fbc1e69dd91b', 'this build is withdrawn: the temporary sweep of old Transfer tombstones (#8'),
                               ('not-listed', 'not among the Worker')):
            for args in ((), ('--yes', '--accept-caveats')):
                code, _ = self.rollback(target, *args)
                self.assertIsInstance(code, str, target)
                self.assertIn(reason, code, target)
                self.assertIn('Nothing was changed', code, target)
        self.assertEqual(self.ran, [])

    def test_a_target_needs_yes(self):
        code, out = self.rollback('tagged-1-0-0')
        self.assertEqual(code, 0)
        self.assertIn("Would run: wrangler rollback tagged-1-0-0 --message 'fyl rollback to v1.0.0' --yes\nNothing was changed. Add --yes to roll back.", out)
        self.assertIn('Secrets: The target runs with the secret values it was deployed with', out)
        self.assertNotIn('Caveat', out)
        self.assertNotIn('reconcile', out)
        self.assertEqual(self.ran, [])
        code, out = self.rollback('tagged-1-0-0', '--yes', '--message', 'bad deploy')
        self.assertEqual(code, 0)
        self.assertEqual(self.ran, [['rollback', 'tagged-1-0-0', '--message', 'bad deploy', '--yes']])
        # Then the budget's totals are recounted at once, and again after fixing forward.
        self.assertTrue(out.endswith('Next: run npm run admin -- reconcile now, and again after the deploy that fixes forward, '
                                     "so the upload budget's totals match its records at once.\n"), out)
        self.module.run = lambda args: self.ran.append(args) or 1
        code, out = self.rollback('tagged-1-0-0', '--yes')
        self.assertEqual(code, 1)
        self.assertNotIn('reconcile', out)
        self.ran.pop()
        code, out = self.rollback('tagged-1-0-1', '--yes')
        self.assertIn('already serving', out)
        self.assertEqual(len(self.ran), 1)

    def test_a_version_that_never_served_needs_accept_caveats(self):
        code, out = self.rollback('uploaded-1-0-2')
        self.assertEqual(code, 0)
        self.assertIn('Caveat: This version never served traffic', out)
        self.assertIn("--yes\nNothing was changed. Add --yes --accept-caveats to roll back.", out)
        code, _ = self.rollback('uploaded-1-0-2', '--yes')
        self.assertIn('Refused: the caveats above apply', code)
        self.assertEqual(self.ran, [])
        self.assertEqual(self.rollback('uploaded-1-0-2', '--yes', '--accept-caveats')[0], 0)
        self.assertEqual(self.ran, [['rollback', 'uploaded-1-0-2', '--message', 'fyl rollback to v1.0.2', '--yes']])

    def test_caveats_of_a_later_release_apply_to_older_targets(self):
        self.module.CAVEATS = [('1.0.2', 'Versions before 1.0.2 ignore a newer setting.')]
        code, out = self.rollback('tagged-1-0-0', '--yes')
        self.assertIn('Refused: the caveats above apply', code)
        self.assertIn('Caveat: Versions before 1.0.2 ignore', out)
        code, out = self.rollback('uploaded-1-0-2')
        self.assertNotIn('Versions before 1.0.2', out)
        self.assertEqual(self.ran, [])

    def test_the_floor_needs_a_release_tag_of_the_new_numbering(self):
        refusal = self.module.refusal
        for tag, expected in (('v1.0.0', None), ('v1.10.0', None), ('1.0.1', None), ('v2.5.2', None), ('v2.6.0', None), ('v3.0.0', None),
                              ('v0.9.9', 'below the floor'), ('v0.0.1', 'below the floor'),
                              ('v2.0.0', 'old numbering'), ('v2.4.0', 'old numbering'), ('v2.5.0', 'old numbering'), ('v2.5.1', 'old numbering'),
                              ('2.4.1', 'old numbering'), ('nightly', 'untagged'), ('v1.0.0-rc.1', 'untagged'), ('', 'untagged')):
            self.assertEqual(refusal({'annotations': {'workers/tag': tag}}), expected, tag)
        self.assertEqual(refusal({'metadata': {'created_on': '2030-01-01T00:00:00Z'}}), 'untagged')

    def test_never_served_is_only_said_when_certain(self):
        never = self.module.never_served
        version = {'id': 'x', 'metadata': {'created_on': '2026-10-30T09:00:00Z'}}
        self.assertTrue(never(version, DEPLOYMENTS))
        # Older than every deployment listed (wrangler lists the last ten): it may have served before them.
        self.assertFalse(never({**version, 'metadata': {'created_on': '2026-10-28T20:18:04Z'}}, DEPLOYMENTS))
        self.assertFalse(never(version, []))
        self.assertFalse(never({**version, 'id': 'tagged-2-3-0'}, DEPLOYMENTS))


if __name__ == '__main__':
    unittest.main()

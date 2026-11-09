"""scripts/admin.py, the operator CLI, against a fake operator API on loopback."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from fake_operator import ACCESS, ACCESS_NAMES, ADMIN, CASE, CLIENT_ID, CLIENT_SECRET, ID, NOTE_REQUIRED, OTHER, SIGN_IN, TOKEN, serve, view
from native import ROOT, load_script

# The one-off tombstone sweep (temporary, removed with the command): the Cloudflare API token it lists objects with,
# and the Worker and account of wrangler.jsonc that it lists them for.
CF_TOKEN = 'cloudflare-' + 'c' * 40
_CONFIG = json.loads('\n'.join(line for line in (ROOT / 'wrangler.jsonc').read_text().splitlines() if not line.lstrip().startswith('//')))
ACCOUNT, SCRIPT = _CONFIG['account_id'], _CONFIG['name']
NAMESPACES = '/client/v4/accounts/{}/workers/durable_objects/namespaces'.format(ACCOUNT)
OBJECTS = NAMESPACES + '/ns-transfer/objects'


class AdminTests(unittest.TestCase):
    def setUp(self):
        self.server = serve(self)
        self.origin = 'http://127.0.0.1:{}'.format(self.server.server_port)
        self.routes = self.server.routes

    def admin(self, *args, stdin=subprocess.DEVNULL, base=None, extra=None, script=ADMIN):
        env = {**{name: value for name, value in os.environ.items() if name not in ACCESS_NAMES}, 'FYL_ADMIN_TOKEN': TOKEN,
               'FYL_BASE_URL': base or self.origin, 'PYTHONDONTWRITEBYTECODE': '1', **(extra or {})}
        if base == '':
            env.pop('FYL_BASE_URL')
        result = subprocess.run([sys.executable, '-I', str(script), *args], stdin=stdin, capture_output=True, text=True, env=env, timeout=30)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertNotIn(CLIENT_SECRET, result.stdout + result.stderr)
        return result

    def requests(self):
        for request in self.server.requests:
            self.assertEqual(request[3], 'Bearer ' + TOKEN)
        return [request[:3] for request in self.server.requests]

    def test_targets_are_a_bare_id_or_an_exact_download_link(self):
        self.routes[('GET', '/api/admin/transfers/' + ID)] = (200, view())
        for text in (ID, 'https://fyl.at/d/' + ID, 'https://fyl.at/d/{}/report%20%26%20plans.zip'.format(ID),
                     'HTTPS://FYL.AT/d/' + ID, self.origin + '/d/' + ID, self.origin + '/d/{}/x.zip'.format(ID)):
            self.server.requests.clear()
            result = self.admin('show', text)
            self.assertEqual(result.returncode, 0, (text, result.stderr))
            self.assertEqual(self.requests(), [('GET', '/api/admin/transfers/' + ID, None)], text)
            self.assertIn('report & plans.zip', result.stdout)
            self.assertIn('3.00 GB', result.stdout)

    def test_anything_else_is_refused_before_a_request(self):
        refused = [ID[:-1], ID + 'x' * 22, 'see https://fyl.at/d/' + ID, 'https://fyl.at/d/{}!'.format(ID),
                   'https://evil.example/d/' + ID, 'https://fyl.at.evil.example/d/' + ID, 'http://fyl.at/d/' + ID,
                   'https://fyl.at/d/{}?dl=1'.format(ID), 'https://fyl.at/d/{}?'.format(ID), 'https://fyl.at/d/{}#x'.format(ID),
                   'https://fyl.at/d/{}/a/b'.format(ID), 'https://fyl.at/d/{}/'.format(ID), ' https://fyl.at/d/' + ID,
                   'https://fyl.at/d/{}\n'.format(ID), 'https://fyl.at/d/{}\t{}'.format(ID[:20], ID[20:]),
                   'https://user@fyl.at/d/' + ID, 'https://fyl.at:8443/d/' + ID, 'https://fyl.at/x/d/' + ID, '/d/' + ID,
                   'https://fyl.at/d/{}/{}'.format(ID, OTHER) + '/', 'https://fyl.at/?d=' + ID, 'https://[fyl.at/d/' + ID, '']
        for text in refused:
            result = self.admin('takedown', text, '--yes')
            self.assertEqual(result.returncode, 1, text)
            self.assertIn('Pass a transfer id', result.stderr, text)
        manage = self.admin('takedown', 'https://fyl.at/#manage/{}/{}'.format(ID, 'k' * 43), '--yes')
        self.assertEqual(manage.returncode, 1)
        self.assertIn('That is a management link', manage.stderr)
        self.assertNotIn('k' * 43, manage.stderr)
        self.assertEqual(self.requests(), [])

    def test_takedown_shows_the_exact_target_and_needs_a_confirmation(self):
        self.routes[('GET', '/api/admin/transfers/' + ID)] = (200, view())
        self.routes[('POST', '/api/admin/takedown')] = (200, {'removed': True, 'existed': True})
        dry = self.admin('takedown', 'https://fyl.at/d/' + ID, '--dry-run', '--note', 'malware')
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertIn('report & plans.zip', dry.stdout)
        self.assertIn('Dry run: would remove ' + ID, dry.stdout)
        unconfirmed = self.admin('takedown', ID, '--note', 'malware')
        self.assertEqual(unconfirmed.returncode, 1)
        self.assertIn('Nothing was changed. Pass --yes', unconfirmed.stderr)
        self.assertIn('report & plans.zip', unconfirmed.stdout)
        self.assertEqual(self.requests(), [('GET', '/api/admin/transfers/' + ID, None)] * 2)
        self.server.requests.clear()
        confirmed = self.admin('takedown', ID, '--yes', '--note', 'malware')
        self.assertEqual(confirmed.returncode, 0, confirmed.stderr)
        self.assertIn('Removed {}.'.format(ID), confirmed.stdout)
        self.assertNotIn('Warning', confirmed.stdout)
        self.assertEqual(self.requests(), [('GET', '/api/admin/transfers/' + ID, None), ('POST', '/api/admin/takedown', {'id': ID, 'note': 'malware'})])

    def test_takedown_asks_at_a_terminal(self):
        self.routes[('GET', '/api/admin/transfers/' + ID)] = (200, view())
        self.routes[('POST', '/api/admin/takedown')] = (200, {'removed': True, 'existed': True})
        for answer, posted in (('no\n', False), ('yes\n', True)):
            self.server.requests.clear()
            master, slave = os.openpty()
            try:
                os.write(master, answer.encode())
                result = self.admin('takedown', ID, '--note', 'phishing', stdin=slave)
            finally:
                os.close(slave)
                os.close(master)
            self.assertIn('Type "yes" to remove this file', result.stdout)
            self.assertEqual((result.returncode, ('POST', '/api/admin/takedown', {'id': ID, 'note': 'phishing'}) in self.requests()),
                             (0 if posted else 1, posted), answer)

    def test_takedown_of_an_unknown_or_removed_id(self):
        self.routes[('GET', '/api/admin/transfers/' + OTHER)] = (200, {'id': OTHER, 'exists': False})
        self.routes[('POST', '/api/admin/takedown')] = (200, {'removed': True, 'existed': False})
        result = self.admin('takedown', OTHER, '--yes', '--note', 'blocked in advance')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('no transfer with this id exists now', result.stdout)
        self.assertIn('its link is blocked for good', result.stdout)
        self.server.requests.clear()
        self.routes[('GET', '/api/admin/transfers/' + ID)] = (200, view(status='removed'))
        removed = self.admin('takedown', ID, '--yes', '--note', 'malware')
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertIn('Already removed', removed.stdout)
        self.assertEqual(self.requests(), [('GET', '/api/admin/transfers/' + ID, None)])

    def test_takedown_records_a_reason(self):
        self.routes[('GET', '/api/admin/transfers/' + ID)] = (200, view())
        for extra in ((), ('--note', ''), ('--note', ' ok '), ('--dry-run',), ('--dry-run', '--note', 'no')):
            result = self.admin('takedown', ID, '--yes', *extra)
            self.assertEqual(result.returncode, 1, extra)
            self.assertEqual(result.stderr.strip(), NOTE_REQUIRED + ' Pass it with --note TEXT; it is recorded with the decision. '
                                                                   'Nothing was changed.', extra)
        self.assertEqual(self.requests(), [])
        # The Worker's own refusal (a stricter rule than this script knows) is shown as it says it.
        self.routes[('POST', '/api/admin/takedown')] = (400, {'error': NOTE_REQUIRED, 'code': 'note_required'})
        refused = self.admin('takedown', ID, '--yes', '--note', 'abc')
        self.assertEqual((refused.returncode, refused.stderr.strip()), (1, 'HTTP 400: ' + NOTE_REQUIRED + ' Pass it with --note TEXT. Nothing was changed.'))
        self.server.requests.clear()
        # It took effect, but the open cases on the transfer could not record the reason.
        self.routes[('POST', '/api/admin/takedown')] = (200, {'removed': True, 'existed': True, 'reportsUpdated': False})
        result = self.admin('takedown', ID, '--yes', '--note', 'confirmed malware')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Removed {}.'.format(ID), result.stdout)
        self.assertIn('could not record the reason; add it to each with decide CASE note', result.stdout)
        self.assertEqual(self.requests()[-1], ('POST', '/api/admin/takedown', {'id': ID, 'note': 'confirmed malware'}))

    def test_quarantine_and_restore(self):
        self.routes[('GET', '/api/admin/transfers/' + ID)] = (200, view())
        self.routes[('POST', '/api/admin/quarantine')] = (200, view(quarantine={'at': 1793260800000, 'note': 'case R-7K3M9Q2XPA'}))
        self.routes[('POST', '/api/admin/restore')] = (200, view())
        dry = self.admin('quarantine', ID, '--dry-run', '--note', 'checking')
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertIn('Dry run: would quarantine', dry.stdout)
        self.assertEqual(self.requests(), [('GET', '/api/admin/transfers/' + ID, None)])
        self.server.requests.clear()
        result = self.admin('quarantine', 'https://fyl.at/d/' + ID, '--note', 'case R-7K3M9Q2XPA')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('since 2026-10-29 08:00 UTC (case R-7K3M9Q2XPA)', result.stdout)
        self.assertIn('Quarantined', result.stdout)
        self.assertNotIn('Warning', result.stdout)
        self.assertEqual(self.admin('restore', ID, '--note', 'report rejected').returncode, 0)
        self.assertEqual(self.requests(), [('POST', '/api/admin/quarantine', {'id': ID, 'note': 'case R-7K3M9Q2XPA'}),
                                           ('POST', '/api/admin/restore', {'id': ID, 'note': 'report rejected'})])
        self.routes[('POST', '/api/admin/restore')] = (409, {'error': 'This transfer is not quarantined.', 'code': 'conflict'})
        conflict = self.admin('restore', ID, '--note', 'again')
        self.assertEqual((conflict.returncode, conflict.stderr.strip()), (1, 'HTTP 409: This transfer is not quarantined.'))

    def test_quarantine_and_restore_record_a_reason(self):
        self.routes[('POST', '/api/admin/quarantine')] = (200, {**view(quarantine={'at': 1793260800000, 'note': 'x'}), 'reportsUpdated': False})
        for args in (('quarantine', ID), ('restore', ID), ('quarantine', ID, '--note', '  '), ('restore', ID, '--dry-run'),
                     ('quarantine', ID, '--note', 'ab'), ('restore', ID, '--note', ' ok\t'), ('quarantine', ID, '--dry-run', '--note', 'no')):
            result = self.admin(*args)
            self.assertEqual(result.returncode, 1, args)
            self.assertIn(NOTE_REQUIRED + ' Pass it with --note TEXT', result.stderr, args)
        self.assertEqual(self.requests(), [])
        # Three characters are enough, also beyond ASCII (the Worker counts code points).
        self.routes[('POST', '/api/admin/restore')] = (200, view())
        self.assertEqual(self.admin('restore', ID, '--note', 'ü✓é').returncode, 0)
        self.routes[('POST', '/api/admin/restore')] = (400, {'error': NOTE_REQUIRED, 'code': 'note_required'})
        refused = self.admin('restore', ID, '--note', 'abc')
        self.assertEqual((refused.returncode, refused.stderr.strip()), (1, 'HTTP 400: ' + NOTE_REQUIRED + ' Pass it with --note TEXT. Nothing was changed.'))
        # It took effect, but the open cases on the transfer could not record it.
        result = self.admin('quarantine', ID, '--note', 'malware sample')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('could not record this; add it to each with decide CASE note', result.stdout)

    def test_reports_and_decisions(self):
        # GET and POST /api/admin/reports/<case> answer the case's fields at the top level, with its events.
        case = {'case': CASE, 'createdAt': 1793260800000, 'transferId': ID, 'category': 'phishing', 'status': 'open',
                'details': 'Fake bank login page.\nSecond line.', 'name': 'Jo Reporter', 'email': 'jo@example.org', 'fileAvailable': True,
                'priority': 2}
        events = [{'at': 1793260800000, 'action': 'received', 'note': ''}]
        self.routes[('GET', '/api/admin/reports?status=open&limit=50')] = (200, {'reports': [case], 'next': None})
        self.routes[('GET', '/api/admin/reports?status=all&limit=5')] = (200, {'reports': [], 'next': None})
        self.routes[('GET', '/api/admin/reports/' + CASE)] = (200, {**case, 'events': events})
        self.routes[('GET', '/api/admin/transfers/' + ID)] = (200, view())
        closed = {**case, 'status': 'closed', 'outcome': 'removed', 'events': events, 'transfer': {'status': 'removed', 'quarantine': None}}
        self.routes[('POST', '/api/admin/reports/' + CASE)] = (200, closed)
        listing = self.admin('reports')
        self.assertEqual(listing.returncode, 0, listing.stderr)
        self.assertIn(CASE + '  P2  2026-10-29 08:00 UTC  phishing   open', listing.stdout)
        self.assertNotIn('file gone', listing.stdout)
        self.assertNotIn('Next page', listing.stdout)
        self.assertIn('No reports.', self.admin('reports', '--status', 'all', '--limit', '5').stdout)
        detail = self.admin('report', CASE.lower())
        self.assertEqual(detail.returncode, 0, detail.stderr)
        self.assertIn('Case       {}  open'.format(CASE), detail.stdout)
        self.assertIn('  Priority   2 (malware, phishing)\n', detail.stdout)
        self.assertIn('    Second line.', detail.stdout)
        self.assertIn('available when reported', detail.stdout)
        self.assertIn('received', detail.stdout)
        self.assertEqual(self.requests(), [('GET', '/api/admin/reports?status=open&limit=50', None),
                                           ('GET', '/api/admin/reports?status=all&limit=5', None),
                                           ('GET', '/api/admin/reports/' + CASE, None)])
        self.server.requests.clear()
        for args in (('report', 'R-7K3M9Q2XPI'), ('report', '../uploads'), ('report', 'R-123'), ('decide', CASE, 'note')):
            result = self.admin(*args)
            self.assertEqual(result.returncode, 1, args)
        self.assertEqual(self.admin('decide', CASE, 'delete').returncode, 2)
        self.assertEqual(self.admin('reports', '--limit', '201').returncode, 2)
        self.assertEqual(self.requests(), [])
        dry = self.admin('decide', CASE, 'quarantine', '--dry-run', '--note', 'looks like phishing')
        self.assertIn('Dry run: would apply quarantine to ' + CASE, dry.stdout)
        unconfirmed = self.admin('decide', CASE, 'remove', '--note', 'confirmed phishing')
        self.assertEqual(unconfirmed.returncode, 1)
        self.assertIn('report & plans.zip', unconfirmed.stdout)
        self.assertTrue(all(method == 'GET' for method, _, _ in self.requests()))
        self.server.requests.clear()
        removed = self.admin('decide', CASE, 'remove', '--yes', '--note', 'confirmed phishing')
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertIn('case closed (removed)', removed.stdout)
        self.assertIn('Transfer   removed · quarantine: no', removed.stdout)
        self.routes[('POST', '/api/admin/reports/' + CASE)] = (200, {**case, 'events': events, 'transfer': {
            'status': 'ready', 'quarantine': {'at': 1793260800000, 'note': 'looks like phishing'}}})
        quarantined = self.admin('decide', CASE, 'quarantine', '--note', 'looks like phishing')
        self.assertEqual(quarantined.returncode, 0, quarantined.stderr)
        self.assertIn('Transfer   ready · quarantine: since 2026-10-29 08:00 UTC (looks like phishing)', quarantined.stdout)
        # The transfer did not answer after the decision.
        self.routes[('POST', '/api/admin/reports/' + CASE)] = (200, {**case, 'status': 'closed', 'outcome': 'rejected', 'events': events, 'transfer': None})
        rejected = self.admin('decide', CASE, 'reject', '--note', 'not abusive')
        self.assertEqual(rejected.returncode, 0, rejected.stderr)
        self.assertIn('Transfer   unknown (it did not answer)', rejected.stdout)
        posts = [request for request in self.requests() if request[0] == 'POST']
        self.assertEqual(posts, [('POST', '/api/admin/reports/' + CASE, {'action': 'remove', 'note': 'confirmed phishing'}),
                                 ('POST', '/api/admin/reports/' + CASE, {'action': 'quarantine', 'note': 'looks like phishing'}),
                                 ('POST', '/api/admin/reports/' + CASE, {'action': 'reject', 'note': 'not abusive'})])
        self.routes[('POST', '/api/admin/reports/' + CASE)] = (409, {'error': 'This file is quarantined. Decide restore to lift the quarantine, '
                                                                     'or remove to take the file down.', 'code': 'quarantined'})
        refused = self.admin('decide', CASE, 'reject', '--note', 'not abusive')
        self.assertEqual((refused.returncode, refused.stderr.strip()), (1, 'HTTP 409: This file is quarantined. Decide restore to lift '
                                                                          'the quarantine, or remove to take the file down.'))

    def test_every_decision_records_a_reason(self):
        # Quarantine, restore, remove and reject need a reason of at least 3 characters; a note only needs text.
        short = (('--note', 'ab'), ('--note', ' ok '), ('--yes', '--note', 'no'))
        for action in ('quarantine', 'restore', 'remove', 'reject', 'note'):
            for extra in ((), ('--note', ''), ('--note', ' \t'), ('--dry-run',), ('--yes',)) + (() if action == 'note' else short):
                result = self.admin('decide', CASE, action, *extra)
                self.assertEqual(result.returncode, 1, (action, extra))
                self.assertIn(NOTE_REQUIRED + ' Pass it with --note TEXT' if action != 'note' else 'Pass the note with --note TEXT. Nothing was changed.',
                              result.stderr, (action, extra))
        self.assertEqual(self.requests(), [])
        self.routes[('POST', '/api/admin/reports/' + CASE)] = (200, {'case': CASE, 'status': 'open', 'events': []})
        self.assertEqual(self.admin('decide', CASE, 'note', '--note', 'ok').returncode, 0)
        self.assertEqual(self.requests(), [('POST', '/api/admin/reports/' + CASE, {'action': 'note', 'note': 'ok'})])
        # The Worker's refusal is shown in its words.
        self.routes[('POST', '/api/admin/reports/' + CASE)] = (400, {'error': NOTE_REQUIRED, 'code': 'note_required'})
        refused = self.admin('decide', CASE, 'reject', '--note', 'abc')
        self.assertEqual((refused.returncode, refused.stderr.strip()), (1, 'HTTP 400: ' + NOTE_REQUIRED + ' Pass it with --note TEXT. Nothing was changed.'))

    def test_help_says_a_decision_needs_its_note(self):
        # -h shows --note as needed, as the docstring does, not as [--note NOTE]; a missing note still gets the
        # note_required words and exit 1 from admin.py, not argparse's exit 2.
        usages = {'quarantine': 'quarantine TARGET --note T [--dry-run]', 'restore': 'restore TARGET --note T [--dry-run]',
                  'takedown': 'takedown TARGET --note T [--yes] [--dry-run]', 'decide': 'decide CASE ACTION --note T [--yes] [--dry-run]'}
        doc = load_script('admin').__doc__
        for command, usage in usages.items():
            result = self.admin(command, '-h')
            self.assertEqual(result.returncode, 0, command)
            self.assertIn('usage: npm run admin -- ' + usage + '\n', result.stdout, command)
            self.assertNotIn('[--note', result.stdout, command)
            self.assertIn('npm run admin -- ' + usage.removesuffix(' [--dry-run]'), doc, command)
        self.assertIn('takedown TARGET --note T [--yes]', self.admin('takedown', '-h').stdout)
        for args in (('takedown', ID, '--yes'), ('quarantine', ID), ('restore', ID), ('decide', CASE, 'reject')):
            result = self.admin(*args)
            self.assertEqual(result.returncode, 1, args)
            self.assertIn(NOTE_REQUIRED + ' Pass it with --note TEXT', result.stderr, args)
        self.assertEqual(self.requests(), [])

    def test_reports_page_after_the_last_case_and_filter_by_transfer(self):
        # The open queue comes most urgent first; `next` is the last case of the page, the next one starts after it.
        later = 'R-0000000001'
        page = [{'case': CASE, 'createdAt': 1793260800000, 'transferId': ID, 'category': 'csam', 'status': 'open', 'fileAvailable': False,
                 'priority': 1}]
        self.routes[('GET', '/api/admin/reports?status=open&limit=1&transfer=' + ID)] = (200, {'reports': page, 'next': CASE})
        self.routes[('GET', '/api/admin/reports?status=open&limit=1&transfer={}&after={}'.format(ID, CASE))] = (
            200, {'reports': [{**page[0], 'case': later, 'category': 'copyright', 'priority': 4, 'fileAvailable': True}], 'next': None})
        first = self.admin('reports', '--limit', '1', '--transfer', 'https://fyl.at/d/' + ID)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn(CASE + '  P1  2026-10-29 08:00 UTC  csam       open             {}  file gone\n'.format(ID), first.stdout)
        self.assertIn('Next page: npm run admin -- reports --status open --limit 1 --transfer {} --after {}\n'.format(ID, CASE), first.stdout)
        second = self.admin('reports', '--limit', '1', '--transfer', ID, '--after', CASE.lower())
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn(later + '  P4  ', second.stdout)
        self.assertNotIn('file gone', second.stdout)
        self.assertNotIn('Next page', second.stdout)
        self.assertEqual(len(self.requests()), 2)
        self.routes[('GET', '/api/admin/reports?status=closed&limit=50&after=' + later)] = (200, {'reports': [], 'next': None})
        self.assertIn('No closed reports after that case.', self.admin('reports', '--status', 'closed', '--after', later).stdout)
        self.server.requests.clear()
        # The time cursor of earlier versions (--before TIME:CASE) is gone; --after takes a case id only.
        for args, code in ((('--after', '1793260800000:' + CASE), 1), (('--after', CASE + ' '), 1), (('--after', 'R-7K3M9Q2XPI'), 1),
                           (('--before', '1793260800000:' + CASE), 2), (('--transfer', 'https://evil.example/d/' + ID), 1)):
            result = self.admin('reports', *args)
            self.assertEqual(result.returncode, code, args)
        self.assertEqual(self.requests(), [])
        # A server cursor that is not a case id is not offered as a command.
        for cursor in ('1; rm -rf /', '1793260800000:' + CASE, 42):
            self.routes[('GET', '/api/admin/reports?status=open&limit=50')] = (200, {'reports': page, 'next': cursor})
            self.assertNotIn('Next page', self.admin('reports').stdout)

    def test_show_names_the_open_cases(self):
        cases = ['R-{:010d}'.format(number) for number in range(20)]
        for extra, expected in (({'openReports': 2, 'openCases': cases[:2]}, '2 open: R-0000000000, R-0000000001'),
                                ({'openReports': 25, 'openCases': cases}, '25 open: R-0000000000, ' + ', '.join(cases[1:]) +
                                 ' and 5 more (reports --transfer {})'.format(ID)),
                                ({'openReports': 0, 'openCases': []}, '0 open'),
                                ({'openReports': None, 'openCases': None}, 'unknown (the reports did not answer)')):
            self.routes[('GET', '/api/admin/transfers/' + ID)] = (200, view(**extra))
            result = self.admin('show', ID)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('  Reports    ' + expected + '\n', result.stdout)

    def test_ready(self):
        checks = {'secrets': {'NETWORK_HASH_KEY': True, 'GRANT_SIGNING_KEY': True, 'ADMIN_TOKEN': True}, 'rotation': True, 'r2': True,
                  'budget': True, 'reports': True}
        self.routes[('GET', '/api/admin/ready')] = (200, {'ready': True, 'checks': checks, 'backlog': {'overdueCleanups': 0}, 'openReports': 0})
        result = self.admin('ready')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Ready:     yes', result.stdout)
        self.assertIn('Reports:   0 open\n', result.stdout)
        self.assertTrue(result.stdout.endswith('Attention: no\n'), result.stdout)
        # The Worker names what waits for the operator; the oldest open report's age and the most urgent priority.
        self.routes[('GET', '/api/admin/ready')] = (200, {
            'ready': True, 'attention': True, 'reasons': ['open_reports', 'storage_60', 'daily_60', 'new_reason'], 'checks': checks,
            'backlog': {'overdueCleanups': 0}, 'openReports': 2, 'oldestOpenReportAge': 3 * 3600 + 5 * 60 + 59, 'highestOpenPriority': 1,
            'capacity': {'storedPercent': 61, 'dailyPercent': None}, 'newCount': 3})
        result = self.admin('ready')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Reports:   2 open · oldest 3 h 5 min · most urgent priority 1 (CSAM)\n', result.stdout)
        self.assertIn('Capacity:  stored 61 % of MAX_STORED_BYTES · today - of MAX_DAILY_UPLOAD_BYTES\n', result.stdout)
        self.assertIn('newCount: 3\n', result.stdout)
        self.assertIn('Attention: YES\n  open_reports      reports wait for a decision: npm run admin -- reports\n'
                      '  storage_60        stored bytes reached 60 % of MAX_STORED_BYTES: npm run admin -- status\n'
                      "  daily_60          today's upload volume reached 60 % of MAX_DAILY_UPLOAD_BYTES: npm run admin -- status\n"
                      "  new_reason        see the Worker's readiness answer\n", result.stdout)
        admin = load_script('admin')
        for seconds, shown in ((59, '0 min'), (3599, '59 min'), (3600, '1 h 0 min'), (47 * 3600 + 120, '47 h 2 min'), (49 * 3600, '2 d 1 h'),
                               (None, None), (-1, None), (True, None)):
            self.assertEqual(admin.age(seconds), shown, seconds)
        # A Worker without reason codes: the API says attention, or its counts show it.
        for answer, reason in (({'attention': True, 'openReports': 0}, '  attention         '), ({'openReports': 2}, '  open_reports      ')):
            self.routes[('GET', '/api/admin/ready')] = (200, {'ready': True, 'checks': checks, 'backlog': {'overdueCleanups': 0}, **answer})
            result = self.admin('ready')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Attention: YES\n' + reason, result.stdout)
        self.assertIn('2 open\n', result.stdout)
        failing = {**checks, 'secrets': {**checks['secrets'], 'GRANT_SIGNING_KEY': False}, 'r2': False}
        self.routes[('GET', '/api/admin/ready')] = (503, {'ready': False, 'checks': failing, 'backlog': {'overdueCleanups': 3}, 'openReports': 0})
        result = self.admin('ready')
        self.assertEqual(result.returncode, 1)
        self.assertIn('GRANT_SIGNING_KEY MISSING', result.stdout)
        self.assertIn('r2        FAILED', result.stdout)
        self.assertIn('overdueCleanups 3', result.stdout)
        self.assertIn('Attention: YES\n  overdue_cleanups  cleanups are overdue', result.stdout)

    def test_status_and_pause(self):
        status = {'paused': False,
                  'stored': {'bytes': 2 * 1024 ** 4, 'payload': 2 * 1024 ** 4 - 150 * 1024 ** 2, 'copies': 100 * 1024 ** 2, 'reserved': 50 * 1024 ** 2,
                             'uploads': 3, 'maxBytes': 5 * 1024 ** 4, 'maxUploads': 100000},
                  'today': {'bytes': 0, 'payload': 0, 'reserved': 0, 'attempted': 5 * 1024 ** 3, 'uploads': 0, 'maxBytes': 1024 ** 4, 'maxUploads': 50000},
                  'network': {'maxBytes': 250 * 1024 ** 3, 'maxUploads': 500, 'maxActive': 50, 'maxStored': 250 * 1024 ** 3},
                  'overdueCleanups': 0, 'networkHashKeyed': True, 'openReports': 4, 'newCounter': {'bytes': 1024 ** 2}}
        self.routes[('GET', '/api/admin/uploads')] = (200, status)
        self.routes[('POST', '/api/admin/uploads')] = (200, {**status, 'paused': True})
        shown = self.admin('status')
        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertIn('2.00 TB of 5.00 TB · 3 of 100000 uploads', shown.stdout)
        self.assertIn('payload 2.00 TB · copies 100.00 MB · reserved 50.00 MB', shown.stdout)
        self.assertIn('attempted 5.00 GB', shown.stdout)
        self.assertIn('Network:   per day 250.00 GB and 500 uploads · 50 running at once · 250.00 GB stored at once\n', shown.stdout)
        self.assertIn('Cleanups:  0 overdue', shown.stdout)
        self.assertIn('Reports:   4 open', shown.stdout)
        self.assertIn('newCounter: bytes 1.00 MB', shown.stdout)
        self.assertNotIn('NETWORK_HASH_KEY', shown.stdout)
        # The storage cap with more network numbers, and a Worker that has no cap yet.
        for network, line in (({'maxStored': 1024 ** 4, 'storedNetworks': 3, 'maxStoredWarnBytes': 1024 ** 3},
                               '- running at once · 1.00 TB stored at once\n            storedNetworks 3 · maxStoredWarnBytes 1.00 GB\n'),
                              ({'maxBytes': 1024 ** 3, 'maxUploads': 5, 'maxActive': 2}, 'per day 1.00 GB and 5 uploads · 2 running at once · - stored at once\n')):
            self.routes[('GET', '/api/admin/uploads')] = (200, {**status, 'network': network})
            self.assertIn(line, self.admin('status').stdout)
        self.routes[('GET', '/api/admin/uploads')] = (200, status)
        self.server.requests.clear()
        dry = self.admin('pause', '--dry-run')
        self.assertIn('Dry run: would pause uploads', dry.stdout)
        paused = self.admin('pause')
        self.assertIn('PAUSED', paused.stdout)
        self.assertEqual(self.requests(), [('GET', '/api/admin/uploads', None), ('POST', '/api/admin/uploads', {'paused': True})])

    def test_reconcile(self):
        status = {'paused': False, 'stored': {'bytes': 0, 'uploads': 0, 'maxBytes': 1, 'maxUploads': 1}, 'today': {}}
        self.routes[('GET', '/api/admin/uploads')] = (200, status)
        dry = self.admin('reconcile', '--dry-run')
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertIn('Dry run: would recount', dry.stdout)
        self.assertEqual(self.requests(), [('GET', '/api/admin/uploads', None)])
        self.server.requests.clear()
        self.routes[('POST', '/api/admin/reconcile')] = (200, {'drift': {'network_active': 2, 'reserved': 52428800}, **status})
        fixed = self.admin('reconcile')
        self.assertEqual(fixed.returncode, 0, fixed.stderr)
        self.assertIn('Fixed:     network_active 2, reserved 50.00 MB', fixed.stdout)
        self.assertIn('Uploads:   accepted', fixed.stdout)
        self.routes[('POST', '/api/admin/reconcile')] = (200, {'drift': {}, 'cleanups': {'rearmed': 1, 'released': 0, 'failed': 0}})
        quiet = self.admin('reconcile').stdout
        self.assertIn('Fixed:     nothing was off', quiet)
        self.assertIn('Cleanups:  rearmed 1 (overdue transfers', quiet)
        self.assertEqual(self.requests(), [('POST', '/api/admin/reconcile', {})] * 2)
        del self.routes[('POST', '/api/admin/reconcile')]
        older = self.admin('reconcile')
        self.assertEqual(older.returncode, 1)
        self.assertIn('is this command known to its version?', older.stderr)

    def test_the_access_service_token_goes_with_every_request(self):
        self.routes[('GET', '/api/admin/uploads')] = (200, {'paused': False})
        result = self.admin('status', extra=ACCESS)
        self.assertEqual(result.returncode, 0, result.stderr)
        sent = self.server.headers[-1]
        self.assertEqual((sent.get('CF-Access-Client-Id'), sent.get('CF-Access-Client-Secret'), sent.get('Authorization')),
                         (CLIENT_ID, CLIENT_SECRET, 'Bearer ' + TOKEN))

    def test_the_admin_host_needs_the_service_token(self):
        # A copy without a .env next to it, so only the environment counts: the default admin host, no service token.
        folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, folder)
        (folder / 'scripts').mkdir()
        script = folder / 'scripts' / 'admin.py'
        shutil.copy(ADMIN, script)
        result = self.admin('status', base='', script=script)
        self.assertEqual(result.returncode, 1)
        self.assertIn('admin.fyl.at is behind Cloudflare Access: set FYL_ACCESS_CLIENT_ID and FYL_ACCESS_CLIENT_SECRET', result.stderr)
        # Which hosts get the service token: the admin host needs it, a local Worker takes it when set.
        module = load_script('admin')
        module.ENV_FILE = folder / '.env'
        with mock.patch.dict(os.environ, ACCESS):
            for base, headers in (('https://admin.fyl.at', {'CF-Access-Client-Id': CLIENT_ID, 'CF-Access-Client-Secret': CLIENT_SECRET}),
                                  ('http://127.0.0.1:4173', {'CF-Access-Client-Id': CLIENT_ID, 'CF-Access-Client-Secret': CLIENT_SECRET})):
                module.BASE = base
                self.assertEqual(module.access(), headers, base)
        with mock.patch.dict(os.environ, {name: '' for name in ACCESS}):
            for base in ('http://admin.localhost:4173', 'http://127.0.0.1:4173'):
                module.BASE = base
                self.assertEqual(module.access(), {}, base)
            module.BASE = 'https://admin.fyl.at'
            with self.assertRaises(SystemExit):
                module.access()
        # The .env file fills in what the environment lacks.
        (folder / '.env').write_text('FYL_ACCESS_CLIENT_ID={}\nFYL_ACCESS_CLIENT_SECRET={}\n'.format(CLIENT_ID, CLIENT_SECRET))
        with mock.patch.dict(os.environ, {name: '' for name in ACCESS}):
            self.assertEqual(module.access(), {'CF-Access-Client-Id': CLIENT_ID, 'CF-Access-Client-Secret': CLIENT_SECRET})
        # The public host has no operator API.
        module.BASE = 'https://fyl.at'
        with self.assertRaises(SystemExit) as refused:
            module.base()
        self.assertIn('has no operator API', str(refused.exception))
        # A local admin host may use plain HTTP like the other loopback names.
        module.BASE = 'http://admin.localhost:4173'
        self.assertEqual(module.base(), 'http://admin.localhost:4173')

    def test_an_access_refusal_names_the_service_token(self):
        for answer in ((302, {}, {'Location': SIGN_IN + '?redirect_url=%2F'}), (403, b'<html>Forbidden</html>', {'Content-Type': 'text/html'}),
                       (403, {'error': 'Cloudflare Access sign-in required.', 'code': 'access_denied'})):
            self.routes[('GET', '/api/admin/uploads')] = answer
            result = self.admin('status', extra=ACCESS)
            self.assertEqual(result.returncode, 1, answer)
            self.assertIn('Cloudflare Access refused the request. Check FYL_ACCESS_CLIENT_ID and FYL_ACCESS_CLIENT_SECRET', result.stderr)
            self.assertIn('2027-10-30', result.stderr)

    def test_redirects_are_not_followed_and_the_token_stays_on_loopback_https(self):
        elsewhere = serve(self)
        self.routes[('GET', '/api/admin/uploads')] = (302, {}, {'Location': 'http://127.0.0.1:{}/steal'.format(elsewhere.server_port)})
        result = self.admin('status')
        self.assertEqual(result.returncode, 1)
        self.assertIn('HTTP 302: redirected', result.stderr)
        self.assertEqual(elsewhere.requests, [])
        plain = self.admin('status', base='http://fyl.at')
        self.assertEqual(plain.returncode, 1)
        self.assertIn('FYL_BASE_URL must start with https://', plain.stderr)
        self.routes[('GET', '/api/admin/uploads')] = (401, {'error': 'Operator token required.', 'code': 'denied'})
        self.assertEqual(self.admin('status').stderr.strip(), 'HTTP 401: Operator token required.')
        self.routes[('GET', '/api/admin/uploads')] = (200, b'<html>')
        self.assertIn('not a JSON object', self.admin('status').stderr)


class SweepTests(unittest.TestCase):
    """npm run admin -- sweep against a fake operator API and a fake Cloudflare API, both on loopback."""

    def setUp(self):
        self.server, self.cloudflare = serve(self), serve(self)
        self.origin = 'http://127.0.0.1:{}'.format(self.server.server_port)
        self.api = 'http://127.0.0.1:{}/client/v4'.format(self.cloudflare.server_port)
        # 110 objects over two pages, every third without stored data: 74 with it, in batches of 50 and 24.
        self.objects = [{'id': '{:064x}'.format(index + 1), 'hasStoredData': index % 3 != 2} for index in range(110)]
        self.stored = [item['id'] for item in self.objects if item['hasStoredData']]

        def ok(result, **info):
            return 200, {'success': True, 'errors': [], 'result': result, 'result_info': info}
        self.cloudflare.routes.update({
            ('GET', NAMESPACES + '?page=1&per_page=100'): ok([{'id': 'ns-other', 'name': 'other_Transfer', 'script': 'other', 'class': 'Transfer'},
                                                              {'id': 'ns-budget', 'name': SCRIPT + '_Budget', 'script': SCRIPT, 'class': 'Budget'}],
                                                             page=1, per_page=100, total_pages=2),
            ('GET', NAMESPACES + '?page=2&per_page=100'): ok([{'id': 'ns-transfer', 'name': SCRIPT + '_Transfer', 'script': SCRIPT, 'class': 'Transfer'}],
                                                             page=2, per_page=100, total_pages=2),
            ('GET', OBJECTS + '?limit=1000'): ok(self.objects[:60], count=60, cursor='page-two'),
            ('GET', OBJECTS + '?limit=1000&cursor=page-two'): ok(self.objects[60:], count=50, cursor=''),
        })

    def answers(self, *answers):
        """The Worker's sweep answers, one per request in order."""
        queue = list(answers)
        self.server.routes[('POST', '/api/admin/sweep')] = lambda headers: queue.pop(0)

    def admin(self, *args):
        env = {**{name: value for name, value in os.environ.items() if name not in ACCESS_NAMES + ('CLOUDFLARE_API_TOKEN',)},
               'FYL_ADMIN_TOKEN': TOKEN, 'FYL_BASE_URL': self.origin, 'FYL_CLOUDFLARE_API': self.api, 'CLOUDFLARE_API_TOKEN': CF_TOKEN,
               'PYTHONDONTWRITEBYTECODE': '1'}
        result = subprocess.run([sys.executable, '-I', str(ADMIN), *args], stdin=subprocess.DEVNULL, capture_output=True, text=True, env=env, timeout=30)
        for secret in (TOKEN, CF_TOKEN):
            self.assertNotIn(secret, result.stdout + result.stderr)
        return result

    def listed(self):
        """The Cloudflare API requests, each with the Cloudflare token (never the operator's)."""
        for request in self.cloudflare.requests:
            self.assertEqual(request[3], 'Bearer ' + CF_TOKEN)
        return [request[1] for request in self.cloudflare.requests]

    def posted(self):
        for request in self.server.requests:
            self.assertEqual(request[3], 'Bearer ' + TOKEN)
        return [(request[1], request[2]['ids']) for request in self.server.requests]

    def test_sweeps_the_stored_objects_of_the_transfer_namespace_in_batches(self):
        self.answers((200, {'checked': 50, 'stored': 50, 'fixed': 7, 'leftover': 0, 'failed': 0}), (200, {'checked': 24, 'stored': 23, 'fixed': 1, 'leftover': 0, 'failed': 0}))
        result = self.admin('sweep')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.listed(), [NAMESPACES + '?page=1&per_page=100', NAMESPACES + '?page=2&per_page=100',
                                         OBJECTS + '?limit=1000', OBJECTS + '?limit=1000&cursor=page-two'])
        self.assertEqual(self.posted(), [('/api/admin/sweep', self.stored[:50]), ('/api/admin/sweep', self.stored[50:])])
        lines = result.stdout.splitlines()
        self.assertEqual(lines, ['Listed:    110 Transfer objects, 74 objects with stored data',
                                 'Batch 1/2: 50 checked · 50 stored · 7 fixed · 0 leftover · 0 failed',
                                 'Batch 2/2: 74 checked · 73 stored · 8 fixed · 0 leftover · 0 failed',
                                 'Swept 74 objects: 73 stored, 8 fixed, 0 leftover, 0 failed.'])
        # Counts only: no object id is printed.
        self.assertNotIn(self.stored[0], result.stdout + result.stderr)

    def test_all_takes_every_object_and_dry_run_sends_nothing(self):
        dry = self.admin('sweep', '--dry-run')
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertIn('Dry run: would sweep 74 objects with stored data in 2 batches of up to 50. Nothing was sent.', dry.stdout)
        everything = self.admin('sweep', '--all', '--dry-run')
        self.assertIn('Listed:    110 Transfer objects, 110 objects', everything.stdout)
        self.assertIn('Dry run: would sweep 110 objects in 3 batches of up to 50.', everything.stdout)
        self.assertEqual(self.server.requests, [])
        self.answers(*[(200, {'checked': size, 'stored': size, 'fixed': 0, 'leftover': 0, 'failed': 0}) for size in (50, 50, 10)])
        result = self.admin('sweep', '--all')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([len(ids) for _, ids in self.posted()], [50, 50, 10])
        self.assertEqual(sum((ids for _, ids in self.posted()), []), [item['id'] for item in self.objects])
        self.assertIn('Swept 110 objects: 110 stored, 0 fixed, 0 leftover, 0 failed.', result.stdout)

    def test_a_failed_object_or_batch_exits_1(self):
        self.answers((200, {'checked': 50, 'stored': 49, 'fixed': 2, 'leftover': 0, 'failed': 1}), (200, {'checked': 24, 'stored': 24, 'fixed': 0, 'leftover': 0, 'failed': 0}))
        failed = self.admin('sweep')
        self.assertEqual(failed.returncode, 1)
        self.assertIn('Swept 74 objects: 73 stored, 2 fixed, 0 leftover, 1 failed.', failed.stdout)
        # A record left over (nothing removes its name) exits 1 too, with a warning that the guard must stay.
        self.server.requests.clear()
        self.answers((200, {'checked': 50, 'stored': 50, 'fixed': 0, 'leftover': 2, 'failed': 0}), (200, {'checked': 24, 'stored': 24, 'fixed': 0, 'leftover': 1, 'failed': 0}))
        left = self.admin('sweep')
        self.assertEqual(left.returncode, 1)
        self.assertIn('Swept 74 objects: 74 stored, 0 fixed, 3 leftover, 0 failed.', left.stdout)
        self.assertIn('3 stored records still hold a file name, fingerprint or session', left.stderr)
        self.assertIn('Keep the guard', left.stderr)
        # A refused batch stops the run with the Worker's message, after the totals so far.
        self.server.requests.clear()
        self.answers((200, {'checked': 50, 'stored': 50, 'fixed': 0, 'leftover': 0, 'failed': 0}), (400, {'error': 'Send {"ids": [...]}.', 'code': 'request_failed'}))
        refused = self.admin('sweep')
        self.assertEqual(refused.returncode, 1)
        self.assertIn('Batch 1/2: 50 checked', refused.stdout)
        self.assertNotIn('Swept', refused.stdout)
        self.assertIn('HTTP 400: Send {"ids": [...]}.', refused.stderr)
        # A Worker without the route.
        del self.server.routes[('POST', '/api/admin/sweep')]
        older = self.admin('sweep')
        self.assertEqual(older.returncode, 1)
        self.assertIn('is this command known to its version?', older.stderr)
        # An answer without its counts.
        self.answers((200, {'ok': True}))
        self.assertIn('had no counts', self.admin('sweep').stderr)

    def test_the_cloudflare_listing_must_be_clean(self):
        # No token: nothing is listed or sent.
        env = {name: value for name, value in os.environ.items() if name != 'CLOUDFLARE_API_TOKEN'}
        module = load_script('admin')
        module.ENV_FILE = Path(tempfile.gettempdir()) / 'fyl-sweep-no-env' / '.env'
        with mock.patch.dict(os.environ, env, clear=True), self.assertRaises(SystemExit) as missing:
            module.cloudflare('/x')
        self.assertIn('Set CLOUDFLARE_API_TOKEN', str(missing.exception))
        # Cloudflare refuses the token: its message, never the token.
        self.cloudflare.routes[('GET', NAMESPACES + '?page=1&per_page=100')] = (403, {'success': False, 'errors': [{'code': 10000, 'message': 'Authentication error'}], 'result': None})
        denied = self.admin('sweep', '--dry-run')
        self.assertEqual(denied.returncode, 1)
        self.assertIn('Cloudflare API HTTP 403: Authentication error', denied.stderr)
        # No Transfer namespace of this Worker.
        self.cloudflare.routes[('GET', NAMESPACES + '?page=1&per_page=100')] = (200, {'success': True, 'result': [], 'result_info': {'total_pages': 1}})
        absent = self.admin('sweep')
        self.assertIn('lists 0 Durable Object namespaces of {} class Transfer'.format(SCRIPT), absent.stderr)
        # An id that is not 64 lowercase hex digits stops everything before a batch is sent.
        self.setUp()
        self.objects[70]['id'] = 'F' * 64
        bad = self.admin('sweep')
        self.assertEqual(bad.returncode, 1)
        self.assertIn('not 64 lowercase hex digits. Nothing was sent.', bad.stderr)
        self.assertEqual(self.server.requests, [])
        # The token only travels to https://api.cloudflare.com, or to loopback: never plain HTTP to Cloudflare, never
        # another host, whatever the scheme.
        for api in ('http://api.cloudflare.com/client/v4', 'https://api.cloudflare.com.evil.example/client/v4',
                    'https://evil.example/client/v4', 'https://api.cloudflare.com@evil.example/client/v4',
                    'https://api.cloudflare.com:8443/client/v4', 'http://10.0.0.1/client/v4'):
            module.CLOUDFLARE_API = api
            with mock.patch.dict(os.environ, {'CLOUDFLARE_API_TOKEN': CF_TOKEN}), \
                    mock.patch.object(module.urllib.request, 'build_opener') as opener, self.assertRaises(SystemExit) as foreign:
                module.cloudflare('/x')
            self.assertIn('must be https://api.cloudflare.com/', str(foreign.exception))
            opener.assert_not_called()

    def test_an_empty_or_malformed_listing_is_not_a_clean_run(self):
        # No objects, or none with stored data: exit 1 with a message, never "Swept 0 objects".
        for objects in ([], [{'id': '{:064x}'.format(1), 'hasStoredData': False}]):
            self.cloudflare.routes[('GET', OBJECTS + '?limit=1000')] = (200, {'success': True, 'result': objects, 'result_info': {'cursor': ''}})
            for args in (('sweep',), ('sweep', '--dry-run')):
                empty = self.admin(*args)
                self.assertEqual(empty.returncode, 1, args)
                self.assertIn('Nothing to sweep: the listing returned no objects with stored data', empty.stderr)
                self.assertNotIn('Swept', empty.stdout)
        # --all with an empty namespace says so too.
        self.cloudflare.routes[('GET', OBJECTS + '?limit=1000')] = (200, {'success': True, 'result': [], 'result_info': {'cursor': ''}})
        self.assertIn('Nothing to sweep: the listing returned no objects.', self.admin('sweep', '--all').stderr)
        # A result that is not a list, or an item that is not an object, stops before anything is sent.
        for result, message in (({'objects': []}, 'object listing was not a list'), (['x' * 64], 'not a JSON object')):
            self.cloudflare.routes[('GET', OBJECTS + '?limit=1000')] = (200, {'success': True, 'result': result, 'result_info': {}})
            malformed = self.admin('sweep')
            self.assertEqual(malformed.returncode, 1)
            self.assertIn(message, malformed.stderr)
        self.cloudflare.routes[('GET', NAMESPACES + '?page=1&per_page=100')] = (200, {'success': True, 'result': {'id': 'ns-transfer'}, 'result_info': {}})
        self.assertIn('namespace listing was not a list', self.admin('sweep').stderr)
        self.assertEqual(self.server.requests, [])

    def test_a_rate_limited_batch_is_sent_again(self):
        self.answers((429, {'error': 'Too many requests. Please try again shortly.', 'code': 'rate_limited'}),
                     (200, {'checked': 50, 'stored': 50, 'fixed': 0, 'leftover': 0, 'failed': 0}), (200, {'checked': 24, 'stored': 24, 'fixed': 0, 'leftover': 0, 'failed': 0}))
        module = load_script('admin')
        module.BASE, module.CLOUDFLARE_API, module.ENV_FILE = self.origin, self.api, Path(tempfile.gettempdir()) / 'fyl-sweep-no-env' / '.env'
        output = io.StringIO()
        with mock.patch.dict(os.environ, {'FYL_ADMIN_TOKEN': TOKEN, 'CLOUDFLARE_API_TOKEN': CF_TOKEN}), \
                mock.patch.object(module.time, 'sleep') as slept, contextlib.redirect_stdout(output):
            module.main(['sweep'])
        self.assertEqual(slept.call_args_list, [mock.call(module.SWEEP_RETRY_SECONDS)])
        self.assertEqual([len(ids) for _, ids in self.posted()], [50, 50, 24])
        self.assertIn('Swept 74 objects: 74 stored, 0 fixed, 0 leftover, 0 failed.', output.getvalue())
        # It gives up after SWEEP_RETRIES more tries.
        self.server.requests.clear()
        self.answers(*[(429, {'error': 'Too many requests.', 'code': 'rate_limited'})] * (module.SWEEP_RETRIES + 1))
        with mock.patch.dict(os.environ, {'FYL_ADMIN_TOKEN': TOKEN, 'CLOUDFLARE_API_TOKEN': CF_TOKEN}), \
                mock.patch.object(module.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as stopped:
            module.main(['sweep'])
        self.assertIn('still rate limited', str(stopped.exception))
        self.assertEqual(len(self.server.requests), module.SWEEP_RETRIES + 1)


if __name__ == '__main__':
    unittest.main()

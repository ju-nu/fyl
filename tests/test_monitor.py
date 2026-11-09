"""scripts/monitor.py, the Monitor workflow's check, against a fake Worker on loopback."""
import contextlib
import io
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from fake_operator import ACCESS, ACCESS_NAMES, CLIENT_ID, CLIENT_SECRET, NOT_FOUND, SIGN_IN, TOKEN, serve
from native import load_script


# The Worker's prices (PRICES in src/billing.ts): id, product, name, unit, included, step, dollars per step.
PRICES = [('workerRequests', 'Workers', 'Requests', 'requests', 10e6, 1e6, 0.30), ('workerCpu', 'Workers', 'CPU time', 'ms', 30e6, 1e6, 0.02),
          ('r2Storage', 'R2', 'Storage', 'GB-month', 10, 1, 0.015), ('r2ClassA', 'R2', 'Class A operations', 'operations', 1e6, 1e6, 4.50),
          ('r2ClassB', 'R2', 'Class B operations', 'operations', 10e6, 1e6, 0.36),
          ('objectRequests', 'Durable Objects', 'Requests', 'requests', 1e6, 1e6, 0.15),
          ('objectDuration', 'Durable Objects', 'Duration', 'GB-s', 400000, 1e6, 12.50),
          ('rowsRead', 'Durable Objects', 'SQLite rows read', 'rows', 25e9, 1e6, 0.001),
          ('rowsWritten', 'Durable Objects', 'SQLite rows written', 'rows', 50e6, 1e6, 1.00)]
# The first real reading (docs/COSTS.md): everything within the allowances, 4 days into the cycle from 28 Oct.
FIRST = {'workerRequests': 8232, 'workerCpu': 31338.486, 'r2Storage': 0.98, 'r2ClassA': 1451, 'r2ClassB': 378, 'objectRequests': 5172,
         'objectDuration': 99.8, 'rowsRead': 100717, 'rowsWritten': 14485}
ROUGH = '(rough: the usage so far at the same daily rate, today counted as a whole day)'
BILLED = ('Billing:    about $5.00 so far (28 Oct – 27 Nov, day 4 of 31); alert at $15.00\n'
          'Pace:       on pace for about $5.00 by 27 Nov ' + ROUGH + '\n')


def estimate(elapsed=4, **used):
    """GET /api/billing's answer for the usage so far (`used` per meter id, nothing else used), priced as the Worker
    prices it, `elapsed` days into the cycle from 28 Oct to 27 Nov."""
    meters = []
    for meter, product, name, unit, included, step, price in PRICES:
        value = used.get(meter, 0)
        steps = math.ceil((value - included) / step - 1e-9) if value > included else 0
        meters.append({'id': meter, 'product': product, 'name': name, 'unit': unit, 'used': value, 'included': included, 'step': step,
                       'price': price, 'billedSteps': steps, 'cost': round(steps * price, 6)})
    above = round(sum(meter['cost'] for meter in meters), 6)
    return {'generatedAt': 1793409600000, 'sample': False, 'pricesAsOf': '2026-10-31', 'currency': 'USD',
            'cycle': {'day': 28, 'start': '2026-10-28', 'end': '2026-11-27', 'days': 31, 'elapsedDays': elapsed},
            'base': 5, 'aboveAllowance': above, 'total': round(5 + above, 6), 'meters': meters}


class MonitorTests(unittest.TestCase):
    """scripts/monitor.py, the Monitor workflow's check, against a fake Worker on loopback."""
    def setUp(self):
        self.monitor = load_script('monitor')
        self.monitor.PAUSE = 0
        self.monitor.ENV_FILE = Path(tempfile.gettempdir()) / 'fyl-monitor-test-no-env' / '.env'
        self.server, self.elsewhere = serve(self), serve(self)
        self.origin = 'http://127.0.0.1:{}'.format(self.server.server_port)
        self.routes = self.server.routes
        self.checks = {'secrets': {'NETWORK_HASH_KEY': True, 'GRANT_SIGNING_KEY': True, 'ADMIN_TOKEN': True}, 'rotation': True,
                       'r2': True, 'budget': True, 'reports': True}
        self.routes[('GET', '/api/health')] = (200, {'service': 'fyl.at', 'status': 'ok'})
        self.ready({})
        self.bill(estimate(**FIRST))

    def ready(self, extra, status=200):
        self.routes[('GET', '/api/admin/ready')] = (status, {'ready': status == 200, 'checks': self.checks, 'backlog': {'overdueCleanups': 0},
                                                             'openReports': 0, 'attention': False, **extra})

    def bill(self, answer, status=200):
        self.routes[('GET', '/api/billing')] = (status, answer)

    def check(self, token=TOKEN, **env):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {'FYL_BASE_URL': self.origin, 'MONITOR_TOKEN': token, 'GITHUB_ACTIONS': 'false', **env}), \
                contextlib.redirect_stdout(out):
            for name in {*ACCESS_NAMES, 'BILLING_ALERT_USD'} - set(env):
                os.environ.pop(name, None)
            if env.get('FYL_BASE_URL') == '':
                os.environ.pop('FYL_BASE_URL')
            try:
                self.monitor.main()
                code = 0
            except SystemExit as exit:
                code = exit.code
        self.assertNotIn(TOKEN, out.getvalue())
        self.assertNotIn(CLIENT_SECRET, out.getvalue())
        return code, out.getvalue()

    def paths(self):
        return [(path, authorization) for _, path, _, authorization in self.server.requests]

    def test_all_well_passes_and_prints_counts_only(self):
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertEqual(out, 'Health:     ok\nReady:      yes\nChecks:     5 passed, 0 failed\nReports:    0 open\n'
                              'Cleanups:   0 overdue\nAttention:  no\n' + BILLED)
        # The token goes to readiness and the estimate only.
        self.assertEqual(self.paths(), [('/api/health', None), ('/api/admin/ready', 'Bearer ' + TOKEN), ('/api/billing', 'Bearer ' + TOKEN)])

    def test_in_github_actions_only_the_names_of_failed_checks_are_printed(self):
        # Actions logs are public: no dollars, capacity, counts, pause state, hints, hosts or token dates, only which
        # checks passed. Locally the same answers print everything (the tests above and below).
        self.assertEqual(self.check(GITHUB_ACTIONS='true'), (0, 'Monitor: all checks passed.\n'))
        self.ready({'attention': True, 'reasons': ['open_reports', 'storage_60'], 'openReports': 2, 'oldestOpenReportAge': 7200,
                    'highestOpenPriority': 1, 'capacity': {'storedPercent': 61, 'dailyPercent': 75}, 'paused': True})
        self.bill(estimate(r2ClassA=5e6))
        code, out = self.check(GITHUB_ACTIONS='true')
        self.assertEqual(code, 1, out)
        self.assertEqual(out, 'Monitor: FAILED (attention, billing). Details stay out of public logs: run npm run monitor locally '
                              '(docs/OPERATIONS.md#monitor).\n'
                              '::error::The attention check failed; npm run monitor shows why.\n'
                              '::error::The billing check failed; npm run monitor shows why.\n')
        self.assertNotRegex(out, r'\d')
        code, local = self.check()
        self.assertEqual(code, 1, local)
        for detail in ('Reports:    2 open', 'Capacity:   stored 61 %, today 75 %', 'Uploads:    PAUSED', 'Billing:    about $23.00'):
            self.assertIn(detail, local)
        # Every other failure is named the same way.
        self.ready({})
        self.bill(estimate(**FIRST))
        self.routes[('GET', '/api/health')] = (500, {'error': 'Internal error.'})
        self.routes[('GET', '/api/admin/ready')] = (403, b'<html>Forbidden</html>')
        code, out = self.check(GITHUB_ACTIONS='true', BILLING_ALERT_USD='abc', **ACCESS)
        self.assertEqual(code, 1, out)
        self.assertIn('Monitor: FAILED (setup, health, readiness).', out)
        for secret in (self.monitor.TOKEN_EXPIRES, '127.0.0.1', 'HTTP', 'Access'):
            self.assertNotIn(secret, out)
        code, out = self.check(token='', GITHUB_ACTIONS='true')
        self.assertIn('Monitor: FAILED (health, setup).', out)
        # An estimate Cloudflare's analytics did not answer warns by name and fails nothing.
        self.routes[('GET', '/api/health')] = (200, {'status': 'ok'})
        self.ready({})
        self.bill({'error': 'Try again.', 'code': 'billing_unavailable'}, status=502)
        self.assertEqual(self.check(GITHUB_ACTIONS='true'), (0, '::warning::The billing check could not be read this run; the next run '
                                                                'asks again.\nMonitor: all checks passed.\n'))

    def test_a_pause_is_printed_as_a_notice_and_fails_nothing(self):
        self.ready({'paused': True})
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn('Attention:  no\nUploads:    PAUSED (notice only; npm run admin -- resume accepts them again)\n', out)

    def test_every_attention_reason_fails_the_run_and_is_printed(self):
        self.ready({'attention': True, 'reasons': ['open_reports', 'storage_60', 'daily_60'], 'openReports': 2,
                    'oldestOpenReportAge': 2 * 86400 + 3600, 'highestOpenPriority': 1, 'capacity': {'storedPercent': 61, 'dailyPercent': 75}})
        code, out = self.check()
        self.assertEqual(code, 1, out)
        self.assertEqual(out, 'Health:     ok\nReady:      yes\nChecks:     5 passed, 0 failed\nReports:    2 open, oldest 2 d 1 h, priority 1\n'
                              'Cleanups:   0 overdue\nCapacity:   stored 61 %, today 75 %\nAttention:  open_reports, storage_60, daily_60\n'
                              + BILLED +
                              'Problem:    Attention open_reports: 2 open reports wait for a decision. Run npm run admin -- reports.\n'
                              'Problem:    Attention storage_60: stored bytes reached 61 % of MAX_STORED_BYTES; uploads are refused once it is full. '
                              'Run npm run admin -- status.\n'
                              "Problem:    Attention daily_60: today's upload volume reached 75 % of MAX_DAILY_UPLOAD_BYTES. Run npm run admin -- status.\n")
        # Below 60 % the fill levels are shown and nothing fails; without them the warning names the threshold.
        self.ready({'capacity': {'storedPercent': 59, 'dailyPercent': None}})
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn('Capacity:   stored 59 %, today unknown\nAttention:  no\n', out)
        self.ready({'attention': True, 'reasons': ['storage_60']})
        self.assertIn('Attention storage_60: stored bytes reached 60 % of MAX_STORED_BYTES;', self.check()[1])
        # Each capacity warning alone fails the run, and so does a code added later or one that is no plain name.
        for codes, shown in ((['storage_60'], 'storage_60'), (['daily_60'], 'daily_60'), (['disk_90'], 'disk_90'),
                             (['<b>x</b>', 7], 'unknown'), (['daily_60', 'daily_60'], 'daily_60')):
            self.ready({'attention': True, 'reasons': codes})
            code, out = self.check()
            self.assertEqual(code, 1, codes)
            self.assertIn('Attention:  {}\n'.format(shown), out)
            self.assertIn('Problem:    Attention {}: '.format(shown), out)
        self.ready({'attention': True, 'reasons': ['disk_90']})
        self.assertIn('Problem:    Attention disk_90: the Worker reports this without a known meaning. Run npm run admin -- ready.\n', self.check()[1])

    def test_attention_from_a_worker_without_reason_codes(self):
        for extra, line in (({'attention': True}, 'Attention attention: the Worker reports attention without a reason.'),
                            ({'openReports': 2}, 'Attention open_reports: 2 open reports wait for a decision.'),
                            ({'backlog': {'overdueCleanups': 1}}, 'Attention overdue_cleanups: 1 cleanups are overdue'),
                            # Counts the reasons leave out still count.
                            ({'reasons': ['storage_60'], 'backlog': {'overdueCleanups': 1}}, 'Attention overdue_cleanups: 1 cleanups are overdue')):
            self.ready(extra)
            code, out = self.check()
            self.assertEqual(code, 1, extra)
            self.assertIn('Problem:    ' + line, out)
        self.assertIn('Attention:  storage_60, overdue_cleanups\n', out)

    def test_not_ready_fails_the_run(self):
        self.checks.update(r2=False, secrets={'NETWORK_HASH_KEY': True, 'GRANT_SIGNING_KEY': False, 'ADMIN_TOKEN': True})
        self.ready({}, status=503)
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn('Ready:      NO', out)
        self.assertIn('Checks:     3 passed, 2 failed (r2, secrets)', out)
        self.assertIn('Problem:    fyl.at is not ready: r2, secrets failed. Run npm run admin -- ready.', out)
        self.assertNotIn('GRANT_SIGNING_KEY', out)
        self.checks.update(r2=True, secrets={})
        self.ready({'ready': False})
        self.assertEqual(self.check()[0], 1)

    def test_health_must_answer_ok(self):
        for answer, tries in (((500, b''), self.monitor.TRIES), ((500, {'error': 'Internal error.'}), 1), ((200, {'status': 'degraded'}), 1),
                              ((200, b'<html>'), 1), ((302, {}, {'Location': 'http://127.0.0.1:{}/x'.format(self.elsewhere.server_port)}), 1)):
            self.server.requests.clear()
            self.routes[('GET', '/api/health')] = answer
            code, out = self.check()
            self.assertEqual(code, 1, answer)
            self.assertIn('Health:     FAILED (HTTP {})'.format(answer[0]), out)
            self.assertIn('/api/health did not answer ok.', out)
            self.assertIn('Ready:      yes', out)
            self.assertEqual(self.paths().count(('/api/health', None)), tries, answer)
        self.assertEqual(self.elsewhere.requests, [])

    def test_without_the_token_readiness_is_not_asked(self):
        code, out = self.check(token='  ')
        self.assertEqual(code, 1)
        self.assertIn('Health:     ok', out)
        self.assertIn('Problem:    Set the repository secret MONITOR_TOKEN', out)
        self.assertEqual(self.paths(), [('/api/health', None)])

    def test_readiness_errors_fail_the_run(self):
        for answer, message in (((401, {'error': 'Operator token required.'}), 'Readiness answered HTTP 401. The Worker refused MONITOR_TOKEN'),
                                ((404, {'error': 'API endpoint not found.'}), 'Readiness answered HTTP 404. The Worker has no readiness route'),
                                ((200, b'<html>'), 'Readiness answered HTTP 200.'),
                                ((302, {}, {'Location': 'http://127.0.0.1:{}/steal'.format(self.elsewhere.server_port)}), 'Readiness answered HTTP 302.')):
            self.routes[('GET', '/api/admin/ready')] = answer
            code, out = self.check()
            self.assertEqual(code, 1, answer)
            self.assertIn(message, out)
            # Without an answer from readiness the estimate isn't asked: the same token would only fail there again.
            self.assertNotIn('Billing:', out)
        self.assertNotIn('/api/billing', [path for path, _ in self.paths()])
        # A redirect is never followed, so the token never leaves the origin.
        self.assertEqual(self.elsewhere.requests, [])

    def test_the_service_token_goes_to_the_admin_host_only(self):
        code, out = self.check(**ACCESS)
        self.assertEqual(code, 0, out)
        sent = {path: (headers.get('CF-Access-Client-Id'), headers.get('CF-Access-Client-Secret'))
                for (_, path, _, _), headers in zip(self.server.requests, self.server.headers, strict=True)}
        self.assertEqual(sent, {'/api/health': (None, None), '/api/admin/ready': (CLIENT_ID, CLIENT_SECRET), '/api/billing': (CLIENT_ID, CLIENT_SECRET)})

    def test_an_estimate_below_the_alert_passes_with_its_overage_and_pace(self):
        # 64 GB-month of R2 storage and 2.5 million Class A operations 4 days in: $14.81 so far. At that rate the cycle
        # ends far above the alert, which is informational: only the total so far fails a run.
        self.bill(estimate(r2Storage=64, r2ClassA=2.5e6, workerRequests=8232))
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn('Attention:  no\nBilling:    about $14.81 so far (28 Oct – 27 Nov, day 4 of 31); alert at $15.00\n'
                      'Overage:    R2 class A operations $9.00, R2 storage $0.81\n'
                      # Each meter scaled to the cycle and priced again: 496 GB-month and 19.4 million operations.
                      'Pace:       on pace for about $97.79 by 27 Nov ' + ROUGH + '\n', out)
        self.assertNotIn('Problem', out)

    def test_an_estimate_at_or_above_the_alert_fails_naming_the_meters_and_the_invoice(self):
        # Exactly the alert: $9.00 of R2 Class A operations and $1.00 of Workers CPU time above the allowances, plus the base.
        self.bill(estimate(r2ClassA=3e6, workerCpu=80e6))
        code, out = self.check()
        self.assertEqual(code, 1, out)
        self.assertIn('Billing:    about $15.00 so far (28 Oct – 27 Nov, day 4 of 31); alert at $15.00\n'
                      'Overage:    R2 class A operations $9.00, Workers CPU time $1.00\nPace:       ', out)
        self.assertIn('Problem:    The estimated Cloudflare bill is about $15.00 so far (28 Oct – 27 Nov, day 4 of 31), at or above the alert '
                      'at $15.00 (BILLING_ALERT_USD). Above the allowances: R2 class A operations $9.00, Workers CPU time $1.00. Check the '
                      'invoice at https://dash.cloudflare.com/?to=/:account/billing (the estimate leaves out tax and a few products, '
                      'docs/COSTS.md). This fails every run until the cycle starts over or BILLING_ALERT_USD is raised.\n', out)
        # Above it with more meters than the mail names: the three dearest, a meter's third decimal kept.
        self.bill(estimate(elapsed=20, r2ClassA=5e6, objectDuration=1.5e6, r2Storage=11, rowsRead=25.001e9))
        code, out = self.check()
        self.assertEqual(code, 1, out)
        self.assertIn('Billing:    about $48.02 so far (28 Oct – 27 Nov, day 20 of 31); alert at $15.00\n'
                      'Overage:    Durable Objects duration $25.00, R2 class A operations $18.00, R2 storage $0.015\n', out)
        self.assertIn('Above the allowances: Durable Objects duration $25.00, R2 class A operations $18.00, R2 storage $0.015.', out)
        self.assertNotIn('rows read', out)

    def test_billing_alert_usd_sets_the_alert(self):
        self.bill(estimate(r2Storage=64, r2ClassA=2.5e6))
        for value, expected, alert in (('9.50', 1, '$9.50'), (' 20 ', 0, '$20.00'), ('14.81', 1, '$14.81'), ('14.82', 0, '$14.82'), ('', 0, '$15.00')):
            code, out = self.check(BILLING_ALERT_USD=value)
            self.assertEqual(code, expected, (value, out))
            self.assertIn('Billing:    about $14.81 so far (28 Oct – 27 Nov, day 4 of 31); alert at {}\n'.format(alert), out)
        # The total is compared as it is shown, in cents rounded half up: $14.995 ($0.495 of R2 storage in $0.015 steps
        # and $9.50 of CPU time) shows as $15.00 and fails at $15.00; $14.985 shows as $14.99 and passes.
        for storage, cpu, expected, shown in ((43, 505e6, 1, '$15.00'), (29, 515e6, 0, '$14.99')):
            self.bill(estimate(r2Storage=storage, workerCpu=cpu))
            code, out = self.check()
            self.assertEqual(code, expected, out)
            self.assertIn('Billing:    about {} so far (28 Oct – 27 Nov, day 4 of 31); alert at $15.00\n'.format(shown), out)
        self.assertIn('Overage:    Workers CPU time $9.70, R2 storage $0.285\n', out)
        self.bill(estimate(r2Storage=43, workerCpu=505e6))
        self.assertIn('Problem:    The estimated Cloudflare bill is about $15.00 so far (28 Oct – 27 Nov, day 4 of 31), at or above the alert at '
                      '$15.00 (BILLING_ALERT_USD). Above the allowances: Workers CPU time $9.50, R2 storage $0.495.', self.check()[1])
        # An alert at the base fires with nothing above an allowance, and says so.
        self.bill(estimate(**FIRST))
        code, out = self.check(BILLING_ALERT_USD='5')
        self.assertEqual(code, 1, out)
        self.assertIn('alert at $5.00 (BILLING_ALERT_USD). Nothing is above its allowance: the alert is at or below the base charge.', out)

    def test_an_invalid_billing_alert_usd_fails_the_run(self):
        self.bill(estimate(r2ClassA=5e6))
        for value in ('abc', '0', '0.00', '-5', '1e3', 'inf', 'nan', '15 USD', '$15', '1,000', '12.'):
            code, out = self.check(BILLING_ALERT_USD=value)
            self.assertEqual(code, 1, value)
            self.assertIn('Problem:    BILLING_ALERT_USD must be a number of dollars above 0, such as 15 or 12.50 (the repository variable, '
                          'see docs/OPERATIONS.md#monitor); the billing estimate is not compared until it is.\n', out)
            # The estimate is still read and shown, but compared with nothing: $23.00 is above the default and fails nothing here.
            self.assertIn('Billing:    about $23.00 so far (28 Oct – 27 Nov, day 4 of 31)\n', out)
            self.assertEqual(out.count('Problem:'), 1, out)

    def test_analytics_not_answering_warns_and_fails_nothing(self):
        failing = {'error': "Cloudflare's analytics did not answer the billing estimate. Try again in a few minutes.", 'code': 'billing_unavailable'}
        for answer, shown in (((502, failing), 'HTTP 502 billing_unavailable'), ((502, {**failing, 'code': 'stats_unavailable'}), 'HTTP 502 stats_unavailable'),
                              ((504, b'<html>Gateway time-out</html>'), 'HTTP 504'), ((522, b''), 'HTTP 522')):
            self.server.requests.clear()
            self.routes[('GET', '/api/billing')] = answer
            code, out = self.check()
            self.assertEqual(code, 0, out)
            self.assertIn('Attention:  no\nBilling:    not read ({})\n'.format(shown), out)
            self.assertIn("Warning:    Cloudflare's analytics did not answer the billing estimate ({}); not checked this run, the next one "
                          "asks again.\n".format(shown), out)
            self.assertNotIn('Problem:', out)
        # An edge's error page is no JSON answer: tried again like any (see get()).
        self.assertEqual(self.paths().count(('/api/billing', 'Bearer ' + TOKEN)), self.monitor.TRIES)
        # A timeout or a broken connection: the same.
        real = self.monitor.get
        with mock.patch.object(self.monitor, 'get', lambda url, *args: ('no answer (timed out)', None) if url.endswith('/api/billing') else real(url, *args)):
            code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn("Billing:    not read (no answer (timed out))\nWarning:    Cloudflare's analytics did not answer", out)

    def test_a_misconfigured_estimate_fails_with_a_hint(self):
        unconfigured = {'error': 'The billing estimate needs the CF_ANALYTICS_TOKEN secret (a read-only API token with Account Analytics Read).',
                        'code': 'billing_unconfigured'}
        # An expired or revoked analytics token lasts until it is replaced: unlike an outage, it fails the run.
        refused = {'error': 'Cloudflare refused the CF_ANALYTICS_TOKEN secret for the billing estimate: the token expired, was revoked or lacks '
                            'Account Analytics Read for this account.', 'code': 'billing_refused'}
        for answer, message in (((401, {'error': 'Operator token required.', 'code': 'denied'}),
                                 'The billing estimate answered HTTP 401 denied. The Worker refused MONITOR_TOKEN for the estimate: a Worker from '
                                 'before the monitor\'s billing check takes it for readiness only (deploy the current main)'),
                                ((403, b'<html>Forbidden</html>'), 'The billing estimate answered HTTP 403. Cloudflare Access refused the service token'),
                                ((302, {}, {'Location': SIGN_IN}), 'The billing estimate answered HTTP 302. Cloudflare Access refused the service token'),
                                (NOT_FOUND, 'The billing estimate answered HTTP 404 not_found. The Worker has no billing estimate at this address: '
                                            'FYL_BASE_URL must be the admin host'),
                                ((503, unconfigured), "The billing estimate answered HTTP 503 billing_unconfigured. The Worker can't estimate the bill: "
                                                      'it needs the secret CF_ANALYTICS_TOKEN (read-only, Account Analytics Read) and the var BILLING_CYCLE_DAY'),
                                ((503, refused), "The billing estimate answered HTTP 503 billing_refused. Cloudflare refused the Worker's CF_ANALYTICS_TOKEN: "
                                                 'it expired, was revoked or lacks Account Analytics Read. Create a new read-only token and set it with npx '
                                                 'wrangler secret put CF_ANALYTICS_TOKEN (docs/OPERATIONS.md#admin-host-and-statistics); until then the '
                                                 "dashboard's estimate is missing too.\n"),
                                ((500, {'error': 'Internal error.', 'code': 'internal'}), 'The billing estimate answered HTTP 500 internal.\n'),
                                ((200, b'<html>'), 'The billing estimate answered HTTP 200.\n'),
                                ((200, {'total': 'lots'}), 'The billing estimate answered HTTP 200.\n'),
                                ((302, {}, {'Location': 'http://127.0.0.1:{}/steal'.format(self.elsewhere.server_port)}), 'The billing estimate answered HTTP 302.')):
            self.routes[('GET', '/api/billing')] = answer
            code, out = self.check()
            self.assertEqual(code, 1, answer)
            self.assertIn('Billing:    FAILED (HTTP {}'.format(answer[0]), out)
            self.assertIn('Problem:    ' + message, out)
        self.assertEqual(self.elsewhere.requests, [])

    def test_a_sample_estimate_never_alerts(self):
        # A local Worker with DEV_FAKE_STATS makes its numbers up.
        self.bill({**estimate(r2ClassA=9e6), 'sample': True})
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn('Billing:    about $41.00 so far (28 Oct – 27 Nov, day 4 of 31); sample data, never alerts\n', out)

    def test_odd_meters_are_named_plainly_or_not_at_all(self):
        answer = estimate(r2ClassA=3e6)
        answer['meters'][3]['name'] = 'Class A\n::error::forged'
        # Without every meter's numbers there is no pace.
        del answer['meters'][0]['used']
        self.bill(answer)
        code, out = self.check()
        self.assertEqual(code, 0, out)
        self.assertIn('Overage:    unknown meter $9.00\n', out)
        self.assertNotIn('forged', out)
        self.assertNotIn('Pace:', out)
        # Without a readable cycle the total still counts.
        self.bill({**estimate(r2ClassA=5e6), 'cycle': {'start': 'soon', 'days': 31, 'elapsedDays': 4}})
        code, out = self.check()
        self.assertEqual(code, 1, out)
        self.assertIn('Billing:    about $23.00 so far; alert at $15.00\nOverage:    R2 class A operations $18.00\nProblem:    ', out)
        self.assertIn('Problem:    The estimated Cloudflare bill is about $23.00 so far, at or above the alert at $15.00', out)

    def test_readiness_on_the_admin_host_needs_the_service_token(self):
        # The default admin host (no FYL_BASE_URL), health on the public site (here the fake one): without the service
        # token readiness is not asked, and the run fails naming the repository secrets.
        code, out = self.check(FYL_BASE_URL='', FYL_PUBLIC_URL=self.origin)
        self.assertEqual(code, 1)
        self.assertIn('Health:     ok', out)
        self.assertIn('Problem:    Set the repository secrets FYL_ACCESS_CLIENT_ID and FYL_ACCESS_CLIENT_SECRET to the Cloudflare Access '
                      'service token of admin.fyl.at', out)
        self.assertEqual(self.paths(), [('/api/health', None)])
        for answer in ((302, {}, {'Location': SIGN_IN}), (403, b'<html>Forbidden</html>')):
            self.routes[('GET', '/api/admin/ready')] = answer
            code, out = self.check(**ACCESS)
            self.assertEqual(code, 1, answer)
            self.assertIn('Readiness answered HTTP {}. Cloudflare Access refused the service token'.format(answer[0]), out)
            self.assertIn('it runs until {}'.format(self.monitor.TOKEN_EXPIRES), out)
        code, _ = self.check(FYL_PUBLIC_URL='http://fyl.at')
        self.assertIn('FYL_PUBLIC_URL must start with https://', code)

    def test_no_answer_and_plain_http_elsewhere(self):
        self.server.shutdown()
        self.server.server_close()
        code, out = self.check()
        self.assertEqual(code, 1)
        self.assertIn('Health:     FAILED (no answer', out)
        self.assertIn('Ready:      FAILED (no answer', out)
        code, _ = self.check(FYL_BASE_URL='http://fyl.at')
        self.assertIn('FYL_BASE_URL must start with https://', code)


if __name__ == '__main__':
    unittest.main()

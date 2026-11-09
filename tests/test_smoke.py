"""scripts/smoke.py's requests, page checks and served-code comparison against loopback servers."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import unittest
from unittest import mock

from fake_operator import ACCESS, CLIENT_ID, CLIENT_SECRET, ID, NOT_FOUND, SIGN_IN, TOKEN, serve
from native import ROOT, load_script


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self.smoke = load_script('smoke')
        self.server, self.elsewhere = serve(self), serve(self)
        self.origin = 'http://127.0.0.1:{}'.format(self.server.server_port)
        self.steal = 'http://127.0.0.1:{}/steal'.format(self.elsewhere.server_port)
        self.elsewhere.routes[('GET', '/steal')] = (200, {'ready': True})

    def test_credentials_never_follow_a_redirect(self):
        self.server.routes[('GET', '/api/admin/ready')] = (302, {}, {'Location': self.steal + '?grant=secret#x'})
        # The readiness check sends the operator token, the Basic Auth downloads a password. (urllib never follows a
        # redirect for the DELETE and PATCH calls that carry a management key.)
        for headers, follow in (({'Authorization': 'Bearer ' + TOKEN}, False), ({'Authorization': 'Bearer ' + TOKEN}, True),
                                (self.smoke.basic('a password'), True), ({'CF-Access-Client-Id': CLIENT_ID, 'CF-Access-Client-Secret': CLIENT_SECRET}, True)):
            with self.assertRaises(RuntimeError) as raised:
                self.smoke.request(self.origin + '/api/admin/ready', headers=headers, expected=(200, 503), follow=follow)
            self.assertEqual(str(raised.exception), 'Unexpected HTTP status: 302; expected (200, 503). Redirected to {}.'.format(self.steal))
        self.assertEqual(self.elsewhere.requests, [])
        # A transfer id in the redirect's path stays out of the message, which lands in deploy logs.
        self.server.routes[('GET', '/api/admin/ready')] = (302, {}, {'Location': self.steal + '/d/' + ID})
        with self.assertRaises(RuntimeError) as raised:
            self.smoke.request(self.origin + '/api/admin/ready', expected=200, follow=False)
        self.assertEqual(str(raised.exception), 'Unexpected HTTP status: 302; expected 200. Redirected to {}/d/<id>.'.format(self.steal))
        # Without credentials a redirect is still followed.
        self.server.routes[('GET', '/api/admin/ready')] = (302, {}, {'Location': self.steal})
        self.assertEqual(json.loads(self.smoke.request(self.origin + '/api/admin/ready')[1]), {'ready': True})
        self.assertEqual([request[3] for request in self.elsewhere.requests], [None])

    def test_readiness_prefers_the_read_only_monitor_token(self):
        for env, expected in (({'MONITOR_TOKEN': 'm' * 40, 'FYL_ADMIN_TOKEN': TOKEN}, 'm' * 40), ({'MONITOR_TOKEN': ' ', 'FYL_ADMIN_TOKEN': TOKEN}, TOKEN),
                              ({'FYL_ADMIN_TOKEN': TOKEN}, TOKEN), ({}, '')):
            with mock.patch.dict(os.environ, env):
                for name in {'MONITOR_TOKEN', 'FYL_ADMIN_TOKEN'} - set(env):
                    os.environ.pop(name, None)
                self.assertEqual(self.smoke.readiness_token(), expected, env)

    def test_the_admin_host_refuses_without_access_and_serves_with_the_service_token(self):
        def page(headers):
            if headers.get('CF-Access-Client-Secret') != CLIENT_SECRET:
                return 302, {}, {'Location': SIGN_IN}
            return 200, b'<!doctype html><script src="/admin/admin.js" defer></script>', {
                'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'"}

        def ready(headers):
            if headers.get('CF-Access-Client-Secret') != CLIENT_SECRET:
                return 403, b'<html>Forbidden</html>', {'Content-Type': 'text/html'}
            return (200, {'ready': True}) if headers.get('Authorization') == 'Bearer ' + TOKEN else (401, {'code': 'denied'})
        self.server.routes[('GET', '/')], self.server.routes[('GET', '/api/admin/ready')] = page, ready
        with mock.patch.dict(os.environ, ACCESS):
            self.assertIs(self.smoke.admin_host(self.origin, TOKEN), True)
        sent = [(headers.get('CF-Access-Client-Id'), headers.get('Authorization')) for headers in self.server.headers]
        self.assertEqual(sent, [(None, None), (None, 'Bearer ' + TOKEN), (CLIENT_ID, None), (CLIENT_ID, 'Bearer ' + TOKEN)])
        # Without the service token only the refusals are checked.
        self.server.headers.clear()
        with mock.patch.dict(os.environ, {name: '' for name in ACCESS}):
            self.assertIs(self.smoke.admin_host(self.origin, ''), False)
        self.assertEqual(len(self.server.headers), 1)
        failures = (
            ((200, b'<html>dashboard</html>', {'Content-Type': 'text/html'}), 'Unexpected HTTP status: 200; expected (302, 403).'),
            ((302, {}, {'Location': self.steal}), 'The admin host redirected somewhere other than the Cloudflare Access sign-in.'),
        )
        for answer, message in failures:
            self.server.routes[('GET', '/')] = answer
            with self.assertRaises(RuntimeError) as raised, mock.patch.dict(os.environ, {name: '' for name in ACCESS}):
                self.smoke.admin_host(self.origin, '')
            self.assertEqual(str(raised.exception), message)
        self.assertEqual(self.elsewhere.requests, [])

    def test_hotlinks_are_refused_and_followed_links_open_the_page(self):
        url = self.origin + '/d/' + ID
        page = b'<html><script type="application/json" id="fyl-state">{"state": "ready", "once": true}</script></html>'
        hotlink = (403, {'error': "fyl.at files can't be embedded on other sites. Open the link instead.", 'code': 'hotlink'})
        self.server.routes[('GET', '/d/' + ID)] = hotlink
        self.server.routes[('GET', '/d/{}?dl=1'.format(ID))] = (200, page, {'Content-Type': 'text/html; charset=utf-8'})
        self.smoke.hotlinks(url)
        # What a browser sends: an image another site embeds, then a navigation from another site.
        sent = [{name: headers.get(name) for name in ('Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-Dest')} for headers in self.server.headers]
        self.assertEqual(sent, [{'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image'},
                                {'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document'}])
        self.assertEqual(self.server.headers[1].get('Accept'), 'text/html')
        failures = (
            ((200, b'file bytes', {'Content-Type': 'application/octet-stream'}), None, 'Unexpected HTTP status: 200; expected 403.'),
            ((403, {'error': 'Forbidden.', 'code': 'denied'}), None, 'An embedded file was refused without the hotlink code.'),
            ((403, b'<html>Forbidden</html>'), None, 'An embedded file was refused without the hotlink code.'),
            (hotlink, (200, b'file bytes', {'Content-Type': 'application/octet-stream'}), 'A file link followed from another site skipped the download page.'),
            (hotlink, (200, page.replace(b'ready', b'gone'), {'Content-Type': 'text/html'}), 'A file link followed from another site skipped the download page.'),
        )
        for embedded, followed, message in failures:
            self.server.routes[('GET', '/d/' + ID)] = embedded
            if followed:
                self.server.routes[('GET', '/d/{}?dl=1'.format(ID))] = followed
            with self.assertRaises(RuntimeError) as raised:
                self.smoke.hotlinks(url)
            self.assertEqual(str(raised.exception), message)

    def test_the_report_probe_expects_turnstile_while_config_js_names_a_site_key(self):
        # What the Worker answers: /config.js names the site key only while Turnstile is on, and a report without a
        # token then gets 403 turnstile_failed before the unknown link's 404.
        def script(config):
            return (200, b'window.FYL_CONFIG=' + json.dumps(config).encode() + b';', {'Content-Type': 'application/javascript'})
        off, on = script({'maxFileBytes': 50 * 1024 ** 3}), script({'maxFileBytes': 50 * 1024 ** 3, 'turnstileSiteKey': '0x4AAAAAAFswoYx8izefOy0Y'})
        refused = (403, {'error': 'Please confirm you are human and send again.', 'code': 'turnstile_failed'})
        for config, report, guarded in ((off, NOT_FOUND, False), (on, refused, True)):
            self.server.routes[('GET', '/config.js')], self.server.routes[('POST', '/api/reports')] = config, report
            self.server.requests.clear()
            self.assertIs(self.smoke.report_refused(self.origin, self.origin), guarded)
            sent = self.server.requests[-1][2]
            self.assertEqual((sent['category'], sent['goodFaith'], 'turnstile' in sent), ('other', True, False))
        failures = (
            (on, NOT_FOUND, 'Unexpected HTTP status: 404; expected 403.'),
            (on, (403, {'error': 'Forbidden.', 'code': 'denied'}), 'A report without a Turnstile token was refused without turnstile_failed.'),
            (off, refused, 'Unexpected HTTP status: 403; expected 404.'),
            ((200, b'console.log(1);', {'Content-Type': 'application/javascript'}), NOT_FOUND, '/config.js does not set window.FYL_CONFIG.'),
        )
        for config, report, message in failures:
            self.server.routes[('GET', '/config.js')], self.server.routes[('POST', '/api/reports')] = config, report
            with self.assertRaises(RuntimeError) as raised:
                self.smoke.report_refused(self.origin, self.origin)
            self.assertEqual(str(raised.exception), message)

    def test_the_deploy_check_tries_again_after_a_network_error_or_a_failed_check(self):
        # The deploy runs smoke.py --pages right after wrangler deploy: a timeout from the build machine or a location
        # still serving the old version is tried again; only the last failure counts.
        calls = []
        def flaky(base, report):
            calls.append(base)
            if len(calls) == 1:
                raise TimeoutError('timed out')
            if len(calls) == 2:
                raise RuntimeError('/ allows other scripts than its own.')
        with mock.patch.object(self.smoke, 'health'), mock.patch.object(self.smoke, 'page_policies', side_effect=flaky), \
                mock.patch.object(self.smoke, 'served_code', return_value={}), mock.patch.object(self.smoke.time, 'sleep') as sleep:
            self.smoke.pages_after_deploy(self.origin, self.origin)
        self.assertEqual((len(calls), sleep.call_count), (3, 2))
        with mock.patch.object(self.smoke, 'health'), mock.patch.object(self.smoke, 'page_policies', side_effect=TimeoutError('timed out')), \
                mock.patch.object(self.smoke, 'served_code', return_value={}), mock.patch.object(self.smoke.time, 'sleep'):
            with self.assertRaises(TimeoutError):
                self.smoke.pages_after_deploy(self.origin, self.origin, tries=3, wait=0)

    def test_the_kept_code_is_compared_byte_for_byte_and_its_hashes_printed(self):
        # The deploy's page check reads policies and scripts; this reads the bytes of every file the build
        # ships as written (KEPT in scripts/minify_assets.mjs), so a served copy that differs from dist/ fails the deploy.
        kept = re.search(r"export const KEPT = \[([^\]]*)\]", (ROOT / 'scripts' / 'minify_assets.mjs').read_text()).group(1)
        self.assertEqual(tuple(sorted(re.findall(r"'([^']+)'", kept))), tuple(sorted(self.smoke.KEPT)))
        with tempfile.TemporaryDirectory() as folder:
            dist = Path(folder)
            for path, body in (('download.js', b'// download\n'), ('i18n.js', b'// i18n\n'), ('e2ee/age.js', b'export const x = 1;\n'), ('_dl/sw.js', b"'use strict';\n"),
                               ('vendor/noble-ciphers-2.4.0/chacha.js', b'// chacha\n'), ('app.js', b'// minified elsewhere\n'), ('styles.css', b'body{}\n')):
                (dist / path).parent.mkdir(parents=True, exist_ok=True)
                (dist / path).write_bytes(body)
            expected = {'/download.js', '/i18n.js', '/e2ee/age.js', '/_dl/sw.js', '/vendor/noble-ciphers-2.4.0/chacha.js'}
            sums = self.smoke.kept_files(dist)
            self.assertEqual(set(sums), expected)
            self.assertEqual(sums['/_dl/sw.js'], hashlib.sha256(b"'use strict';\n").hexdigest())
            for path in expected:
                self.server.routes[('GET', path)] = (200, (dist / path[1:]).read_bytes(), {'Content-Type': 'text/javascript'})
            self.assertEqual(self.smoke.served_code(self.origin, dist), sums)
            paths = [path for method, path, _, _ in self.server.requests]
            self.assertEqual(sorted(paths), sorted(expected))
            self.assertNotIn('/app.js', paths)
            # One byte off in the served service worker, the one that must stay keyless, fails the check by name.
            self.server.routes[('GET', '/_dl/sw.js')] = (200, b"'use strict';\nself.leak = 1;\n", {'Content-Type': 'text/javascript'})
            with self.assertRaises(RuntimeError) as raised:
                self.smoke.served_code(self.origin, dist)
            self.assertEqual(str(raised.exception), 'Served code differs from the repository\'s bytes: /_dl/sw.js.')
            self.server.routes[('GET', '/_dl/sw.js')] = (404, b'', {})
            with self.assertRaises(RuntimeError):
                self.smoke.served_code(self.origin, dist)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.smoke.print_sums(sums)
            self.assertIn(hashlib.sha256(b'// download\n').hexdigest() + '  download.js\n', out.getvalue())
        # The deploy's --pages run answers the sums after its retries, and the byte check counts as a failed check too.
        with mock.patch.object(self.smoke, 'health'), mock.patch.object(self.smoke, 'page_policies'), \
                mock.patch.object(self.smoke, 'served_code', side_effect=[RuntimeError('differs'), {'/x': 'y'}]) as code, \
                mock.patch.object(self.smoke.time, 'sleep'):
            self.assertEqual(self.smoke.pages_after_deploy(self.origin, self.origin), {'/x': 'y'})
        self.assertEqual(code.call_count, 2)

    def test_page_policies_name_only_fyls_scripts(self):
        # What the Worker sends (pagePolicy() in src/index.ts): every page lists its own scripts, /e2ee/ and /vendor/.
        origin = self.origin

        def page(scripts, workers, outside='', extra=b''):
            policy = "default-src 'self'; script-src {} {o}/e2ee/ {o}/vendor/{}; worker-src {}; style-src 'self'".format(
                ' '.join(origin + script for script in scripts), outside, ' '.join(origin + worker for worker in workers), o=origin)
            html = b''.join(b'<script src="' + script.encode() + b'"></script>' for script in scripts) + extra
            return html, {'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': policy}
        site, download = ['/md5-worker.js', '/e2ee/', '/vendor/'], ['/e2ee/', '/vendor/', '/_dl/sw.js']
        pages = {'/en/': page(['/theme.js', '/i18n.js', '/config.js', '/api.js', '/app.js'], site),
                 '/en/report': page(['/theme.js', '/i18n.js', '/config.js', '/report.js'], site, ' https://challenges.cloudflare.com'),
                 '/en/privacy': page(['/theme.js'], site), '/d/' + ID: page(['/theme.js', '/i18n.js', '/download.js'], download)}
        switch = {'Location': '/de/', 'Vary': 'Accept, Accept-Language', 'Cache-Control': 'no-store'}
        # An agent (no text/html in Accept) gets llms.txt itself at /, with the Link headers.
        manual = {'Content-Type': 'text/markdown; charset=utf-8', 'Vary': 'Accept, Accept-Language', 'Link': '<https://fyl.at/llms.txt>; rel="describedby"; type="text/markdown"'}

        def install(changes=None):
            for path, (html, headers) in {**pages, **(changes or {})}.items():
                self.server.routes[('GET', path)] = (404 if path.startswith('/d/') else 200, html, headers)
            for path in ('/download.js', '/theme.js', '/i18n.js', '/e2ee/age.js', '/e2ee/worker.js', '/_dl/sw.js'):
                self.server.routes[('GET', path)] = (200, b'', {'Cache-Control': 'no-cache'})
            self.server.routes[('GET', '/')] = lambda headers: (302, b'', switch) if 'text/html' in (headers.get('Accept') or '') else (200, b'# fyl.at\n', manual)

        def run():
            with mock.patch.object(self.smoke.secrets, 'token_urlsafe', side_effect=[ID, 'x' * 22]):
                self.smoke.page_policies(origin, origin, '/en/report')
        install()
        run()
        injected = page(['/theme.js', '/i18n.js', '/download.js'], download, extra=b'<script src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script>')
        lax = (pages['/en/'][0], {**pages['/en/'][1], 'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'"})
        for changes, message in (({'/d/' + ID: injected}, "The download page loads a script that isn't fyl's own: a zone feature injects HTML (/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js)."),
                                 ({'/en/': lax}, '/en/ allows other scripts than its own.'),
                                 ({'/en/report': page(['/theme.js', '/i18n.js', '/config.js', '/report.js'], site)}, 'The report form allows other scripts than its own.'),
                                 ({'/en/privacy': page(['/theme.js'], download)}, '/en/privacy allows other workers than its own.'),
                                 ({'/d/' + ID: page(['/theme.js', '/i18n.js', '/download.js', '/extra.js'], download)},
                                  'The download page loads other scripts than theme.js, i18n.js and download.js.')):
            install(changes)
            with self.assertRaises(RuntimeError) as raised:
                run()
            self.assertEqual(str(raised.exception), message)
        install()
        self.server.routes[('GET', '/e2ee/age.js')] = (200, b'', {'Cache-Control': 'public, max-age=31536000, immutable'})
        with self.assertRaises(RuntimeError) as raised:
            run()
        self.assertEqual(str(raised.exception), '/e2ee/age.js is not revalidated on every load.')


if __name__ == '__main__':
    unittest.main()

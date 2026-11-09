"""A fake fyl.at API on loopback for the native CLI's tests (tests/test_cli.py): it keeps the uploads, parts and
failures a test sets up in State and answers like the real Worker, refusals included."""
import base64
import hashlib
import json
import re
import threading
import unicodedata
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit


TRANSFER_ID = 't' * 43
OWNER_KEY = 'k' * 43
# Like the real server, the fake's upload ID is the transfer ID, which the receipt and its link carry.
UPLOAD_ID = 'u' * 43
PROTECTED = 'https://dl.fyl.at/d/' + UPLOAD_ID
LINK = PROTECTED + '/file.zip'
# A management link as `fyl rm` takes it: the transfer ID and a 43-character key.
MANAGE = 'https://fyl.at/#manage/{}/{}'.format(UPLOAD_ID, OWNER_KEY)


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def unb64url(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))




def plaintext_size(ciphertext):
    """P(C) of docs/E2EE.md §6, None where no file has this size."""
    rest = ciphertext - 184
    if rest < 16:
        return None
    chunks = max(1, -(-rest // 65552))
    plaintext = rest - 16 * chunks
    return plaintext if chunks < 2 or plaintext > 65536 * (chunks - 1) else None


# The first 168 bytes of every profile age file: one X25519 stanza, one body line, the MAC (docs/E2EE.md §4.2 step 4).
AGE_HEADER = re.compile(rb'age-encryption\.org/v1\n-> X25519 [A-Za-z0-9+/]{43}\n[A-Za-z0-9+/]{43}\n--- [A-Za-z0-9+/]{43}\n\Z')


def e2ee_init_error(data):
    """What the 2.4.0 server refuses in an E2EE init (docs/E2EE.md §12.1), or None."""
    if 'filename' in data:
        return 'An encrypted upload sends no file name.'
    size = data.get('size')
    if not isinstance(size, int) or size < 201 or plaintext_size(size) is None:
        return 'Invalid size.'
    try:
        head, meta = unb64url(data['e2ee']['head']), unb64url(data['e2ee']['meta'])
    except (KeyError, TypeError, ValueError):
        return 'Invalid head or meta.'
    if len(head) != 184 or len(meta) not in (712, 1224, 1736, 2248, 2760):
        return 'Invalid head or meta size.'
    if not all(AGE_HEADER.match(blob[:168]) for blob in (head, meta)):
        return 'Invalid age header.'
    if any(head[a:b] == meta[a:b] for a, b in ((32, 75), (76, 119), (168, 184))):
        return 'The metadata reuses the content header\'s randomness.'
    return None


def resume_token(key):
    """The resume token the server derives from a management key."""
    return base64.urlsafe_b64encode(hashlib.sha256(('fyl-resume:' + key).encode()).digest()).rstrip(b'=').decode()


def simulated(status, code=None, retry_after=0):
    """A simulated failure, listed as a status or a tuple of these arguments; it says Retry-After: 0 unless told otherwise."""
    return status, code, retry_after


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.requests, self.parts, self.failures = [], {}, {}
        # Every request as it arrived (request line, headers, body), to show what never reaches the server.
        self.wire = []
        self.metadata = None
        self.done = {}
        self.status = None
        self.corrupt = 0
        self.opaque = False
        self.completed = False
        self.deleted = False
        # A report about the file is under review: see Handler.transfers().
        self.quarantined = False
        # The upload is still in progress: what the owner's GET of /api/transfers/ID answers, see Handler.transfers().
        self.unfinished = None
        self.init_keys = set()
        self.started, self.release = threading.Event(), threading.Event()
        self.block = False
        self.mutate = None
        self.expires_at = 1793000000000
        # A server that ignores the password sends no link at init.
        self.early_url = True
        # Per path, how the next successful replies break: see Handler.garbled().
        self.garble = {}
        # 2.4.0 (docs/E2EE.md): the fake's own origin, which E2EE links must be on.
        self.origin = None
        # Part bodies the server stored, by part number, and every part request as (number, SHA-256, Content-MD5).
        self.blobs, self.sent = {}, []
        # E2EE: the init's head and meta, and the pinned MD5 of each part.
        self.e2ee, self.pins = None, {}
        self.e2ee_disabled = False
        # Init echoes `mode`; `url` overrides for init and receipt (a misconfigured or malicious server).
        self.echo_mode, self.init_url, self.receipt_url, self.management_url, self.receipt_name = True, None, None, None, None
        # Status lists `e2ee` and `pins` (a server without them, such as another implementation, gets no resume).
        self.status_pins = True
        # E2EE: this many parts are stored with an ETag that isn't their pin (502 part_corrupt).
        self.part_corrupt = 0
        # The transfer /d/ and the info route serve: {mode, data, name, password, once[, head, meta]}.
        self.transfer = None
        # Downloads: bytes served instead of the stored file; per response, bytes sent before the connection drops;
        # info polls still answering `uploading`; password tries left; a one-time link closed.
        self.served, self.cuts, self.uploading, self.tries, self.closed = None, [], 0, 5, False
        # A download response waits after its first bytes until `release` (see test_ctrl_c_during_a_download...).
        self.hold = False
        # The info route's `size` instead of the stored file's; a 206 that breaks its 'range' or its 'length'.
        self.info_size, self.bad_206 = None, None
        # Files under /cli/ by path (version.json, SHA256SUMS, binaries), and every request for one.
        self.cli, self.cli_requests = {}, []
        # The `error` text of simulated failures (a hostile server may put terminal escapes there).
        self.failure_text = 'simulated failure'


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def garbled(self, mode, payload):
        """A reply that doesn't arrive intact, after the request did its work."""
        self.close_connection = True
        if mode == 'drop':
            return
        if mode == 'schema':
            payload = {name: value for name, value in payload.items() if name != 'transferId'}
        body = json.dumps(payload).encode()
        sent = body[:len(body) // 2] if mode in ('cut', 'short') else body
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        # 'cut' promises the whole body and breaks off; 'short' sends a complete reply that isn't JSON.
        self.send_header('Content-Length', str(len(body) if mode == 'cut' else len(sent)))
        self.end_headers()
        self.wfile.write(sent)

    def reply(self, status, payload, retry_after=None):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        if retry_after is not None:
            self.send_header('Retry-After', str(retry_after))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def failure(self, path):
        """A simulated failure listed for `path`, sent; else False."""
        failures = self.server.state.failures.get(path, [])
        if not failures:
            return False
        failure = failures.pop(0)
        status, code, after = simulated(*failure) if isinstance(failure, tuple) else simulated(failure)
        self.reply(status, {'error': self.server.state.failure_text, **({'code': code} if code else {})}, retry_after=after)
        return True

    def credential(self, token):
        """'owner' (the key) or 'resume' when the real server's upload routes accept `token`, else None."""
        key = (self.server.state.metadata or {}).get('clientKey')
        return None if not key else 'owner' if token == key else 'resume' if token == resume_token(key) else None

    def bearer(self):
        value = self.headers.get('Authorization', '')
        return self.credential(value[len('Bearer '):]) if value.startswith('Bearer ') else None

    def basic(self):
        """The password of `Authorization: Basic`, the user name ignored; None without one."""
        value = self.headers.get('Authorization', '')
        if not value.startswith('Basic '):
            return None
        try:
            return base64.b64decode(value[len('Basic '):]).decode().split(':', 1)[1]
        except (ValueError, IndexError):
            return ''

    def encrypted(self):
        return (self.server.state.metadata or {}).get('mode') == 'e2ee'

    def link(self):
        """The download link: a protected upload's has no name segment, an encrypted one's is on this origin."""
        state = self.server.state
        if self.encrypted():
            return state.origin + '/d/' + UPLOAD_ID
        return PROTECTED if 'password' in state.metadata else LINK

    def transfers(self):
        state = self.server.state
        if self.failure(self.path):
            return None
        if self.headers.get('Authorization') != 'Bearer ' + OWNER_KEY:
            return self.reply(403, {'error': 'This private key is not valid.', 'code': 'denied'})
        if state.deleted:
            return self.reply(410, {'error': 'This file is no longer available.', 'code': 'deleted'})
        if self.command == 'DELETE':
            state.deleted = True
            return self.reply(200, {'deleted': True})
        # Like the server: an upload still in progress has no info for its owner yet ('unavailable'), or a newer server
        # shows its state ('uploading'). The owner may delete it all the same.
        if state.unfinished == 'unavailable':
            return self.reply(410, {'error': 'This file is no longer available.', 'code': 'unavailable'})
        if state.unfinished == 'uploading':
            return self.reply(200, {'id': TRANSFER_ID, 'name': 'report.zip', 'state': 'uploading', 'expiresAt': None})
        # Like the server: while a report is reviewed, even the owner gets no info, but may still delete the file.
        if state.quarantined:
            return self.reply(403, {'error': 'This file is unavailable while a report about it is reviewed.', 'code': 'quarantined'})
        return self.reply(200, {'id': TRANSFER_ID, 'name': 'report.zip', 'state': 'ready'})

    def info(self):
        """The public GET /api/transfers/ID of 2.4.0 (docs/E2EE.md §11, §12.2): Basic on it counts password tries."""
        state, transfer = self.server.state, self.server.state.transfer
        if self.failure('/info'):
            return None
        if transfer is None:
            return self.reply(404, {'error': 'Transfer not found.', 'code': 'not_found'})
        if state.closed:
            return self.reply(410, {'error': 'This file is no longer available.', 'code': 'consumed'})
        size, encrypted = state.info_size or len(transfer['data']), transfer['mode'] == 'e2ee'
        common = {'id': UPLOAD_ID, 'size': size, 'once': transfer['once'], 'protected': bool(transfer['password']), 'mode': transfer['mode']}
        if state.uploading:
            state.uploading -= 1
            return self.reply(200, {**common, 'state': 'uploading', 'received': size // 2, 'name': None, 'expiresAt': None}, retry_after=0)
        unlocked, password = not transfer['password'], self.basic()
        if transfer['password'] and password is not None:
            if state.tries <= 0:
                return self.reply(429, {'error': 'Too many wrong passwords.', 'code': 'password_paused', 'pausedUntil': 1793000000000}, retry_after=900)
            if password != transfer['password']:
                state.tries -= 1
                return self.reply(401, {'error': 'Wrong password.', 'code': 'password_wrong', 'triesLeft': state.tries})
            unlocked, state.tries = True, 5
        body = {**common, 'state': 'ready', 'expiresAt': state.expires_at,
                'name': transfer['name'] if unlocked and not encrypted else None}
        if encrypted:
            body['e2ee'] = {'head': b64url(transfer['head']), 'meta': b64url(transfer['meta'])} if unlocked else None
        return self.reply(200, body)

    def download(self, route):
        """GET /d/ID?dl=1: the stored file, Range with If-Range, Basic for a protected one, 409 for E2EE without ?dl=1."""
        state = self.server.state
        with state.lock:
            state.requests.append(('/d/', self.command, {'path': self.path, **{name: self.headers.get(name) for name in
                                                                                ('Range', 'If-Range', 'Accept', 'Authorization')}}))
            transfer = state.transfer
            if self.failure('/d/'):
                return
            identifier = re.split('/|%23', route.path[len('/d/'):], maxsplit=1, flags=re.I)[0]
            if transfer is None or identifier != UPLOAD_ID:
                return self.reply(404, {'error': 'Transfer not found.', 'code': 'not_found'})
            if state.closed:
                return self.reply(410, {'error': 'This file is no longer available.', 'code': 'consumed'})
            if transfer['mode'] == 'e2ee' and parse_qs(route.query).get('dl') != ['1']:
                return self.reply(409, {'error': "Run: fyl download '{}/d/{}'".format(state.origin, UPLOAD_ID), 'code': 'encrypted'})
            if transfer['password'] and self.basic() != transfer['password']:
                return self.reply(401, {'error': 'This file needs its password.', 'code': 'password_wrong'})
            data = transfer['data'] if state.served is None else state.served
            etag = '"{}"'.format(hashlib.md5(data).hexdigest())
            status, start, wanted = 200, 0, re.fullmatch(r'bytes=(\d+)-', self.headers.get('Range') or '')
            if wanted and self.headers.get('If-Range') in (None, etag):
                status, start = 206, int(wanted.group(1))
            # A one-time raw file closes once delivered whole; an E2EE one stays open for retries until `done`.
            if transfer['once'] and transfer['mode'] == 'raw' and status == 200:
                state.closed = True
            cut = state.cuts.pop(0) if state.cuts else None
        body = data[start:]
        # Another part than asked for: the range a byte further on, or a byte short of the end.
        shift = 1 if status == 206 and state.bad_206 == 'range' else 0
        if status == 206 and state.bad_206 == 'length':
            body = body[:-1]
        self.send_response(status)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('ETag', etag)
        if status == 206:
            self.send_header('Content-Range', 'bytes {}-{}/{}'.format(start + shift, len(data) - 1, len(data)))
        self.end_headers()
        try:
            if cut is not None:
                # The connection drops after `cut` bytes, short of the Content-Length promised.
                self.wfile.write(body[:cut])
                self.close_connection = True
                return
            if state.hold:
                self.wfile.write(body[:100_000])
                self.wfile.flush()
                state.started.set()
                state.release.wait(10)
                body = body[100_000:]
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def handle_request(self):
        state = self.server.state
        route = urlsplit(self.path)
        payload = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        with state.lock:
            state.wire.append(self.requestline.encode() + b'\n' + str(self.headers).encode() + payload)
        if route.path.startswith('/cli/'):
            with state.lock:
                state.cli_requests.append(route.path)
                body = state.cli.get(route.path)
            if body is None:
                return self.reply(404, {'error': 'Not found.'})
            self.send_response(200)
            self.send_header('Content-Type', 'application/json' if route.path.endswith('.json') else 'application/octet-stream')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return None
        if route.path.startswith('/d/'):
            return self.download(route)
        if route.path == '/api/transfers/' + UPLOAD_ID:
            with state.lock:
                state.requests.append(('/info', self.command, {'Authorization': self.headers.get('Authorization')}))
                return self.info()
        if route.path == '/api/transfers/' + UPLOAD_ID + '/done':
            with state.lock:
                state.requests.append(('/done', self.command, None))
                # Closes a one-time session at once (docs/E2EE.md §11).
                if state.transfer and state.transfer['once']:
                    state.closed = True
            self.send_response(204)
            self.end_headers()
            return None
        if route.path == '/api/upload/status':
            with state.lock:
                state.requests.append(('/status', self.command, None))
                # A closed upload's record is dropped after 7 days; then even the right key gets 404.
                if state.status == 'purged':
                    return self.reply(404, {'error': 'Transfer not found.', 'code': 'not_found'})
                access = self.bearer()
                if not access:
                    return self.reply(403, {'error': 'This private key is not valid.'})
                status = {'status': state.status or ('ready' if state.completed else 'uploading'),
                          'name': state.metadata.get('filename', 'fyl-{}.age'.format(UPLOAD_ID[:8])), 'mode': state.metadata.get('mode', 'raw'),
                          'size': state.metadata['size'], 'partSize': 50 * 1024 * 1024, 'access': access,
                          'expiresIn': state.metadata['expiresIn'], 'once': state.metadata['oneTime'],
                          'parts': [{'partNumber': n, 'size': 0, 'etag': e} for n, e in sorted(state.done.items())]}
                if self.encrypted() and state.status_pins:
                    status['e2ee'] = {name: b64url(blob) for name, blob in state.e2ee.items()}
                    status['pins'] = [{'partNumber': n, 'md5': md5} for n, md5 in sorted(state.pins.items())]
                return self.reply(200, status)
        if route.path == '/api/transfers/' + TRANSFER_ID:
            with state.lock:
                state.requests.append((route.path, self.command, None))
                return self.transfers()
        path = route.path.removeprefix('/api/upload')
        data = json.loads(payload) if self.headers.get('Content-Type') == 'application/json' else None
        with state.lock:
            state.requests.append((path, self.command, data))
            if path == '/init':
                # Like the server: 6 to 200 characters (not bytes) in NFC, no controls or lone surrogates.
                password = data.get('password')
                normal = unicodedata.normalize('NFC', password) if isinstance(password, str) else None
                if password is not None and (normal is None or not 6 <= len(normal) <= 200
                                             or any(unicodedata.category(c) in ('Cc', 'Cs') for c in normal)):
                    self.reply(400, {'error': 'Password must be 6 to 200 characters, without control characters.'})
                    return
                encrypted = data.get('mode') == 'e2ee'
                if encrypted and state.e2ee_disabled:
                    self.reply(403, {'error': "Encrypted uploads aren't enabled on this server.", 'code': 'e2ee_disabled'})
                    return
                if encrypted and e2ee_init_error(data):
                    self.reply(400, {'error': e2ee_init_error(data)})
                    return
                # A new upload: the fake reuses its id, so it forgets the previous one's parts and completion.
                state.metadata, state.parts, state.done, state.completed, state.blobs, state.pins = data, {}, {}, False, {}, {}
                state.e2ee = {'head': unb64url(data['e2ee']['head']), 'meta': unb64url(data['e2ee']['meta'])} if encrypted else None
                state.init_keys.add(self.headers.get('Idempotency-Key'))
                response = {'uploadId': UPLOAD_ID, 'key': data['clientKey']}
                if state.echo_mode:
                    response['mode'] = data.get('mode', 'raw')
                if state.early_url:
                    response['url'] = state.init_url or self.link()
            elif path == '/pin':
                # docs/E2EE.md §8.3: the first MD5 is stored, the same again is fine, another is part_changed.
                number, md5 = data.get('partNumber'), data.get('md5')
                if not self.bearer() or not self.encrypted() or not isinstance(md5, str) or not re.fullmatch('[0-9a-f]{32}', md5):
                    self.reply(400, {'error': 'Invalid pin.', 'code': 'request_failed'})
                    return
                if state.pins.setdefault(number, md5) != md5:
                    self.reply(409, {'error': 'This part changed.', 'code': 'part_changed'})
                    return
                response = {}
            elif path == '/part':
                params = parse_qs(route.query)
                if not self.bearer() or 'key' in params:
                    self.reply(403, {})
                    return
                if state.completed:
                    self.reply(410, {'error': 'This upload session is closed.'})
                    return
                number = int(params['partNumber'][0])
                content_md5 = self.headers.get('Content-MD5')
                state.sent.append((number, hashlib.sha256(payload).hexdigest(), content_md5))
                md5 = hashlib.md5(payload).hexdigest()
                if self.encrypted():
                    # An E2EE part carries Content-MD5 equal to its pin; R2 refuses a body that doesn't match it.
                    try:
                        claimed = base64.b64decode(content_md5 or '', validate=True).hex()
                    except ValueError:
                        claimed = ''
                    if len(claimed) != 32 or number not in state.pins or claimed != md5:
                        self.reply(400, {'error': 'Content-MD5 is missing, malformed or unpinned.', 'code': 'request_failed'})
                        return
                    if claimed != state.pins[number]:
                        self.reply(409, {'error': 'This part changed.', 'code': 'part_changed'})
                        return
                state.parts[number] = (len(payload), hashlib.sha256(payload).hexdigest())
                # Like R2's, the part ETag is the MD5 of the bytes (quoted, as ETags may be). The server sends
                # nothing else, and records whatever R2 returned: `corrupt` simulates damaged parts.
                etag = '"{}"'.format(md5)
                if state.opaque:
                    etag = 'local-simulator-' + hashlib.sha256(payload).hexdigest()
                if state.corrupt:
                    state.corrupt -= 1
                    etag = '0' * 32
                if self.encrypted() and state.part_corrupt:
                    # The server compares R2's ETag with the pin: a damaged part fails and isn't confirmed.
                    state.part_corrupt -= 1
                    self.reply(502, {'error': 'The stored part is damaged.', 'code': 'part_corrupt'})
                    return
                response = {'etag': etag}
                if state.mutate:
                    state.mutate.write_bytes(b'changed during upload')
            elif path == '/complete':
                credential = self.credential(data.get('key'))
                if not credential:
                    self.reply(403, {'error': 'This private key is not valid.'})
                    return
                expected = [{'partNumber': n, 'etag': state.done.get(n, '')} for n in sorted(state.parts)]
                if data['parts'] != expected:
                    self.reply(400, {'error': 'incorrect part order'})
                    return
                stored = b''.join(state.blobs[n] for n in sorted(state.blobs))
                encrypted, protected = self.encrypted(), 'password' in state.metadata
                if encrypted and stored[:184] != state.e2ee['head']:
                    self.reply(409, {'error': "The upload doesn't start with its head.", 'code': 'head_mismatch'})
                    return
                state.completed = True
                name = None if encrypted else state.metadata['filename']
                response = {'url': state.receipt_url or self.link(), 'id': UPLOAD_ID, 'transferId': UPLOAD_ID,
                            'name': name if state.receipt_name is None else state.receipt_name, 'size': state.metadata['size'], 'mode': state.metadata.get('mode', 'raw'),
                            'once': state.metadata['oneTime'], 'expiresAt': state.expires_at, 'protected': protected}
                # Only a completion made with the key gets the management link; the server keeps just hashes.
                if credential == 'owner':
                    response.update(managementUrl=state.management_url or MANAGE, deleteToken=data['key'])
                state.transfer = {'mode': state.metadata.get('mode', 'raw'), 'data': stored, 'name': name, 'once': state.metadata['oneTime'],
                                  'password': state.metadata.get('password'), **(state.e2ee or {})}
            elif path == '/abort':
                state.release.set()
                self.reply(403 if not self.credential(data.get('key')) else 409 if state.completed else 200, {})
                return
            else:
                self.reply(404, {})
                return
            failures = state.failures.get(path, [])
            failure = failures.pop(0) if failures else 200
            status, code, after = simulated(*failure) if isinstance(failure, tuple) else simulated(failure)
            garble = state.garble.get(path)
            mode = garble.pop(0) if garble and status == 200 else None
        if path == '/part' and state.block:
            state.started.set()
            state.release.wait(10)
        if path == '/part' and status == 200:
            with state.lock:
                state.done[number] = response['etag']
                state.blobs[number] = payload
        if mode:
            return self.garbled(mode, response)
        self.reply(status, response if status == 200 else {'error': state.failure_text, **({'code': code} if code else {})},
                   retry_after=None if status == 200 else after)
        return None

    do_POST = do_PUT = do_GET = do_DELETE = handle_request

"""A fake operator API on loopback for the operator tools' tests (scripts/admin.py, monitor.py and smoke.py), and
the values those tests share."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading

from native import ROOT

ADMIN = ROOT / 'scripts' / 'admin.py'
TOKEN = 'operator-' + 't' * 40
ID, OTHER = 'A' * 20 + '_-' + 'b' * 21, 'C' * 43
CASE = 'R-7K3M9Q2XPA'
# The admin host's Cloudflare Access service token, as the operator tools send it.
CLIENT_ID, CLIENT_SECRET = '0123abcd.access', 'access-secret-' + 's' * 40
ACCESS = {'FYL_ACCESS_CLIENT_ID': CLIENT_ID, 'FYL_ACCESS_CLIENT_SECRET': CLIENT_SECRET}
ACCESS_NAMES = ('FYL_ACCESS_CLIENT_ID', 'FYL_ACCESS_CLIENT_SECRET', 'FYL_PUBLIC_URL')
SIGN_IN = 'https://example-team.cloudflareaccess.com/cdn-cgi/access/login/admin.fyl.at'
NOT_FOUND = (404, {'error': 'API endpoint not found.', 'code': 'not_found'})
# The Worker's 400 note_required message (src/index.ts reasonOf), which admin.py repeats before asking it.
NOTE_REQUIRED = 'Give the reason for this decision in a note of at least 3 characters.'


def view(transfer=ID, **extra):
    return {'id': transfer, 'exists': True, 'status': 'ready', 'name': 'report & plans.zip', 'size': 3 * 1024 ** 3,
            'createdAt': 1793260800000, 'expiresAt': 1793347200000, 'once': False, 'protected': True,
            'quarantine': None, 'clean': False, 'openReports': 1, **extra}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def answer(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        self.server.requests.append((self.command, self.path, body, self.headers.get('Authorization')))
        self.server.headers.append(self.headers)
        route = self.server.routes.get((self.command, self.path), NOT_FOUND)
        # A route may depend on the request's headers (the Access service token, say).
        status, payload, *headers = route(self.headers) if callable(route) else route
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        headers = {'Content-Type': 'application/json', **(headers[0] if headers else {})}
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = answer


def serve(test):
    """A fake API on loopback for the test's duration: answers server.routes and records server.requests (and the
    request headers in server.headers)."""
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.requests, server.headers, server.routes = [], [], {}
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    test.addCleanup(thread.join)
    test.addCleanup(server.server_close)
    test.addCleanup(server.shutdown)
    return server


#!/usr/bin/env python3
"""Exercise real transfers with the published CLI; never print private management links or keys.

--pages checks only what every visitor gets, without uploading anything or any credential: each page's
Content-Security-Policy and scripts, the download page's code revalidating on every load, and the code the build keeps
as written served byte for byte as in dist/, whose SHA256SUMS it prints. The deploy runs it right after wrangler deploy
(docs/E2EE.md §17)."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

NATIVE = {("Linux", "x86_64"): "fyl-linux-x86_64", ("Linux", "aarch64"): "fyl-linux-arm64",
          ("Darwin", "x86_64"): "fyl-macos-x86_64", ("Darwin", "arm64"): "fyl-macos-arm64"}
# What the deploy ships byte for byte (KEPT in scripts/minify_assets.mjs, repeated here; tests/test_smoke.py compares
# them): the code that handles keys in the browser, which the served copy is the only public place to check.
KEPT = ("e2ee/", "download.js", "i18n.js", "_dl/", "vendor/")
DIST = Path(__file__).resolve().parents[1] / "dist"


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def page_state(body):
    """The state the Worker put into a download page."""
    match = re.search(rb'<script type="application/json" id="fyl-state">(.*?)</script>', body, re.S)
    check(match is not None, "The download page has no state block.")
    return json.loads(match.group(1))


def basic(password):
    return {"Authorization": "Basic " + base64.b64encode(("fyl:" + password).encode()).decode()}


def failing(checks, prefix=""):
    """Names of failed readiness checks (never values): false, or an object whose `ok` is false."""
    for name, value in checks.items():
        if isinstance(value, dict) and "ok" not in value:
            yield from failing(value, prefix + name + ".")
        elif value is False or (isinstance(value, dict) and value.get("ok") is False):
            yield prefix + name


class Stay(urllib.request.HTTPRedirectHandler):
    """Report redirects instead of following them."""
    def redirect_request(self, *args):
        return None


def request(url, method="GET", data=None, headers=None, expected=200, body=None, follow=True):
    """(headers, body) of a response whose status is `expected`. A request with credentials (an Authorization header or
    the Access service token) never follows a redirect: urllib would resend them to wherever Location points, another
    host or plain HTTP included."""
    payload = json.dumps(data).encode() if data is not None else body
    combined = {"User-Agent": "fyl-smoke/1.0.1", **(headers or {})}
    if data is not None:
        combined["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=payload, method=method, headers=combined)
    follow = follow and "Authorization" not in combined and "CF-Access-Client-Secret" not in combined
    try:
        with (urllib.request.urlopen if follow else urllib.request.build_opener(Stay).open)(req, timeout=120) as response:
            status, response_headers, body = response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        status, response_headers, body = error.code, error.headers, error.read()
    moved = ""
    if 300 <= status < 400:
        # Without its query and fragment, which could carry a grant, and with transfer ids (any path segment of 20 or
        # more URL-safe characters) left out: the message lands in deploy logs.
        target = urllib.parse.urlsplit(response_headers.get("Location") or "")._replace(query="", fragment="")
        target = target._replace(path=re.sub(r"(?<=/)[A-Za-z0-9_-]{20,}(?=/|$)", "<id>", target.path))
        moved = " Redirected to {}.".format(target.geturl())
    check(status in (expected if isinstance(expected, tuple) else (expected,)), f"Unexpected HTTP status: {status}; expected {expected}.{moved}")
    return response_headers, body


def readiness_token():
    """The read-only MONITOR_TOKEN opens readiness and the billing estimate and nothing else, so it goes before the
    operator token."""
    return os.environ.get("MONITOR_TOKEN", "").strip() or os.environ.get("FYL_ADMIN_TOKEN", "").strip()


def access_headers():
    """The admin host's Cloudflare Access service token (FYL_ACCESS_CLIENT_ID and FYL_ACCESS_CLIENT_SECRET), or {}."""
    client, secret = os.environ.get("FYL_ACCESS_CLIENT_ID", "").strip(), os.environ.get("FYL_ACCESS_CLIENT_SECRET", "").strip()
    return {"CF-Access-Client-Id": client, "CF-Access-Client-Secret": secret} if client and secret else {}


def access_refused(url, headers=None):
    """Without the service token the admin host serves nothing: Access answers 403 or sends the browser to its sign-in."""
    response_headers, _ = request(url, headers=headers, expected=(302, 403), follow=False)
    location = response_headers.get("Location")
    check(location is None or (urllib.parse.urlsplit(location).hostname or "").endswith(".cloudflareaccess.com"),
          "The admin host redirected somewhere other than the Cloudflare Access sign-in.")


def admin_host(admin, token):
    """The admin host refuses requests without Access (an operator token alone included), and with the service token
    serves the dashboard (strict CSP, never cached) and readiness. Returns whether the service token was there to try."""
    access_refused(admin + "/")
    if token:
        access_refused(admin + "/api/admin/ready", {"Authorization": "Bearer " + token})
    access = access_headers()
    if not access:
        return False
    headers, page = request(admin + "/", headers=access, follow=False)
    check(headers.get_content_type() == "text/html" and b"/admin/admin.js" in page, "The admin host did not serve the dashboard.")
    check("default-src 'self'" in headers.get("Content-Security-Policy", "") and "no-store" in headers.get("Cache-Control", ""),
          "The dashboard lacks the strict CSP or no-store.")
    if token:
        _, body = request(admin + "/api/admin/ready", headers={**access, "Authorization": "Bearer " + token}, expected=(200, 503), follow=False)
        ready = json.loads(body)
        check(ready.get("ready") is True, "The Worker is not ready: " + (", ".join(failing(ready.get("checks") or {})) or "no details") + ".")
    return True


def error_code(body):
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    return data.get("code") if isinstance(data, dict) else None


# What a browser sends for a file another site embeds (<img src>) and for a file link followed from another site.
# curl, wget and the CLI send no Sec-Fetch headers, so the rest of the smoke test downloads as before.
EMBEDDED = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image"}
FOLLOWED = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document", "Accept": "text/html"}


def hotlinks(url):
    """Other sites cannot embed a file (403 hotlink), and a direct file link followed from another site opens the
    download page instead. Neither counts a download or opens a one-time session: the caller downloads afterwards."""
    _, body = request(url, headers=EMBEDDED, expected=403)
    check(error_code(body) == "hotlink", "An embedded file was refused without the hotlink code.")
    headers, page = request(url + "?dl=1", headers=FOLLOWED)
    check(headers.get_content_type() == "text/html" and page_state(page)["state"] == "ready",
          "A file link followed from another site skipped the download page.")


def directive(policy, name):
    """The sources of one directive of a Content-Security-Policy."""
    for part in policy.split(";"):
        words = part.split()
        if words and words[0] == name:
            return words[1:]
    return []


def page_policies(base, report, form="/en/"):
    """Every page names only fyl's own scripts (docs/E2EE.md §9.5, §15.6): its policy lists the page's own <script src>
    files, /e2ee/ and /vendor/ (the report form on its own host also Turnstile), never 'self' or /cdn-cgi/, and no zone
    feature added a script to the HTML. A download page, here for a link that doesn't exist (which opens nothing), loads exactly
    theme.js, i18n.js and download.js and allows its workers and the download service worker; its code revalidates on
    every load, and /_dl/ addresses never reach anything at the Worker. / only picks a language: 302 to /<lang>/, never
    cached (i18n/README.md); an agent gets llms.txt there instead."""
    headers, _ = request(base + "/", headers={"Accept": "text/html", "Accept-Language": "de-AT,de;q=0.9"}, expected=302, follow=False)
    check(headers.get("Location") == "/de/" and headers.get("Vary") == "Accept, Accept-Language" and headers.get("Cache-Control") == "no-store",
          "/ does not pick the language by Accept-Language (302 to /<lang>/, Vary, no-store).")
    # An agent (no text/html in Accept) gets llms.txt itself at /, and every answer names it in Link headers.
    headers, body = request(base + "/", headers={"Accept": "*/*"})
    check((headers.get("Content-Type") or "").startswith("text/markdown") and body.startswith(b"# fyl.at"),
          "/ does not answer an agent (Accept: */*) with llms.txt.")
    check('rel="describedby"' in ", ".join(headers.get_all("Link") or []), "/ does not name llms.txt in a Link header.")
    for origin, path, is_form in ((base, "/en/", False), (report, form, True), (base, "/en/privacy", False), (base, "/d/" + secrets.token_urlsafe(32), False)):
        download = path.startswith("/d/")
        name = "The download page" if download else "The report form" if is_form else path
        headers, body = request(origin + path, headers={"Accept": "text/html"}, expected=404 if download else 200)
        policies = headers.get_all("Content-Security-Policy") or []
        check(len(policies) == 1, name + " has no single Content-Security-Policy.")
        policy, page = policies[0], body.decode("utf-8", "replace")
        sources = [urllib.parse.urljoin(origin + path, src) for src in re.findall(r'<script\b[^>]*\bsrc="([^"]+)"', page)]
        # Names what was injected (host and path, never a query), so a build log shows which zone feature it was.
        foreign = sorted({urllib.parse.urlsplit(source)._replace(query="", fragment="").geturl() for source in sources if not source.startswith(origin + "/")}
                         | set(re.findall(r"/cdn-cgi/[\w./-]+", page)))
        check(not foreign, name + " loads a script that isn't fyl's own: a zone feature injects HTML (" + ", ".join(foreign[:3]) + ").")
        outside = ["https://challenges.cloudflare.com"] if is_form else []
        check(directive(policy, "script-src") == [*sources, origin + "/e2ee/", origin + "/vendor/", *outside], name + " allows other scripts than its own.")
        workers = ["/e2ee/", "/vendor/", "/_dl/sw.js"] if download else ["/md5-worker.js", "/e2ee/", "/vendor/"]
        check(directive(policy, "worker-src") == [origin + worker for worker in workers], name + " allows other workers than its own.")
        check("cdn-cgi" not in policy and "unsafe" not in policy and "'self'" not in directive(policy, "script-src"), name + " has a lax policy.")
        if download:
            check([urllib.parse.urlsplit(source).path for source in sources] == ["/theme.js", "/i18n.js", "/download.js"],
                  "The download page loads other scripts than theme.js, i18n.js and download.js.")
    for path in ("/download.js", "/theme.js", "/i18n.js", "/e2ee/age.js", "/e2ee/worker.js", "/_dl/sw.js"):
        headers, _ = request(base + path)
        check(headers.get("Cache-Control") == "no-cache", path + " is not revalidated on every load.")
    request(base + "/_dl/" + secrets.token_urlsafe(16), expected=404)


def kept_files(dist=DIST):
    """The files of dist/ the build keeps byte for byte, as site paths with their SHA-256 (sorted)."""
    found = {}
    for path in sorted(dist.rglob("*")):
        relative = path.relative_to(dist).as_posix()
        if path.is_file() and any(relative.startswith(kept) if kept.endswith("/") else relative == kept for kept in KEPT):
            found["/" + relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return found


def served_code(base, dist=DIST):
    """Every file the build ships unminified (download.js, i18n.js, e2ee/, _dl/, vendor/) is served byte for byte as in dist/:
    the deploy's page check reads policies and scripts, this reads the bytes, so a changed or substituted copy of the
    code that handles keys fails the deploy. Returns {path: sha256} of what the site serves, to print as
    SHA256SUMS so anyone can compare the served code with a copy kept from earlier."""
    expected = kept_files(dist)
    check(expected, "dist/ holds none of the kept files.")
    differing = []
    for path, digest in expected.items():
        _, body = request(base + path, headers={"Accept": "*/*"})
        if hashlib.sha256(body).hexdigest() != digest:
            differing.append(path)
    check(not differing, "Served code differs from the repository's bytes: " + ", ".join(differing[:5]) + ".")
    return expected


def print_sums(sums):
    """The served code's hashes in SHA256SUMS form (the build log publishes them)."""
    print("SHA256SUMS of the served code (byte-identical to dist/):")
    for path, digest in sums.items():
        print(f"{digest}  {path.lstrip('/')}")


def turnstile_on(base):
    """Whether the report form checks Turnstile: /config.js hands the page a site key only while the Worker does."""
    _, body = request(base + "/config.js")
    match = re.fullmatch(rb"\s*window\.FYL_CONFIG\s*=\s*(\{.*\})\s*;?\s*", body, re.S)
    check(match is not None, "/config.js does not set window.FYL_CONFIG.")
    config = json.loads(match.group(1))
    return isinstance(config, dict) and bool(config.get("turnstileSiteKey"))


def report_refused(base, report):
    """A report about a link that does not exist is refused, so nothing is filed: 404, or while Turnstile is on 403
    turnstile_failed, since the smoke test sends no token and the Worker checks it before it looks the link up.
    Returns whether Turnstile is on."""
    guarded = turnstile_on(report)
    _, body = request(report + "/api/reports", method="POST", headers={"Origin": report}, expected=403 if guarded else 404, data={
        "link": base + "/d/" + secrets.token_urlsafe(32), "category": "other", "goodFaith": True,
        "details": "fyl smoke test: a report about a link that does not exist.", "name": "fyl smoke test", "email": "smoke@fyl.at"})
    check(not guarded or error_code(body) == "turnstile_failed", "A report without a Turnstile token was refused without turnstile_failed.")
    return guarded


def health(base):
    headers, body = request(base + "/api/health")
    check(json.loads(body)["maxFileBytes"] == 50 * 1024 ** 3, "Wrong production file limit.")
    check("no-store" in headers.get("Cache-Control", ""), "Health response is cached.")
    check("max-age=" in headers.get("Strict-Transport-Security", ""), "HSTS is missing.")


def pages_after_deploy(base, report, tries=7, wait=10):
    """The deploy's own check (--pages): health, the pages' policies and the kept code's bytes (returns its sums),
    tried again every `wait` seconds for about a minute, because a new version takes that long to reach every location and the build machine's network can stall.
    A failed check (RuntimeError) and a network error (OSError: a timeout, a reset, a DNS failure) count the same; the
    deploy has already happened, so a stall must not mark it failed."""
    for attempt in range(tries):
        try:
            health(base)
            page_policies(base, report)
            return served_code(base)
        except (RuntimeError, OSError):
            if attempt == tries - 1:
                raise
            time.sleep(wait)
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="https://fyl.at")
    parser.add_argument("--admin-url", default="https://admin.fyl.at", help="The admin host, behind Cloudflare Access")
    parser.add_argument("--report-url", default="https://report.fyl.at", help="The report form's own host")
    parser.add_argument("--multipart", action="store_true", help="Upload a 52 MiB fixture for each of the four transfers instead of 2 KiB")
    parser.add_argument("--pages", action="store_true", help="Check only the pages' policies and scripts and the kept code's "
                        "bytes (no uploads, no credentials); tries for up to a minute while a new version reaches every location")
    args = parser.parse_args()
    parsed = urllib.parse.urlsplit(args.base_url)
    check(parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password
          and parsed.path in ("", "/") and not parsed.query and not parsed.fragment, "Use an HTTPS origin.")
    base, admin, report = args.base_url.rstrip("/"), args.admin_url.rstrip("/"), args.report_url.rstrip("/")
    check(urllib.parse.urlsplit(admin).scheme == "https" and urllib.parse.urlsplit(report).scheme == "https", "Use HTTPS admin and report origins.")

    if args.pages:
        sums = pages_after_deploy(base, report)
        print("Page policies and scripts passed; the kept code is byte-identical to dist/.")
        print_sums(sums)
        return
    health(base)
    page_policies(base, report)
    sums = served_code(base)
    print("Page policies and scripts passed; the kept code is byte-identical to dist/.")
    print_sums(sums)
    for origin, page in ((report, "/en/"), (base, "/en/privacy")):
        headers, _ = request(origin + page, headers={"Accept": "text/html"})
        check(headers.get_content_type() == "text/html", origin + page + " is not an HTML page.")
    # The form moved to its own host: the old address forwards with its query, the form's host serves nothing else.
    headers, _ = request(base + "/report?link=smoke", expected=302, follow=False)
    check(headers.get("Location") == report + "/?link=smoke", "/report does not forward to the report host.")
    request(report + "/privacy", expected=404)
    guarded = report_refused(base, report)
    print("Report and privacy pages passed (report form on {}, Turnstile {}).".format(urllib.parse.urlsplit(report).hostname, "on" if guarded else "off"))
    # The dashboard's files, its statistics and the operator API exist on the admin host only.
    for path in ("/admin", "/admin/admin.js", "/api/stats", "/api/admin/ready"):
        request(base + path, expected=404)
    token = readiness_token()
    if admin_host(admin, token):
        print("Admin host passed: refused without Access, dashboard{} with the service token.".format(" and readiness" if token else ""))
    elif token:
        print("Admin host refuses without Access; its service token is not set (FYL_ACCESS_CLIENT_ID, FYL_ACCESS_CLIENT_SECRET), "
              "so readiness was not read.")
    else:
        print("Admin host refuses without Access; readiness skipped: neither MONITOR_TOKEN nor FYL_ADMIN_TOKEN is set.")
    # The installer reads /cli/latest and fetches /cli/<version>/, which never changes once published.
    latest_headers, body = request(base + "/cli/latest")
    release = body.decode().strip()
    check(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?", release) is not None, "/cli/latest is not a version.")
    check("max-age=60" in latest_headers.get("Cache-Control", ""), "/cli/latest is cached too long.")
    _, body = request(base + "/cli/version.json")
    version = json.loads(body)
    check(version["version"] == release and version.get("path") == f"/cli/{release}/", "/cli/version.json and /cli/latest disagree.")
    folder = f"{base}/cli/{release}/"
    sums_headers, sums = request(folder + "SHA256SUMS")
    check("immutable" in sums_headers.get("Cache-Control", ""), "Versioned CLI files are not cached as immutable.")
    published = dict(line.split()[::-1] for line in sums.decode().splitlines())
    check(sorted(published) == sorted(NATIVE.values()) and version["files"] == published, "Published CLI file list mismatch.")
    downloads = {}
    for name, digest in published.items():
        _, downloads[name] = request(folder + name)
        check(hashlib.sha256(downloads[name]).hexdigest() == digest, "Published CLI checksum mismatch: " + name)
    # Installers before 2.3.0 fetch the unversioned paths (with curl -L).
    for name in [*published, "SHA256SUMS"]:
        headers, _ = request(base + "/cli/" + name, expected=302, follow=False)
        check(headers.get("Location") in (f"/cli/{release}/{name}", folder + name), "Old CLI path does not lead to this version: " + name)
    print("Versioned CLI files and redirects passed.")
    with tempfile.TemporaryDirectory(prefix="fyl-smoke-") as directory:
        root = Path(directory)
        native = NATIVE.get((platform.system(), platform.machine()))
        check(native is not None, "Run the smoke test on macOS or Linux (x86_64 or arm64).")
        cli = root / "fyl"
        cli.write_bytes(downloads[native])
        cli.chmod(0o755)
        program = [str(cli)]
        # The CLI adds FYL_UA_SUFFIX to its User-Agent (since 2.5.0), so the dashboard counts these
        # uploads and downloads as fyl's own and leaves them out; an older CLI ignores it.
        cli_env = {**os.environ, "FYL_UA_SUFFIX": "fyl-smoke"}
        output = subprocess.run(program + ["--version"], capture_output=True, timeout=15)
        check(output.returncode == 0 and output.stdout.decode().strip() == "fyl " + version["version"], "Wrong CLI version.")
        fixture = root / "fyl-smoke-über.zip"
        content = (b"fyl.at production smoke\n" * 100)[:2048]
        if args.multipart:
            content = os.urandom(52 * 1024 * 1024)
        fixture.write_bytes(content)
        links = []
        try:
            for once in (False, True):
                command = program + [str(fixture), "--expires", "5m", "--manage", "--endpoint", base + "/api/upload"]
                if once:
                    command.append("--once")
                if args.multipart:
                    # Verbose output shows retries, which would otherwise hide server errors such as CPU limits.
                    command.append("--verbose")
                result = subprocess.run(command, capture_output=True, timeout=600, env=cli_env)
                check(result.returncode == 0, "CLI upload failed; private diagnostic output was suppressed.")
                lines = result.stdout.decode().split()
                check(len(lines) == 2 and (args.multipart or result.stderr == b""), "CLI output is not exactly the two links.")
                check(b"retrying" not in result.stderr, "The upload needed retries; the server returned errors.")
                url, manage = lines
                links.append(manage)
                check(url.startswith(base + "/d/") and manage.startswith(base + "/#manage/"), "CLI printed unexpected links.")
                transfer, key = manage.split("#manage/", 1)[1].split("/")
                control = base + "/api/transfers/" + transfer
                auth = {"Authorization": "Bearer " + key}
                headers, _ = request(url, method="HEAD")
                check("attachment;" in headers.get("Content-Disposition", "")
                      and urllib.parse.quote(fixture.name, safe="") in headers.get("Content-Disposition", ""),
                      "Original attachment filename is missing.")
                check("no-store" in headers.get("Cache-Control", ""), "Download is cached.")
                check(headers.get("Cross-Origin-Resource-Policy") == "same-origin", "Other sites may embed the file (CORP is not same-origin).")
                hotlinks(url)
                request(control, method="DELETE", expected=403)
                # Browsers get the download page first; for a one-time link it must not open the session.
                page_headers, page = request(url, headers={"Accept": "text/html"})
                state = page_state(page)
                check(page_headers.get_content_type() == "text/html" and state["state"] == "ready" and state["once"] == once
                      and state["name"] == fixture.name and state["downloadUrl"] == url + "?dl=1", "Browser download page is wrong.")
                _, partial = request(url, headers={"Range": "bytes=0-7"}, expected=206)
                check(partial == content[:8], "Range bytes differ.")
                if not once:
                    request(control, method="PATCH", data={"expiresIn": 600}, headers=auth)
                    request(control, method="PATCH", data={"expiresIn": 300}, headers=auth)
                headers, downloaded = request(url)
                check(downloaded == content and headers.get_content_type() == "application/octet-stream", "Direct download differs.")
                if once:
                    # A complete download closes the one-time session; cleanup runs right after the response.
                    for _ in range(10):
                        try:
                            request(url, method="HEAD", expected=410)
                            break
                        except RuntimeError:
                            time.sleep(1)
                    else:
                        check(False, "One-time link stayed open after a complete download.")
                else:
                    removed = subprocess.run(program + ["rm", manage], capture_output=True, timeout=60, env=cli_env)
                    check(removed.returncode == 0 and removed.stdout.decode().startswith("Deleted "), "fyl rm failed.")
                    request(url, expected=410)
                print(("One-time" if once else "Regular") + " upload/download controls and hotlink protection passed.")
            # A password upload: the CLI takes FYL_PASSWORD, curl uses Basic Auth, browsers the page's form.
            password = "smoke-" + secrets.token_hex(8)
            command = program + [str(fixture), "--expires", "5m", "--manage", "--password", "--endpoint", base + "/api/upload"]
            result = subprocess.run(command + (["--verbose"] if args.multipart else []), capture_output=True, timeout=600,
                                    stdin=subprocess.DEVNULL, env={**cli_env, "FYL_PASSWORD": password})
            check(result.returncode == 0, "CLI password upload failed; private diagnostic output was suppressed.")
            lines = result.stdout.decode().split()
            check(len(lines) == 2 and (args.multipart or result.stderr == b""), "CLI output is not exactly the two links.")
            check(b"retrying" not in result.stderr and password.encode() not in result.stdout + result.stderr,
                  "The password upload needed retries or printed the password.")
            url, manage = lines
            links.append(manage)
            transfer = manage.split("#manage/", 1)[1].split("/")[0]
            check(url == base + "/d/" + transfer, "A protected link must not contain the file name.")
            _, page = request(url, headers={"Accept": "text/html"})
            state = page_state(page)
            check(state["state"] == "protected" and state["name"] is None and fixture.stem.encode() not in page,
                  "The password page shows the file name or no password form.")
            headers, _ = request(url, expected=401)
            check(headers.get("WWW-Authenticate", "").startswith("Basic "), "Basic Auth challenge is missing.")
            request(url, headers=basic("wrong-" + password), expected=401)
            headers, downloaded = request(url, headers=basic(password))
            check(downloaded == content and urllib.parse.quote(fixture.name, safe="") in headers.get("Content-Disposition", ""),
                  "Basic Auth download differs.")
            form = urllib.parse.urlencode({"password": password}).encode()
            _, page = request(url, method="POST", body=form, headers={"Content-Type": "application/x-www-form-urlencoded",
                                                                       "Origin": base, "Accept": "text/html"})
            state = page_state(page)
            check(state["state"] == "unlocked" and state["name"] == fixture.name and "?grant=" in state["downloadUrl"],
                  "The page's password form did not unlock the file.")
            _, downloaded = request(state["downloadUrl"])
            check(downloaded == content, "Grant download differs.")
            removed = subprocess.run(program + ["rm", manage], capture_output=True, timeout=60, env=cli_env)
            check(removed.returncode == 0, "fyl rm of the password upload failed.")
            print("Password upload, Basic Auth and page unlock passed.")
            # An end-to-end encrypted upload (docs/E2EE.md): the key is the part of the link after #, which nothing here
            # sends anywhere (fyl download reads the link from stdin); browsers get the page, which decrypts, other
            # clients 409 encrypted unless they ask for the ciphertext with ?dl=1.
            command = program + [str(fixture), "--expires", "5m", "--manage", "--encrypt", "--endpoint", base + "/api/upload"]
            result = subprocess.run(command + (["--verbose"] if args.multipart else []), capture_output=True, timeout=600, stdin=subprocess.DEVNULL,
                                    env=cli_env)
            check(result.returncode == 0, "CLI encrypted upload failed; private diagnostic output was suppressed.")
            lines = result.stdout.decode().split()
            check(len(lines) == 2 and (args.multipart or result.stderr == b""), "CLI output is not exactly the two links.")
            check(b"retrying" not in result.stderr, "The encrypted upload needed retries; the server returned errors.")
            url, manage = lines
            links.append(manage)
            transfer = manage.split("#manage/", 1)[1].split("/")[0]
            plain, _, key = url.partition("#")
            check(plain == base + "/d/" + transfer and re.fullmatch(r"[A-Za-z0-9_-]{43}", key) is not None, "An encrypted link must be /d/<id>#<key>.")
            headers, page = request(plain, headers={"Accept": "text/html"})
            state = page_state(page)
            check(state["state"] == "ready" and state.get("mode") == "e2ee" and state["name"] is None and b" data-e2ee" in page
                  and "<title>Encrypted file · fyl.at</title>".encode() in page and fixture.stem.encode() not in page,
                  "The encrypted download page is wrong or shows the file name.")
            check(directive(headers.get("Content-Security-Policy", ""), "worker-src")[-1:] == [base + "/_dl/sw.js"], "The encrypted page's policy is wrong.")
            _, refusal = request(plain, expected=409)
            check(refusal.startswith(b"This file is end-to-end encrypted."), "A plain GET of an encrypted file wasn't refused with the fyl download hint.")
            _, sealed = request(plain + "?dl=1")
            check(sealed.startswith(b"age-encryption.org/v1\n-> X25519 ") and len(sealed) > len(content), "The stored file is not an age file.")
            saved = root / "decrypted"
            saved.mkdir()
            result = subprocess.run(program + ["download", "-", "-o", str(saved), "--endpoint", base + "/api/upload"],
                                    input=(url + "\n").encode(), capture_output=True, timeout=600, env=cli_env)
            check(result.returncode == 0, "fyl download of the encrypted upload failed; private diagnostic output was suppressed.")
            check((saved / fixture.name).read_bytes() == content, "fyl download decrypted other bytes than were uploaded.")
            removed = subprocess.run(program + ["rm", manage], capture_output=True, timeout=60, env=cli_env)
            check(removed.returncode == 0, "fyl rm of the encrypted upload failed.")
            print("Encrypted upload, its page and fyl download passed.")
        finally:
            failed_cleanup = False
            for manage in links:
                transfer, key = manage.split("#manage/", 1)[1].split("/")
                try:
                    req = urllib.request.Request(base + "/api/transfers/" + transfer, method="DELETE",
                                                 headers={"Authorization": "Bearer " + key, "User-Agent": "fyl-smoke"})
                    urllib.request.urlopen(req, timeout=30).close()
                except urllib.error.HTTPError as error:
                    failed_cleanup = failed_cleanup or error.code not in (404, 410)
                except Exception:
                    failed_cleanup = True
            check(not failed_cleanup, "Test cleanup failed; synthetic files have a five-minute expiry backstop.")
    print("Published CLI hashes, HTTPS headers and production smoke checks passed.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # urllib/subprocess exceptions may contain URLs or bearer keys.
        message = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print("Smoke check failed: " + message, file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""The Monitor workflow's check: fails (exit 1, so GitHub mails the failure) when /api/health does not answer ok,
when /api/admin/ready is not ready, when readiness names anything that waits for the operator (its `reasons` codes
open_reports, overdue_cleanups, storage_60 (stored bytes at 60 % of MAX_STORED_BYTES), daily_60 (today's volume at
60 % of MAX_DAILY_UPLOAD_BYTES), or any code added later), or when the estimate of the open Cloudflare bill
(GET /api/billing) reached BILLING_ALERT_USD dollars (default 15). Run locally it prints codes, counts, percentages and
dollars only. In GitHub Actions (GITHUB_ACTIONS=true), whose logs anyone can read in a public repository, it prints
only whether the run passed and the names of the checks that failed: no dollars, capacity, counts, pause state or
hints. The details are one local run away (docs/OPERATIONS.md#monitor):

  MONITOR_TOKEN=… FYL_ACCESS_CLIENT_ID=… FYL_ACCESS_CLIENT_SECRET=… [BILLING_ALERT_USD=15] npm run monitor

Health is read from the public site (https://fyl.at), readiness and the estimate from the admin host
(https://admin.fyl.at), which sits behind Cloudflare Access: FYL_ACCESS_CLIENT_ID and FYL_ACCESS_CLIENT_SECRET are its
service token (environment or the ignored .env). FYL_BASE_URL sets one Worker for all three (a local one needs no
service token), FYL_PUBLIC_URL the health check's alone. MONITOR_TOKEN is the read-only token the Worker accepts for
GET /api/admin/ready and, on the admin host, GET /api/billing, nothing else. Both tokens go to those two requests
alone, only over HTTPS (plain HTTP on loopback for tests) and never across a redirect.

The estimate's alert sits below the Cloudflare account's own budget alert, so the monitor mails first (docs/COSTS.md).
"""
import contextlib
import datetime
from decimal import ROUND_HALF_UP, Decimal
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# A request that gets no JSON answer at all (network error, a 5xx from in front of the Worker) is tried this often,
# PAUSE seconds apart, so a passing blip does not page anyone.
TRIES, PAUSE = 3, 10
ENV_FILE = Path(__file__).resolve().parents[1] / ".env"
# Readiness `reasons`: what waits for the operator. Every code fails the run, a code not listed here too.
REASONS = {"open_reports": "{reports} open reports wait for a decision. Run npm run admin -- reports.",
           "overdue_cleanups": "{overdue} cleanups are overdue: files hold storage past their lifetime. Run npm run admin -- status.",
           "storage_60": "stored bytes reached {stored} of MAX_STORED_BYTES; uploads are refused once it is full. Run npm run admin -- status.",
           "daily_60": "today's upload volume reached {daily} of MAX_DAILY_UPLOAD_BYTES. Run npm run admin -- status.",
           "attention": "the Worker reports attention without a reason. Run npm run admin -- ready."}
# When the admin host's Access service token expires; a new one goes into the secrets of the same names.
TOKEN_EXPIRES = "2027-10-30"
ACCESS_REFUSED = (" Cloudflare Access refused the service token: the secrets FYL_ACCESS_CLIENT_ID and FYL_ACCESS_CLIENT_SECRET "
                  "(of the GitHub environment monitor, or in .env) are wrong, or the token expired (it runs until {}).".format(TOKEN_EXPIRES))
# The estimate's alert in dollars while BILLING_ALERT_USD is unset or empty: below the account's own budget alert.
ALERT_USD = "15"
# Where the monitor's setup and its secrets are described.
DOCS = "docs/OPERATIONS.md#monitor"
# Where the dashboard's "Open billing" goes (dist/admin/index.html): the account's Cloudflare billing page.
BILLING_URL = "https://dash.cloudflare.com/?to=/:account/billing"
# The estimate's codes for Cloudflare's analytics not answering this time: a warning, and the next run asks again.
PASSING = ("billing_unavailable", "stats_unavailable")
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()


class Stay(urllib.request.HTTPRedirectHandler):
    """A redirect is answered as it is, never followed: the token stays on the origin."""
    def redirect_request(self, *args):
        return None


def decode(raw):
    try:
        data = json.loads(raw or b"")
    except ValueError:
        data = None
    return data if isinstance(data, dict) else None


# The names of the checks whose answers were only warned about this run (see warn()), for the public summary.
WARNED = []


def say(kind, text):
    """A line for the operator, `error` (it fails the run) or `warning`."""
    print({"error": "Problem:    ", "warning": "Warning:    "}[kind] + text)


def warn(name, text):
    """A warning about check `name` that fails nothing; the public summary names the check only."""
    WARNED.append(name)
    say("warning", text)


def setting(name):
    """A value from the environment, else from the ignored .env file ('' when neither has it)."""
    if os.environ.get(name, "").strip():
        return os.environ[name].strip()
    if ENV_FILE.is_file():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip()
    return ""


def local(base):
    host = urllib.parse.urlsplit(base).hostname or ""
    return host in ("localhost", "127.0.0.1", "::1") or host.endswith(".localhost")


def get(url, token=None, extra=None):
    """(HTTP status or the network error, JSON object or None) of a GET."""
    headers = {"User-Agent": "fyl-monitor", **({"Authorization": "Bearer " + token} if token else {}), **(extra or {})}
    for attempt in range(TRIES):
        if attempt:
            time.sleep(PAUSE)
        try:
            with urllib.request.build_opener(Stay).open(urllib.request.Request(url, headers=headers), timeout=30) as response:
                status, body = response.status, decode(response.read())
        except urllib.error.HTTPError as error:
            status, body = error.code, decode(error.read())
        except OSError as error:
            status, body = "no answer ({})".format(getattr(error, "reason", None) or error), None
        if body is not None or (isinstance(status, int) and status < 500):
            break
    return status, body


def passed(check):
    """A readiness check: true, {"ok": true}, or a map of names to true (the secrets)."""
    if isinstance(check, dict):
        return check.get("ok") is True if "ok" in check else all(value is True for value in check.values())
    return check is True


def number(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def amount(value):
    """A finite number of at least 0 from an answer (dollars, a meter's usage), else None."""
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None


def dollars(value, exact=False):
    """$1,234.56, rounded half up like the dashboard; `exact` keeps a third decimal where there is one ($0.015, one
    step of R2 storage)."""
    cents = not exact or round(value * 1000) % 10 == 0
    return "${:,}".format(Decimal(repr(value)).quantize(Decimal("0.01" if cents else "0.001"), ROUND_HALF_UP))


def cents(value):
    """Dollars rounded half up to cents, as dollars() shows them: the alert compares what the lines say, so a total of
    $14.995 (R2 storage steps are $0.015) shown as $15.00 fails at an alert of $15.00."""
    return Decimal(repr(value)).quantize(Decimal("0.01"), ROUND_HALF_UP)


def alert_of(text):
    """BILLING_ALERT_USD in dollars (ALERT_USD when unset or empty): a plain number above 0 such as 15 or 12.50, else
    None."""
    text = (text or "").strip() or ALERT_USD
    value = float(text) if re.fullmatch(r"\d{1,9}(?:\.\d{1,6})?", text) else 0
    return value if value > 0 else None


def day(text):
    """A cycle's 'YYYY-MM-DD' as '28 Oct', or None."""
    try:
        date = datetime.date.fromisoformat(text) if isinstance(text, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", text) else None
    except ValueError:
        return None
    return "{} {}".format(date.day, MONTHS[date.month - 1]) if date else None


def label(meter):
    """A meter as the mail names it ("R2 storage", "Workers CPU time"); a product or name that is no plain words makes
    it "unknown meter", so the answer can't put anything else into the log."""
    product, name = meter.get("product"), meter.get("name")
    if not all(isinstance(part, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 ]{0,39}", part) for part in (product, name)):
        return "unknown meter"
    return "{} {}".format(product, name[0].lower() + name[1:] if name[1:2].islower() else name)


def pace(meters, base, days, elapsed):
    """A rough total for the whole cycle: each meter's usage so far scaled by days / elapsed days (today counts as a
    whole day) and priced again against its allowance as src/billing.ts prices it, plus the base. Scaling only the
    dollars already above the allowances would miss a meter that crosses its allowance later in the cycle. None when
    a meter lacks its numbers."""
    total = base
    for meter in meters:
        used, included, step, price = (amount(meter.get(name)) for name in ("used", "included", "step", "price"))
        if used is None or included is None or not step or price is None:
            return None
        over = used * days / elapsed - included
        total += math.ceil(over / step - 1e-9) * price if over > 0 else 0
    return total


def bill(base, token, access, alert):
    """The problems of the estimate of the open Cloudflare bill (GET /api/billing): its total at or above `alert`
    dollars (None: BILLING_ALERT_USD is invalid and nothing is compared), or an answer that needs the operator. Prints
    the total, the cycle, the meters above their allowances and a rough pace (names and dollars only). When Cloudflare's
    analytics don't answer this time (502 billing_unavailable, no answer, an edge error) it warns and fails nothing:
    the next run asks again. A token Cloudflare refuses (503 billing_refused: expired, revoked, without the permission)
    stays refused, so it fails the run like any misconfiguration; only an outage that lasts shows as warnings alone in
    Actions > Monitor (and on the dashboard), no mail."""
    status, body = get(base + "/api/billing", token, access)
    given = body.get("code") if body is not None else None
    code = given if isinstance(given, str) and re.fullmatch(r"[a-z0-9_]{1,40}", given) else None
    shown = ("HTTP {}".format(status) if isinstance(status, int) else status) + (" " + code if code else "")
    if not isinstance(status, int) or (status == 502 and code in PASSING) or (status >= 500 and body is None):
        print("Billing:    not read ({})".format(shown))
        warn("billing", "Cloudflare's analytics did not answer the billing estimate ({}); not checked this run, the next one asks again.".format(shown))
        return []
    total = amount(body.get("total")) if body is not None else None
    if status != 200 or total is None:
        hint = {401: " The Worker refused MONITOR_TOKEN for the estimate: a Worker from before the monitor's billing check takes it for "
                     "readiness only (deploy the current main), or the secret of the GitHub environment monitor and the Worker secret differ.",
                404: " The Worker has no billing estimate at this address: FYL_BASE_URL must be the admin host (the public host answers 404).",
                503: " Cloudflare refused the Worker's CF_ANALYTICS_TOKEN: it expired, was revoked or lacks Account Analytics Read. Create "
                     "a new read-only token and set it with npx wrangler secret put CF_ANALYTICS_TOKEN "
                     "(docs/OPERATIONS.md#admin-host-and-statistics); until then the dashboard's estimate is missing too." if code == "billing_refused" else
                     " The Worker can't estimate the bill: it needs the secret CF_ANALYTICS_TOKEN (read-only, Account Analytics Read) and "
                     "the var BILLING_CYCLE_DAY (docs/OPERATIONS.md#admin-host-and-statistics).",
                302: ACCESS_REFUSED, 403: ACCESS_REFUSED}
        print("Billing:    FAILED ({})".format(shown))
        return [("billing", "The billing estimate answered {}.{}".format(shown, hint.get(status, "")))]
    cycle = body.get("cycle") if isinstance(body.get("cycle"), dict) else {}
    start, end, days, elapsed = day(cycle.get("start")), day(cycle.get("end")), number(cycle.get("days")), number(cycle.get("elapsedDays"))
    period = "{} – {}, day {} of {}".format(start, end, elapsed, days) if start and end and days and elapsed and elapsed <= days else ""
    meters = [meter for meter in body["meters"] if isinstance(meter, dict)] if isinstance(body.get("meters"), list) else []
    # The meters above their allowances, dearest first: the three that matter most for the mail.
    above = sorted((meter for meter in meters if (amount(meter.get("cost")) or 0) > 0), key=lambda meter: -amount(meter["cost"]))
    top = ", ".join("{} {}".format(label(meter), dollars(amount(meter["cost"]), True)) for meter in above[:3])
    # Made-up numbers (a local Worker with DEV_FAKE_STATS) never alert.
    sample = body.get("sample") is True
    print("Billing:    about {} so far{}{}".format(dollars(total), " ({})".format(period) if period else "",
                                                 "; sample data, never alerts" if sample else "; alert at " + dollars(alert) if alert else ""))
    if top:
        print("Overage:    " + top)
    projected = pace(meters, amount(body.get("base")), days, elapsed) if period and meters and amount(body.get("base")) is not None else None
    if projected is not None:
        print("Pace:       on pace for about {} by {} (rough: the usage so far at the same daily rate, today counted as a whole day)".format(dollars(projected), end))
    if sample or alert is None or cents(total) < cents(alert):
        return []
    named = "Above the allowances: {}.".format(top) if top else "Nothing is above its allowance: the alert is at or below the base charge."
    return [("billing", "The estimated Cloudflare bill is about {} so far{}, at or above the alert at {} (BILLING_ALERT_USD). {} Check the "
                        "invoice at {} (the estimate leaves out tax and a few products, docs/COSTS.md). This fails every run until the cycle "
                        "starts over or BILLING_ALERT_USD is raised.".format(dollars(total), " ({})".format(period) if period else "",
                                                                             dollars(alert), named, BILLING_URL))]


def reasons(body, reports, overdue):
    """The codes of what waits for the operator: the Worker's `reasons`, plus what the counts of a Worker without
    them show, or `attention` for an attention without a code. A code that is no plain name is shown as unknown."""
    given = body.get("reasons")
    codes = [code if isinstance(code, str) and re.fullmatch(r"[a-z0-9_]{1,40}", code) else "unknown"
             for code in (given if isinstance(given, list) else [])]
    codes += [code for code, value in (("open_reports", reports), ("overdue_cleanups", overdue)) if value and code not in codes]
    return list(dict.fromkeys(codes)) or (["attention"] if body.get("attention") is True else [])


def age(seconds):
    minutes, hours = seconds // 60, seconds // 3600
    if hours < 1:
        return "{} min".format(minutes)
    return "{} h {} min".format(hours, minutes % 60) if hours < 48 else "{} d {} h".format(hours // 24, hours % 24)


def check(base, token, public=None, access=None, alert=ALERT_USD):
    """The problems found, each (the check's name, a line for the operator); prints what it saw (codes, counts,
    percentages and dollars only). `public` is the site whose health counts (default `base`), `access` the service token's headers for `base`,
    `alert` BILLING_ALERT_USD as given. The estimate is read once readiness answered."""
    problems, public, limit = [], public or base, alert_of(alert)
    if limit is None:
        problems.append(("setup", "BILLING_ALERT_USD must be a number of dollars above 0, such as 15 or 12.50 (the variable of the GitHub environment "
                                  "monitor, see {}); the billing estimate is not compared until it is.".format(DOCS)))
    status, body = get(public + "/api/health")
    healthy = status == 200 and body is not None and body.get("status") == "ok"
    print("Health:     " + ("ok" if healthy else "FAILED ({})".format("HTTP {}".format(status) if isinstance(status, int) else status)))
    if not healthy:
        problems.append(("health", "{}/api/health did not answer ok.".format(public)))
    if not token:
        return problems + [("setup", "Set the secret MONITOR_TOKEN of the GitHub environment monitor (or in .env) to the Worker's MONITOR_TOKEN (see {}); readiness and the "
                                     "billing estimate were not checked.".format(DOCS))]
    if access is None:
        return problems + [("setup", "Set the secrets FYL_ACCESS_CLIENT_ID and FYL_ACCESS_CLIENT_SECRET of the GitHub environment monitor (or in "
                                     ".env) to the Cloudflare Access "
                                     "service token of {} (see {}); readiness and the billing estimate were not checked."
                                     .format(urllib.parse.urlsplit(base).hostname, DOCS))]
    status, body = get(base + "/api/admin/ready", token, access)
    if status not in (200, 503) or body is None:
        hint = {401: " The Worker refused MONITOR_TOKEN: the secret of the GitHub environment monitor and the Worker secret differ.",
                404: " The Worker has no readiness route for this token: is MONITOR_TOKEN (32 characters or more) set on it?",
                302: ACCESS_REFUSED, 403: ACCESS_REFUSED}
        shown = "HTTP {}".format(status) if isinstance(status, int) else status
        print("Ready:      FAILED ({})".format(shown))
        return problems + [("readiness", "Readiness answered {}.{}".format(shown, hint.get(status, "")))]
    checks = body.get("checks") if isinstance(body.get("checks"), dict) else {}
    failed = sorted(name for name, value in checks.items() if not passed(value))
    ready = status == 200 and body.get("ready") is True
    reports, overdue = number(body.get("openReports")), number((body.get("backlog") or {}).get("overdueCleanups"))
    oldest, urgent = number(body.get("oldestOpenReportAge")), number(body.get("highestOpenPriority"))
    codes = reasons(body, reports, overdue)
    print("Ready:      " + ("yes" if ready else "NO"))
    print("Checks:     {} passed, {} failed{}".format(len(checks) - len(failed), len(failed), " ({})".format(", ".join(failed)) if failed else ""))
    extra = (["oldest " + age(oldest)] if reports and oldest is not None else []) + (["priority {}".format(urgent)] if reports and urgent else [])
    print("Reports:    " + ("unknown" if reports is None else ", ".join(["{} open".format(reports)] + extra)))
    print("Cleanups:   " + ("unknown" if overdue is None else "{} overdue".format(overdue)))
    # How full the stored and daily budgets are, in whole percent (Workers before the capacity warnings omit it).
    capacity = body.get("capacity") if isinstance(body.get("capacity"), dict) else {}
    stored, daily = number(capacity.get("storedPercent")), number(capacity.get("dailyPercent"))
    if capacity:
        print("Capacity:   stored {}, today {}".format(*("unknown" if value is None else "{} %".format(value) for value in (stored, daily))))
    print("Attention:  " + (", ".join(codes) or "no"))
    # A pause is the operator's own decision, so it is a notice only and never mails.
    if body.get("paused") is True:
        print("Uploads:    PAUSED (notice only; npm run admin -- resume accepts them again)")
    if not ready:
        problems.append(("readiness", "fyl.at is not ready" + (": {} failed.".format(", ".join(failed)) if failed else ".") + " Run npm run admin -- ready."))
    values = {"reports": "?" if reports is None else reports, "overdue": "?" if overdue is None else overdue,
              "stored": "60 %" if stored is None else "{} %".format(stored), "daily": "60 %" if daily is None else "{} %".format(daily)}
    unknown = "the Worker reports this without a known meaning. Run npm run admin -- ready."
    problems += [("attention", "Attention {}: {}".format(code, REASONS.get(code, unknown).format(**values))) for code in codes]
    return problems + bill(base, token, access, limit)


def main():
    base = os.environ.get("FYL_BASE_URL", "").strip().rstrip("/") or "https://admin.fyl.at"
    public = (os.environ.get("FYL_PUBLIC_URL", "").strip() or os.environ.get("FYL_BASE_URL", "").strip() or "https://fyl.at").rstrip("/")
    for name, url in (("FYL_BASE_URL", base), ("FYL_PUBLIC_URL", public)):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" and not (parsed.scheme == "http" and local(url)):
            sys.exit(name + " must start with https:// (http:// only for localhost, *.localhost, 127.0.0.1 or [::1]).")
    client, secret = setting("FYL_ACCESS_CLIENT_ID"), setting("FYL_ACCESS_CLIENT_SECRET")
    # A local Worker has no Access; the service token goes along anyway when set.
    access = {"CF-Access-Client-Id": client, "CF-Access-Client-Secret": secret} if client and secret else {} if local(base) else None
    arguments = base, os.environ.get("MONITOR_TOKEN", "").strip(), public, access, os.environ.get("BILLING_ALERT_USD", "")
    WARNED.clear()
    if os.environ.get("GITHUB_ACTIONS") != "true":
        problems = check(*arguments)
        for _, text in problems:
            say("error", text)
        sys.exit(1 if problems else 0)
    # Public logs: what the checks print stays here, and only the names of the checks that failed or warned go out.
    with contextlib.redirect_stdout(io.StringIO()):
        problems = check(*arguments)
    failed = list(dict.fromkeys(name for name, _ in problems))
    for name in dict.fromkeys(WARNED):
        print("::warning::The {} check could not be read this run; the next run asks again.".format(name))
    if not failed:
        print("Monitor: all checks passed.")
        sys.exit(0)
    print("Monitor: FAILED ({}). Details stay out of public logs: run npm run monitor locally ({}).".format(", ".join(failed), DOCS))
    for name in failed:
        print("::error::The {} check failed; npm run monitor shows why.".format(name))
    sys.exit(1)


if __name__ == "__main__":
    main()

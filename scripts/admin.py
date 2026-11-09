#!/usr/bin/env python3
"""fyl.at operator commands, against the admin host https://admin.fyl.at (FYL_BASE_URL sets another Worker, e.g.
http://admin.localhost:4173 or http://127.0.0.1:4173 for npm run dev). The operator token comes from FYL_ADMIN_TOKEN,
and the admin host's Cloudflare Access service token from FYL_ACCESS_CLIENT_ID and FYL_ACCESS_CLIENT_SECRET, each from
the environment or the ignored ./.env file. A local Worker needs no service token.

  npm run admin -- status                         switches, stored bytes and copies, today's volume, network limits
  npm run admin -- ready                          readiness checks and what waits for you (exit 1 when not ready)
  npm run admin -- pause | resume                 refuse new uploads and further parts, or accept them again
  npm run admin -- reconcile                      recount the upload budget from its records (after a rollback,
                                                  or when networks get 429 refusals they should not)
  npm run admin -- show TARGET                    operator view of one transfer, name and open cases included
  npm run admin -- quarantine TARGET --note T     block downloads while a report is reviewed
  npm run admin -- restore TARGET --note T        lift a quarantine
  npm run admin -- takedown TARGET --note T [--yes]
                                                  remove a file now and block its link for good (final)
  npm run admin -- reports [--status open|closed|all] [--limit N] [--transfer TARGET] [--after CASE]
                                                  open cases most urgent first (priority 1 to 4), others newest first
  npm run admin -- report CASE                    one report and its history
  npm run admin -- decide CASE ACTION --note T [--yes]
                                                  ACTION: quarantine, restore, remove (= takedown), reject, note

TARGET is a transfer id or its exact download link (https://fyl.at/d/<id> or https://fyl.at/d/<id>/<name>, or the
same on FYL_BASE_URL); anything else is refused. CASE looks like R-7K3M9Q2XPA. A listing that has more cases
prints the command for its next page (--after, the last case shown). Quarantine, restore, takedown, remove and
reject record their reason (--note, at least 3 characters); a note on a case needs text. Every command that
changes something takes --dry-run, which shows the exact target and changes nothing.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("FYL_BASE_URL", "https://admin.fyl.at").rstrip("/")
ENV_FILE = Path(__file__).resolve().parents[1] / ".env"
# The public host has no operator API (it answers 404 there); it lives on the admin host only.
PUBLIC_HOST = "fyl.at"
ID = re.compile(r"[A-Za-z0-9_-]{43,64}")
LINK = re.compile(r"/d/([A-Za-z0-9_-]{43,64})(/[^/]+)?")
CASE = re.compile(r"R-[0-9A-HJKMNP-TV-Z]{10}")
ACTIONS = ("quarantine", "restore", "remove", "reject", "note")
# The Worker's words for a decision without its reason (400 note_required); only the `note` action needs none.
NOTE_REQUIRED = "Give the reason for this decision in a note of at least 3 characters."
# Budget fields that count bytes, shown as sizes.
BYTES = {"bytes", "maxBytes", "payload", "copies", "reserved", "attempted", "maxStored", "maxStoredBytes"}
# Report categories by priority (1 most urgent), as the Worker orders the open queue.
PRIORITIES = {1: "CSAM", 2: "malware, phishing", 3: "illegal, privacy", 4: "copyright, other"}
# Cloudflare Access (a redirect to its sign-in, its own 403 page) or the Worker's Access check refused the request.
ACCESS_REFUSED = ("HTTP {}: Cloudflare Access refused the request. Check FYL_ACCESS_CLIENT_ID and FYL_ACCESS_CLIENT_SECRET "
                  "(the service token expires on 2027-10-30) and that the Access policy allows it.")
# What readiness says waits for the operator (its `reasons` codes), and where to look.
REASONS = {"open_reports": "reports wait for a decision: npm run admin -- reports",
           "overdue_cleanups": "cleanups are overdue, files hold storage past their lifetime: npm run admin -- status",
           "storage_60": "stored bytes reached 60 % of MAX_STORED_BYTES: npm run admin -- status",
           "daily_60": "today's upload volume reached 60 % of MAX_DAILY_UPLOAD_BYTES: npm run admin -- status"}


def setting(name):
    """A value from the environment, else from the ignored .env file ('' when neither has it)."""
    if os.environ.get(name, "").strip():
        return os.environ[name].strip()
    if ENV_FILE.is_file():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip()
    return ""


def token():
    return setting("FYL_ADMIN_TOKEN") or sys.exit("Set FYL_ADMIN_TOKEN (or add it to .env).")


def local(host):
    return host in ("localhost", "127.0.0.1", "::1") or (host or "").endswith(".localhost")


def access():
    """The Access service token's headers for the admin host. A local Worker has no Access (they are sent anyway when
    set, so tests see them); every other host needs both."""
    host = urllib.parse.urlsplit(BASE).hostname or ""
    client, secret = setting("FYL_ACCESS_CLIENT_ID"), setting("FYL_ACCESS_CLIENT_SECRET")
    if client and secret:
        return {"CF-Access-Client-Id": client, "CF-Access-Client-Secret": secret}
    if local(host):
        return {}
    sys.exit("{} is behind Cloudflare Access: set FYL_ACCESS_CLIENT_ID and FYL_ACCESS_CLIENT_SECRET (the service token, "
             "see docs/OPERATIONS.md#admin-host-and-statistics) in the environment or .env, or FYL_BASE_URL to a local Worker.".format(host))


def base():
    """The operator token only travels over HTTPS; plain HTTP is accepted for a local Worker on loopback."""
    parsed = urllib.parse.urlsplit(BASE)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and local(parsed.hostname)):
        sys.exit("FYL_BASE_URL must start with https:// (http:// only for localhost, *.localhost, 127.0.0.1 or [::1]), "
                 "so the operator token is never sent in clear.")
    if parsed.hostname == PUBLIC_HOST:
        sys.exit("{} has no operator API: use the admin host (FYL_BASE_URL=https://admin.fyl.at, the default).".format(PUBLIC_HOST))
    return BASE


def target(text):
    """The transfer id in a bare id or an exact download link of fyl.at or FYL_BASE_URL. A typo must never select
    another transfer, so nothing is searched for inside other input: extra characters, another host, a query,
    a fragment or a management link are refused."""
    if ID.fullmatch(text):
        return text
    try:
        parsed = urllib.parse.urlsplit(text)
    except ValueError:
        parsed = urllib.parse.urlsplit("")
    # Download links live on fyl.at; a Worker named by FYL_BASE_URL (a local one) has its own.
    own = "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(BASE)).lower()
    origins = {"https://fyl.at"} | ({own} if os.environ.get("FYL_BASE_URL") else set())
    path = LINK.fullmatch(parsed.path)
    # urlsplit drops tabs and line breaks anywhere in the input, so those are checked on the raw text.
    if (path and "{}://{}".format(parsed.scheme, parsed.netloc).lower() in origins
            and "?" not in text and "#" not in text and not re.search(r"[\s\x00-\x1f\x7f-\x9f]", text)):
        return path[1]
    if "#manage/" in text:
        sys.exit("That is a management link. Pass the download link (…/d/<id>) or the transfer id.")
    sys.exit("Pass a transfer id (43 to 64 letters, digits, - or _) or its exact download link "
             "https://fyl.at/d/<id>[/<name>], without anything before or after it.")


def case_id(text):
    case = text.upper()
    if not CASE.fullmatch(case):
        sys.exit("Pass a report case id like R-7K3M9Q2XPA.")
    return case


class Refuse(urllib.request.HTTPRedirectHandler):
    """urllib would resend the token to wherever a redirect points, plain HTTP included; the API never redirects."""
    def redirect_request(self, *args):
        return None


def decode(raw):
    try:
        data = json.loads(raw or b"{}")
    except ValueError:
        data = None
    return data if isinstance(data, dict) else None


def call(path, data=None, accept=()):
    """The operator API's JSON answer; an error status exits with the API's message unless it is in `accept`."""
    request = urllib.request.Request(base() + path, method="POST" if data is not None else "GET",
                                     data=json.dumps(data).encode() if data is not None else None,
                                     headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json",
                                              "User-Agent": "fyl-admin", **access()})
    try:
        with urllib.request.build_opener(Refuse).open(request, timeout=30) as response:
            body = decode(response.read())
    except urllib.error.HTTPError as error:
        location = error.headers.get("Location") or ""
        if 300 <= error.code < 400 and (urllib.parse.urlsplit(location).hostname or "").endswith(".cloudflareaccess.com"):
            sys.exit(ACCESS_REFUSED.format(error.code))
        if 300 <= error.code < 400:
            sys.exit("HTTP {}: redirected to {}; set FYL_BASE_URL to the Worker's https:// address.".format(error.code, location))
        body = decode(error.read())
        if error.code in accept and body is not None:
            return body
        if error.code == 403 and (body is None or body.get("code") == "access_denied"):
            sys.exit(ACCESS_REFUSED.format(error.code))
        message = (body or {}).get("error", "request failed")
        if message == "API endpoint not found.":
            message += " Is ADMIN_TOKEN set on the Worker, with at least 32 characters, and is this command known to its version?"
        if (body or {}).get("code") == "note_required":
            message += " Pass it with --note TEXT. Nothing was changed."
        sys.exit("HTTP {}: {}".format(error.code, message))
    except urllib.error.URLError as error:
        sys.exit("Could not reach {}: {}".format(BASE, error.reason))
    if body is None:
        sys.exit("The Worker's answer was not a JSON object.")
    return body


def size(value):
    for unit, factor in (("TB", 1024 ** 4), ("GB", 1024 ** 3), ("MB", 1024 ** 2)):
        if value >= factor:
            return "{:.2f} {}".format(value / factor, unit)
    return "{} bytes".format(value)


def when(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(value / 1000))
    return "-" if value in (None, "", 0) else str(value)


def field(data, *names):
    """The first of the named fields that is present and not null."""
    return next((data[name] for name in names if data.get(name) is not None), None)


def count(value):
    return isinstance(value, int) and not isinstance(value, bool)


def plain(value, key=""):
    """A compact rendering for fields this script does not know by name (new budget numbers and the like)."""
    if isinstance(value, dict):
        return ", ".join("{} {}".format(name, plain(item, name)) for name, item in value.items())
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, float)) and (key in BYTES or "bytes" in key.lower()):
        return size(value)
    return json.dumps(value) if isinstance(value, list) else str(value)


def show_status(status):
    print("Uploads:   " + ("PAUSED" if status.get("paused") else "accepted"))
    for label, key in (("Stored:   ", "stored"), ("Today:    ", "today")):
        part = status.get(key) or {}
        print("{} {} of {} · {} of {} uploads".format(label, size(part.get("bytes", 0)), size(part.get("maxBytes", 0)),
                                                      part.get("uploads", 0), part.get("maxUploads", 0)))
        # The parts of `bytes` (payload, copies of re-sent parts, reserved) and what else the budget reports.
        rest = {name: value for name, value in part.items() if name not in ("bytes", "maxBytes", "uploads", "maxUploads")}
        if rest:
            print("            " + " · ".join("{} {}".format(name, plain(value, name)) for name, value in rest.items()))
    network = status.get("network")
    if isinstance(network, dict):
        # Stored at once: what the uploads a network started may hold until they are cleaned up (- from older Workers).
        stored = field(network, "maxStored", "maxStoredBytes")
        print("Network:   per day {} and {} uploads · {} running at once · {} stored at once".format(
            size(network["maxBytes"]) if count(network.get("maxBytes")) else "-", network.get("maxUploads", "-"),
            network.get("maxActive", "-"), size(stored) if count(stored) else "-"))
        rest = {name: value for name, value in network.items() if name not in ("maxBytes", "maxUploads", "maxActive", "maxStored", "maxStoredBytes")}
        if rest:
            print("            " + " · ".join("{} {}".format(name, plain(value, name)) for name, value in rest.items()))
    if "openReports" in status:
        print("Reports:   " + ("unknown (the reports did not answer)" if status["openReports"] is None else "{} open".format(status["openReports"])))
    if "overdueCleanups" in status:
        print("Cleanups:  {} overdue".format(status["overdueCleanups"]))
    for name, value in status.items():
        if name not in ("paused", "stored", "today", "network", "openReports", "overdueCleanups", "networkHashKeyed"):
            print("{}: {}".format(name, plain(value, name)))
    if status.get("networkHashKeyed") is False:
        print("Warning:   NETWORK_HASH_KEY is not set.")


def show_reports(view):
    """The transfer's open reports and the newest case ids among them; null when the reports did not answer."""
    number, cases = view.get("openReports"), view.get("openCases")
    if number is None:
        return "unknown (the reports did not answer)"
    text = "{} open".format(number)
    if isinstance(cases, list) and cases:
        text += ": " + ", ".join(str(case) for case in cases)
        if count(number) and number > len(cases):
            text += " and {} more (reports --transfer {})".format(number - len(cases), view.get("id"))
    return text


def quarantined(quarantine):
    return ("since {} ({})".format(when(quarantine.get("at")), quarantine.get("note") or "no note")
            if isinstance(quarantine, dict) else "no")


def show_transfer(view):
    print("Transfer   " + str(view.get("id")))
    if not view.get("exists"):
        print("           no transfer with this id exists now")
        return
    for label, value in (("Status", view.get("status")), ("Name", view.get("name")),
                         ("Size", size(view["size"]) if count(view.get("size")) else view.get("size")),
                         ("Created", when(view.get("createdAt"))), ("Expires", when(view.get("expiresAt"))),
                         ("Downloads", "one" if view.get("once") else "any number"),
                         ("Password", "yes" if view.get("protected") else "no"),
                         ("Quarantine", quarantined(view.get("quarantine"))),
                         ("Cleaned up", "yes" if view.get("clean") else "no"),
                         ("Reports", show_reports(view))):
        print("  {:<10} {}".format(label, "-" if value is None else value))


def priority(value):
    return "{} ({})".format(value, PRIORITIES[value]) if count(value) and value in PRIORITIES else value


def show_case(case, events=()):
    print("Case       {}  {}{}".format(field(case, "id", "case"), field(case, "status") or "-",
                                       " ({})".format(case["outcome"]) if case.get("outcome") else ""))
    rows = [("Category", field(case, "category")), ("Priority", priority(case.get("priority"))),
            ("Received", when(field(case, "createdAt"))), ("Transfer", field(case, "transferId"))]
    # Reports about a transfer that had already closed are kept too (while its link is known as gone).
    if isinstance(case.get("fileAvailable"), bool):
        rows.append(("File", "available when reported" if case["fileAvailable"] else "already gone when reported"))
    rows.append(("Reporter", " ".join(str(part) for part in (field(case, "name"), field(case, "email")) if part) or "anonymous"))
    for label, value in rows:
        print("  {:<10} {}".format(label, "-" if value is None else value))
    details = field(case, "details")
    if details:
        print("  Details")
        for line in str(details).splitlines():
            print("    " + line)
    for event in events:
        print("  {}  {:<10} {}".format(when(event.get("at")), event.get("action", "-"), event.get("note") or ""))


def confirm(args, what):
    """--yes, or "yes" typed at a terminal; anything else changes nothing."""
    if args.yes:
        return
    if not sys.stdin.isatty():
        sys.exit("Nothing was changed. Pass --yes to {}.".format(what))
    try:
        answer = input('Type "yes" to {}: '.format(what))
    except EOFError:
        answer = ""
    if answer.strip() != "yes":
        sys.exit("Nothing was changed.")


def reason(args, action):
    """Every decision records why it was made, in at least 3 characters as the Worker requires (it trims the note
    and counts code points, like len()); a note added to a case only needs text."""
    if action == "note":
        if not args.note.strip():
            sys.exit("Pass the note with --note TEXT. Nothing was changed.")
    elif len(args.note.strip()) < 3:
        sys.exit(NOTE_REQUIRED + " Pass it with --note TEXT; it is recorded with the decision. Nothing was changed.")
    return args.note


def transfer_view(transfer):
    return call("/api/admin/transfers/" + transfer)


def takedown(args):
    transfer, note = target(args.target), reason(args, "remove")
    view = transfer_view(transfer)
    show_transfer(view)
    if view.get("status") == "removed":
        print("Already removed for good. Nothing was changed.")
        return
    if args.dry_run:
        print("Dry run: would remove {} and block its link for good. Nothing was changed.".format(transfer))
        return
    confirm(args, "remove this file and block its link for good")
    result = call("/api/admin/takedown", {"id": transfer, "note": note})
    if result.get("existed", True):
        print("Removed " + transfer + ".")
    else:
        print("No transfer " + transfer + " exists now; its link is blocked for good.")
    if result.get("reportsUpdated") is False:
        print("Warning:   the open reports on this transfer could not record the reason; add it to each with decide CASE note --note TEXT.")


def mark(args):
    transfer, note = target(args.target), reason(args, args.command)
    if args.dry_run:
        show_transfer(transfer_view(transfer))
        print("Dry run: would {} {}. Nothing was changed.".format(args.command, transfer))
        return
    result = call("/api/admin/" + args.command, {"id": transfer, "note": note})
    if "exists" in result:
        show_transfer(result)
    print(("Quarantined {}: downloads answer 403 until it is restored." if args.command == "quarantine"
           else "Restored {}: downloads work again.").format(transfer))
    if result.get("reportsUpdated") is False:
        print("Warning:   the open reports on this transfer could not record this; add it to each with decide CASE note --note TEXT.")


def decide(args):
    case, note = case_id(args.case), reason(args, args.action)
    if args.dry_run or args.action == "remove":
        data = call("/api/admin/reports/" + case)
        record = data.get("case") if isinstance(data.get("case"), dict) else data
        show_case(record, data.get("events") or [])
        transfer = field(record, "transferId")
        if transfer and ID.fullmatch(str(transfer)):
            show_transfer(transfer_view(transfer))
        if args.dry_run:
            print("Dry run: would apply {} to {}. Nothing was changed.".format(args.action, case))
            return
        confirm(args, "remove this file and block its link for good")
    data = call("/api/admin/reports/" + case, {"action": args.action, "note": note})
    record = data.get("case") if isinstance(data.get("case"), dict) else data
    print("{}: {} recorded; case {}{}.".format(case, args.action, field(record, "status") or "updated",
                                              " ({})".format(record["outcome"]) if record.get("outcome") else ""))
    # The transfer as the decision left it; null when it did not answer afterwards.
    if "transfer" in data:
        after = data["transfer"]
        print("Transfer   " + ("{} · quarantine: {}".format(after.get("status") or "-", quarantined(after.get("quarantine")))
                               if isinstance(after, dict) else "unknown (it did not answer); check it with show"))


def reasons(data):
    """The codes of what waits for the operator: the Worker's `reasons`, plus what the counts of a Worker without
    them show; `attention` alone (no code) still counts."""
    given = field(data, "reasons")
    codes = [code for code in given if isinstance(code, str)] if isinstance(given, list) else []
    overdue = (data.get("backlog") or {}).get("overdueCleanups")
    for code, value in (("open_reports", data.get("openReports")), ("overdue_cleanups", overdue)):
        if count(value) and value > 0 and code not in codes:
            codes.append(code)
    return codes or (["attention"] if data.get("attention") is True else [])


def age(seconds):
    if not count(seconds) or seconds < 0:
        return None
    minutes, hours = seconds // 60, seconds // 3600
    if hours < 1:
        return "{} min".format(minutes)
    return "{} h {} min".format(hours, minutes % 60) if hours < 48 else "{} d {} h".format(hours // 24, hours % 24)


def ready():
    data = call("/api/admin/ready", accept=(503,))
    print("Ready:     " + ("yes" if data.get("ready") else "NO"))
    for name, value in (data.get("checks") or {}).items():
        if isinstance(value, dict) and "ok" not in value:
            value = ", ".join("{} {}".format(item, "ok" if good is True else "MISSING" if good is False else plain(good))
                              for item, good in value.items())
        elif isinstance(value, dict):
            value = "ok" if value.get("ok") is True else "FAILED" + (": " + str(value["error"]) if value.get("error") else "")
        else:
            value = "ok" if value is True else "FAILED" if value is False else plain(value)
        print("  {:<9} {}".format(name, value))
    for name, value in (data.get("backlog") or {}).items():
        print("  {:<9} {}".format(name, value))
    if "openReports" in data:
        oldest, urgent = age(data.get("oldestOpenReportAge")), data.get("highestOpenPriority")
        parts = ["{} open".format(data["openReports"])] + (["oldest " + oldest] if oldest else []) + (
            ["most urgent priority {}".format(priority(urgent))] if urgent is not None else [])
        print("Reports:   " + ("unknown" if data["openReports"] is None else " · ".join(parts)))
    capacity = data.get("capacity")
    if isinstance(capacity, dict):
        # Fill levels in whole percent; storage_60 and daily_60 below say when one reached 60 %.
        print("Capacity:  stored {} of MAX_STORED_BYTES · today {} of MAX_DAILY_UPLOAD_BYTES".format(
            *("{} %".format(value) if count(value) else "-" for value in (capacity.get("storedPercent"), capacity.get("dailyPercent")))))
    known = ("ready", "attention", "reasons", "checks", "backlog", "capacity", "openReports", "oldestOpenReportAge",
             "highestOpenPriority")
    for name, value in data.items():
        if name not in known:
            print("{}: {}".format(name, plain(value, name)))
    codes = reasons(data)
    print("Attention: " + ("YES" if codes else "no"))
    for code in codes:
        print("  {:<17} {}".format(code, REASONS.get(code, "see the Worker's readiness answer")))
    if not data.get("ready"):
        sys.exit(1)


def reconcile(args):
    if args.dry_run:
        show_status(call("/api/admin/uploads"))
        print("Dry run: would recount the upload budget's totals and network counters from its records and reconcile overdue cleanups. Nothing was changed.")
        return
    result = call("/api/admin/reconcile", {})
    drift = result.get("drift")
    if isinstance(drift, dict):
        print("Fixed:     " + (plain(drift) if drift else "nothing was off"))
    cleanups = result.get("cleanups")
    if isinstance(cleanups, dict):
        done = {name: count for name, count in cleanups.items() if count}
        print("Cleanups:  " + (plain(done) + " (overdue transfers: rearmed ran their alarm, released had no file left)" if done else "none overdue"))
    if "stored" in result:
        show_status(result)
    else:
        print("Recounted the upload budget.")


def reports(args):
    query = {"status": args.status, "limit": args.limit}
    transfer = target(args.transfer) if args.transfer else None
    if transfer:
        query["transfer"] = transfer
    # A page starts after the last case of the one before (`next`), in the list's order: priority for open cases.
    if args.after:
        query["after"] = case_id(args.after)
    data = call("/api/admin/reports?" + urllib.parse.urlencode(query))
    cases = data.get("reports") or []
    for case in cases:
        status = (field(case, "status") or "-") + ("/" + case["outcome"] if case.get("outcome") else "")
        rank = case.get("priority")
        print("{}  P{}  {}  {:<9}  {:<15}  {}{}".format(field(case, "id", "case"), rank if count(rank) else "-",
                                                       when(field(case, "createdAt")), field(case, "category") or "-", status,
                                                       field(case, "transferId") or "-",
                                                       "  file gone" if case.get("fileAvailable") is False else ""))
    if not cases:
        print(("No reports" if args.status == "all" else "No {} reports".format(args.status)) + (" after that case." if args.after else "."))
    cursor = data.get("next")
    if isinstance(cursor, str) and CASE.fullmatch(cursor):
        print("Next page: npm run admin -- reports --status {} --limit {}{} --after {}".format(
            args.status, args.limit, " --transfer " + transfer if transfer else "", cursor))


def limit(text):
    if not text.isdigit() or not 1 <= int(text) <= 200:
        raise argparse.ArgumentTypeError("use 1 to 200")
    return int(text)


def parser():
    root = argparse.ArgumentParser(prog="npm run admin --", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = root.add_subparsers(dest="command", metavar="COMMAND")
    commands.required = True
    commands.add_parser("status")
    commands.add_parser("ready")
    commands.add_parser("show").add_argument("target")
    # --note is checked by reason() (not required=True), so a missing note gets the note_required words and exit 1;
    # these usage lines say it is needed, as the module docstring does.
    usages = {"quarantine": "TARGET --note T [--dry-run]", "restore": "TARGET --note T [--dry-run]",
              "takedown": "TARGET --note T [--yes] [--dry-run]", "decide": "CASE ACTION --note T [--yes] [--dry-run]"}
    for name in ("pause", "resume", "reconcile", "quarantine", "restore", "takedown", "decide"):
        command = commands.add_parser(name, usage="%(prog)s " + usages[name] if name in usages else None)
        if name == "decide":
            command.add_argument("case", metavar="CASE")
            command.add_argument("action", choices=ACTIONS, metavar="ACTION", help=", ".join(ACTIONS) + " (remove = takedown)")
        elif name not in ("pause", "resume", "reconcile"):
            command.add_argument("target", metavar="TARGET")
        if name in ("quarantine", "restore", "takedown", "decide"):
            command.add_argument("--note", default="", metavar="T",
                                 help="why (required, at least 3 characters for every decision but note; recorded with it)")
        if name in ("takedown", "decide"):
            command.add_argument("--yes", action="store_true", help="confirm a final removal without asking")
        command.add_argument("--dry-run", action="store_true", help="show the exact target and change nothing")
    listing = commands.add_parser("reports")
    listing.add_argument("--status", choices=("open", "closed", "all"), default="open")
    listing.add_argument("--limit", type=limit, default=50, metavar="1..200")
    listing.add_argument("--transfer", metavar="TARGET", help="only this transfer's cases")
    listing.add_argument("--after", metavar="CASE", help="the next page: the case a listing printed (the last one it showed)")
    commands.add_parser("report").add_argument("case")
    return root


def main(argv):
    args = parser().parse_args(argv)
    if args.command == "status":
        show_status(call("/api/admin/uploads"))
    elif args.command in ("pause", "resume"):
        if args.dry_run:
            show_status(call("/api/admin/uploads"))
            print("Dry run: would {} uploads. Nothing was changed.".format("pause" if args.command == "pause" else "accept"))
        else:
            show_status(call("/api/admin/uploads", {"paused": args.command == "pause"}))
    elif args.command == "reconcile":
        reconcile(args)
    elif args.command == "ready":
        ready()
    elif args.command == "show":
        show_transfer(transfer_view(target(args.target)))
    elif args.command in ("quarantine", "restore"):
        mark(args)
    elif args.command == "takedown":
        takedown(args)
    elif args.command == "reports":
        reports(args)
    elif args.command == "report":
        data = call("/api/admin/reports/" + case_id(args.case))
        show_case(data.get("case") if isinstance(data.get("case"), dict) else data, data.get("events") or [])
    elif args.command == "decide":
        decide(args)


if __name__ == "__main__":
    main(sys.argv[1:])

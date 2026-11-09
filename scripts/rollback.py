#!/usr/bin/env python3
"""Roll the fyl-at Worker back to an earlier version, never below the safe floor. Prefer fixing forward.

  npm run rollback                                 list recent versions and which are rollback targets
  npm run rollback -- <version-id>                 show what a rollback to that version would do
  npm run rollback -- <version-id> --yes [--message TEXT]   roll back with `wrangler rollback`

Only versions that `npm run deploy` tagged v<ROLLBACK_FLOOR> or later are targets. Untagged versions (deploys
before 2.3.0 of the old numbering, secret or dashboard changes, uploads) are refused, and so is every version tagged
in the old numbering (v2.0.0 to v2.5.1, before the public release started over at 1.0.0): it is older than the
floor whatever its number says. A build listed in WITHDRAWN is refused whatever its tag. A tagged version that never
served traffic (uploaded, never deployed), or one that lacks what CAVEATS lists, also needs --accept-caveats. After a
rollback, and after the deploy that fixes forward, run npm run admin -- reconcile.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys

# Fix forward: no version before the public release 1.0.0 is a target. Raise it when a release makes older versions
# unsafe.
ROLLBACK_FLOOR = "1.0.0"
# Versions deployed before 1.0.0 were numbered 2.0.0 to 2.5.1 (first and last): Cloudflare's deployment history still
# lists their tags, and they are never targets, though their numbers are higher. Releases never use them again
# (scripts/build_cli.py refuses them).
OLD_NUMBERING = ("2.0.0", "2.5.1")
# (since, text): what a target older than `since` lacks or breaks; such a rollback needs --accept-caveats. Add one
# when a release changes something an older version would mishandle without being unsafe (else raise the floor).
CAVEATS = []
# Builds that carry a valid tag but must never serve again, by Worker version id: why. Tags and (before the deploy
# after 1.0.1) messages don't tell them apart from their neighbours.
WITHDRAWN = {
    "32a6b7f1-55b2-42cc-918f-fbc1e69dd91b": "the temporary sweep of old Transfer tombstones (#8, 2026-11-09 15:12 UTC), removed again by #9",
}
NEVER_SERVED = "This version never served traffic: it was uploaded but is in none of the Worker's deployments since then."
SECRETS = ("The target runs with the secret values it was deployed with; wrangler names any secret changed since then. "
           "Set a secret rotated since (GRANT_SIGNING_KEY, ADMIN_TOKEN, MONITOR_TOKEN, NETWORK_HASH_KEY) again afterwards.")
# Versions may keep different budget totals (a newer one adds per-network ones); the Budget's daily alarm would fix
# them within a day, reconcile does it at once.
RECONCILE = ("Next: run npm run admin -- reconcile now, and again after the deploy that fixes forward, so the upload "
             "budget's totals match its records at once.")
ROOT = Path(__file__).resolve().parents[1]
WRANGLER = ["node", str(ROOT / "node_modules" / "wrangler" / "bin" / "wrangler.js")]


def wrangler(args):
    """Runs wrangler with captured output and returns stdout; exits with its error output when it fails."""
    result = subprocess.run(WRANGLER + args, cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit("wrangler {} failed:\n{}".format(" ".join(args), (result.stderr or result.stdout).strip()[-2000:]))
    return result.stdout


def run(args):
    """Runs wrangler with its output on the terminal and returns its exit code."""
    return subprocess.call(WRANGLER + args, cwd=ROOT)


def release(tag):
    match = re.fullmatch(r"v?([0-9]+)\.([0-9]+)\.([0-9]+)", tag or "")
    return tuple(int(part) for part in match.groups()) if match else None


def moment(text):
    """A UTC time from the API (2026-10-28T20:18:01.123456Z); fractions of a second are dropped."""
    match = re.fullmatch(r"([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\.[0-9]+)?(Z|\+00:00)", text or "")
    if not match:
        sys.exit("Unexpected version time: {!r}".format(text))
    return datetime.strptime(match[1], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)


def tag_of(version):
    return (version.get("annotations") or {}).get("workers/tag") or ""


def old_numbering(number):
    return release(OLD_NUMBERING[0]) <= number <= release(OLD_NUMBERING[1])


def refusal(version):
    """Why the version is no rollback target, or None when it is one: it needs a release tag of the new numbering at
    or above the floor."""
    if version.get("id") in WITHDRAWN:
        return "withdrawn"
    number = release(tag_of(version))
    if number is None:
        return "untagged"
    if old_numbering(number):
        return "old numbering"
    return "below the floor" if number < release(ROLLBACK_FLOOR) else None


def never_served(version, deployments):
    """True only when it is certain: created after the oldest deployment listed, yet in none of them."""
    times = [moment(deployment["created_on"]) for deployment in deployments]
    return (bool(times) and moment(version["metadata"]["created_on"]) >= min(times)
            and all(version["id"] != item.get("version_id") for deployment in deployments for item in deployment.get("versions", [])))


def row(version, active, deployments):
    created = moment(version["metadata"]["created_on"]).strftime("%Y-%m-%d %H:%M UTC")
    message = (version.get("annotations") or {}).get("workers/message") or "-"
    verdict = ("serving" if version["id"] in active else refusal(version)
               or ("target, never served" if never_served(version, deployments) else "target"))
    return "{}  {}  {:<8}  {:<20}  {}".format(version["id"], created, tag_of(version) or "-", verdict, message)


def parse_json(text, kind):
    try:
        data = json.loads(text)
    except ValueError:
        data = None
    if not isinstance(data, kind):
        sys.exit("wrangler printed no usable JSON.")
    return data


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("version_id", nargs="?")
    parser.add_argument("--yes", action="store_true", help="roll back (without it, only show what would happen)")
    parser.add_argument("--accept-caveats", action="store_true", help="roll back to a target the caveats apply to")
    parser.add_argument("--message", help="reason recorded with the rollback")
    args = parser.parse_args(argv)
    versions = parse_json(wrangler(["versions", "list", "--json"]), list)
    # The Worker's recent deployments, oldest first; the newest one is serving.
    deployments = sorted(parse_json(wrangler(["deployments", "list", "--json"]), list), key=lambda item: moment(item["created_on"]))
    active = {item["version_id"] for item in (deployments[-1].get("versions", []) if deployments else [])}
    floor = "Targets: versions tagged v{} or later; untagged versions and the old numbering (v{} to v{}) are never targets.".format(
        ROLLBACK_FLOOR, *OLD_NUMBERING)
    if not args.version_id:
        for version in reversed(versions):
            print(row(version, active, deployments))
        print(floor)
        return
    target = next((version for version in versions if version.get("id") == args.version_id), None)
    if target is None:
        sys.exit("{} is not among the Worker's recent versions (npm run rollback lists them). Nothing was changed.".format(args.version_id))
    print(row(target, active, deployments))
    if target["id"] in active:
        print("This version is already serving. Nothing was changed.")
        return
    reason = refusal(target)
    if reason == "untagged":
        sys.exit("Refused: this version has no release tag (an old deploy, a secret or dashboard change, or an upload). "
                 + floor + " Fix forward instead. Nothing was changed.")
    if reason == "old numbering":
        sys.exit("Refused: {} is of the old numbering (v{} to v{}), from before v{}. Fix forward instead. Nothing was changed.".format(
            tag_of(target), OLD_NUMBERING[0], OLD_NUMBERING[1], ROLLBACK_FLOOR))
    if reason == "withdrawn":
        sys.exit("Refused: this build is withdrawn: {}. Fix forward instead. Nothing was changed.".format(WITHDRAWN[target["id"]]))
    if reason:
        sys.exit("Refused: {} is older than the floor v{}. Fix forward instead. Nothing was changed.".format(tag_of(target), ROLLBACK_FLOOR))
    number = release(tag_of(target))
    caveats = [caveat for since, caveat in CAVEATS if number < release(since)] + ([NEVER_SERVED] if never_served(target, deployments) else [])
    for caveat in caveats:
        print("Caveat: " + caveat)
    print("Secrets: " + SECRETS)
    command = ["rollback", target["id"], "--message", args.message or "fyl rollback to " + tag_of(target), "--yes"]
    if not args.yes:
        print("Would run: wrangler " + shlex.join(command) + "\nNothing was changed. Add --yes{} to roll back.".format(
            " --accept-caveats" if caveats else ""))
        return
    if caveats and not args.accept_caveats:
        sys.exit("Refused: the caveats above apply to this target. Fix forward, or add --accept-caveats. Nothing was changed.")
    print("Running: wrangler " + shlex.join(command), flush=True)
    code = run(command)
    if code == 0:
        print(RECONCILE)
    sys.exit(code)


if __name__ == "__main__":
    main(sys.argv[1:])

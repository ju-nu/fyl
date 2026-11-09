#!/usr/bin/env python3
"""Print one version's CHANGELOG.md section as GitHub release notes.

  python3 scripts/release_notes.py 2.3.0 [--link-base https://github.com/<owner>/<repo>/blob/<sha>]

--link-base turns the changelog's repository-relative links (docs/CLI-API.md#…) into absolute ones, which a
release page needs.
"""
import argparse
from pathlib import Path
import re
import sys

CHANGELOG = Path(__file__).resolve().parents[1] / "CHANGELOG.md"


def section(text, version):
    """The body under `## <version>` (heading and surrounding blank lines left out), or None."""
    lines, body = text.splitlines(), None
    for line in lines:
        if line.startswith("## "):
            if body is not None:
                break
            if re.match(r"## {}(\s|$)".format(re.escape(version)), line):
                body = []
        elif body is not None:
            body.append(line)
    return None if body is None else "\n".join(body).strip("\n") + "\n"


def absolute(notes, base):
    return re.sub(r"\]\((?![a-z][a-z0-9+.-]*:|#|/)([^)\s]+)\)", lambda match: "]({}/{})".format(base.rstrip("/"), match[1]), notes)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("version")
    parser.add_argument("--link-base")
    parser.add_argument("--changelog", type=Path, default=CHANGELOG)
    args = parser.parse_args(argv)
    notes = section(args.changelog.read_text(), args.version)
    if not notes or not notes.strip():
        sys.exit("CHANGELOG.md has no section for {}.".format(args.version))
    sys.stdout.write(absolute(notes, args.link_base) if args.link_base else notes)


if __name__ == "__main__":
    main(sys.argv[1:])

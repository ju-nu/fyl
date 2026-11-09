"""Write the CLI download index for the native fyl binaries in dist/cli/<version>/.

The binaries are built by scripts/build_native.sh and committed. Files under /cli/<version>/ never change once
published, so they are cached as immutable; /cli/latest (the version, read by the installer) and
/cli/version.json name the current one. The current version's folder and the one before it are kept: an installer that read /cli/latest just before a deploy, or from a cache (60 s), still
finds the files it names.

Versions 2.0.0 to 2.5.1 were used before the public release and are never used again
(docs/ARCHITECTURE.md#version-scheme): render() refuses them.

  python3 scripts/build_cli.py            write the index files
  python3 scripts/build_cli.py --stale    list what build_native.sh removes from dist/cli after a build
"""
from pathlib import Path
import hashlib
import json
import re
import sys

NATIVE = ["fyl-linux-x86_64", "fyl-linux-arm64", "fyl-macos-x86_64", "fyl-macos-arm64"]
ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"([0-9]+)\.([0-9]+)\.([0-9]+)(-[0-9A-Za-z.]+)?")
# Used before the public release started at 1.0.0; never used again (docs/ARCHITECTURE.md#version-scheme).
OLD_NUMBERING = ("2.0.0", "2.5.1")


def version_of(root):
    version = json.loads((root / "package.json").read_text())["version"]
    if not VERSION.fullmatch(version):
        raise SystemExit("package.json has an unusable version: " + version)
    return version


def numbers(name):
    """A version folder's release numbers (2.3.0-rc.1 counts as 2.3.0), or None for any other name."""
    match = VERSION.fullmatch(name)
    return tuple(int(part) for part in match.groups()[:3]) if match else None


def old_numbering(name):
    """Whether a version is one of 2.0.0 to 2.5.1, which releases never use."""
    found = numbers(name)
    return bool(found) and numbers(OLD_NUMBERING[0]) <= found <= numbers(OLD_NUMBERING[1])


def stale(cli, version):
    """What dist/cli must not hold: version folders other than this one and the newest one before it."""
    dirs = [path.name for path in cli.iterdir() if path.is_dir() and numbers(path.name)]
    before = max([name for name in dirs if numbers(name) < numbers(version)], key=numbers, default=version)
    keep = {version, before}
    return sorted(path.name for path in cli.iterdir() if path.is_dir() and path.name not in keep)


def digests(folder):
    """SHA-256 of each native binary in a version folder; exits when one is missing."""
    missing = [name for name in NATIVE if not (folder / name).is_file()]
    if missing:
        raise SystemExit("Missing native binaries in dist/cli/{}: {}. Run scripts/build_native.sh first.".format(folder.name, ", ".join(missing)))
    return {name: hashlib.sha256((folder / name).read_bytes()).hexdigest() for name in NATIVE}


def index(version, files):
    return (json.dumps({"name": "fyl", "version": version, "path": "/cli/{}/".format(version), "files": files}, indent=2) + "\n").encode()


def sums(files):
    return "".join("{}  {}\n".format(digest, name) for name, digest in files.items()).encode()


def render(root=ROOT):
    """The generated files as {path relative to root: bytes}. Exits when the binaries are missing or stale."""
    version = version_of(root)
    if old_numbering(version):
        raise SystemExit("package.json names {}, one of {} to {}, which releases never use.".format(version, *OLD_NUMBERING))
    cli = root / "dist" / "cli"
    files = digests(cli / version)
    extra = stale(cli, version)
    if extra:
        raise SystemExit("Only dist/cli/{} and the version before it are kept; remove dist/cli/{} (git rm -r).".format(
            version, ", dist/cli/".join(extra)))
    return {
        "dist/cli/{}/SHA256SUMS".format(version): sums(files),
        "dist/cli/latest": (version + "\n").encode(),
        "dist/cli/version.json": index(version, files),
    }


def main(argv):
    if argv == ["--stale"]:
        print("".join(name + "\n" for name in stale(ROOT / "dist" / "cli", version_of(ROOT))), end="")
        return
    generated = render()
    for path, content in generated.items():
        (ROOT / path).write_bytes(content)
    print("Wrote " + ", ".join(generated) + ".")


if __name__ == "__main__":
    main(sys.argv[1:])

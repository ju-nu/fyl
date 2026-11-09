"""Write cli-rs/THIRD-PARTY-LICENSES.txt: the license texts of everything the native fyl binaries link statically.

The crates are those `cargo tree` lists for the four release targets as normal dependencies (no build scripts, proc
macros or dev-dependencies), at the versions in cli-rs/Cargo.lock; each one's license files come from its source in
the cargo registry. Then the Rust standard library's licenses, from the pinned toolchain, and musl's (Linux), from
zig's copy of it. MIT, BSD, ISC and similar licenses ask for these texts to go along with the binaries, so the file is
attached to every GitHub release (scripts/release.sh). It needs the toolchain of cli-rs/rust-toolchain.toml, the
crates fetched (any cargo build or test does that) and zig on PATH, as scripts/build_native.sh does.

  python3 scripts/cli_licenses.py           write the file
  python3 scripts/cli_licenses.py --check   exit 1 when the committed file is not what this would write
"""
from pathlib import Path
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "cli-rs"
OUT = CLI / "THIRD-PARTY-LICENSES.txt"
TARGETS = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "x86_64-apple-darwin", "aarch64-apple-darwin"]
LICENSE_FILE = re.compile(r"(LICEN[CS]E|COPYING|COPYRIGHT|NOTICE|UNLICENSE)([-._].*)?", re.IGNORECASE)
RULE = "=" * 100


def run(*command):
    return subprocess.run(command, cwd=CLI, check=True, capture_output=True, text=True).stdout


def crates():
    """(name, version, license expression, source folder) of every crate linked into the binaries, sorted."""
    targets = [argument for target in TARGETS for argument in ("--target", target)]
    listed = set()
    for line in run("cargo", "tree", "--locked", "--edges", "normal,no-proc-macro", "--prefix", "none", "--format", "{p}", *targets).splitlines():
        match = re.match(r"(\S+) v(\S+)", line)
        if match and "(/" not in line:  # the fyl package itself is listed with its path
            listed.add(match.groups())
    packages = {(package["name"], package["version"]): package
                for package in json.loads(run("cargo", "metadata", "--locked", "--format-version", "1"))["packages"]}
    return sorted(((name, version, packages[(name, version)]["license"] or "see its license files",
                    Path(packages[(name, version)]["manifest_path"]).parent) for name, version in listed),
                  key=lambda crate: (crate[0], [int(part) if part.isdigit() else part for part in re.split(r"[.+-]", crate[1])]))


def texts(folder):
    """The license files at the top of a folder, as [(name, text)]."""
    return [(path.name, path.read_text(encoding="utf-8", errors="replace").strip("\n"))
            for path in sorted(folder.iterdir(), key=lambda path: path.name) if path.is_file() and LICENSE_FILE.fullmatch(path.name)]


def section(title, files):
    return "\n".join([RULE, title, RULE, ""] + ["--- {} ---\n\n{}\n".format(name, text) for name, text in files])


def render():
    linked = crates()
    missing = [name for name, _, _, folder in linked if not texts(folder)]
    if missing:
        raise SystemExit("No license file in the source of: " + ", ".join(missing))
    sysroot = Path(run("rustc", "--print", "sysroot").strip())
    toolchain = run("rustc", "--version").split()[1]
    rust = sysroot / "share" / "doc" / "rust" / "licenses"
    zig = re.search(r'lib_dir"?\s*[:=]\s*"([^"]+)"', run("zig", "env"))
    musl = Path(zig.group(1)) / "libc" / "musl" / "COPYRIGHT" if zig else None
    if not (rust / "MIT.txt").is_file() or not (rust / "Apache-2.0.txt").is_file() or not musl or not musl.is_file():
        raise SystemExit("Needs the Rust toolchain of cli-rs/rust-toolchain.toml and zig on PATH (see scripts/build_native.sh).")
    head = [
        "Third-party licenses of the fyl CLI",
        "",
        "Written by scripts/cli_licenses.py; do not edit. The native fyl binaries (dist/cli/<version>/ and the GitHub",
        "releases) are fyl's own code under the AGPL-3.0 (LICENSE) and link the following statically: the crates below,",
        "at the versions pinned in cli-rs/Cargo.lock, the Rust standard library and, in the Linux builds, musl.",
        "Where a crate offers a choice of licenses, all of its license files are included.",
        "",
        "Crates:",
        "",
    ] + ["  {} {} ({})".format(name, version, license) for name, version, license, _ in linked] + [""]
    parts = ["\n".join(head)]
    parts += [section("{} {} ({})".format(name, version, license), texts(folder)) for name, version, license, folder in linked]
    parts.append(section("The Rust standard library, Rust {} (MIT OR Apache-2.0)".format(toolchain), [
        ("COPYRIGHT", "Copyrights in the Rust Standard Library are retained by their contributors. The notices of the code it\n"
                      "includes from elsewhere are in share/doc/rust/COPYRIGHT-library.html of the Rust {} toolchain.".format(toolchain)),
        ("MIT", (rust / "MIT.txt").read_text().strip("\n")),
        ("Apache-2.0", (rust / "Apache-2.0.txt").read_text().strip("\n")),
    ]))
    parts.append(section("musl, the C library of the Linux builds (MIT)", [("COPYRIGHT", musl.read_text().strip("\n"))]))
    return "\n".join(parts)


def main(argv):
    content = render()
    if argv == ["--check"]:
        if not OUT.is_file() or OUT.read_text() != content:
            raise SystemExit("cli-rs/THIRD-PARTY-LICENSES.txt is not current: run python3 scripts/cli_licenses.py and commit it.")
        print("cli-rs/THIRD-PARTY-LICENSES.txt is current.")
        return
    if argv:
        raise SystemExit("Usage: python3 scripts/cli_licenses.py [--check]")
    OUT.write_text(content)
    print("Wrote cli-rs/THIRD-PARTY-LICENSES.txt.")


if __name__ == "__main__":
    main(sys.argv[1:])

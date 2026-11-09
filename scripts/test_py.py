#!/usr/bin/env python3
"""Run the Python tests (tests/test_*.py) in parallel processes: `npm run test:cli`.

Each module is one job, and a module with many tests is cut into several jobs of whole tests, so the run takes about
as long as its slowest job instead of the sum of all of them (the CLI tests wait on real retry backoff). Each job's
`unittest -v` output is printed as one block when it ends, so the blocks never interleave, followed by a summary.

  python3 scripts/test_py.py [-j JOBS] [MODULE ...]     (e.g. test_cli test_monitor; default: all of them)

A single test runs as usual: cd tests && python3 -m unittest -v test_cli.NativeClientTests.test_version_and_help
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import unittest

TESTS = Path(__file__).resolve().parents[1] / "tests"
# A module with more tests than this is cut into jobs of about this many.
CHUNK = 12


def ids(suite):
    for test in suite:
        if isinstance(test, unittest.TestSuite):
            yield from ids(test)
        else:
            yield test.id()


def jobs(modules):
    """(label, unittest arguments) per job. A module that doesn't import is one job by its name, so its error shows."""
    sys.path.insert(0, str(TESTS))
    loader = unittest.TestLoader()
    for module in modules:
        found = list(ids(loader.loadTestsFromName(module)))
        if not found or any(test.startswith("unittest.loader.") for test in found):
            yield module, [module]
            continue
        parts = max(1, round(len(found) / CHUNK))
        for part in range(parts):
            chosen = found[part::parts]
            yield ("{} ({}/{})".format(module, part + 1, parts) if parts > 1 else module), chosen


def run(label, names):
    started = time.monotonic()
    result = subprocess.run([sys.executable, "-m", "unittest", "-v", *names], cwd=TESTS, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    return label, result.returncode, result.stdout, time.monotonic() - started


def counts(output):
    """(tests run, skipped, failures + errors) from unittest's last lines."""
    ran = re.search(r"(?m)^Ran (\d+) tests? in", output)
    skipped = re.search(r"skipped=(\d+)", output)
    failed = sum(int(number) for number in re.findall(r"(?:failures|errors)=(\d+)", output))
    return int(ran[1]) if ran else 0, int(skipped[1]) if skipped else 0, failed


def main():
    parser = argparse.ArgumentParser(description="Run the Python tests in parallel.")
    parser.add_argument("-j", "--jobs", type=int, default=os.cpu_count() or 2, help="processes at once (default: the CPU count)")
    parser.add_argument("modules", nargs="*", help="test modules, e.g. test_cli (default: tests/test_*.py)")
    args = parser.parse_args()
    modules = [name.removesuffix(".py") for name in args.modules] or sorted(path.stem for path in TESTS.glob("test_*.py"))
    planned = list(jobs(modules))
    started = time.monotonic()
    total = skipped = 0
    failing = []
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        for future in as_completed([pool.submit(run, label, names) for label, names in planned]):
            label, code, output, seconds = future.result()
            ran, skips, failed = counts(output)
            total, skipped = total + ran, skipped + skips
            if code != 0:
                failing.append(label)
            print("=" * 70)
            print("{}: {} tests in {:.1f} s, {}".format(label, ran, seconds, "OK" if code == 0 else "FAILED ({} failed)".format(failed or "exit {}".format(code))))
            print("-" * 70)
            print(output.rstrip(), flush=True)
    print("=" * 70)
    print("{} tests in {} jobs ({} at once), {:.1f} s{}: {}".format(total, len(planned), args.jobs, time.monotonic() - started,
                                                                ", {} skipped".format(skipped) if skipped else "",
                                                                "FAILED in " + ", ".join(sorted(failing)) if failing else "OK"))
    sys.exit(1 if failing else 0)


if __name__ == "__main__":
    main()

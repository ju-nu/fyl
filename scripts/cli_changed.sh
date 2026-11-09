#!/bin/sh
# Prints true when Checks must run the native CLI job (Rust tests, audit, rebuild and compare), else false.
#   sh scripts/cli_changed.sh EVENT [PR_BASE]
#   sh scripts/cli_changed.sh --bridge EVENT [PR_BASE]
# It runs when the CLI, its build inputs, the test vectors its unit tests share with the server or this gate
# changed. A pull request compares with its base. A push to main compares with what production already has, so
# a commit whose native job failed stays in the diff of every later push until a run passes it. Without
# production (and for the weekly run) the job always runs.
# With --bridge: true when the job must also rebuild the bridge's binaries (dist/cli/<build_cli.py BRIDGE>/) from
# this source and compare them: while the CLI source (cli-rs/, scripts/build_native.sh) is the one they were
# committed with, with or without a base, so a repository whose history starts after them checks them too; and when
# the change adds or changes them. Once published they never change (cli_published.sh), and a later source no
# longer builds them byte for byte, so after it changed, and without such a change, it prints false.
set -eu
bridge=""
if [ "${1:-}" = "--bridge" ]; then bridge="$(python3 "$(dirname "$0")/build_cli.py" --bridge)"; shift; fi
base=""
case "${1:-}" in
  pull_request) base="${2:-}" ;;
  push) base="$(git merge-base refs/remotes/origin/production HEAD 2>/dev/null)" || base="" ;;
esac
if [ -n "$bridge" ]; then
  added="$(git log -1 --format=%H -- "dist/cli/$bridge/")"
  if [ -n "$added" ] && git diff --quiet "$added" HEAD -- cli-rs scripts/build_native.sh; then echo true; exit 0; fi
fi
if [ -z "$base" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  if [ -n "$bridge" ]; then echo false; else echo true; fi
  exit 0
fi
changed="$(git diff --name-only "$base" HEAD)"
if [ -n "$bridge" ]; then
  if printf '%s\n' "$changed" | grep -qF "dist/cli/$bridge/"; then echo true; else echo false; fi
  exit 0
fi
if printf '%s\n' "$changed" | grep -qE '^(cli-rs/|tests/vectors/|dist/cli/([^/]+/)?fyl-|scripts/(build_native|cli_changed)\.sh|scripts/(build_cli|cli_licenses)\.py|package\.json|\.github/workflows/checks\.yml)'; then
  echo true
else
  echo false
fi

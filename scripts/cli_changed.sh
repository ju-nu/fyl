#!/bin/sh
# Prints true when Checks must run the native CLI job (Rust tests, audit, rebuild and compare), else false.
#   sh scripts/cli_changed.sh EVENT [PR_BASE]
# It runs when the CLI, its build inputs, the test vectors its unit tests share with the server or this gate
# changed. A pull request compares with its base. A push to main compares with what production already has, so
# a commit whose native job failed stays in the diff of every later push until a run passes it. Without
# production (and for the weekly run) the job always runs.
set -eu
base=""
case "${1:-}" in
  pull_request) base="${2:-}" ;;
  push) base="$(git merge-base refs/remotes/origin/production HEAD 2>/dev/null)" || base="" ;;
esac
if [ -z "$base" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then echo true; exit 0; fi
changed="$(git diff --name-only "$base" HEAD)"
if printf '%s\n' "$changed" | grep -qE '^(cli-rs/|tests/vectors/|dist/cli/[^/]+/fyl-|scripts/(build_native|cli_changed)\.sh|scripts/(build_cli|cli_licenses)\.py|package\.json|\.github/workflows/checks\.yml)'; then
  echo true
else
  echo false
fi

#!/bin/sh
# Fails when a commit changes CLI files that are already published. /cli/<version>/ is served as immutable and the
# GitHub release v<version> carries the same files, so a rebuild needs a new version in package.json: a version
# folder may be added, or removed as a whole, but nothing in a folder the base already has may change.
#   sh scripts/cli_published.sh EVENT [PR_BASE]
# The base is what is published: for a push to main what production has, for a pull request its base. Without one
# (no production yet, the weekly run) there is nothing to compare.
set -eu
base=""
case "${1:-}" in
  pull_request) base="${2:-}" ;;
  push) base="$(git merge-base refs/remotes/origin/production HEAD 2>/dev/null)" || base="" ;;
esac
if [ -z "$base" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then echo "No published base to compare dist/cli with."; exit 0; fi
versions="$(git diff --name-only --no-renames "$base" HEAD -- dist/cli/ | sed -n 's|^dist/cli/\([^/]*\)/.*|\1|p' | sort -u)"
changed=""
for version in $versions; do
  if git cat-file -e "$base:dist/cli/$version" 2>/dev/null && git cat-file -e "HEAD:dist/cli/$version" 2>/dev/null; then
    changed="$changed $version"
    git diff --stat --no-renames "$base" HEAD -- "dist/cli/$version/"
  fi
done
if [ -n "$changed" ]; then
  echo "Published CLI files changed in dist/cli/:$changed. They never change once published: bump the version in package.json and rebuild (npm run build:native) instead." >&2
  exit 1
fi
echo "Published CLI files are unchanged."

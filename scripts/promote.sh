#!/bin/sh
# The Deploy gate's step: fast-forward origin's production branch to SHA, a main commit whose Checks run passed,
# but only while main still points at it, and never with --force. A remote that cannot be read fails the run, so
# a merged commit is never skipped with a green result.   Usage: sh scripts/promote.sh SHA
set -eu
fail() { printf 'promote: %s\n' "$*" >&2; exit 1; }
commit() { printf '%s\n' "$1" | grep -qxE '[0-9a-f]{40}([0-9a-f]{24})?'; }
sha="${1:-}"
commit "$sha" || fail "Pass the commit id to promote."
heads="$(git ls-remote --exit-code origin refs/heads/main)" || fail "Could not read main from origin. Re-run this job; if it fails again, check that FYL_DEPLOY_TOKEN has not expired."
main="$(printf '%s\n' "$heads" | cut -f 1)"
commit "$main" || fail "origin answered no commit id for main. Re-run this job."
if [ "$main" != "$sha" ]; then echo "main moved on to $main; its own Checks run decides."; exit 0; fi
# --exit-code: 2 means production does not exist yet, anything else non-zero that it could not be read.
found=0
git ls-remote --exit-code origin refs/heads/production >/dev/null || found=$?
case "$found" in
  0) git fetch --no-tags origin production
     if git merge-base --is-ancestor "$sha" FETCH_HEAD; then echo "production already contains $sha."; exit 0; fi ;;
  2) echo "production does not exist yet; creating it." ;;
  *) fail "Could not read production from origin. Re-run this job." ;;
esac
# No --force: if production is not an ancestor of this commit, the push fails instead of overwriting it.
git push origin "$sha:refs/heads/production" ||
  fail "GitHub refused the push: production has a commit that is not on main, or FYL_DEPLOY_TOKEN lacks Contents and Workflows write access to this repository (or has expired)."
echo "production is now $sha; Workers Builds deploys it."

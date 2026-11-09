#!/bin/sh
# The Release workflow's step: publish the CLI release v<version> of SHA once per version, only once the Deploy
# gate moved production to SHA and https://fyl.at/cli/latest names that version, so a release never runs ahead of
# what fyl.at serves. Workers Builds deploys production minutes after the Deploy gate, and not at all when its build
# fails: this waits up to 20 minutes and then fails. A release that exists already must carry exactly the committed
# SHA256SUMS: published files never change.
# The binary must report this version.
#   sh scripts/release.sh SHA      (from a checkout of SHA; needs gh with GH_TOKEN, GITHUB_REPOSITORY,
#                                   GITHUB_SERVER_URL and RUNNER_TEMP, and curl, as in GitHub Actions)
set -eu
fail() { printf 'release: %s\n' "$*" >&2; exit 1; }
sha="${1:-}"
printf '%s\n' "$sha" | grep -qxE '[0-9a-f]{40}([0-9a-f]{24})?' || fail "Pass the commit id to release."
production="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/production" --jq .object.sha)" || fail "Could not read production. Re-run this job."
if [ "$production" != "$sha" ]; then echo "production is at $production, not $sha; nothing to release."; exit 0; fi
python3 scripts/build_cli.py
version="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
[ "$("dist/cli/$version/fyl-linux-x86_64" --version)" = "fyl $version" ] || fail "dist/cli/$version/fyl-linux-x86_64 does not report fyl $version."
# The release must ship exactly the committed, reviewed files; a generated file left untracked counts too.
changed="$(git status --porcelain --untracked-files=all -- dist/cli/)"
[ -z "$changed" ] || fail "The generated CLI files differ from the committed ones: $changed"
[ -s cli-rs/THIRD-PARTY-LICENSES.txt ] || fail "cli-rs/THIRD-PARTY-LICENSES.txt is missing (python3 scripts/cli_licenses.py)."
mkdir -p "$RUNNER_TEMP/published"

# Whether the release of version $1 exists; one that does must carry exactly dist/cli/$1/SHA256SUMS.
published() {
  gh release view "v$1" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1 || return 1
  rm -f "$RUNNER_TEMP/published/SHA256SUMS"
  gh release download "v$1" --repo "$GITHUB_REPOSITORY" --pattern SHA256SUMS --dir "$RUNNER_TEMP/published" ||
    fail "Could not download SHA256SUMS of the existing release v$1."
  cmp -s "$RUNNER_TEMP/published/SHA256SUMS" "dist/cli/$1/SHA256SUMS" ||
    fail "Release v$1 exists with other files than dist/cli/$1/SHA256SUMS. Published files never change: bump the version to ship a rebuild."
  echo "Release v$1 exists and carries the committed SHA256SUMS."
}

# Release version $1 from dist/cli/$1 with the notes file $2; further arguments go to gh release create. The license
# texts of what the binaries link (scripts/cli_licenses.py) go along with them.
create() {
  each="$1" notes="$2"
  shift 2
  cli="dist/cli/$each"
  gh release create "v$each" "$cli/fyl-linux-x86_64" "$cli/fyl-linux-arm64" "$cli/fyl-macos-x86_64" "$cli/fyl-macos-arm64" \
    "$cli/SHA256SUMS" cli-rs/THIRD-PARTY-LICENSES.txt --repo "$GITHUB_REPOSITORY" --target "$sha" --title "fyl.at v$each" --notes-file "$notes" "$@"
  echo "Released v$each."
}

if ! published "$version"; then
  # Only this version's changelog section; its repository-relative links point at the released commit.
  python3 scripts/release_notes.py "$version" --link-base "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/blob/$sha" > "$RUNNER_TEMP/notes.md"
  # 60 tries 20 s apart: Workers Builds runs npm run ci before it deploys, and latest may be cached for 60 s.
  # Only digits and dots are ever echoed to the log; anything else counts as unreadable.
  tries=60
  while :; do
    served="$(curl -fs --max-time 15 https://fyl.at/cli/latest)" || served=""
    [ "$served" != "$version" ] || break
    case "$served" in '' | *[!0-9.]*) served="nothing readable" ;; esac
    tries=$((tries - 1))
    [ "$tries" -gt 0 ] ||
      fail "fyl.at still serves $served at /cli/latest after 20 minutes, not $version. Check the Workers Build of production, then re-run this job."
    echo "fyl.at serves $served at /cli/latest, not $version yet; waiting for the Workers Build."
    sleep 20
  done
  create "$version" "$RUNNER_TEMP/notes.md"
fi

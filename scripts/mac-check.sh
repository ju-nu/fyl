#!/bin/sh
# Checks the fyl CLI on a real Mac and uploads the report with fyl itself.
#
#   sh mac-check.sh                 (FYL_BASE_URL overrides https://fyl.at)
#
# fyl is installed into a temporary folder only, nothing touches your PATH, and every test upload
# is deleted again (or expires after 5 minutes). The report leaves out your user name and home folder.
set -u
base="${FYL_BASE_URL:-https://fyl.at}"
FYL_API_URL="$base/api/upload"; export FYL_API_URL
# fyl's own check: the CLI adds this to its User-Agent, so the dashboard leaves these uploads out.
FYL_UA_SUFFIX="fyl-smoke"; export FYL_UA_SUFFIX
work="$(mktemp -d "${TMPDIR:-/tmp}/fyl-check.XXXXXX")" || exit 1
work="$(printf '%s' "$work" | sed 's|//*|/|g')"
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT TERM
report="$work/fyl-mac-report.txt"
passed=0 failed=0

log() { printf '%s\n' "$*" | tee -a "$report"; }
ok() { passed=$((passed + 1)); log "PASS  $*"; }
bad() { failed=$((failed + 1)); log "FAIL  $*"; }
note() { log "      $*"; }
section() { log ""; log "== $*"; }
attach() { [ -s "$1" ] && sed 's/^/      | /' "$1" >> "$report"; }
status() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
same() { cmp -s "$1" "$2"; }

finish() {
  section "Summary"
  log "$passed passed, $failed failed"
  clean="$work/report/fyl-mac-report.txt"
  mkdir -p "$work/report"
  # codesign reports the resolved /private/var path; the --resume command carries the upload key here
  # (--manage) or a resume token, both private.
  # TMPDIR ends with a slash on macOS, so paths may carry "//"; any per-user temp folder is redacted too.
  sed -e 's|\([^:]\)//*|\1/|g' -e "s|/private$work|<tmp>|g" -e "s|$work|<tmp>|g" -e 's|/private/var/folders/[^ ]*|<tmp>|g' \
    -e 's|/var/folders/[^ ]*|<tmp>|g' -e "s|$HOME|~|g" -e "s|${USER:-<user>}|<user>|g" \
    -e 's/echo [A-Za-z0-9_-]*\.[A-Za-z0-9_-]* |/echo <token> |/g' -e 's/--resume [A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/--resume <token>/g' "$report" > "$clean"
  link=""
  [ -x "${fyl:-}" ] && link="$("$fyl" "$clean" --expires 3d 2>/dev/null)"
  printf '\n'
  if [ -n "$link" ]; then
    printf 'Report uploaded. Send this link:\n\n  %s\n\n' "$link"
  else
    printf 'The report could not be uploaded. Please paste this instead:\n\n'
    cat "$clean"
  fi
  exit 0
}

log "fyl Mac check, $(date -u '+%Y-%m-%d %H:%M UTC'), against $base"

section "System"
note "macOS $(sw_vers -productVersion 2>/dev/null) ($(sw_vers -buildVersion 2>/dev/null)), $(uname -m), $(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
note "Rosetta: $(if [ "$(uname -m)" != arm64 ]; then echo 'not needed (Intel)'; elif arch -x86_64 /usr/bin/true 2>/dev/null; then echo installed; else echo 'not installed'; fi)"
note "$(curl --version | head -n 1)"
note "/bin/sh: $(/bin/sh -c 'echo ${BASH_VERSION:-${ZSH_VERSION:-other}}')"

section "Install"
mkdir -p "$work/bin"
if curl -fsSL "$base/cli/install" | FYL_BASE_URL="$base" FYL_INSTALL_DIR="$work/bin" sh > "$work/install.log" 2>&1
then ok "installer finished"; else bad "installer failed"; fi
attach "$work/install.log"
fyl="$work/bin/fyl"
[ -x "$fyl" ] || { bad "no fyl binary was installed"; finish; }

section "Binary"
version="$("$fyl" --version 2>&1)"
case "$version" in "fyl "*) ok "runs: $version" ;; *) bad "--version printed: $version" ;; esac
note "$(file "$fyl" | sed 's/^[^:]*: //')"
codesign -dv "$fyl" > "$work/codesign.log" 2>&1; note "codesign -dv (exit $?):"; attach "$work/codesign.log"
if xattr -p com.apple.quarantine "$fyl" > /dev/null 2>&1; then bad "installed binary is quarantined"; else ok "no quarantine flag after curl install"; fi
note "spctl (informational, unnotarized CLI tools are expected to be rejected): $(spctl --assess --type execute "$fyl" 2>&1 | tr '\n' ' ')"
# otool is a stub that asks to install the developer tools unless they are present.
if xcode-select -p > /dev/null 2>&1; then
  note "build version: $(otool -l "$fyl" | grep -E '^ *(minos|sdk) ' | tr -s ' ' | tr '\n' ' ')"
fi

section "Messages"
"$fyl" > "$work/hint.log" 2>&1; code=$?
if grep -q "fyl uploads a file" "$work/hint.log"; then ok "friendly hint without arguments (exit $code)"; else bad "no-argument output (exit $code):"; attach "$work/hint.log"; fi
"$fyl" "$work/missing.zip" > "$work/missing.log" 2>&1; code=$?
if [ "$code" -ne 0 ]; then ok "missing file is refused (exit $code): $(head -n 1 "$work/missing.log")"; else bad "missing file exited 0"; fi

section "Upload, download, delete"
head -c 1048576 /dev/urandom > "$work/small.bin"
"$fyl" "$work/small.bin" --expires 5m --manage > "$work/small.out" 2> "$work/small.err"; code=$?
url="$(sed -n 1p "$work/small.out")" manage="$(sed -n 2p "$work/small.out")"
if [ "$code" -eq 0 ] && [ "$(wc -l < "$work/small.out" | tr -d ' ')" = 2 ]; then ok "--manage prints the link and the management link"
else bad "upload with --manage (exit $code):"; attach "$work/small.out"; attach "$work/small.err"; fi
[ -s "$work/small.err" ] && { note "unexpected stderr:"; attach "$work/small.err"; }
if curl -fsS -o "$work/small.down" "$url" && same "$work/small.bin" "$work/small.down"; then ok "download is identical"; else bad "download differs or failed"; fi
if "$fyl" rm "$manage" > "$work/rm.log" 2>&1; then ok "fyl rm: $(cat "$work/rm.log")"; else bad "fyl rm failed:"; attach "$work/rm.log"; fi
code="$(status "$url")"; if [ "$code" = 410 ]; then ok "deleted link answers 410"; else bad "deleted link answers $code"; fi

section "One-time link"
"$fyl" "$work/small.bin" --once --expires 5m > "$work/once.out" 2>&1; code=$?
url="$(sed -n 1p "$work/once.out")"
if [ "$code" -eq 0 ] && [ "$(wc -l < "$work/once.out" | tr -d ' ')" = 1 ]; then ok "default output is only the link"; else bad "upload --once (exit $code):"; attach "$work/once.out"; fi
if curl -fsS -o "$work/once.down" "$url" && same "$work/small.bin" "$work/once.down"; then ok "first download is identical"; else bad "first download differs or failed"; fi
code="$(status "$url")"; if [ "$code" = 410 ]; then ok "second download answers 410"; else bad "second download answers $code"; fi

section "Password and JSON"
# A fresh password per run: the transfer lives five minutes, and nothing here looks like a credential to keep.
pw="$(openssl rand -hex 12)"
url="$(FYL_PASSWORD="$pw" "$fyl" "$work/small.bin" --password --expires 5m 2> "$work/pw.err")"; code=$?
if [ "$code" -eq 0 ] && [ -n "$url" ]; then ok "--password upload with FYL_PASSWORD"; else bad "--password upload (exit $code):"; attach "$work/pw.err"; fi
code="$(status "$url")"; if [ "$code" = 401 ]; then ok "protected link without password answers 401"; else bad "protected link without password answers $code"; fi
if curl -fsS -u "fyl:$pw" -o "$work/pw.down" "$url" && same "$work/small.bin" "$work/pw.down"; then ok "curl -u download is identical"; else bad "curl -u download differs or failed"; fi
"$fyl" "$work/small.bin" --json --once --expires 5m > "$work/json.out" 2> "$work/json.err"; code=$?
if [ "$code" -eq 0 ] && [ "$(wc -l < "$work/json.out" | tr -d ' ')" = 1 ] && grep -q '"url":"' "$work/json.out" && grep -q '"once":true' "$work/json.out"; then ok "--json prints one JSON line"; else bad "--json (exit $code):"; attach "$work/json.out"; attach "$work/json.err"; fi
url="$(sed -n 's/.*"url":"\([^"]*\)".*/\1/p' "$work/json.out")"; [ -n "$url" ] && curl -fsS -o /dev/null "$url"
"$fyl" "$work/small.bin" --expires 5m >&- 2> "$work/closed.err"; code=$?
note "stdout closed: exit $code, stderr: $(head -n 2 "$work/closed.err" | tr '\n' ' ' | sed 's#https://[^ ]*#<link>#g')"

section "Multipart upload, Ctrl+C, resume"
head -c $((60 * 1048576)) /dev/urandom > "$work/big.bin"
start="$(date +%s)"
"$fyl" "$work/big.bin" --expires 5m --manage --workers 1 -v > "$work/big.out" 2> "$work/big.err" &
pid=$!
sleep 4
running=no; kill -INT "$pid" 2> /dev/null && running=yes
wait "$pid"; code=$?
token="$(sed -n 's/.*echo \([A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\) | .*--resume -.*/\1/p' "$work/big.err" | head -n 1)"
if [ -n "$token" ]; then
  ok "Ctrl+C keeps the upload resumable (exit $code)"
  attach "$work/big.err"
  printf '%s\n' "$token" | "$fyl" "$work/big.bin" --resume - --manage -v > "$work/big.out" 2> "$work/resume.err"; code=$?
  if [ "$code" -eq 0 ]; then ok "resume finished: $(grep -m 1 'Resuming' "$work/resume.err")"; else bad "resume failed (exit $code):"; attach "$work/resume.err"; fi
elif [ "$code" -eq 0 ] && [ "$running" = yes ]; then
  bad "the upload ignored SIGINT (Ctrl+C) and finished"
elif [ "$code" -eq 0 ]; then
  note "upload finished within 4 seconds, so the interrupt was not tested"
else
  bad "interrupted upload printed no --resume command (exit $code):"; attach "$work/big.err"
fi
note "upload time: $(($(date +%s) - start)) s for 60 MB (2 parts)"
url="$(sed -n 1p "$work/big.out")" manage="$(sed -n 2p "$work/big.out")"
if [ -n "$url" ] && curl -fsS -o "$work/big.down" "$url" && same "$work/big.bin" "$work/big.down"; then ok "multipart download is identical"; else bad "multipart download differs or failed"; fi
[ -n "$manage" ] && "$fyl" rm "$manage" > /dev/null 2>&1

section "Intel build under Rosetta"
if [ "$(uname -m)" != arm64 ]; then
  note "this Mac is Intel; the tests above used the x86_64 build and the arm64 build was not tested"
elif ! arch -x86_64 /usr/bin/true 2> /dev/null; then
  note "Rosetta is not installed, so the x86_64 build was not tested (softwareupdate --install-rosetta)"
else
  release="$(curl -fsSL "$base/cli/latest")"
  curl -fsSL -o "$work/fyl-x86" "$base/cli/$release/fyl-macos-x86_64" && curl -fsSL -o "$work/sums" "$base/cli/$release/SHA256SUMS"
  expected="$(grep ' fyl-macos-x86_64$' "$work/sums" | cut -d ' ' -f 1)"
  if [ -n "$expected" ] && [ "$(shasum -a 256 "$work/fyl-x86" | cut -d ' ' -f 1)" = "$expected" ]; then ok "x86_64 checksum matches"; else bad "x86_64 checksum mismatch"; fi
  chmod 755 "$work/fyl-x86"
  version="$(arch -x86_64 "$work/fyl-x86" --version 2>&1)"
  case "$version" in "fyl "*) ok "x86_64 runs: $version" ;; *) bad "x86_64 --version printed: $version" ;; esac
  url="$(arch -x86_64 "$work/fyl-x86" "$work/small.bin" --once --expires 5m 2> "$work/x86.err")"
  if [ -n "$url" ] && curl -fsS -o "$work/x86.down" "$url" && same "$work/small.bin" "$work/x86.down"; then ok "x86_64 upload and download are identical"; else bad "x86_64 upload failed:"; attach "$work/x86.err"; fi
fi

finish

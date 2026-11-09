#!/bin/sh
# Cross-build the native fyl binaries into dist/cli/<version> (package.json) with cargo-zigbuild.
#   sh scripts/build_native.sh            this version; then dist/cli keeps its folder, the one before it and the
#                                         bridge (build_cli.py --stale)
#   sh scripts/build_native.sh --bridge   the bridge release of the old numbering (build_cli.py BRIDGE) from this
#                                         source, under that version (FYL_BUILD_VERSION, cli-rs/src/main.rs)
# Needs: the Rust toolchain from cli-rs/rust-toolchain.toml, zig and cargo-zigbuild on PATH.
# Paths are remapped so the output is reproducible; CI rebuilds and compares the committed binaries.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
unset FYL_BUILD_VERSION
case "${1:-}" in
  '') version="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$root/package.json")" ;;
  --bridge) version="$(python3 "$root/scripts/build_cli.py" --bridge)"; export FYL_BUILD_VERSION="$version" ;;
  *) echo "Usage: sh scripts/build_native.sh [--bridge]" >&2; exit 2 ;;
esac
case "$version" in *[!0-9A-Za-z.-]*|'') echo "Unusable version: $version" >&2; exit 1 ;; esac
out="$root/dist/cli/$version"
mkdir -p "$out"
cd "$root/cli-rs"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--remap-path-prefix=$root=/fyl --remap-path-prefix=$cargo_home=/cargo -C link-arg=-s"
export SOURCE_DATE_EPOCH=1767225600
export MACOSX_DEPLOYMENT_TARGET=11.0
for pair in x86_64-unknown-linux-musl:linux-x86_64 aarch64-unknown-linux-musl:linux-arm64 \
            x86_64-apple-darwin:macos-x86_64 aarch64-apple-darwin:macos-arm64; do
  target="${pair%%:*}" name="${pair##*:}"
  cargo zigbuild --quiet --release --locked --target "$target"
  install -m 755 "target/$target/release/fyl" "$out/fyl-$name"
  echo "Built dist/cli/$version/fyl-$name"
done
# The license texts of what the binaries link, released with them (scripts/cli_licenses.py).
python3 "$root/scripts/cli_licenses.py"
[ -z "${FYL_BUILD_VERSION:-}" ] || exit 0
stale="$(python3 "$root/scripts/build_cli.py" --stale)"
printf '%s\n' "$stale" | while IFS= read -r old; do
  [ -n "$old" ] || continue
  rm -rf "${root:?}/dist/cli/$old"
  echo "Removed dist/cli/$old (only this version, the one before it and the bridge are kept)"
done

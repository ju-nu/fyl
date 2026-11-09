# Notes for coding agents

Start with [CONTRIBUTING.md](CONTRIBUTING.md): its setup, test layout and **Rules that must hold** apply to every
change. Then read what the change touches: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how the service works, limits,
compatibility code), [docs/OPERATIONS.md](docs/OPERATIONS.md) (deploys, secrets, runbooks), [PRODUCT.md](PRODUCT.md) and
[DESIGN.md](DESIGN.md) (product and interface decisions), and the protocol docs in `docs/`.

- Public command and executable: `fyl`. Domain: `fyl.at`. Source repository: `ju-nu/fyl-at` on GitHub.
- Merging into `main` is a production deploy: a green `Checks` run of a `main` commit lets the Deploy gate
  fast-forward `production`, and Cloudflare Workers Builds deploys it with `npm run deploy` (which checks the Worker
  secrets and tags the version `v<version>`). Work on a branch and open a pull request; never push to `main` or
  `production` directly, never deploy an untagged version, and never roll back below `ROLLBACK_FLOOR` in
  `scripts/rollback.py`: fix forward.
- Run `npm run ci` after meaningful changes, and `npm run test:rust` after CLI changes. Keep the version (package.json,
  package-lock.json, cli-rs/Cargo.toml, cli-rs/Cargo.lock via `cargo update --workspace --offline`, the smoke
  User-Agent in scripts/smoke.py), the generated CLI files and the CHANGELOG section consistent: the release notes are
  that section. Never use the versions 2.0.0 to 2.5.1 ([version scheme](docs/ARCHITECTURE.md#version-scheme)).
- The CLI is `cli-rs/` (Rust). Binaries live in `dist/cli/<version>/` with `SHA256SUMS`; only the current version's
  folder, the one before it and the bridge 2.5.1 stay (`scripts/build_cli.py` refuses any other). Rebuild with
  `npm run build:native` (pinned toolchain, zig and cargo-zigbuild) and commit the binaries; `sh
  scripts/build_native.sh --bridge` rebuilds the bridge. A published version folder never changes.
- Checks against production must stay out of the statistics: fyl's own tools send `fyl-smoke`, `fyl-monitor` or
  `fyl-admin` in their User-Agent, and an ad-hoc check adds `fyl-ops` (`curl -A fyl-ops …`, or `HEAD`, which is never
  counted; a Playwright context against fyl.at appends ` fyl-ops` to its `userAgent`). `OWN_TOOLS` in `src/index.ts`
  writes no page view or CLI download for them and counts their uploads and downloads as `own`. The CLI appends
  `FYL_UA_SUFFIX` (set to `fyl-smoke` by `smoke.py` and `mac-check.sh`) to its User-Agent.
- Never print, log or commit a token, key, management link or `.env` value; the operator scripts read their secrets
  from the environment or the ignored `.env` (`.env.example` lists the names).
- Write code, comments, docs and UI text in English and keep the repository's dense style: comments say why. Every new
  user-facing string of the public site goes into all five catalogs in `i18n/` (`npm run build:i18n`).

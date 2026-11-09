# Changelog

## Unreleased

Server and repository only; the CLI is unchanged.

- **Old tombstones:** a one-off sweep (2026-11-09, a temporary operator route and `npm run admin -- sweep`, both
  removed again) fixed the last 24 tombstones from before 2026-10-30, with 0 left over, so the Transfer constructor's
  guard for them is removed.
- **CLI files:** a `/cli/` file that doesn't exist (a version not published yet) answers a plain-text 404 that no
  cache keeps, instead of the published files' year-long immutable caching.
- **Pages:** every indexed page carries `og:title`, `og:description` and `og:type`, the privacy and report pages too.
  A browser opening a page address that doesn't exist (`/faq`, `/en/nonexistent`) goes to the home page of its
  language instead of an empty 404.
- **API:** `HEAD /api/health` answers like `GET`, without a body.
- **Report host:** `report.fyl.at` serves `/.well-known/security.txt`, which names both canonical addresses.
- **Deploys:** the Worker version message names the commit (`fyl <version> <commit>`), so builds that share a tag
  can be told apart in `npm run rollback`.
- **Repository:** the deploy key and the monitor's tokens live in the GitHub environments `production` and `monitor`,
  limited to `main`; the Monitor runs at minute 23.

## 1.0.1 — 2026-11-09

- **CLI dependencies:** getrandom 0.4 and crc32fast 1.5.4. Encryption, checksums and the zip format are unchanged;
  every test vector passes as before.
- **CLI downloads:** `/cli/version.json` names the current release for every client, and only the versioned
  `/cli/<version>/` paths are served. The update path for CLIs from before 1.0.0 (the 2.5.1 build in `/cli/2.5.1/`)
  and the unversioned `/cli/fyl-<os>-<arch>` and `/cli/SHA256SUMS` paths are gone. A fyl from before 1.0.0
  installs again with `curl -fsSL https://fyl.at/cli/install | sh`.
- **`fyl update`** compares version numbers plainly.
- **Server:** code that only handled records and links of the versions before 1.0.0 is removed
  ([compatibility code](docs/ARCHITECTURE.md#compatibility-code)).

## 1.0.0 — 2026-11-09

The first public release of fyl.at: anonymous, temporary file sharing on Cloudflare Workers, with its source open
under the [GNU AGPL-3.0](LICENSE). Drop a file or a folder, choose when the link expires, share the link. No accounts.

### What fyl does

- **Files and folders up to 50 GB.** Uploads go in 50 MiB parts and resume where they stopped, also after a reload
  or an interrupted CLI run. A folder goes as one uncompressed zip built on the sender's device
  ([folder zip](docs/FOLDER-ZIP.md)).
- **Share while uploading.** The link works at once; a recipient who opens it early sees the progress and gets the
  file when it is ready.
- **Link lifetimes** from 5 minutes to 7 days (presets or a custom time), and **one download** if the sender wants:
  a one-time link allows one download session, which resumes from the same network.
- **Password.** Recipients type it on the download page, or curl asks for it; wrong tries pause the link, and the
  sender can lift a pause.
- **Optional end-to-end encryption.** The file is encrypted on the sender's device as an age file; the key is the part
  of the link after `#`, which never reaches fyl.at, and "Even safer: send the key separately" splits link and key
  ([E2EE](docs/E2EE.md)).
- **A private management link** changes the expiry, lifts a password pause or deletes the file at once.
- **Download pages in browsers, the file in terminals,** with a warning for files that can run code, chat link
  previews that show nothing about protected or encrypted files, and hotlink protection.
- **The `fyl` CLI** for macOS and Linux (x86_64, arm64): upload a file or folder with every option, `--json`,
  `--resume`, `fyl download`, `fyl decrypt`, `fyl rm` and `fyl update`, installed with
  `curl -fsSL https://fyl.at/cli/install | sh` and checked against published SHA-256 sums ([CLI](docs/CLI.md)).
- **Five languages:** English, German, Spanish, French and Dutch, each page at its own address, chosen by the
  browser's language and switched without cookies.
- **A report form** on its own origin, `report.fyl.at`, guarded by Cloudflare Turnstile; a person reviews every case,
  and a file under review can't be downloaded.
- **No account, no tracking cookie,** fair-use limits per network, and [llms.txt](https://fyl.at/llms.txt) for agents.

### Dependencies

- The CLI uses the current generation of its crypto libraries, together, so that only one version of each shared
  building block is compiled in: `chacha20poly1305` 0.11, `x25519-dalek` 3 (with `curve25519-dalek` 5), `hkdf` 0.13,
  `hmac` 0.13, `sha2` 0.11 and `md-5` 0.11; the test-only `miniz_oxide` moves to 0.9. The CLI encrypts, decrypts,
  hashes and zips byte for byte as before (the shared vectors in `tests/vectors/` pass unchanged). Building it needs
  Rust 1.88 or later; the release binaries are built with the pinned 1.99.1.

### Before 1.0.0

fyl.at was developed privately before its source was published with this release. Its versions then were numbered
2.0.0 to 2.5.1, which releases never use again ([version scheme](docs/ARCHITECTURE.md#version-scheme)).

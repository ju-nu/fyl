# Changelog

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

### New in this release

- **Public source.** Every page's footer links the source repository, and the privacy page says that the code of
  fyl.at and the CLI is public and where each release lists its checksums. `/.well-known/security.txt` names
  `security@fyl.at` and the [security policy](SECURITY.md).
- **Version numbers start over at 1.0.0** for the service and the CLI ([version scheme](docs/ARCHITECTURE.md#version-scheme)).
- **A paused link answers 429** (with `Retry-After`) to a download request without a password too, instead of 401,
  and still spends no try. The download page uses it to notice, once a minute and when it comes back into view, that
  the sender lifted a pause early.
- **Upload page:** a file dropped or pasted while a dialog is open is no longer chosen behind it; after Cancel or a
  failure a folder's card comes back as it was; with encryption on, a folder too large to encrypt is refused before
  its files are read; a changed folder for an unfinished folder upload says it can't be resumed; the clipboard
  fallback gives focus back to the button; menus close on Tab and on scroll, and skip their scale under reduced motion.
- **Download page:** a paused password page focuses the reason, an encrypted link without a key focuses the key
  field, and a one-time link's button says "Download again (only if it broke)" once its download started.
- **Sizes and counts** keep their number and unit on one line in every language; French writes Ko, Mo and Go.
- **Operators:** the operator's Access identities are the Worker secret `ADMIN_EMAILS` instead of a var; set it with
  `npx wrangler secret put ADMIN_EMAILS` right after deploying this release
  ([order](docs/OPERATIONS.md#secrets-and-rotation)). The hourly monitor's GitHub Actions log names only the checks that
  failed; `npm run monitor` run locally shows the details.
- **The operator API answers on the admin host only:** `https://fyl.at/api/admin/*` now answers 404; use
  `https://admin.fyl.at` (the default of `npm run admin`).

### Dependencies

- The CLI uses the current generation of its crypto libraries, together, so that only one version of each shared
  building block is compiled in: `chacha20poly1305` 0.11, `x25519-dalek` 3 (with `curve25519-dalek` 5), `hkdf` 0.13,
  `hmac` 0.13, `sha2` 0.11 and `md-5` 0.11; the test-only `miniz_oxide` moves to 0.9. The CLI encrypts, decrypts,
  hashes and zips byte for byte as before (the shared vectors in `tests/vectors/` pass unchanged). Building it needs
  Rust 1.88 or later; the release binaries are built with the pinned 1.99.1.

### Before 1.0.0

fyl.at was developed privately and ran in production from release 2.0.0 to 2.5.1 before its source was published.
Those version numbers are never used again. An installed fyl 2.x moves to the new numbering like this: fyl 2.5.0
compares versions by number and would take 1.0.0 for an older one, so `/cli/version.json` offers it 2.5.1 first, a
build of the 1.0.0 source that takes 1.0.0 and every later release as newer. Run `fyl update` twice (2.5.0 → 2.5.1 →
1.0.0). A fyl before 2.5.0 has no `fyl update` and installs again with `curl -fsSL https://fyl.at/cli/install | sh`.

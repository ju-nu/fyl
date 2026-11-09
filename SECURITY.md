# Security

fyl.at is anonymous, temporary file sharing: https://fyl.at, its report form on https://report.fyl.at, the operator's
host https://admin.fyl.at and the `fyl` command-line client. Customers do not create accounts. This file says how to
report a vulnerability, where abuse reports go, how the service protects files, links and keys, and what it doesn't
protect against.

## Reporting a vulnerability

Report a vulnerability privately, in either of two ways:

- **E-mail** `security@fyl.at`.
- **GitHub private vulnerability reporting** on the source repository:
  [Report a vulnerability](https://github.com/ju-nu/fyl-at/security/advisories/new).

Please don't open a public issue or pull request for a vulnerability. Include:

- what is affected (a URL path, an API route, a CLI command and its version from `fyl --version`, or a file in this
  repository at a commit),
- the steps to reproduce it, with the requests or commands you sent and what you got back,
- what an attacker gains, and anything you know about who is exposed.

Never put a working management link, upload key, resume command (`fyl … --resume`), download password, encryption
key (the part of a link after `#`), grant URL or any credential into a report, an issue or a public post: describe it,
or send a link that you have deleted. Test only with files and links you created yourself, keep uploads small, and
stop and tell us if you reach data that isn't yours. A person reads every report and answers from the same channel;
fixes are released like any change ([CHANGELOG.md](CHANGELOG.md)) and credited if you wish.

**In scope:** fyl.at, report.fyl.at, admin.fyl.at (including its Cloudflare Access setup as seen from outside), the
`fyl` CLI and its installer (`https://fyl.at/cli/install`), and the code in this repository. **Out of scope:**
Cloudflare's own platform (report those to Cloudflare), volumetric denial of service, findings that need a compromised
device of the sender or recipient, and copies of this code that others run on their own accounts.

`https://fyl.at/.well-known/security.txt` names the same contact.

## Abuse reports

An abusive or illegal file is not a vulnerability: report it with the site's
[report form](https://report.fyl.at/) ("Report this file" on every download page, "Report a file" in every footer),
not by e-mail or on GitHub. A person reviews every report; while a report is reviewed the file can be quarantined,
which blocks every download. Reports of child sexual abuse material need no name or e-mail. The form refuses
encryption keys in its fields; never send one.

A report stores the transfer id (never the link as entered, which may contain a grant), the category, the details,
the reporter's name and e-mail if given, that day's keyed hash of the reporter's network, and the operator's decisions
with their reasons. Closed cases are deleted with their history 183 days after closing; an open case on a file that is
gone closes by itself at the latest about 8 days after it was filed. A network may file 50 reports a day.

The report form checks with Cloudflare Turnstile that a person sends it; uploads, downloads and the CLI never ask for
it. The Worker sends the token, the reporter's IP address and its secret to Cloudflare's siteverify, accepts only a
token solved on the form's host, `report.fyl.at`, for the action `report` within the last 5 minutes, and stores neither
token nor address. It fails closed: when siteverify can't be reached or gives no readable answer, the report is
refused with 503 rather than taken unchecked. The form has its own origin, `https://report.fyl.at/` (`fyl.at/report`
forwards there with its `?link=`), which serves only the form, its files and `POST /api/reports`, so Turnstile's script
never runs on fyl.at's origin and can't read what the browser keeps there, such as encryption keys in session or local
storage. The report links on the upload and download pages open the form in a new tab without an opener.

## Security design

### Downloads

Downloads are bearer links: anyone with a link can retrieve an available file, unless the sender also set a password.
A separate private key controls deletion and expiry. Upload keys are read only from the `Authorization` header or a
JSON body: a key in a URL authorises nothing. The Worker checks access on every request; R2 has no public bucket
endpoint. Browsers opening a link get a download page first (never cached or indexed); its warning for files that can
run code goes by the extension and is no malware scan. Files are not malware-scanned.

File responses are attachments with `application/octet-stream`, `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'none'; sandbox` (a browser that renders one anyway runs nothing of it) and
`Cross-Origin-Resource-Policy: same-origin`. Other sites can't embed a file: a browser request from another site that
loads a link as an image, video, frame, script, style, font or fetch gets 403 `hotlink`, and another site's navigation
to a direct file address gets the download page instead. curl, wget and the CLI are not affected. Link-preview bots get
the download page, never the file; for images up to 8 MB that aren't protected or one-time they get the picture,
inline with the same sandbox policy and only after its first bytes prove it a PNG, JPEG, GIF, WebP or AVIF (never SVG).
A chat app's copy of a previewed picture can outlive the link. The User-Agent never grants access. Bidi controls are
dropped from filenames, and filenames with control characters, line separators or lone surrogates are refused, so a
name can't disguise its extension.

Every page's Content-Security-Policy, set by the Worker, allows scripts and workers only from fyl's own script paths
(never `'self'`, which would admit scripts Cloudflare injects under `/cdn-cgi/`); the report form is the only page that
allows another origin, `https://challenges.cloudflare.com`, for Turnstile's script and frame.

### End-to-end encryption

A sender can encrypt a file on their device before the upload (the upload page's Encryption option, `fyl --encrypt`).
The file becomes an [age](https://age-encryption.org/v1) file for a fresh X25519 key, and the key is the part of the
link after `#` (`https://fyl.at/d/<id>#<key>`), which browsers never send to fyl.at. The service stores the
ciphertext, a generic name, the exact size, two encrypted headers and each part's MD5, never the name, the contents or
the key; recipients decrypt in the download page or with `fyl download`, and `fyl decrypt` or `age -d` opens a
downloaded `.age` file. Anyone with the full link can open the file, and a lost key can't be recovered. The normative
design and threat model are in [docs/E2EE.md](docs/E2EE.md).

- **What it doesn't hide:** the exact size, the times, the networks and the download counts, as for any file. A link
  with its key reaches whatever carries it (messengers, mail link rewriters, browser history and sync); sending the
  link without the key and the key another way avoids that.
- **Trust in served code:** in the browser, encryption relies on the code fyl.at serves. Pages allow scripts only from
  fyl's own paths, that code revalidates on every load and the download service worker never sees the key, but a
  compromised deployment could still serve code that sends keys elsewhere. The source is public, so the served code
  can be checked against it: the deploy ships the E2EE code (`dist/e2ee/`), the download page's script, its service
  worker and the vendored libraries byte for byte, strips only whitespace and comments from the site's other scripts
  and stylesheets, and checks right after each deploy that the live site serves exactly the bytes of `dist/`
  (`scripts/smoke.py --pages`, [kept as written](docs/OPERATIONS.md#kept-as-written)). Anyone can fetch those files and
  compare them with `dist/` at the release's tag. Whoever needs protection from the operator uses the CLI on both ends:
  a fixed, versioned build (`/cli/<version>/` never changes) instead of code loaded on every visit, reproducible from
  the public source. Its binary and `SHA256SUMS` come from fyl.at; the GitHub release `v<version>` carries the same
  checksums from a second origin, so a changed binary on one of them shows.
- **Keys in the browser:** a sender's keys stay in the tab's session storage, in local storage only with "Remember
  keys on this device"; a recipient's typed key that verified stays in that tab's session storage. The download page
  reads the key from the address once, drops any path segment or query, sends no Referer, keeps the decrypted name out
  of the title, and marks every element that shows the key or the name `translate="no"`, so a browser's translation
  service doesn't receive them.
- **No downgrade:** a link with a key never yields an unencrypted file, the key is checked against the file's headers
  before anything is downloaded (a one-time link is not used up by a wrong key), and a resumed upload can't send other
  bytes under the same nonces: each part's MD5 is pinned on the server before its body is sent.
- **Passwords with encryption:** a password still only controls access; the encrypted headers of a protected transfer
  are released only to its sender or with the right password, with tries counted as for raw links.
- **Abuse:** nobody can scan encrypted files. Every encrypted page warns that fyl.at can't check them, the program
  warning covers pages, shortcuts and scripts as well, and reports work by transfer id; the report form and API refuse
  a key in the details, the name or the e-mail. The operator judges such reports on plausibility and may quarantine
  ([operations](docs/OPERATIONS.md#end-to-end-encryption)).

### Passwords

A download password is access control, not encryption: R2 stores the file as uploaded, and anyone with the link and
the password can download it. The server keeps only a PBKDF2-HMAC-SHA-256 hash of the NFC-normalised password (100,000
iterations, 16-byte random salt), compares it in constant time, and never stores or logs the password; cleanup deletes
the hash. Tries are counted in the transfer's Durable Object per network (a keyed hash of the IPv4 address or IPv6 /56
for this transfer), so concurrent tries can't get past the count: 5 wrong ones in a row pause that network for 15
minutes, and 50 wrong ones from all networks within 15 minutes pause the whole transfer for 15 minutes, during which
every try is refused, except from the address holding a one-time link's download session (it gave the password or a
grant when the session opened; an IPv4 address or IPv6 /64), which only its own network's pause refuses. No pause
closes a download in progress. The sender can lift every pause from the management view, which counts as no try.
Generated passphrases have about 30 bits; a short typed password is weaker.

A protected link carries no file name, and the name stays out of the download page, the chat preview tags and the
public metadata until the password was given. Browsers unlock on the download page through a same-origin form (a
cross-origin `Origin` or a `Sec-Fetch-Site` other than `same-origin` is refused, and `Origin: null` only passes with
`Sec-Fetch-Site: same-origin`) and get a grant URL, signed with the `GRANT_SIGNING_KEY` secret and valid for one hour,
that downloads without the password; anyone given that URL within the hour can use it too. Page responses never send
`WWW-Authenticate`. curl and other tools send the password with HTTP Basic Auth on every request, protected in transit
by HTTPS. Send the password through another channel than the link.

### Deletion, links and browser storage

Deletion and expiry block new reads; an existing response can finish and downloaded bytes can't be recalled. A
one-time link allows one download session from one network, which is no guarantee that the intended recipient received
the file: browsers and known preview bots get a page first, but a scanner that follows its Download button can still
use up the download ([rules](docs/CLI-API.md#one-time-download-sessions)). Keep management links private, and the
resume command the CLI prints after an interruption too: it carries a [resume token](docs/CLI-API.md#resume-token),
which can't delete the finished file or change its expiry, or with `--manage` the management key itself. The CLI
prints that command as `echo … | fyl … --resume -`, and `fyl rm -` reads a management link the same way, so neither
credential appears in the process list.

The website keeps recent uploads with their management links in the browser's local storage (up to 20, each until
forgotten or a day after its link expires) and an interrupted upload with its key, but without its password, until it
finishes, is discarded or its 24-hour window ends. Download passwords and encryption keys stay in the tab's session
storage unless the sender ticks "Remember the password on this device" or "Remember keys on this device"; an
interrupted encrypted upload keeps each part's MD5, never its key. "Forget this device" clears all of it. Anyone with
access to that browser profile can use what it keeps.

Cleanup deletes the file and clears the stored filename, password hash and tries, one-time session and multipart
details. A minimal closed record without the filename stays for 7 days after cleanup, then the transfer's storage is
dropped completely; a takedown keeps its minimal record for good, so its link and id stay blocked. Cloudflare keeps
request logs (10 % sample, query strings redacted; a path can contain a file's link and name) under its own retention.
The [privacy page](https://fyl.at/en/privacy) lists what is stored and for how long.

### Secrets and operator access

Worker secrets, each at least 32 characters (a shorter one counts as missing, except as noted for
`NETWORK_HASH_KEY`) and generated with `openssl rand -base64 48`, except `TURNSTILE_SECRET`, which Cloudflare issues,
and `ADMIN_EMAILS`, a list of addresses:

- `NETWORK_HASH_KEY` keys the HMAC of client networks for budgets, one-time sessions, password tries and reports, so
  stored hashes can't be turned back into addresses. Without any value, requests that need a network hash answer 503
  `misconfigured`.
- `GRANT_SIGNING_KEY` signs download grants and the password part of upload fingerprints. There is no fallback key:
  without it no grant is issued or accepted and password uploads are refused. While it is rotated,
  `GRANT_SIGNING_KEY_PREVIOUS` passes only grants that expire within an hour of `GRANT_SIGNING_KEY_ROTATED_AT`, so a
  leaked previous key mints nothing usable afterwards.
- `ADMIN_TOKEN` enables the operator routes (pause, takedown, quarantine, reports); without it they don't exist (404).
  It is compared as a hash in constant time.
- `MONITOR_TOKEN` is read-only: it opens `GET /api/admin/ready` and, on the admin host behind Access,
  `GET /api/billing` (the hourly monitor's cost alert), nothing else.
- `ADMIN_EMAILS` names the Access identities that read the dashboard's data without the operator token; without it no
  identity does.
- `TURNSTILE_SECRET` is the secret key of the report form's Turnstile widget. Together with the public site key in
  `wrangler.jsonc` it turns the check on; without it the form works unchecked.
- `CF_ANALYTICS_TOKEN` (optional) is a read-only Cloudflare API token with Account Analytics Read only, for the admin
  host's statistics and its billing estimate; it can't change anything.

The operator's host `admin.fyl.at` is behind Cloudflare Access: one operator identity signs in with a one-time PIN,
and the operator scripts use a service token. The Worker verifies Access's signed token on every request to that host
(RS256 against the team's published keys, audience, issuer and expiry), so a missing or loosened Access policy still
serves nothing there. The dashboard is served only on that host and holds no token: the operator's identity reads
aggregates, readiness and a report queue without reporter details, and every change still needs `ADMIN_TOKEN`. The
public host answers 404 for the dashboard's paths.

Client addresses are never stored: networks (an IPv4 address, an IPv6 /56 for budgets, password tries and reports, an
IPv6 /64 for one-time sessions) are kept only as those HMACs. The `fyl_events` counters record only event names, codes
and numbers, never addresses, network hashes, transfer ids, keys or file names; page views add only coarse fields and
no cookie, script or identifier, so nothing in them recognises a visitor or connects two visits
([METRICS.md](docs/METRICS.md)). The operator routes have their own rate limit, and `npm run admin` sends the token and
the Access service token only over HTTPS (plain HTTP only to loopback), never follows a redirect, and accepts only an
exact transfer id or download link. A takedown is final: the sender can't relabel it, and its id can never take a new
upload.

### Source, builds and deploys

No credential is in this repository: secrets live in Cloudflare and in GitHub repository secrets, local `.dev.vars`,
`.env*` (except `.env.example`, which lists names only) and `.wrangler/` are ignored, and `Checks` runs gitleaks over
the tree and every change's commits (and the whole history weekly). Production deploys come only from the
`production` branch, which the Deploy gate moves after `Checks` passed, using a fine-grained token limited to this
repository; previews never get production storage. Actions are pinned to immutable commits, which Dependabot updates
through reviewed pull requests; release publishing runs only for the commit production has. The CLI binaries are
rebuilt and compared byte for byte in CI. Secret rotation, emergency takedown and operational limits are in
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## Known limitations

- **Browser encryption trusts the served code.** A compromised deployment could serve code that sends keys elsewhere;
  the byte check and the public source make that visible, they don't prevent it. The CLI on both ends avoids it.
- **Checksums are not signed out of band.** The installer and `fyl update` check the binary against `SHA256SUMS` from
  fyl.at; the GitHub release is a second copy to compare with, but nothing carries a signature yet.
- **No independent cryptographic review** of the E2EE profile and its two implementations has been done; both
  interoperate with the reference `age` 1.1.1 and 1.2.1 and pass the C2SP CCTV vectors.
- **Encrypted downloads in browsers other than Chromium** decrypt in memory, up to 256 MB, until the browser matrix of
  [E2EE.md §9.4](docs/E2EE.md#94-limits) is measured.
- **No malware scanning.** Raw files are stored as sent; encrypted ones can't be scanned at all.
- **Password pauses can be repeated** by a distributed guesser (50 wrong tries from anywhere pause the link for 15
  minutes); the sender can lift them.
- **HSTS** runs six months without `includeSubDomains` or preload.
- The macOS binaries are signed ad hoc, not notarised: a browser-downloaded binary is blocked by Gatekeeper.
- Further accepted trade-offs of the design are listed in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#known-limitations).

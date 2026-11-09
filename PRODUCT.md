# fyl.at product

## Promise

Fyl for now. Upload once, choose 5 minutes to 7 days, and share a link without registering, even before the upload has finished. Browser and terminal use the same service. A file can allow repeated downloads until expiry or one download attempt, can require a password, and can be end-to-end encrypted on the sender's device, so fyl.at stores only ciphertext. The sender gets a separate private link for changing expiry, lifting a password pause or deleting immediately.

## How it is built

One Cloudflare Worker with SQLite Durable Objects for each transfer, the upload budget and the report cases, a private
R2 bucket for file bytes and Workers Static Assets for the site and the CLI downloads. Every download checks
authoritative state; nothing bypasses the Worker. The details, the limits with their code locations and the accepted
trade-offs are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Experience

The upload area opens the native picker on click, Enter or Space, and accepts a single dropped or pasted file (paste anywhere on the page outside a field; an unnamed pasted image is named from the time). File selection and expiry survive an upload error or cancel. Pressing *Upload and get link* turns the button into the link, one address line with its own copy button, with *Copy link* (its arrow opens other ways to copy), Share, a QR code and a "Ready in …" estimate, so it can be sent while the file uploads (until the link exists, quiet placeholders hold its place, so nothing jumps when it arrives); one lifetime line shows the progress, turns green when the file is ready, then shows the time left. An upload that loses the network waits in place and continues when the connection is back.

Opened in a browser (or by a known preview bot), every link shows a download page with the file's name, size, type, expiry and a Download button, a warning for files that can run code, the matching `curl` command and "Report this file"; curl, wget and the CLI get the file immediately with attachment filename headers ([rules](docs/CLI-API.md#download-pages)). A recipient who opens the link early sees the upload's progress, and the download starts by itself when the file is ready; `curl --retry` waits for it. Posted in a chat app, a link shows the file's name, size and expiry, and a picture up to 8 MB that may be downloaded more than once shows the picture itself; password-protected and encrypted links show nothing about the file ([previews](docs/CLI-API.md#link-previews)).

Under *Options*, *One download*, *Password* and *Encryption* are one row of toggles; each one that is on opens its short section in one block below, and with none on a single line says that anyone with the link can download it until it expires. The *Password* option offers a generated passphrase the sender can replace; the receipt shows it with Copy and a reminder to send it separately. Recipients type it on the page (curl uses `-u fyl`), the link carries no file name, and 5 wrong tries pause that recipient's network for 15 minutes (50 wrong tries from anywhere pause the link); the sender can lift a pause with "Lift pause". A password controls access; it doesn't encrypt. The password stays in the sender's tab unless they tick "Remember the password on this device".

The *Encryption* option (end-to-end encryption, offered to everyone, off by default; its note links *Why?* to the privacy page) encrypts the file in the browser before the upload; the key is the part of the link after `#`, which browsers don't send to fyl.at. *Copy link* copies the link with the key; a quiet line "Even safer: send the key separately" opens the link without the key and the key, each with a copy button, and the copy menu also has the key alone and `fyl download` with and without the key (the terminal companion shows it without, so `fyl download` asks for the key). The page warns before the tab closes until something with the key was copied or shared. Recipients' download page checks the key against the file's encrypted headers before it downloads anything, shows the name only after that, and decrypts and verifies the file in the browser (streamed in Chromium, from memory up to 256 MB elsewhere until the browser matrix is measured). Without the key in the link it asks for it. fyl.at can't check encrypted files, and the page says so ([E2EE](docs/E2EE.md)).

Private controls are visually separated. Download links work in another browser or tab; management links work after reload. An interrupted upload resumes when the same file is chosen again, also after the tab was closed, and only one tab continues it. Recent uploads with their management links are kept in the browser (up to 20, each until forgotten or a day after its link expires), refresh once the page is idle, show "Under review" while a report is checked, and can be forgotten one by one or with "Forget this device".

The `fyl` CLI is a native Rust binary for macOS and Linux (x86_64, arm64). It supports `fyl FILE --expires 3d --once --password --encrypt` (passwords asked without echo, generated on Enter, or `FYL_PASSWORD`), downloads and decrypts with `fyl download LINK` (asking for a missing key, or `FYL_KEY`), opens a saved `.age` file with `fyl decrypt`, prints only the download link (`--manage` adds the management link, `--json` prints one JSON object), prints a command to resume an interrupted upload, deletes with `fyl rm LINK` (also a file under review or an unfinished upload), keeps no settings or state on disk, and gives plain-language guidance with distinct exit codes ([CLI](docs/CLI.md)). The one-line installer (`curl -fsSL https://fyl.at/cli/install | sh`) needs only curl, verifies the published checksums and installs `/usr/local/bin/fyl` without editing shell profiles. No browser verification, account or Turnstile is required for CLI upload or download.

## Abuse handling

fyl.at handles reports itself. The report form (on its own host `https://report.fyl.at/`, so Turnstile's script never runs where the upload page keeps keys; `/report`, linked from every download page and footer, forwards there) takes the link, a category, details, contact details (optional for child sexual abuse material) and a good-faith statement, checks with Cloudflare Turnstile that a person sends it (this form only, never uploads or downloads), and returns a case number. A person reviews every case; nothing is removed automatically. The operator can quarantine a file while reviewing it (nobody can download it, the sender can still delete it), restore it, take it down for good or reject the report, and every decision records its reason. Cases are kept until 183 days after they close. Per-network caps (250 GB uploaded a day, 50 running uploads, 250 GB stored at once) keep one network from filling the service, and an hourly monitor mails the operator when reports wait, cleanups are overdue, storage or daily volume reach 60 %, or the estimated Cloudflare bill of the billing cycle reaches its alert ($15 unless set otherwise). The privacy page (`/privacy`) states what is stored and for how long.

## Limits and operation

The limits (50 GB per file, budgets per network and for the whole service, rate limits) are settings in
`wrangler.jsonc` and constants in code, listed in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#limits-and-retention);
review them against real usage and billing. Keep Cloudflare's managed WAF and DDoS protection and the route-specific
CLI compatibility rules, and never authenticate by User-Agent. Deploys, secrets and incidents are in
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## Not in the product

No accounts or customer registration, no tracking, no malware scanning of uploads (the service forces attachment
downloads and limits resource use instead), and one file per link: a folder goes as one zip
([docs/FOLDER-ZIP.md](docs/FOLDER-ZIP.md)). Larger files, longer lifetimes or paid limits come only after measured
usage. Open work on encryption (the measured browser matrix of docs/E2EE.md §9.4, an independent cryptographic review)
is in [SECURITY.md](SECURITY.md#known-limitations).

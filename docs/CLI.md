# The fyl CLI

`fyl` uploads a file to fyl.at and prints its download link. It is a native binary for macOS and Linux and keeps no settings on your computer; the only thing it stores is the time of its last [update check](#update-notice). The HTTP protocol behind it is in [CLI-API.md](CLI-API.md).

## Install and update

```bash
curl -fsSL https://fyl.at/cli/install | sh
```

The installer reads the current version from `/cli/latest`, downloads the binary for your system (macOS 11+ or Linux, x86_64 or arm64; Linux builds are static) and `SHA256SUMS` from `/cli/<version>/`, checks the checksum and that the binary reports that version, and installs it as `/usr/local/bin/fyl`. It asks for `sudo` only if that folder isn't writable and never edits your shell profile. Run the same command again to update, or `fyl update`; `FYL_INSTALL_DIR` installs somewhere else. Other CPUs are not supported.

`fyl update` reads `/cli/version.json`, downloads the binary it names for this system from `/cli/<version>/`, and checks it against the SHA-256 in `version.json` and in that release's `SHA256SUMS`, which must agree, and that it runs and reports that version. Only then does it replace the running binary (the file a symlink to it points at): written next to it, synced, and moved over it in one rename, so a failure or a crash leaves the old one in place. It prints `Updated fyl 1.0.0 to 1.1.0: /usr/local/bin/fyl`. A folder you can't write to gets `Run sudo fyl update, or install again: curl -fsSL https://fyl.at/cli/install | sh`. It says `already up to date` for the version it is and refuses an older one, unless `--force`; `fyl update --check` only says whether a newer version exists. The checksums come from the same server as the binary, as for the installer: they catch a broken download, not a compromised server.

Files under `/cli/<version>/` never change; `/cli/latest` and `/cli/version.json` name the current version. Installers before 2.3.0 fetch `/cli/fyl-<os>-<arch>` and `/cli/SHA256SUMS`, which redirect to the current version, so they keep working. The same binaries and `SHA256SUMS` are attached to the GitHub release `v<version>` of the [source repository](https://github.com/ju-nu/fyl-at/releases), a second place to compare the checksums with.

**From a fyl 2.x.** The public release started the version numbers over at 1.0.0; fyl counted 2.0.0 to 2.5.1 before. fyl 2.5.0 would take 1.0.0 for an older version, so it is offered 2.5.1 first, which takes 1.0.0 and every later release as newer: run `fyl update` twice (2.5.0 → 2.5.1 → current). A fyl of the new numbering, the other way round, takes any 2.x as older and does not go back to it without `--force`. A fyl before 2.5.0 has no `fyl update`; install again with `curl -fsSL https://fyl.at/cli/install | sh`. `fyl --version` shows which one you have.

### Update notice

At most once a day, after a command that succeeded (not `fyl decrypt`, which works offline, and not `fyl update`), fyl asks `/cli/version.json` (of the server it talks to, so `--endpoint` and `FYL_API_URL` apply) whether a newer version exists, waiting at most 2 seconds, and if so prints one line on stderr: `fyl 1.1.0 is available: run fyl update`. Nothing goes to stdout, a failing check changes nothing, and the request carries nothing but fyl's User-Agent. It runs only when stderr is a terminal, and never with `FYL_NO_UPDATE_CHECK=1` (any value but empty or `0`) or when `CI` is set. The time of the check goes into `update-check` in fyl's cache folder (`$XDG_CACHE_HOME/fyl`, else `~/Library/Caches/fyl` on macOS and `~/.cache/fyl` elsewhere), which holds only that Unix time.

The macOS binaries are signed ad hoc, not notarized: installed with curl they run directly, but a binary downloaded with a browser (for example from GitHub Releases) is blocked by Gatekeeper until you run `xattr -d com.apple.quarantine ./fyl-macos-arm64`.

The installer is plain POSIX `sh`. `tests/test_installer.py` checks it on the host with a fake `curl`, and `scripts/mac-check.sh` runs the real `curl … | sh` install on a Mac.

## Examples

```bash
fyl ./archive.zip                          # link expires after 1 day
fyl './holiday photos.zip' --expires 3d    # 5m … 7d
fyl ./secret.txt --expires 1h --once       # one download only
fyl ./archive.zip --password               # ask for a password (Enter generates one)
FYL_PASSWORD="$pw" fyl ./archive.zip --password # the same, without asking (scripts)
fyl ./archive.zip --encrypt                # encrypt on this device; the key is the part after #
fyl './holiday photos'                     # a folder, as one zip: holiday photos.zip
fyl download 'https://fyl.at/d/<id>#<key>' # download (and decrypt) into this folder
fyl decrypt fyl-<id>.age                   # open an encrypted file saved with curl ('…?dl=1')
fyl ./archive.zip --manage                 # also print the private management link
fyl ./archive.zip --json                   # the link and its details as one JSON object
fyl rm 'https://fyl.at/#manage/<id>/<key>' # delete it
url="$(fyl ./archive.zip)"                 # stdout is only the link
curl -fOJ "$url"                           # download with the original filename
curl -fOJ -u fyl "$url"                    # a protected link: curl asks for the password
curl -fOJ --retry 120 "$url"               # a link still uploading: wait until it's ready
```

## Options

| Command / option | Meaning |
| --- | --- |
| `fyl FILE` | Upload and print the download link |
| `fyl FOLDER` | Upload a folder as one zip, `<folder>.zip` ([folders](#folders)); takes the same options |
| `--expires 30m\|12h\|3d` | Link lifetime, 5 minutes to 7 days (default `1d`) |
| `--once` | Allow a single download |
| `--password` | Require a password to download: typed twice without echo, Enter generates one, `FYL_PASSWORD` for scripts |
| `--encrypt` | Encrypt the file on this device before the upload ([end-to-end encryption](#end-to-end-encryption)) |
| `-m`, `--manage` | Also print the private management link |
| `-v`, `--verbose` | Show progress and the expiry time on stderr |
| `-q`, `--quiet` | Print only the link (the default) |
| `--json` | Print one JSON object instead of the links |
| `--workers 1-8` | Parallel part uploads (default 4) |
| `--resume ID.TOKEN` | Continue an interrupted upload of the same file or folder (`-` reads the value from stdin) |
| `fyl download LINK [-o PATH]` | Download a file into this folder under its own name (`-o FOLDER`, or `-o FILE` for another name) and print its path; encrypted files are decrypted and verified first. `-` reads the link from stdin |
| `fyl decrypt FILE.age [-o PATH]` | Decrypt an encrypted file downloaded with curl; asks for the key (`FYL_KEY` for scripts) |
| `fyl rm LINK` | Delete an upload with its management link (alias `fyl delete`; `-` reads the link from stdin) |
| `fyl update [--check] [--force]` | Install the current version for this system ([install and update](#install-and-update)) |
| `--version`, `--help` | Version and full help |

Switches take no value (`--once=false` is an error). One file or folder per upload; put several files in a folder first. For development, `FYL_API_URL` (or the hidden `-e`/`--endpoint`) points at another upload endpoint (`<origin>/api/upload`, as `https://fyl.at/api/upload`); it must be HTTPS, except plain HTTP on `localhost`, `127.0.0.1` or `::1`. `FYL_UA_SUFFIX` appends a plain token of up to 40 characters (`A-Z a-z 0-9 . _ / -`) to the User-Agent `fyl-cli/<version>`, anything else is ignored: fyl's own checks set `fyl-smoke`, so the statistics count their transfers as fyl's own ([AGENTS.md](../AGENTS.md)); it changes nothing the server allows.

## Output and exit codes

`fyl` prints exactly one line, the download link. With `--manage` it prints a second line, the private management link, which is the only way to delete the file or change its expiry later:

```text
$ fyl ./archive.zip --expires 1h --once --manage
https://fyl.at/d/<id>/archive.zip
https://fyl.at/#manage/<id>/<key>
```

With `--json` it prints one line of JSON instead: `url`, `name`, `size` (bytes), `expiresAt` (RFC 3339, UTC) and `once`; `managementUrl` only with `--manage`; `protected: true` only for a password upload (also a resumed one), `password` only when fyl generated it, and `encrypted: true` only with `--encrypt`, whose `url` is the link with the key and whose `name` and `size` are the file's own, not the stored ones. A folder adds `folder: {files, skipped}`, with `name` `<folder>.zip` and `size` the zip's. fyl prints the server's links only as plain printable `https` links (`http` only on loopback), the management link only in the form `fyl rm` takes; a receipt with any other link prints none and exits 1 ("The server sent a link that isn't a plain https link, so fyl shows none."); the upload is complete then. Error texts from the server have control characters removed.

```text
$ fyl ./archive.zip --json
{"expiresAt":"2026-10-29T14:05:00Z","name":"archive.zip","once":false,"size":1048576,"url":"https://fyl.at/d/<id>/archive.zip"}
```

Running `fyl` without a file prints a short usage hint. Mistakes produce a short `fyl: …` message on stderr; argument mistakes add a `Try:` line.

| Exit code | When |
| --- | --- |
| 0 | Done |
| 1 | A failure: the service refused the upload or deletion, a network problem persisted, or an upload was interrupted (it then prints the resume command) |
| 2 | A mistake in the command, its file (missing, empty, larger than 50 GB) or a malformed link or resume value; a folder refused as a whole or one that changed or couldn't be read while fyl prepared it, or changed since an interrupted upload ([folders](#folders)); also `--password` without a terminal or `FYL_PASSWORD` |
| 74 | Standard output is full or closed: the links are written to stderr instead. Also when stderr can't show a generated password; fyl then stops before anything is sent, so no file is protected by a password nobody saw |
| 128 + signal | Stopped by a signal before an upload existed (130 for Ctrl+C, also at the password prompt); once an upload exists, Ctrl+C keeps it and exits 1 with the resume command |

## Passwords

`--password` asks for the password twice on the terminal (`/dev/tty`) without showing it. Press Enter instead to have fyl generate one (three words and two digits, such as `tide-lamp-moss-41`); it prints `Password: <passphrase>` on stderr, also without `--verbose`. A password you type is never printed. In scripts, `FYL_PASSWORD` sets it (only together with `--password`). fyl refuses control characters before anything is sent and leaves the length to the service, which counts 6 to 200 characters after Unicode normalisation; a password it refuses ends the run before any part is sent. Against a server without password support (before 2.2.0) fyl cancels the upload before any part.

The link of a protected upload has no file name: `https://fyl.at/d/<id>`. Recipients type the password on the download page, or let curl ask for it with `curl -fOJ -u fyl "$url"`. Rules and limits: [CLI-API.md](CLI-API.md#passwords).

## End-to-end encryption

`--encrypt` encrypts the file as an [age](https://age-encryption.org/v1) file for a fresh key before anything is sent. The printed link is `https://fyl.at/d/<id>#<key>`: the key is the part after `#`, which browsers don't send to fyl.at, and fyl.at stores only the ciphertext, a generic name and the size. Anyone with the full link can open the file, and a lost key can't be recovered; to keep the key out of the channel that carries the link, send the link without it and the key another way. Recipients open the link in a browser, which decrypts in the page, or run `fyl download` with it. It combines with `--once`, `--password` and `--expires`. Details: [E2EE.md](E2EE.md).

`fyl download LINK` takes any fyl.at link. Without the key in the link it asks for it on the terminal (`FYL_KEY` for scripts), and a protected file asks for its password (`FYL_PASSWORD`). The key is checked against the file's encrypted headers before the download starts, so a wrong key uses up no one-time link; the file appears under its own name only once it is decrypted and verified. A command with the key lands in shell history: `fyl download -` with the link pasted at the terminal, or `pbpaste | fyl download -`, keeps it out of history and the process list. curl gets only the ciphertext (`curl -fOJ '<link>?dl=1'` saves `fyl-<id>.age`), which `fyl decrypt` or `age -d -i` opens.

## Folders

`fyl FOLDER` uploads a folder as one zip named `<folder>.zip`, which unzips to the folder itself (`fyl .` uses the current folder's name). The zip is built on this device by the rules of [FOLDER-ZIP.md](FOLDER-ZIP.md), the same as the website's, from the files themselves while the parts go out: nothing is written to disk, and the server sees one file like any other, so `--expires`, `--once`, `--password`, `--encrypt`, `--json` and `--resume` work as for a file. The files are stored as they are, not compressed, with their modification times (whole seconds, UTC); permissions are not kept (every file unzips as `rw-r--r--`). Hidden files are included. Symlinks (never followed), special files such as FIFOs, empty folders and names that are unsafe in a zip (not UTF-8, with control characters or `\`, only dots and spaces, longer than 255 bytes, or a path longer than 4095 bytes, and so a folder whose path leaves no room for a file) are left out, and fyl says so in one line on stderr (`fyl: Skipped 2 symlinks and 1 file with an unsafe name.`; `--verbose` lists each, escaped). Invisible direction marks are dropped from names, as for file names.

Before the upload starts, fyl reads every file once to compute its checksum, which goes into the zip ahead of the file's data; on a terminal it counts `Preparing folder… N/M files`. It reads every file folder by folder from the folder's own handle, so a deep folder under a long path works even where the whole path is longer than the system allows. It refuses the whole folder, before anything is sent, when it has no files to send, more than 100,000 files or folders, two items that would get the same name (two files, or a file and a folder, once invisible direction marks are dropped), or would make a zip larger than 50 GB (about 12.5 MB less with `--encrypt`). A file that changes or can't be read while the folder is prepared stops the run with its path (exit 2). Every part is checked against those checksums before the upload completes, so a file that changes during the upload stops it (exit 1, "A file in the folder changed while it was uploaded. Start a new upload.") instead of reaching the recipient as a damaged zip.

An interrupted folder upload prints the same resume command as a file, with the folder's fingerprint as the value's last field: `echo <id>.<token>.<F> | fyl './photos' --resume -`, and for an encrypted one `<id>.<token>.<key>.<F>` (or `<id>.<token>.<F>` with the key from `FYL_KEY` or the prompt). `F` changes when a file is added, removed, renamed (the folder too), resized or touched, and such a folder is refused at once: "The folder changed since this upload started. Start a new upload." (exit 2; the upload stays as it is).

## Interrupted uploads

If an upload is interrupted (network loss or server errors that retrying didn't fix, Ctrl+C, a file that changed or couldn't be read, a part that couldn't be verified, or a completion whose answer didn't arrive intact), fyl keeps it and prints the command to continue within 24 hours:

```text
fyl: Upload paused.
Resume within 24 hours with the command below. Keep it private: it can cancel the upload, but not delete the file.
  echo <id>.<token> | fyl './archive.zip' --resume -
```

The value is the upload id and its [resume token](CLI-API.md#resume-token), which can't delete the finished file or change its expiry; `echo` is a shell builtin, so piping it in keeps it out of the process list (`--resume <id>.<token>` works too). With `--manage` the command carries the private key instead (the note then says it can also delete the upload), so the resumed upload still prints the management link; a run resumed with the resume token can't, and says so. The command keeps `--manage`, `--json`, `--verbose`, `--workers` and `--endpoint`, and puts `./` before a file named like an option or `rm`. Keep it out of shared logs and chats either way. An encrypted upload prints `fyl './archive.zip' --resume - --encrypt` with the value `<id>.<token>.<key>.<mtime>` on its own line under it, to paste when fyl asks: it adds the file's key and modification time, so keep that line as private as the link with the key. A value without the key takes it from `FYL_KEY` or the prompt, and a file whose modification time changed since the upload started is refused ([E2EE.md](E2EE.md#84-resume)).

Resuming keeps the upload's expiry, download mode and password: an `--expires` or `--once` that differs is refused, and so is `--password` (leave it out; the resume needs no password). A different file name only warns; the link keeps the original name. A resume value that no longer works (the upload expired, was cancelled or deleted, or the value is mistyped) gets one message and exit 1. Errors that retrying can't fix, such as a part past its attempt limit, abort the upload.

Every part is verified against the MD5 that R2 reports as the part's ETag; a damaged part is sent once more, and a part that arrives damaged twice interrupts the upload. Resuming checks the parts already uploaded against your file and sends only what is missing or differs; an upload that already completed replays its completion. An ETag that is not an MD5 can't prove anything: fyl accepts it only from an API on this machine (`localhost`, `127.0.0.1`, `::1`, where `wrangler dev`'s R2 simulator sends such ETags). From any other server the part is sent once more, then the upload stops with "Part N could not be verified: <host> sent a checksum that is not an MD5" and keeps its resume command, and a resume sends such parts again.

Requests are retried by the shared [error classes](CLI-API.md#errors): network errors, 408, 429 and 5xx up to 3 attempts with growing pauses or the server's `Retry-After` (at most 60 s). A completion counts only with this upload's [receipt](CLI-API.md#receipt); an unclear answer is asked for again up to 5 times, then the upload's status decides, and if it stays unclear fyl prints the resume command, which gets the link.

## Deleting

`fyl rm LINK` reads the upload with its management link, then deletes it and prints `Deleted <name>.`; GET and DELETE are retried like upload requests. A file under review after a report can still be deleted by its sender ("Deleted the file."; the name stays hidden), and so can an upload that is still running ("Deleted the unfinished upload of <name>."). A link that is not valid for the upload, an upload that is already gone, or a deletion the service refuses gets a short message and exit 1.

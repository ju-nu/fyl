# fyl.at end-to-end encryption (E2EE), profile `fyl-e2ee-1`

Status: normative since 2.4.0, a release of the numbering before 1.0.0 ([version
scheme](ARCHITECTURE.md#version-scheme)); version numbers in this document are of that numbering, and every release
from 1.0.0 implements it. E2EE is on for everyone: `E2EE_ENABLED` is `"true"` in
production and stays only as an emergency switch ([§17](#17-release-gating)); there is no pilot and no "Preview"
labelling. MUST/SHOULD/MAY are used as in RFC 2119/8174. It builds on 2.3.0 (part slots, retry classes, grants,
per-network password tries, quarantine, validated receipts). Raw transfers are unchanged, protected raw links included
([§2.1](#21-raw-links-unchanged-in-240)), except for the CLI's saved names ([§10](#10-cli-download) step 6).

Notation: `||` concatenation; `b64` standard base64 without padding (what age uses), `b64url` URL-safe base64 without
padding (RFC 4648 §5). Both are canonical: decoders reject padding, other characters and non-zero trailing bits (for
32 bytes in 43 characters the last character's value is a multiple of 4). MiB/GiB are binary. Offsets are 0-based,
chunk indices 0-based, part numbers 1-based. Constants: `H = 184` (head), `CHUNK = 65536`, `S = 65552` (chunk with
tag), `PART = 52428800`. `P` is the plaintext size, `C` the stored (ciphertext) size.

## 1. Goals, non-goals, claims

Goals: file content and file name readable only by whoever has the full link (or the key), fyl.at storing and serving
ciphertext; optional per upload and fixed at init, raw staying the default with direct curl/wget downloads; one format
for the browser and the Rust CLI, interoperable both ways and decryptable with the standard `age` tool; fyl's
properties kept (50 MiB parts in parallel and any order, resume, early links, one-time links, passwords, quarantine,
bounded memory); wrong keys, truncation, extension, reordering and substitution detected, and partial output never
presented as complete.

Non-goals: hiding the size (the exact `P` follows from `C`), timing, access patterns, IP addresses seen at the edge or
the protected/one-time flags; protecting browser users from a fyl.at that serves malicious JavaScript
([§15.6](#156-compromised-javascript-delivery)); sender authentication, key recovery by the operator, recalling copies
already downloaded, password-wrapped keys (a separate mode with its own KDF and threat model); operator content review
of E2EE transfers (reports, quarantine and takedown still work by ID).

Claims. Product copy MUST stay within these:
- "Encrypted on your device before upload. The key is the part of the link after #, which browsers don't send to
  fyl.at. fyl.at stores the encrypted file, its size and when it is fetched, not its name or contents."
- "Anyone with the full link can open the file. Share it like the file itself. A lost key can't be recovered."
- On every E2EE page: "fyl.at can't check encrypted files or who sent them. Only open files you expected."
- In the E2EE help: "In the browser, this relies on the code fyl.at serves.", with a *Why?* link to the privacy page,
  which adds: "the fyl CLI runs a fixed, versioned build on your computer instead." and links the public source and the
  release checksums ([§15.6](#156-compromised-javascript-delivery)).
- Never: "zero-knowledge", "100 % secure", "anonymous", "fyl.at sees nothing", "keys are wiped".

## 2. Modes and links

| | Raw (default) | E2EE |
| --- | --- | --- |
| Share link | `https://fyl.at/d/ID/NAME` | `https://fyl.at/d/ID#KEY` |
| curl/wget | the file | with `?dl=1` the ciphertext (`fyl-<ID[0:8]>.age`), without it a `fyl download` hint |
| Decrypt | not needed | browser page, `fyl download`, `fyl decrypt` for a saved file (or `age -d`, [§3.2](#32-age-identity-string)) |
| Password | optional, independent | optional, independent ([§11](#11-passwords-and-e2ee)) |

### 2.1 Raw links (unchanged in 2.4.0)

A raw transfer's canonical link stays `/d/ID/NAME` for unprotected files and `/d/ID` for password-protected ones
(protected links keep carrying no name). NAME is the
server's existing link encoding (`encodeURIComponent` of the name, as in 2.3.0), so space, Unicode, `#`, `?` and `%`
survive. The segment is cosmetic: the ID selects the transfer, the saved name comes from Content-Disposition, and the
segment never becomes a storage key or path. Old `/d/ID` and `/d/ID/anything` links keep working. Before authentication
the server never returns a protected file's name: not in `GET /api/transfers/:id`, not in the page state, not in the 401
hint or headers. The locked page doesn't echo the URL's segment either, because a link can be crafted with any segment.

### 2.2 E2EE link

`https://fyl.at/d/ID#KEY`, KEY being 43 characters ([§3](#3-key-material-and-encodings)). The fragment holds nothing
else (no `k=`, no version). The path has no name or extension. The format version is in the authenticated age header.
Clients MUST NOT copy KEY into any request (URL, header, body), redirect, error report, metric, log, message or support
link. Browsers send no fragment in requests or in `Referer`, and the site sends `Referrer-Policy: no-referrer`. `/d/`
never redirects, so the fragment never crosses origins. QR codes are rendered locally and encode the link the copy
button copies.

Clients build every keyed link themselves as `<origin>/d/<ID>#KEY`: `<origin>` is the browser's `location.origin` or
the CLI's configured endpoint origin (`https://HOST[:PORT]`, HOST a DNS name or a bracketed IPv6 address; `http://` only
for `localhost`, `127.0.0.1` and `[::1]`), ID the transfer ID of the init response (`[A-Za-z0-9_-]+`). The
server's `url` (init, receipt, status) must equal `<origin>/d/<ID>` byte for byte; otherwise the client stops before
it shows, copies, encodes or stores any link (early link, receipt, link without key, QR code, `--json`, resume
output), and before any part if the init response mismatches. So neither a misconfigured `PUBLIC_BASE_URL` nor a
malicious server can put KEY on another origin or on plain http.

### 2.3 Link without key

`https://fyl.at/d/ID`. The server marks the transfer `mode: "e2ee"` in the page state and the API, so a missing
fragment is recognised and never mistaken for raw. The page asks for the key and the CLI prompts for it.

### 2.4 Key entry

The page's key field and the CLI prompt trim ASCII whitespace at both ends and accept a KEY, a full fyl link whose
fragment is a KEY and whose ID is this transfer's (otherwise "This link is for another file"), or an age identity
`AGE-SECRET-KEY-1…` ([§3.2](#32-age-identity-string)). The form is decided first: input starting with
`AGE-SECRET-KEY-1` in any case is only ever an identity string (those 16 characters are valid b64url, so a cut identity
string could pass for a KEY), other input without `/` only a KEY, the rest only a link. In links, both clients read
`%23` right after the ID as `#`, and an empty fragment as no key; a key that came after `%23` was in the request path,
which both parsers report so that clients warn ([§9.5](#95-page-rules)). A path segment is never a key, not even a
KEY-shaped one: a raw link's NAME sits there and can look like one. Anything else is `key_invalid`, before any
request. An entered key stays in
page memory and, once it verified, in `sessionStorage` for the tab like the sender's keys
([§2.5](#25-sender-copy-actions-and-storage)); it is never added to the URL or history.

### 2.5 Sender copy actions and storage

"Copy link", the copy button in the link field, the QR code and Share (where the browser offers it) all carry the link
with KEY (`…#KEY`): as on MEGA, that one link is the default. The menu "More ways to copy" offers it as "Link with key"
and adds "Link without key", "Key only" (KEY; the hint says recipients paste it into the key field) and the terminal
command in two forms: "Terminal command", `fyl download 'https://fyl.at/d/ID#KEY'` (the link lands in shell history and
the process list), and "Terminal command without key", `fyl download 'https://fyl.at/d/ID'` (asks for the key, so
nothing secret reaches history). Under the actions one quiet line, "Even safer: send the key separately" (shield icon,
disclosure arrow, closed by default), opens a block with the two parts to send through different channels
([§15.7](#157-local-device-and-carriers)): the link without key, shown without `https://`, and KEY, each cut in the
middle to what fits and copied whole by its icon button; no tooltip holds the full key. The terminal companion ("This
file in a terminal") shows and copies the command without key; the one with the key stays in the menu. Until the link,
KEY or the keyed command has been copied or shared, leaving the receipt asks first. The password is never part of a
link, QR code or command. Keys live in `sessionStorage` for the tab; "Remember keys on this device" (opt-in) keeps them
in `localStorage`, cleared by "Forget this device"; otherwise the recent list stores links without keys. The
pending-upload entry (`localStorage`, 2.3.0) holds the part MD5 record ([§8.2](#82-pre-send-check-clients)) but not KEY,
which stays in `sessionStorage` unless keys are remembered; a resume without it asks for the share link or key
([§8.4](#84-resume)). Every fyl.at page load, `/d/` included, drops pending entries past their 24-hour upload window.
Management links never carry KEY and the share link grants no management rights: content key, resume token and
management key are independent random values.

## 3. Key material and encodings

### 3.1 KEY

`KEY = b64url(identity)`, where `identity` is 32 bytes from the platform CSPRNG (`crypto.getRandomValues`, Rust
`getrandom`). It is fresh per transfer and never derived from the password, the ID or another key. KEY has 43
characters of `[A-Za-z0-9_-]`, and its last character is one of `AEIMQUYcgkosw048`. `identity` is an age X25519
identity: `recipient = X25519(identity, basepoint)` (RFC 7748). Clamping happens inside X25519, so the stored bytes are
unclamped, as in age. The recipient is never transmitted or stored. Only key holders can derive it, which is why the
server can't create files that open with KEY ([§15.2](#152-active-malicious-server)).

Why an X25519 identity rather than a raw symmetric key: one identity opens both age files of a transfer (content and
metadata, each with its own fresh file key); a resuming sender recovers the file key from the server-held header
without the server learning it; `age -d -i` works; the header has a fixed size. The cost is one X25519 operation per age
file.

### 3.2 age identity string

`AGE-SECRET-KEY-1` + Bech32 of `identity`, with HRP `age-secret-key-` and the BIP 173 checksum (constant 1, not
Bech32m). It is encoded in uppercase. Decoders accept all-uppercase or all-lowercase input and require exactly 32 data
bytes with zero padding bits. Example, the CCTV test identity:

```text
AGE-SECRET-KEY-1EGTZVFFV20835NWYV6270LXYVK2VKNX2MMDKWYKLMGR48UAWX40Q2P2LM0
KEY        yhYmJSxTzxpNxGaV5_zEZZTLTMre22cS39oHU_OuNV4
recipient  age1xmwwc06ly3ee5rytxm9mflaz2u56jjj36s0mypdrwsvlul66mv4q47ryef
```

Saved ciphertext: `curl -fOJ 'https://fyl.at/d/ID?dl=1'` saves `fyl-<ID[0:8]>.age`, and `fyl decrypt`
([§10](#10-cli-download)) opens it with KEY. With `age`: put the identity string in `key.txt` and run
`age -d -i key.txt -o FILE fyl-….age`. Neither restores the name, which is in the metadata. Clients MAY offer the
identity string; `fyl decrypt` is the supported path ([§17](#17-release-gating)).

## 4. Content format

The stored object is one complete age v1 file (C2SP, <https://age-encryption.org/v1>) restricted to the profile: binary
(no armor), exactly one X25519 stanza, STREAM payload. Every profile file is a valid age file, but not every age file
fits the profile.

### 4.1 Encryption

Each age file (the content, and separately the metadata) uses fresh values:

```text
file_key = CSPRNG(16)   eph = CSPRNG(32)   nonce = CSPRNG(16)
share    = X25519(eph, basepoint)
wrap_key = HKDF-SHA-256(ikm = X25519(eph, recipient), salt = share || recipient, info = "age-encryption.org/v1/X25519")
body     = ChaCha20-Poly1305(key = wrap_key, nonce = 12 × 0x00, plaintext = file_key)              32 bytes
hdr      = "age-encryption.org/v1\n-> X25519 " || b64(share) || "\n" || b64(body) || "\n---"         123 bytes
mac      = HMAC-SHA-256(key = HKDF-SHA-256(ikm = file_key, salt = empty, info = "header"), hdr)
head     = hdr || " " || b64(mac) || "\n" || nonce                                                  184 bytes
pkey     = HKDF-SHA-256(ikm = file_key, salt = nonce, info = "payload")
n        = max(1, ceil(P / 65536))
chunk_i  = ChaCha20-Poly1305(key = pkey, nonce = BE88(i) || (i == n−1 ? 0x01 : 0x00),
                             plaintext = pt[65536·i, min(65536·(i+1), P)))
file     = head || chunk_0 || … || chunk_{n−1}
```

HKDF output is 32 bytes; an empty salt equals 32 zero bytes (RFC 5869), so WebCrypto `salt: new Uint8Array(0)` and
Rust `Hkdf::new(None, …)` agree. AEAD additional data is empty. The age header is the first 168 bytes of `head`; every
base64 field is 43 characters on one line, so `H` is the constant 184. The final chunk is short or exactly 64 KiB, and
empty only when `P = 0` (one empty final chunk, `C = 200`). `P = k·65536` gives k chunks, the last one full and flagged
final, with no empty chunk after it.

Deterministic generation: the sender generates the content `head` once per transfer, at init, and never again. Every
later byte is a function of the file key, the nonce and the plaintext. Identical plaintext therefore yields identical
ciphertext at the same offset, which makes retries, parallel parts and resume byte-identical
([§8](#8-nonce-reuse-defence-and-resume)). Test vectors fix `identity`, `file_key`, `eph` and `nonce` to pin exact
bytes; that injection exists only in tests (Rust `#[cfg(test)]`; in JS the tests replace `crypto.getRandomValues`, and
no export takes these values). P is bound to the content key when it is created or recovered, never passed per part, so
one payload key never seals two plaintext sizes, whose last chunks would share a nonce.

### 4.2 Decryption

Normative order; the first failure wins (codes in [§13](#13-error-semantics)):

1. The version line is the bytes of `[0, 184)` before the first LF. No LF there: `truncated` if the input is shorter
   than 184 bytes, else `corrupt`. If it is not `age-encryption.org/` followed by one or more VCHAR (0x21–0x7E) →
   `corrupt`. If it is any version other than `age-encryption.org/v1` → `unsupported`.
2. The second line must start with `-> ` (`truncated` if the input ends first, otherwise `corrupt`). If its first
   argument, ended by SP or LF (`truncated` if the input ends first), is not `X25519` → `unsupported`.
3. Input shorter than 184 bytes → `truncated`. Steps 1–2 come first so that a later format with a shorter header reads
   as `unsupported`.
4. Bytes `[0, 168)` must match `age-encryption.org/v1\n-> X25519 B\nB\n--- B\n`, where each `B` is 43 characters of
   `[A-Za-z0-9+/]`. This means exactly one stanza, two arguments and one body line. Each `B` must be canonical `b64` of
   32 bytes. Otherwise → `corrupt`.
5. `X25519(identity, share)` is all-zero (or the library refuses the point) → `corrupt`.
6. Opening `body` fails → `key_wrong`. This is the only check that reports a wrong key; over `head` and `meta`
   together, [§9.1](#91-key-check) decides.
7. The HMAC over bytes `[0, 123)` doesn't equal `mac` (compared in constant time) → `corrupt`.
8. Payload from offset 168: the nonce is `[168, 184)`, chunks follow from `i = 0`. Take the next `min(S, remaining)`
   bytes: 0 bytes → `truncated` (no final chunk); 1–15 bytes → `corrupt`; fewer than S → open as final, else
   `corrupt`; exactly S → open as non-final, on failure as final, both failing → `corrupt`. A final chunk with empty
   plaintext at `i > 0` → `corrupt`. Release each opened chunk's plaintext in order. After a final chunk any further
   byte → `trailing_data`, otherwise success; after a non-final chunk continue with `i + 1`.

Released plaintext is authentic chunk by chunk, but it is complete only on success. Clients treat all output as
unverified until then ([§9](#9-browser-download), [§10](#10-cli-download)). The payload rules are age's reference
behaviour, including releasing an authentic chunk before reporting `truncated` or `trailing_data`, so they reproduce
the CCTV payload hashes. The final-chunk decision rests on the authenticated STREAM flag, never on a length the server
declares. Length checks against `C` happen earlier and only add `corrupt` cases.

### 4.3 Reference vectors (C2SP CCTV)

Source: `age/testdata` in <https://github.com/C2SP/CCTV>, pinned at `50a8ecf2a220f4c8bdc4f085789b8e85c26829e7`
(2026-09-25; the npm package `cctv-age` comes from another commit and isn't used). It has 147 files and is licensed
0BSD, CC0-1.0 or Unlicense (copying needs no attribution). Each file is a textual header (`expect`, `payload` = SHA-256
of the released plaintext, `identity`, `file key`, `comment`, `compressed: zlib`, `armored`, `passphrase`), a blank
line, then the age file. The vectors test decryption only: the C2SP spec defines no way to inject randomness, so
encryption is pinned by our own vectors.

Both implementations run all 67 vectors that have an X25519 identity (`AGE-SECRET-KEY-1…`) and no armor or passphrase,
with that identity (`hybrid_x25519_arg` also lists a post-quantum identity, which is ignored). Mapping:

| CCTV expect | Profile result |
| --- | --- |
| `success` | success, with `payload` matching |
| `no match` | `key_wrong` |
| `HMAC failure` | `corrupt` |
| `header failure` | `corrupt`, `truncated` or `unsupported` |
| `payload failure` | `corrupt`, `truncated` or `trailing_data`, with the released plaintext matching `payload` |

Six vectors are valid age but outside the profile: `x25519_grease`, `stanza_valid_characters` and `x25519_lowercase`
give `unsupported`; `x25519_multiple_recipients`, `stanza_empty_body` and `stanza_empty_last_line` give `corrupt`. The
vector manifest ([§16](#16-test-plan)) records the exact code for each file, so both implementations agree exactly.

### 4.4 What the server stores

The R2 object is the age file (`C` bytes). The Transfer record holds `mode: "e2ee"`, `head` (equal to the object's
first 184 bytes, checked at complete, [§12.2](#122-other-routes)), `meta` ([§5](#5-metadata-blob)), pins
([§8.3](#83-pins-server-e2ee-only)) and `name = "fyl-" + ID[0:8] + ".age"`, used only for Content-Disposition. No key,
plaintext name or separate plaintext size is stored. Cleanup drops `head`, `meta` and the pins with the record
(tombstones keep none of them).

## 5. Metadata blob

### 5.1 Plaintext

Canonical JSON padded with spaces:

```text
{"v":1,"name":NAME,"size":P,"headSha256":SUM}
```

Members in this order, no whitespace. NAME is well-formed Unicode (no lone surrogates) and contains no `\`
([§5.3](#53-validation)), so it is a JSON string in which only `"` is escaped (`\"`), every other character raw UTF-8.
P is decimal without sign, fraction or exponent. SUM is `b64url(SHA-256(content head))` (43 characters). 0x20 bytes pad
the text to the next multiple of 512 bytes (0 to 511 of them). For every valid NAME, `JSON.stringify` of
`{v, name, size, headSha256}` and serde_json of a struct with the fields in this order produce exactly these bytes.
Longest case: a 1024-byte name of `"` characters, 95 + 2048 = 2143 bytes.

### 5.2 Encryption

`meta` is a separate profile age file to the same identity, with its own file key, ephemeral key and nonce. Its size is
`184 + L + 16` with `L ∈ {512, 1024, 1536, 2048, 2560}`, so the meta size is one of 712, 1224, 1736, 2248 or 2760 bytes.

### 5.3 Validation

After `meta` decrypts per [§4.2](#42-decryption):
1. The plaintext length is a multiple of 512 and at most 2560, else `corrupt`.
2. T is the plaintext without trailing 0x20 bytes. Fewer than 512 bytes may be stripped, else `corrupt`.
3. If T starts with `{"v":` followed by digits other than exactly `1`, then `,` or `}` → `unsupported`. This is a byte
   check, so both languages agree.
4. T is valid UTF-8, every 0x5C in T is followed by 0x22 (so `\"` is the only escape: no `\u`, `\/` or `\\`), and T
   parses as RFC 8259 JSON and re-encodes per [§5.1](#51-plaintext) to exactly T, else `corrupt`. The byte rule keeps
   out `\ud800`, which JSON.parse accepts and serde_json refuses. This rejects whitespace, duplicate, unknown or missing
   members, `1.0` and `-0`. A P beyond 2^53 that JS can't parse exactly fails here in JS; the size check of step 5
   catches every other one in both languages.
5. Each of these failing → `corrupt`:
   - NAME passes the server's raw-name rules: 1–1024 UTF-8 bytes; not only dots; no `/` or `\`, no C0/C1 controls, no
     U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069, U+2028 or U+2029;
   - `C ≤ 2^53 − 1` (JavaScript's exact integers; the server's `C` is far below) and `P == P(C)` of the content object
     ([§6](#6-ciphertext-layout));
   - SUM equals `b64url(SHA-256(head))` of the content head that was verified.

### 5.4 Why this content

The recipient needs `name` (to save the file) and `size` (to show it before downloading). `headSha256` binds the
metadata to the content: without it a malicious server could hand a resuming sender the metadata's own header as the
content header (both open with KEY), so that a file of up to 64 KiB is encrypted under the metadata's payload key and
chunk nonce `0‖final`, reusing keystream over the known space padding; it could also serve the metadata as the content.
No MIME type (downloads are octet-stream; the page derives a label from the name). No mtime or file sample: resume
safety comes from pins ([§8](#8-nonce-reuse-defence-and-resume)), and an mtime would leak to recipients. Padding hides
the name length to a 512-byte bucket. Changes bump `v` rather than adding ignored members, so JS and Rust stay equally
strict.

## 6. Ciphertext layout

```text
n(P)     = max(1, ceil(P / 65536))
C(P)     = 184 + P + 16·n(P)
chunk i  : plaintext [65536·i, min(65536·(i+1), P)),  ciphertext starts at 184 + 65552·i, length (plaintext len) + 16
P(C)     : L = C − 184; invalid if L < 16; n = max(1, ceil(L / 65552)); P = L − 16·n;
           invalid if n ≥ 2 and P ≤ 65536·(n−1)          (empty last chunk, or one of fewer than 17 bytes)
parts    = ceil(C / PART);  part p = ciphertext [PART·(p−1), min(PART·p, C))
part p covers chunks  first = (p == 1 ? 0 : floor((PART·(p−1) − 184) / 65552))
                      last  = min(n−1, floor((PART·p − 1 − 184) / 65552))
```

Part 1 also carries `head`. A part boundary can fall inside a chunk, even inside its tag. Both parts compute that chunk
in full and keep their own slice, which is deterministic ([§8.1](#81-invariant)). A part touches 800 or 801 chunks, so
it reads at most 801 × 64 KiB of plaintext.

| P | C | Chunks | Last chunk (plaintext) | Parts | Last part |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 B (format only; uploads need P ≥ 1, as for raw) | 200 | 1 | 0 | 1 | 200 |
| 1 B | 201 | 1 | 1 | 1 | 201 |
| 65,536 B | 65,736 | 1 | 65,536, final | 1 | 65,736 |
| 65,537 B | 65,753 | 2 | 1 | 1 | 65,753 |
| 50 MiB = 52,428,800 B | 52,441,784 | 800 | 65,536 | 2 | 12,984 |
| 1 GiB | 1,074,004,152 | 16,384 | 65,536 | 21 | 25,428,152 |
| 50 GiB = 53,687,091,200 B | 53,700,198,584 | 819,200 | 65,536 | 1,025 | refused: C > 50 GiB |
| P_max = 53,673,987,000 B | 53,687,091,200 | 819,001 | 3,000 | 1,024 | 52,428,800 |

Worked examples. 50 MiB file: part 1 = `[0, 52428800)` = head + chunks 0–798 + the first 52,568 bytes of chunk 799
(which spans `[52376232, 52441784)`); part 2 = `[52428800, 52441784)` = the last 12,984 bytes of chunk 799, its tag
included. P_max: part 2 covers chunks 799–1599 (both partly); part 1024 = `[53634662400, 53687091200)` covers chunks
818,200–819,000, the last being the 3,016-byte final chunk at 53,687,088,184.

Size limit: `MAX_FILE_BYTES` (50 GiB) limits the stored size `C`, because budgets and R2 parts count stored bytes. The
largest E2EE plaintext is therefore P_max = 53,673,987,000 B, 13,104,200 B (about 12.5 MiB) less than for raw. It fills
exactly 1,024 parts, so 2.3.0's slot arithmetic (9 slots) is unchanged. Clients compute P_max as the largest P with
`C(P) ≤ maxFileBytes` from `/config.js` or `/api/health`. The highest chunk index, 819,000, stays far below 2^88.

## 7. Upload flow

1. Check `1 ≤ P ≤ P_max`. Normalise NAME to the [§5.3](#53-validation) rules: each lone surrogate and each forbidden
   code point (`/` and `\` included) becomes `_`, a name of only dots becomes `_`, and a name over 1024 bytes is
   shortened at a code-point boundary keeping the extension. Generate `identity`, the content `head`
   ([§4.1](#41-encryption)), then `meta` ([§5](#5-metadata-blob)) with its SUM. Run the recipient's key check
   ([§9.1](#91-key-check)) on them and refuse on any failure, so a drift between implementations costs no upload.
2. `POST /api/upload/init` with `mode: "e2ee"`, `size: C`, `e2ee: {head, meta}` and no `filename`
   ([§12.1](#121-init)); `clientKey`, `Idempotency-Key`, password, expiry and one-time as for raw; retries resend the
   identical body. The response MUST echo `mode: "e2ee"`, otherwise the client aborts the session before any part (a
   pre-2.4.0 server already answers 400 for the missing filename; the echo covers any server that ignores `mode`).
3. Share link: built per [§2.2](#22-e2ee-link) once the response `url` checks out, shown at once; early links work as
   for raw.
4. Parts, in any order and in parallel: compute part p into one buffer (read its plaintext span in pieces of at most
   1 MiB, encrypt chunk by chunk, copy the overlapping bytes) and MD5 it; then check it
   ([§8.2](#82-pre-send-check-clients)), pin it ([§8.3](#83-pins-server-e2ee-only)) and `PUT /api/upload/part` with
   `Content-MD5: <RFC 1864 base64 with padding, 24 characters>`. Every retry of p resends that buffer after the same
   check; p is never recomputed while in flight, and the buffer is released once p is confirmed or the run stops.
5. Complete as for raw. The 2.3.0 receipt check additionally requires `mode == "e2ee"`, `size == C`, `name == null` and
   `url == <origin>/d/<ID>`.
6. CLI: before each part read and before completing, compare the file's size and mtime with the start of the run.
   Browser: `File` size and date are snapshots, so a `NotReadableError` while reading is the change signal. A change
   stops the run without completing ([§8.4](#84-resume) decides what follows). These are early warnings; §8.2 is the
   guarantee.

Memory per part in flight: one buffer of at most 52,428,800 B, a 1 MiB read buffer, crypto and MD5 state. CLI:
`--workers` (1–8, default 4) parts in flight, at most 200 MiB by default and 400 MiB at 8, the bound raw uploads already
have (they hold each part in memory too). Browser: at most 2 E2EE parts in flight (raw keeps 4: it sends Blob slices
without copying), each built and hashed in its own dedicated worker (one worker manages about 130 MiB/s of
ChaCha20-Poly1305 on the 2017 i7 this was measured on). The hashed buffer becomes an immutable `Blob` and the
ArrayBuffer is released, so fetch sends exactly the hashed bytes without a copy of its own; peak about 2 × (buffer +
Blob) while building, measured per [§9.4](#94-limits). Buffering instead of two passes (hash, then encrypt again while
sending): the bytes sent must be the bytes hashed, and a second read could see a changed file.

## 8. Nonce-reuse defence and resume

### 8.1 Invariant

Within a transfer (one payload key), no ciphertext byte position is ever sent with two different values. With ChaCha20,
equal bytes at a position mean equal plaintext there, so the invariant rules out keystream reuse on different plaintext
and two different tags for one chunk (Poly1305 one-time-key reuse). Part boundaries inside a chunk are harmless: the two
parts carry disjoint byte ranges of that chunk. Within one run, step 4 of [§7](#7-upload-flow) guarantees it (one
buffer per part, retries resend it); across runs, tabs and processes, §8.2 and §8.3 do.

### 8.2 Pre-send check (clients)

Immediately before every E2EE part request, first try and retries alike, the client compares the MD5 of the exact
buffer it is about to send with every MD5 it knows for that part: the pin (acknowledged to its own pin request or
listed in status), the browser's local record and earlier attempts in this process. Any mismatch stops the run ("The
file changed since this upload started. Start a new upload.") and nothing is sent. Per part the order is: build and
hash the buffer; check; the browser writes `{part, md5}` to its pending entry (re-read inside the 2.3.0 Web Lock first)
and continues only if the write succeeded; pin; send. Against an honest server only bytes equal to the pin ever leave
the client, whatever happens between reads of the file, across tabs, concurrent CLI runs or failed requests.

### 8.3 Pins (server, E2EE only)

Before part n's body is sent, the client pins its MD5 with `POST /api/upload/pin` ([§12.2](#122-other-routes)): the
first value is stored, the same value again answers 200, another 409 `part_changed` (permanent). An E2EE part request
must carry `Content-MD5` equal to n's pin: missing, malformed or unpinned 400 `request_failed`, another value 409
`part_changed`; nothing reaches R2 and no attempt is counted. A conforming client never sends a body the route would
refuse, because the pin is stored and checked (§8.2) before the body leaves. In finishPart, an R2 ETag of 32 hex digits
that differs from the pin settles the attempt as failed (slot and reservation freed, counted as an attempt) and answers
502 `part_corrupt` (class `retry`): the client resends the same buffer once, then stops with the upload resumable, like
raw's damaged-part rule. Non-hex ETags (local simulator) are not compared. Pins live in their own storage, which
pre-2.4.0 code never writes, for as long as the upload record.

### 8.4 Resume

Resume needs the same KEY. CLI: `fyl FILE --resume -` reads the resume value `ID.TOKEN.KEY.MTIME` from stdin (without
echo at a terminal); the interrupted run prints that command and, on its own line, the value, so pasting it keeps it
out of shell history. A value without KEY (`ID.TOKEN.MTIME`) takes the key or share link from `FYL_KEY` or a prompt.
Browser: the pending entry, and if its KEY is gone ([§2.5](#25-sender-copy-actions-and-storage)) the page asks for the
share link or key. MTIME is the file's mtime in whole milliseconds since the epoch, decimal, taken at the start of the
first run. The server keeps no key; without one the upload can only be aborted. Procedure:

1. `GET /api/upload/status`: `mode` must be `e2ee`, and both `e2ee` and `pins` must be present. Without them (an old
   server or a rollback), refuse to resume.
2. Open the status `head` and `meta` with the key check ([§9.1](#91-key-check)), which includes
   `SUM == SHA-256(head)`. The local file must give `C == status.size` and `P == meta.size`. The CLI also requires the
   file's mtime to equal MTIME.
3. For every pinned or confirmed part, recompute its bytes from the current file and compare their MD5 with the pin (a
   confirmed part without a pin uses its ETag if that has 32 hex digits, otherwise resume is refused). Any difference
   refuses ("The file changed since this upload started. Start a new upload."). The browser also requires the MD5 to
   match its local record, whatever the server says.
4. Continue as in step 4 of [§7](#7-upload-flow): equal confirmed parts are kept, the others are computed when their
   turn comes and pass §8.2 before they are sent. Mode, expiry, one-time setting and password are kept, as for raw. A
   different file name only warns; the name in `meta` stays.

A refusal (missing or wrong key, MTIME, size, any MD5 difference) exits 2 and leaves the upload resumable: it never
calls abort. Only 409 `part_changed` or an explicit cancel aborts. Why a refusal rather than re-encrypting changed
parts: an age file has one payload key, so a changed part could only be sent under a new file key, which means a new
upload.

### 8.5 Residual risk

A malicious server can acknowledge any pin, then hide or alter pins. A CLI resume after an in-place change of an
already-sent part, with size and mtime preserved, then re-encrypts different plaintext under the same keystream, and
the server learns the XOR of the old and new plaintext in the changed bytes. The browser is not exposed while its local
record survives (it outlives a closed browser; re-entering the key resumes against it). Against an honest server the
pin is stored before any body byte leaves the client and §8.2 sends only bytes equal to it, so different bytes never
reach the service, not even the edge.

## 9. Browser download

### 9.1 Key check

`head` and `meta` come from the page state (`ready`, and `uploading` when unprotected) or, for a protected transfer,
from the info route with Basic ([§11](#11-passwords-and-e2ee)). The key check runs [§4.2](#42-decryption) steps 1–5 on
`head`, which must then be exactly 184 bytes (`corrupt` otherwise: a longer stored head would pass the check and fail
every download), then steps 1–5 on `meta`; then step 6 on both: both unwraps failing is `key_wrong`, exactly one
failing is `corrupt` (the key is right, a blob is damaged); then step 7 on `head`, then on `meta`; then the rule of
[§12.1](#121-init) step 6, `corrupt` if `meta` shares `head`'s ephemeral share, stanza body or payload nonce (a sender
that reused the content's randomness for the metadata would reuse its keystream, which the sender's own check of
[§7](#7-upload-flow) step 1 must catch); then `meta`'s payload and [§5.3](#53-validation). The first failure wins. A
stored head checked alone (a part worker given KEY, head and P) takes steps 1–7 with the same length rule. Failure
shows the key field with the error; success shows the decrypted
name, P, the type label and the program warning (computed locally, [§15.4](#154-malicious-sender-and-reports)). No
one-time session has opened and no download has been counted at this point. Only the core's own errors (a code of
§13, or `platform`) are results of the check: when the page's code fails to load (a network blip), the page never calls
the file damaged; it offers a retry that reloads the page (browsers keep a failed module import for the page's life),
which keeps a key in the address. `platform` (no WebCrypto X25519)
shows its own card without a key field, since no key can work in that browser, and keeps the `fyl download` command
with the key.

### 9.2 Streaming path (default where it works)

- **Service worker:** `/_dl/sw.js` (`Cache-Control: no-cache`), so the browser confines it to `/_dl/`; the Worker never
  sends `Service-Worker-Allowed`. It controls no fyl page and never sees `/d/`, `/api/` or KEY: it only relays plaintext
  the page hands it. `/_dl/<token>` must 404 when it reaches the Worker. The page registers it on load and streams only
  if `registration.active` is `activated` at the click (`navigator.serviceWorker.ready` never resolves on `/d/`, which
  is outside the scope). A worker still installing or waiting at the click (a first visit) gets up to 5 s to
  activate; a registration that failed is tried again at the next click.
- **Start (order normative):** on the click, the page posts `{token, name, size: P}` and a MessageChannel port to the
  worker (`token`: 16 random bytes, b64url, single use) and navigates a hidden iframe to `/_dl/<token>`. The worker
  answers with a streamed response (`Content-Type: application/octet-stream`; `Content-Disposition: attachment`, name
  encoded like `downloadHeaders()`; `Content-Length: P`; `X-Content-Type-Options: nosniff`; `Cache-Control: no-store`;
  `Content-Security-Policy: sandbox; default-src 'none'`, so a browser that renders instead of saving runs nothing on
  the fyl.at origin) whose body has `highWaterMark: 0` and pulls plaintext through the port with credit-based
  backpressure (at most 4 chunks buffered). Unknown token: 404. The worker posts `started` when it takes the token and
  `pulled` on the body's first `pull()`, which means the browser accepted the download. Only then does the page send
  the consuming request. No `pulled` within 10 s: the page cancels the token and falls back ([§9.3](#93-fallback)) with
  nothing consumed.
- **Fetch and decrypt:** the page fetches `/d/ID?dl=1` with `cache: "no-store"`, `credentials: "omit"` and, if
  protected, `Authorization: Basic` from page memory; requires 200, `Content-Length == C` and the first 184 bytes equal
  to the verified head (otherwise `corrupt`); decrypts per [§4.2](#42-decryption) in a worker and hands on plaintext
  chunk by chunk.
- **Interruptions:** after a network error the page continues with `Range: bytes=<184 + 65552·i>-` and
  `If-Range: <ETag>` from the first chunk not yet handed on, at most 5 times with backoff; a 200 instead of 206 means
  the object changed (`corrupt`). The resumed bytes go to the same decryptor, which alone knows how much verified, and
  success requires exactly P plaintext bytes. One-time links allow this from the same network within the session
  ([§11](#11-passwords-and-e2ee)).
- **Cancel and failure:** the worker forwards a cancel of its stream (save dialog dismissed, download cancelled, disk
  full) to the page, which aborts its fetch and says the download failed. Any decryption error, or giving up, errors the
  stream; browsers mark the download failed (Content-Length also fails a short one). Chromium removes the partial file,
  others may keep it, so the page always says the download failed and the file is incomplete. "Decrypted and verified,
  saved by your browser as NAME" appears only after the final chunk verified and the worker reported the stream closed.
- **Tab closed:** aborts the download. The page holds the key and decrypts; the worker never gets the key. While a
  download runs the page pings the worker every 10 s (some browsers stop idle workers), and the producer posts
  `{type: "alive"}` on the port every 5 s, also while a retry waits: a worker that waits for data 30 s without a word
  from it, or sees the port's `close` event where browsers send one, errors the stream, so the browser marks the
  download failed instead of keeping a partial file open. While a download runs the page says "Keep this page open
  until the download finishes." and the browser asks before leaving it.

### 9.3 Fallback

Without a usable service worker (Firefox private windows, failed registration, not active within 5 s of the click, no
`pulled` in time), on iOS/iPadOS (iPadOS reports `Macintosh` with `navigator.maxTouchPoints > 1`) and on every engine
other than Chromium (`navigator.userAgentData` names `Chromium` and no `Android WebView`, whose app takes downloads
outside the service worker) until the [§9.4](#94-limits) measurements pass:
decrypt into memory, `new Blob(chunks, {type: "application/octet-stream"})`, save only through `<a download>` (never by
navigating to or opening the blob URL, which would run as fyl.at). Only for P ≤ 256 MiB, decided before the consuming
request; larger files get the `fyl download` command (on iOS: use a computer), and where the streaming path exists
(Chromium) the button stays so the next click tries it again. A failure to load the decryption code says so and offers
a retry. The Blob is built only after success, so
no partial file is ever saved; its URL stays until `pagehide`, with a "Save again" button.

### 9.4 Limits

Measured ([§17](#17-release-gating)) on Chrome/Edge, Firefox, Safari (macOS), Safari (iOS/iPadOS),
Chrome (Android), with 1 B, 64 KiB, 50 MiB + 1 B, 5 GiB and (desktop) 50 GiB, including abort, full disk, closed page,
service worker disabled, a denied download, the sandbox header and a slow network; E2EE uploads (peak memory,
throughput) on the same platforms. A path not measured stays on the fallback; no 50 GiB browser promise before that.
Until the measurements are recorded, the page streams only in Chromium (checked there in headless Chromium against the
local Worker: one-time and password files, a cut connection resumed with `If-Range`, cancel and retry, a closed page,
a worker installing at the click); every other engine uses the fallback.

### 9.5 Page rules

- **Fragment.** The page reads KEY from the fragment once at load, into memory, then `history.replaceState`s to
  `/d/ID` plus the hash, dropping any path segment or query (a crafted `/d/ID/Invoice.pdf#KEY` shows no false name).
  Every page-initiated navigation keeps the fragment: state changes (upload finished, unlock) are fetched in place, a
  reload is `location.reload()` (a `location.replace()` to the same URL plus hash is only a fragment navigation), and
  every `replaceState` appends `location.hash`. `hashchange` re-runs key parsing and the key check. The skip link moves
  focus in JS without changing the hash.
- **Key exposed.** A key after `%23` ([§12.2](#122-other-routes)) is used, removed by the replaceState, and the page
  warns: "This key was sent to fyl.at in the address. For sensitive files, upload again and share the new link." A
  path segment is never used as a key ([§2.4](#24-key-entry)); the replaceState drops it like any segment.
- **Fields and names.** The key field sits outside any form, has no `name`, is `type="text"` with `autocomplete="off"
  spellcheck="false" autocapitalize="off" autocorrect="off"`, so password managers, spell-check services and form
  history don't take it. `document.title` stays "Encrypted file · fyl.at". Every element, toast and live-region text
  with the decrypted name or the key has `translate="no"` (on the sender page the link, both values of the key block and
  the terminal command; on this page the terminal command): a page translated by the browser sends its text to a
  translation service. A test finds every element whose text holds the key and checks the markup. On the sender side
  `navigator.share` gets only `{url}`.
- **Download control.** A `<button>`, never an `<a href>` to `/d/`; it starts only on a click, never by itself after
  unlock or when an early upload completes. E2EE pages show `fyl download` commands, never curl. Without JavaScript the
  page says decryption needs JavaScript or `fyl download`.
- **Code.** The Worker sets the `/d/` CSP itself: `script-src` and `worker-src` name only fyl's own script paths, not
  `'self'`, which would admit scripts Cloudflare injects under `/cdn-cgi/`. `script-src`: the `<script src>` paths of
  `dist/<lang>/download.html` (`theme.js`, `i18n.js`, `download.js`), `/e2ee/` and `/vendor/`; `worker-src`: `/e2ee/`, `/vendor/` and `/_dl/sw.js`. So every module
  and dedicated worker of the E2EE pages lives under `/e2ee/` (the core, `jobs.js`, `worker.js`) and imports only from
  there and `/vendor/`; the hidden `/_dl/<token>` frame and the page's fetches fall under `default-src 'self'` and
  `connect-src 'self'`. All code the page and its workers load is served `Cache-Control: no-cache`
  ([§15.6](#156-compromised-javascript-delivery)).

## 10. CLI download

Usage: `fyl download LINK [-o PATH]`; a LINK of `-` reads one line from stdin (without echo at a terminal).

1. **Parse.** LINK must be `<base>/d/<ID>[/<segment>][#KEY]`, `<base>` the configured endpoint (default
   `https://fyl.at`), no query except `?dl=1`; otherwise exit 2. `%23` counts as `#` and an empty fragment as no key
   ([§2.4](#24-key-entry)); the segment is never sent. A fragment that isn't a valid KEY: exit 2 (`key_invalid`).
2. **Info.** `GET /api/transfers/<ID>`. Missing, closed or quarantined: exit 1 with the server's message. `uploading`:
   wait (Retry-After, progress on stderr), like `curl --retry`.
3. **Mode.** KEY given but `mode` raw: refuse (`mode_mismatch`, exit 1); a link with a key never yields an
   unauthenticated file. `e2ee` without KEY: `FYL_KEY`, else a prompt on `/dev/tty` without echo; neither: exit 2.
4. **Password** (protected): `FYL_PASSWORD`, else a hidden prompt on `/dev/tty` (no terminal: exit 2); then
   `GET /api/transfers/<ID>` with Basic returns `name` (raw) or `e2ee`. 401 `password_wrong`: ask again while tries
   remain (interactive), otherwise exit 1; 429 `password_paused`: exit 1 with the wait. Stdin carries at most the link;
   two secrets never come from stdin.
5. **Key check** as in [§9.1](#91-key-check). A key from the link or `FYL_KEY` that fails: exit 1; a typed one may be
   re-entered (3 tries). Nothing is consumed so far.
6. **Target.** PATH an existing directory (default `.`): `<dir>/<name>`; otherwise PATH is the file (its parent must
   exist). The name is the metadata name (E2EE) or the server's (raw), a single path component ([§5.3](#53-validation));
   a leading `.` becomes `_`, as browsers do, so no hidden or startup file (`.bashrc`, `.envrc`) is created and the
   message names the original; over 255 bytes it is shortened at a UTF-8 boundary keeping the extension. Before anything
   is consumed: an existing target (any type, a dangling symlink too) exits 2; creating and removing the target
   (`O_CREAT|O_EXCL|O_NOFOLLOW`, 0600) must succeed, which proves the name is legal and writable on that filesystem
   (exit 1 otherwise); free space (`statvfs`) must be at least P (E2EE) or the size (raw), else exit 1. `-o -` with
   E2EE: exit 2, since bytes already written to stdout couldn't be taken back after a later failure.
7. **Download.** Temp file `<dir>/.fyl-<16 random hex>.part`, `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600.
   `GET /d/<ID>?dl=1` (`Accept: */*`, Basic if protected); require 200 and `Content-Length` equal to C (E2EE) or the
   size (raw). E2EE: the first 184 bytes must equal the verified head, then decrypt per [§4.2](#42-decryption) in
   bounded memory (one chunk plus I/O buffers), writing plaintext as chunks verify.
8. **Interruptions.** Continue in-process with `Range` and `If-Range`, up to 5 times, 2.3.0 retry classes: raw from the
   bytes written; E2EE after truncating the temp file to `65536·i`, from `184 + 65552·i`.
9. **Success** (final chunk verified, or Content-Length bytes for raw): fsync and close; rename to the target without
   replacing (`renameat2(RENAME_NOREPLACE)` on Linux, `renamex_np(RENAME_EXCL)` on macOS, else `link()`+`unlink()`, and
   where the filesystem supports none of these (exFAT, FAT) create the target with `O_EXCL` and rename over that
   placeholder, racing only a process that replaces it in between); on macOS set `com.apple.quarantine` as browsers do,
   so Gatekeeper checks the file; fsync the directory; print the path on stdout; for a one-time E2EE link send
   `POST /api/transfers/<ID>/done`. If the target appeared meanwhile or the rename fails, keep the verified temp file,
   name it in the message and exit 1.
10. **Failure** before the final chunk verified deletes the temp file and exits 1, SIGINT/SIGTERM likewise with exit
    128 + signal; a verified temp file is never deleted.

Nothing is written outside the temp file before success. The CLI follows no redirects, sends credentials only to the
configured origin, never sends KEY anywhere and never prints it: messages name only `/d/<ID>`, and the key type has a
redacted Debug. Exit codes: 0 saved; 1 failure (network, server refusal, gone, wrong password without a terminal, any
crypto error, disk); 2 usage (malformed link or key, missing secret without a terminal, existing target, `-o -` for
E2EE, a resume refusal); 128 + n signal.

`fyl decrypt FILE [-o PATH]` opens saved ciphertext (from curl, `?dl=1` or a rollback) offline: the key from `FYL_KEY`
or the prompt (any [§2.4](#24-key-entry) form), [§4.2](#42-decryption) on the one file (a failing unwrap is
`key_wrong`), and steps 6, 7 (writing), 9 and 10 locally. PATH defaults to FILE without `.age` and is required for other
names. The original name isn't in the file, so it isn't restored.

Upload side: `fyl FILE --encrypt` prints the link it built ([§2.2](#22-e2ee-link)); `--json` adds `encrypted: true`
(`size` is P). Resume per [§8.4](#84-resume); `--encrypt` is optional on resume but must agree with the mode.

## 11. Passwords and E2EE

The two are independent: the password controls what the server releases, KEY controls local decryption. The password
never derives KEY and is never in a link, QR code or command; KEY never reaches the server, so a wrong key never counts
as a password try.

What the server releases:

| Transfer | Before authentication | After (grant or Basic) |
| --- | --- | --- |
| Raw, protected | `id`, state, `size`, expiry, `once`, `protected`, `mode`; `name: null`; page `url` without name | name, canonical link, file |
| E2EE, unprotected | everything, including `head` and `meta` (no authentication involved) | — |
| E2EE, protected | `id`, state, `size` (= C), expiry, `once`, `protected`, `mode`; `head`/`meta` null | `head`, `meta`, ciphertext |

**Browser, protected E2EE.** The `protected` page shows the password field, plus the key field if KEY is missing or
invalid; the key is validated locally and never submitted. The page doesn't use the unlock form: it sends the password
as `Authorization: Basic` to `GET /api/transfers/:id` (tries counted per network as for the form), checks KEY against
the returned `head`/`meta` without consuming anything, and keeps the password in page memory for the download's
requests. The page never navigates and no grant can expire mid-download. A wrong key brings back the key field.

**CLI.** Steps 3–5 of [§10](#10-cli-download): Basic on the info route, then on the download. The password is checked
on every request, so no grant is involved.

**One-time links.** Pages, info and unlock never open the session; for E2EE only a non-navigation `GET /d/` with
`?dl=1`, a grant or Basic does ([§12.2](#122-other-routes)). The key is checked before that, so a missing, malformed or
wrong key never uses up a link. Delivering the whole file doesn't close an E2EE link: the session stays open for its
network until 15 minutes after its last response ended (2.3.0's idle window, counted from the end of a password pause
that refused that network when that is later; 24 hours after it opened at the latest), so a failed decryption, a lost
write or a dismissed save can be retried. Clients close it at once after the final chunk
verified, with `POST /api/transfers/:id/done`. The service can't see whether decryption succeeded, so there is no
"decrypted exactly once" promise.

**Unchanged.** Takedown, expiry and quarantine apply as before. Copies and keys already handed out can't be recalled.

## 12. API changes

### 12.1 Init

E2EE request body: `{mode: "e2ee", size: C, e2ee: {head, meta}, expiresIn?, oneTime?, password?, partSize?,
clientKey?}`, `head` and `meta` in b64url. The server checks, in this order:

1. `mode` other than `"raw"` or `"e2ee"`, or `e2ee` sent with raw → 400.
2. `mode: "e2ee"` while `E2EE_ENABLED` is not `"true"` → 403 `e2ee_disabled`.
3. `filename` present → 400 (plaintext names never reach the server).
4. `size` a safe integer with `201 ≤ C ≤ MAX_FILE_BYTES` (413 above) and a defined `P(C)` ([§6](#6-ciphertext-layout)),
   else 400.
5. `head` decoding to exactly 184 bytes and `meta` to 712, 1224, 1736, 2248 or 2760 bytes, each with its first 168
   bytes matching the pattern of step 4 in [§4.2](#42-decryption), else 400. The server neither decrypts nor checks
   canonical base64 inside them; clients do.
6. `meta`'s share, stanza body and payload nonce each differ from `head`'s, else 400 (reused randomness).

The idempotency fingerprint is the digest of `{mode, size, expiresIn, once, SHA-256(head), SHA-256(meta), password
signature}`; the record's name is `fyl-<ID[0:8]>.age`; the 201 response adds `mode` (also `"raw"` for raw) and an E2EE
`url` is `/d/ID`. Raw init changes only by `mode` in the response; a protected raw upload's link stays `/d/ID`
([§2.1](#21-raw-links-unchanged-in-240)).

### 12.2 Other routes

- **Pin (E2EE):** `POST /api/upload/pin`, JSON `{uploadId, partNumber, md5}` (`md5` 32 lowercase hex), Bearer as for
  parts, rate-limited like them, only while the upload runs; per [§8.3](#83-pins-server-e2ee-only).
- **Part (E2EE):** `Content-MD5` required and equal to the pin; errors per §8.3.
- **Status:** adds `mode`; E2EE adds `e2ee: {head, meta}` and `pins: [{partNumber, md5}]` (every pinned part, confirmed
  or not); confirmed parts stay in `parts`.
- **Complete:** E2EE reads bytes `[0, 184)` of the completed object; if they differ from `head`, it deletes the object,
  fails the upload and answers 409 `head_mismatch` (no receipt), so no transfer passes the key check and then fails
  every download. The receipt adds `mode`; E2EE: `name` null, `url` `/d/ID`, `size` C.
- **`GET /api/transfers/:id`:** adds `mode`. E2EE: `name` null, and `e2ee: {head, meta}` when the transfer is
  unprotected, the request has the management key, or it has the right password as `Authorization: Basic` (user name
  ignored, checked and counted per network like `/d/`); otherwise `e2ee: null`. Also while `uploading`. Basic errors
  here are JSON, never with `WWW-Authenticate`: 401 `password_wrong` `{triesLeft}`, 429 `password_paused`
  `{pausedUntil}` with Retry-After.
- **`POST /api/transfers/:id/done`:** closes an E2EE one-time session at once when sent from its network (otherwise no
  effect); 204.
- **`/d/`:** for every transfer the ID ends at the first `/` or `%23` (any case). E2EE: a navigation
  (`Sec-Fetch-Mode: navigate`, or `Accept` with `text/html` and no Range) gets the page whatever the query; preview bots
  too, as before. Other GETs get the ciphertext only with `?dl=1`, a grant or Basic, otherwise 409 `encrypted` with a
  plain-text hint (`Run: fyl download '<url>'`) and nothing opened, so unknown link unfurlers and plain curl use up
  nothing. A whole one-time response ends like a ranged one (`ended()`, never `finishConsumed()`). Content-Disposition
  names `fyl-<ID[0:8]>.age`; a protected transfer's 401 hint reads `Run: fyl download '<url>'`. Page state adds `mode`,
  `head`, `meta` (same rule as the info route, null while locked) and `<html data-e2ee>`; E2EE pages send `name`,
  `type`, `ext` null and `risky` false (the page computes them after decryption); the CSP per [§9.5](#95-page-rules).
- **Unknown mode:** a record whose `mode` this server doesn't know answers 503 `unsupported_mode` on `/d/` (GET and
  HEAD; nothing opened or counted), its page says "This file needs a newer fyl.at" and starts nothing, and info returns
  no `e2ee`.
- **`/api/health`, `/config.js`:** add `e2ee` (true when `E2EE_ENABLED` is `"true"`).
- **Metrics and logs:** refusals count as `part_refused` with codes `part_changed`, `part_corrupt`, `head_mismatch`;
  never keys, heads, metas, IDs. Workers invocation logs are off (`observability.logs.invocation_logs: false`): they
  record every path, which can hold a raw name or a key pasted into the path. The structured console events carry no
  URL.

### 12.3 New error codes

These are added to `tests/vectors/errors.json`:

| Status | `code` | Class | Meaning |
| --- | --- | --- | --- |
| 403 | `e2ee_disabled` | permanent | E2EE uploads aren't enabled on this server |
| 409 | `part_changed` | permanent | a pin or `Content-MD5` differs from the part's pin: the file changed; the client aborts and starts a new upload |
| 502 | `part_corrupt` | retry | the stored part's MD5 differs from its pin; resend once, then stop (resumable) |
| 409 | `head_mismatch` | permanent | the completed object doesn't start with the init `head`; the upload failed |
| 409 | `encrypted` | permanent | an E2EE file requested without `?dl=1`, a grant or Basic; the hint names `fyl download` |
| 503 | `unsupported_mode` | retry | the transfer's mode needs a newer server |
| 401 | `password_wrong` | permanent | wrong password on the info route; `triesLeft` |
| 429 | `password_paused` | permanent | too many wrong tries; like `part_limit`, any status with this code is permanent; wait for Retry-After |

Rollback compatibility: records carry `mode`, and a missing `mode` means raw. Pre-2.4.0 code would serve E2EE objects
as raw files and its page would start downloads by itself, using up one-time links on ciphertext. So before
`E2EE_ENABLED` was first set, `ROLLBACK_FLOOR` was raised to 2.4.0 (history: the floor is 1.0.0 now), or to a 2.3.x that answers non-raw modes like the
unknown-mode rule above ([§17](#17-release-gating)). Later modes roll back safely to 2.4.0 by the same rule.

## 13. Error semantics

Client-side codes, which are not HTTP codes: `key_invalid`, `key_wrong`, `mode_mismatch`, `unsupported`, `corrupt`,
`truncated`, `trailing_data`, `network`. `key_wrong` comes only from stanza unwraps: both failing in the key check
([§9.1](#91-key-check)), or the one file of `fyl decrypt`. Every other failure is reported as damage, never as a wrong
key.

| Case | Code / response | Consumes a one-time link | Password try | Browser | CLI |
| --- | --- | --- | --- | --- | --- |
| key missing | — | no | no | key field | `FYL_KEY` or prompt; no terminal: 2 |
| key malformed (fragment or entry) | `key_invalid` | no | no | "This key is incomplete or damaged." | 2 |
| wrong key | `key_wrong` (non-consuming check) | no | no | "This key doesn't open this file. Check that you copied the whole link." | 1; a typed key may be retried |
| key given, transfer raw | `mode_mismatch` | no | no | "This link has a key, but the file isn't encrypted." | 1 |
| other version or stanza type, meta `v` | `unsupported` (found at the key check) | no | no | "This file needs a newer fyl." | 1 |
| bad head, meta, MAC, size or SUM; one stanza failing; served head ≠ verified head; bad chunk | `corrupt` | only if the download had started; retry from the same network ([§11](#11-passwords-and-e2ee)) | no | "The file is damaged or was changed. It can't be decrypted safely." | 1 |
| no final chunk | `truncated` | already open; retry as above | no | "The file is incomplete." | 1 |
| data after the final chunk | `trailing_data` | already open; retry as above | no | as `corrupt` | 1 |
| network retries exhausted | `network` | session idles 15 min; the same network may retry | no | "Download interrupted. Try again." | 1 |
| wrong password | 401 `password_wrong` | no | yes | error with tries left | ask again, or 1 |
| paused after wrong tries | 429 `password_paused` | no | — | wait message | 1 |
| quarantined | 403 `quarantined` | — | — | page `gone`, reason `quarantined` | 1 |
| gone | 404 `not_found`; 410 `expired`, `consumed`, `deleted`, `removed`, `unavailable` | — | — | page `gone` with the reason | 1 |
| still uploading | 503 `uploading` | — | — | waits | waits |
| mode unknown to the server | 503 `unsupported_mode` | no | — | "This file needs a newer fyl.at." | 1 after retries |
| upload side | `e2ee_disabled`, `part_changed`, `head_mismatch`: stop; `part_corrupt`: resend once; `url` mismatch ([§2.2](#22-e2ee-link)) or file changed ([§8.2](#82-pre-send-check-clients)): stop, no link shown | — | — | message | 1; resume refusals 2 |

## 14. Server-visible data

| Data | Seen by the service (Cloudflare included, which terminates TLS) |
| --- | --- |
| Content and name | ciphertext, plus the generic name `fyl-<ID[0:8]>.age`; the name's length to a 512-byte bucket |
| Exact plaintext size | yes, `P(C)`; no padding (a non-goal), so a known file of distinctive size can be recognised |
| `head`, `meta` | yes; random-looking; public for unprotected transfers, like the ciphertext |
| KEY, recipient, file keys | never, unless a user puts the key into a path ([§9.5](#95-page-rules)) |
| Part MD5s and ETags | yes, of the ciphertext |
| Password | PBKDF2 hash at rest; plaintext during each check (as for raw) |
| Times, request sizes, networks (hashed for budgets, sessions and tries), user agents, flags, download counts | yes, as for raw |
| Whether two uploads hold the same file | no: keys are fresh |

## 15. Threat model

Assets: plaintext content, file name, KEY and password. Secondary: integrity of what a recipient saves, and
availability. Assumptions: the CLI binary and the page code as loaded are honest; the platform CSPRNG, age v1 and the
primitives are sound.

### 15.1 Honest-but-curious operator and storage

This covers Cloudflare, R2, Durable Object storage, logs and backups. They see [§14](#14-server-visible-data) and can't
read content or names. Offline guessing of PBKDF2 hashes yields access, not KEY. Residual: size (and with it
recognition of known files), timing, access patterns, name-length bucket, network metadata.

### 15.2 Active malicious server

Assumes honest client code. It can refuse, delete, delay, truncate, extend, reorder or substitute ciphertext, `head` or
`meta`, flip `mode`, fake `uploading`, lie in status and return any `url`. Clients detect blobs from another transfer
(`key_wrong`), the meta header used as the content head or meta served as content (SUM, [§5.4](#54-why-this-content)),
truncation, extension and reordering (STREAM), `mode` flipped to raw on a keyed link (`mode_mismatch`), a foreign `url`
([§2.2](#22-e2ee-link)) and missing pins at resume (refused). It can ignore password and one-time rules (server-side
controls); confidentiality still rests on KEY. It can't learn KEY and can't forge content: forging needs the recipient,
which only key holders can derive. Residual: the CLI resume case of [§8.5](#85-residual-risk); denial of service; when
and how often the file is fetched; a key holder colluding with the server can substitute content (no sender
signatures).

### 15.3 Network attacker

HTTPS only (TLS 1.2+, HSTS) protects transport. The fragment is never sent, and there is no Referer. Residual: traffic
analysis. A compromised TLS chain or edge belongs to [§15.2](#152-active-malicious-server) or
[§15.6](#156-compromised-javascript-delivery).

### 15.4 Malicious sender and reports

A sender may upload malware, phishing pages or illegal content that nobody can scan: mail gateways, link scanners and
the operator see ciphertext and a fyl.at page with a name the sender chose, and "encrypted" reads to many as "safe". So
every E2EE page carries the [§1](#1-goals-non-goals-claims) warning, and the risky-extension list moves to one vector
file shared by the Worker and the page, adding html, htm, xhtml, shtml, svg, mht, mhtml, one, library-ms, search-ms,
settingcontent-ms, desktop and scpt. Crafted names are validated ([§5.3](#53-validation)), and the CLI writes a single
path component inside the chosen directory, never a dotfile, with macOS quarantine ([§10](#10-cli-download)).
Malformed files from a modified client meet the server's shape and size checks and strict decoders that never allocate
by unauthenticated lengths (head and meta sizes are fixed or at most 2760 B). A file that fails only at the end, after
much output, stays unverified until then (temp file, failed browser download). More phishing reports and
domain-reputation incidents are expected; the operator answers them through the report queue, quarantine and
takedowns ([OPERATIONS.md](OPERATIONS.md#reports-abuse-and-incidents)).

Abuse handling relies on reports and quarantine or takedown by ID. The download page builds `/report?link=` from the
link without KEY, the report form strips fragments, and form and server refuse key material in the details, the name
or the email (a fyl link with `#` and 43 key characters, a KEY after `#`, `AGE-SECRET-KEY-1…`): "Don't paste the key
here." 2.4.0 has no channel for keys. The operator judges E2EE reports on plausibility (quarantine is reversible),
can't match re-uploads by content, and uses a key that reaches them anyway only with `fyl download` on an isolated
machine, never recording it in the case (OPERATIONS.md).

### 15.5 Malicious recipient

By design, a recipient can decrypt, keep and pass on plaintext and the link, and can use up a one-time link. They can't
delete the transfer or change its expiry (the management key is separate) and can't learn the password from the link.
Online password guessing is limited by 2.3.0's per-network and transfer-wide pauses.

### 15.6 Compromised JavaScript delivery

Browser E2EE trusts the code fyl.at serves. A compromised deployment, account or edge could serve code that sends KEY
or plaintext elsewhere, to any visitor, without the visitor noticing, and could persist after the fix in HTTP caches and
service workers. Against accidents and persistence, not against this: every page's CSP (`/d/`, and `/`, `/privacy`,
which hold or share the storage of keys, and the report form) names only fyl's own script paths, so Cloudflare-injected
`/cdn-cgi/` scripts can't run there, and HTML-injecting zone features stay off ([§17](#17-release-gating)), which
`npm run deploy` checks on the live pages; no analytics on any page; page and worker code is revalidated on every load,
so a fixed deployment takes effect on the next one; the service worker's path confines it to `/_dl/`. The deploy ships
`dist/e2ee/`, `download.js`, `_dl/sw.js` and `dist/vendor/` byte for byte and strips only whitespace and comments from
the site's other scripts and stylesheets, the upload page's included, keeping every name
([static assets](OPERATIONS.md#static-assets)): the source is public, so anyone can compare the served code with
`dist/` at the tagged commit and check what happens to KEY, and `scripts/smoke.py --pages` checks after every deploy
that the live files equal `dist/` byte for byte. The one third-party script,
Cloudflare Turnstile, runs only on the report form, which has its own origin since 2.4.0 (`https://report.fyl.at/`;
`fyl.at/report` answers 302 there), so it can't read what the browser keeps for fyl.at, keys remembered in
`localStorage` (opt-in) included; the report links of the upload and download pages also open the form in a new tab
without an opener.
Recovery from a compromise includes renaming every script path and sending `Clear-Site-Data`. Residual: complete
compromise for browser users. Whoever needs protection from the operator uses the CLI for both upload and download: a
fixed, versioned build (`/cli/<version>/` never changes once published) instead of code loaded on every visit. Its
binary and `SHA256SUMS` come from fyl.at (the installer fetches both there), so the installer alone is not
independent of the operator. The GitHub release `v<version>` of the public repository carries the same binaries and
`SHA256SUMS` from a second origin, and the build is reproducible from the public source, so anyone can compare the
two or rebuild; a checksum kept from an earlier download shows a later change too. Checksums signed out of band are
not there yet ([known limitations](ARCHITECTURE.md#known-limitations)).

### 15.7 Local device and carriers

KEY can end up in browser history, session restore, synced history and tabs (readable by the sync provider unless the
sync is end-to-end encrypted), bookmarks, the clipboard and clipboard managers, screenshots and screen sharing, and in
extensions with page access. Beyond the device the full link reaches whatever carries it: messenger servers, URL
shorteners, and mail link rewriters (Safe Links, URL Defense), which copy `#KEY` into a query string their servers
receive and log. Sending the link without key and the key through another channel avoids that. A command containing
the link lands in shell history and the process list; `echo '…#KEY' | fyl download -` keeps it out of the process list
only. Interactive input keeps it out of history: the key prompt, or `fyl download -` with the link pasted at the
terminal or piped from the clipboard (`pbpaste | fyl download -`); the same holds for the resume value
([§8.4](#84-resume)). `FYL_KEY` is readable by the same user and root. The pending entry keeps KEY only in
`sessionStorage` unless keys are remembered (opt-in). The temp file is 0600 while downloading; plaintext after the
download is the user's. No memory wiping is promised: JavaScript can't do it, and the CLI zeroizes key buffers only
where practical.

## 16. Test plan

Shared vectors run in the browser and Rust test suites with identical expected results. The Vitest suite runs in
`Checks` on every change. The Rust tests (`cargo test --locked`; locally `npm run test:rust`) run in its native job
whenever `cli-rs/`, its build inputs or `tests/vectors/` change, and weekly, and the interop tests there use a binary
built in the same job, not the committed one.

Vector files: `tests/vectors/e2ee/*.json`, read by vitest and by Rust under `cfg(test)` only. Encryption vectors fix
`identity` and, per age file, `file_key`, `eph` and `nonce`; plaintext byte i is `i mod 251`; they give the expected
`head` and `meta`, the SHA-256 of the whole ciphertext and each part's SHA-256 and MD5 (its pin), with full hex only for
C ≤ 1 MiB (the part-boundary-inside-a-tag case has C of 52,428,801–52,428,816). The 67 CCTV files are vendored from the
pinned commit with a manifest (file SHA-256, expected code, payload hash); the 19 `stream_*` ones are zlib-compressed
(inflated with `node:zlib` and the Rust dev-dependency `miniz_oxide`).

| Area | Tests |
| --- | --- |
| E2EE (nonce reuse, changed resume file, missing final chunk, replay, false metadata, browser limits) | Encryption vectors for P = 0, 1, 65535, 65536, 65537, 131072, a size whose part boundaries fall inside a chunk and one inside a tag, with each part's slice. CCTV per [§4.3](#43-reference-vectors-c2sp-cctv). Header order: no LF in 184 bytes, a short file with another version or stanza type (`unsupported`). Negative vectors: chunks swapped or duplicated, final flag on a middle chunk, cut at a chunk boundary, extra chunk, another transfer's head, meta as content, head swapped for meta's (SUM), one stanza damaged with the other valid (`corrupt`), both wrong (`key_wrong`), meta non-canonical / duplicate member / unknown member / bad padding / bad name / size mismatch / `v: 2` / `\ud800` / `A` / `\/` / raw U+202E / raw C0 / 1025-byte name, non-canonical KEY. Sender normalisation: lone surrogate, forbidden code points, dots only, 1025-byte name. Worker: pin route (first value stored, same 200, other 409); part unpinned → 400, other MD5 → 409, both before R2; concurrent slots; ETag ≠ pin → 502 with the slot freed; status lists pins; forged part 1 → 409 `head_mismatch`, object deleted; meta reusing head's share, body or nonce → 400. Clients: a buffer differing from the pin or local record is never sent (file changed between resume check and send; a second concurrent CLI resume gets 409 at the pin and sends no body); the browser sends nothing when its record write fails; `NotReadableError` → file changed; resume refused for a changed sent part (CLI, browser), for a confirmed part without pin and without hex ETag, and for status without pins; refusals don't abort. Browser matrix of [§9.4](#94-limits); the fallback cap refuses before consuming. |
| E2EE upload choice | Encryption option on and off (web); `--encrypt` (CLI); raw stays the default (existing tests); curl/wget raw download; password on/off × mode; resume keeps the mode (mismatching flags refused); init response without `mode` → client aborts before any part; a fake server returning a foreign host or an http `url` (init, receipt) → no link shown or printed anywhere; `filename` with E2EE → 400; init with E2EE off → 403; fingerprint replay with another head → 409. |
| Raw direct link with name | Unprotected raw receipt `url` includes the name, a protected one's is `/d/ID` without it; names with space, Unicode, `#`, `?`, `%`, `'`; a wrong segment serves by ID with the authoritative name; old `/d/ID` links; Range; the locked page, API and 401 never reveal the name. |
| E2EE share link | Fragment is exactly KEY; no name in the path; missing or empty fragment → key entry (both clients); invalid → `key_invalid`; full link and age identity accepted in key entry, another transfer's link refused; reload, skip link, early protected upload completing and `hashchange`, each followed by a reload, keep the key; a verified typed key survives a reload; `%23` link → key used, address cleaned, warning shown (CLI: the same warning); a KEY-shaped segment is ignored like any segment; the CLI requests neither path; navigation to `?dl=1` or `?grant=` on a one-time E2EE transfer → page, info still shows no download; non-navigation GET without `?dl=1` → 409 `encrypted`, nothing opened; key field attributes, no password-save pairing; `document.title` never holds the name; an `.html` payload never runs script via the service worker or the Blob; copy actions per [§2.5](#25-sender-copy-actions-and-storage). Playwright network capture over the whole flow (upload, page load, keyless link, typed key, password, service-worker download, report link) asserts that KEY and `#` appear in no request URL, header or body, and that no third-party request occurs; it also runs on staging on the real zone. Post-deploy smoke check: a production `/d/` page has exactly the expected scripts and CSP. The report form and API refuse key material in the details, the name and the email. The management link has no KEY; the share link has no management rights. |
| E2EE in the Rust CLI | Browser→CLI and CLI→browser in CI against the local Worker (1 B, 64 KiB, 50 MiB + 1 B, two parts). Wrong key: exit 1, nothing consumed. Damaged head, missing final chunk and trailing data (fake server). Full disk found by `statvfs` before consuming; `RLIMIT_FSIZE` or a small tmpfs during the download: temp file removed, exit 1. A name with `:` on a vfat loop mount → exit 1 before consuming; rename via the placeholder fallback there; a rename failure after verification keeps the temp file. SIGINT: temp file removed, exit 130. `.bashrc` saved as `_bashrc`; macOS quarantine attribute set. Names with shell metacharacters; unknown version; existing target → 2; no terminal and no `FYL_KEY` → 2; link from stdin. No output on any path contains KEY. `fyl decrypt`: success, wrong key (`key_wrong`), truncated, existing target. |
| Password plus E2EE | All four combinations. Wrong password with a valid key → no ciphertext. Right password without a key → key prompt, nothing consumed. A wrong key never changes the try counters. Basic on the info route counts tries and sends no `WWW-Authenticate`; the page's Basic from memory carries a range resume after more than an hour. One-time: the key check happens before the session opens (info still shows no download); after a fully delivered one-time E2EE download, a Range retry from the same network within 15 minutes → 206, from another network → 410; `done` closes it at once. |
| E2EE recovery | Upload interrupted with KEY (resume works), with KEY only in another tab or after closing the browser (asks for the link, then resumes) and without it (refused; assert that no Durable Object field holds a key); changed source file; download restart with Range/If-Range; another network on a one-time link → 410; service worker installing or unregistered at the click, download denied, or no `pulled` within 10 s → no `GET /d/` observed and the link still opens; cancel in the download UI aborts the fetch; "verified" only after the stream closed; a record with an unknown `mode` → 503 `unsupported_mode`, nothing consumed. |
| Optional standard tools | `age -d -i` decrypts CLI and browser output (optional CI job with the distribution's `age`). Identity-string vectors: encode, decode, upper/lower case, bad checksum, wrong HRP, wrong length. |

## 17. Release gating

**Switch.** `E2EE_ENABLED`: `"true"` in the production `wrangler.jsonc`, in tests and in local dev: E2EE is on for
everyone from 2.4.0. The variable stays as an emergency switch: it gates only new E2EE inits
(403 `e2ee_disabled`) and the upload page's Encryption option (via `/config.js`). Existing E2EE transfers stay
downloadable and resumable when it is off, so switching it off never strands files.

**Before the 2.4.0 deploy (E2EE on):** this document reviewed; shared vectors and the CCTV runs pass in both
implementations; the CI jobs of [§16](#16-test-plan) green, interop both ways; password/E2EE tests green; `fyl decrypt`
shipped; the browser matrix of [§9.4](#94-limits) measured and recorded, with limits set to what was measured; the
threat model accepted; an independent cryptographic review of this document and both implementations at their exact
library versions (browser: WebCrypto, including its X25519, plus vendored `@noble/ciphers` 2.4.0; Rust: RustCrypto
`chacha20poly1305`, `hkdf`, `hmac`, `sha2`, `md-5`, and `x25519-dalek`), every finding fixed or accepted in writing.
Zone and operations: HTML-injecting zone features off for fyl.at (Bot Fight Mode and JavaScript detections, Rocket
Loader, Email Address Obfuscation, Web Analytics auto-injection, Zaraz), no WAF or rate-limit rule with a challenge
action on `/d/*`, Network Error Logging off (its reports carry full URLs), Workers invocation logs off, the post-deploy
`/d/` smoke check in the deploy pipeline (`npm run deploy` runs `scripts/smoke.py --pages`, which checks every page's
CSP and scripts on the live site and that the code kept as written is served byte for byte; `npm run smoke` adds an
encrypted round trip), `ROLLBACK_FLOOR` raised
([§12.3](#123-new-error-codes)). PRODUCT.md,
CLI-API.md, SECURITY.md, OPERATIONS.md (E2EE reports, [§15.4](#154-malicious-sender-and-reports)) and the privacy page
updated. The privacy page states: unprotected raw links put the name into every request path (protected ones carry none); E2EE
transfers store a generic name, the exact size, `head`, `meta` and pins until cleanup; the browser keeps keys in
`sessionStorage` (in `localStorage` only on opt-in) and upload MD5 records in `localStorage`; one-time E2EE links stay
open up to 15 minutes after delivery for retries; report details refuse keys. E2EE shipped without two of these
gates: the browser matrix (until it is measured, [§9.4](#94-limits) keeps every engine but Chromium on the in-memory
fallback) and the independent cryptographic review; both stay open ([known limitations](../SECURITY.md#known-limitations)).

**After the deploy.** No pilot and no "Preview" label: the option shows for everyone. Watch `part_changed`,
`part_corrupt`, `head_mismatch` and E2EE error rates; stopping new encrypted uploads means switching the variable off.

**Rollback.** Switch off first. Once E2EE transfers may exist, no Worker below the raised floor is deployed
([§12.3](#123-new-error-codes)); a ciphertext copy that escaped anyway stays usable with `fyl decrypt`.

**Format changes.** A new age version line or stanza type makes older clients answer `unsupported`, as does a new meta
`v`. The profile in this document is frozen once the switch is on.

## 18. Design decisions

| Question | Decision | Reason |
| --- | --- | --- |
| Format | age v1, one X25519 stanza, STREAM with 64 KiB chunks | Standard with test vectors and audited libraries on both sides. Counter nonces allow parallel parts and chunk-aligned resume (libsodium secretstream is stateful). A standard-tool path comes for free. |
| Chunks vs 50 MiB parts | Parts are fixed 50 MiB slices of the ciphertext; chunks straddle part boundaries | Server part logic unchanged; each part computed independently in any order; memory is one part buffer. |
| Memory | One part buffer each; CLI `--workers` (≤ 400 MiB at 8); browser 2 parts, one worker each | Bytes sent = bytes hashed (§7). |
| Empty file | Format: C = 200; uploads refused like raw | Product rule unchanged; decoders still accept it (CCTV). |
| Last chunk exactly 64 KiB | Flagged final, no empty chunk; decoders try non-final, then final | age spec and reference behaviour. |
| Maximum size | C ≤ 50 GiB, so P_max = 53,673,987,000 B | Budgets and parts count stored bytes; 1,024 parts. |
| `Content-MD5` | Required on E2EE parts, RFC 1864 base64, equal to a pin set before the body | §8. |
| Resume state | KEY (`sessionStorage` unless remembered, re-entry possible) plus server pins; CLI also MTIME in the resume value; browser keeps a local MD5 per part, written before sending | No mtime or sample in the shared metadata (it would leak to recipients); pins are stronger than a sample. |
| Metadata | `{v, name, size, headSha256}` padded to 512 B, as a separate age file | The binding closes the head-swap attack; padding hides the name length. |
| Links | Clients build keyed links from their own origin and the ID | KEY never lands on an origin the server chose. |
| Service-worker download | The page decrypts; the worker only relays (`/_dl/sw.js`, no key) and the consuming request waits for the browser's first pull; Blob fallback ≤ 256 MiB; every engine but Chromium (iOS included) on the fallback until measured | Smallest keyless worker; nothing consumed before a save is possible; honest limits. |
| Protected E2EE page | `head`/`meta` only after authentication; the page sends the password as Basic from memory, never navigating | "Protected metadata only after authentication"; key checked before consuming; no grant expires mid-download; KEY never crosses a navigation. |
| One-time E2EE | Full delivery doesn't close the link; 15-minute idle window or `done` | Retries within the session; the server can't see decryption anyway. |
| Error semantics | §13 | Wrong key only when both stanzas fail; damage never reported as a wrong key; password and crypto errors kept apart. |
| Switch | On for everyone; `E2EE_ENABLED` stays as an emergency switch that gates only new E2EE uploads | Switching it off never strands files. |

## Review notes

Where the adversarial review of 2026-10-30 proposed a different fix than the one above:
- Pins vs the wire: instead of a CLI single-run lease, every part is pinned by a body-less request before its body is
  sent ([§8.3](#83-pins-server-e2ee-only)); that also covers concurrent resumes, failed pin writes and rollback windows.
- `key_wrong` with two files: "both unwraps fail" rather than "head first, any meta failure corrupt"; it doesn't depend
  on opening order and never blames a correct key for a damaged blob.
- One-time links after delivery: the session stays open for retries rather than retries being limited to interrupted
  transfers ([§11](#11-passwords-and-e2ee)).
- Meta byte rule: "every 0x5C is followed by 0x22", not "by 0x22 or 0x5C"; NAME has no `\`, and the latter would fail
  the second byte of `\\` anyway.
- CCTV set: 67 vectors (`hybrid_x25519_arg` included, `corrupt` by step 4), not the "exactly one identity" filter (66);
  the revised header order changes no CCTV code.
- Grant renewal: E2EE pages use Basic from page memory, the CLI's model, rather than a new grant route.
- Cached code: revalidation (`no-cache`) rather than SRI, because worker scripts can't carry SRI.
- Typed keys: kept in `sessionStorage` once verified, like the sender's keys, rather than memory only; keys may stay
  for the session.
- Report keys: no separate key field in 2.4.0; refusal plus an operator rule.
- Saved names: trailing dots and spaces stay; the CLI runs on macOS and Linux, where only a leading dot hides or
  activates a file.

From the second review (conformance, misuse, robustness):
- KEY-shaped path segments: never a key ([§2.4](#24-key-entry)), rather than a key with a warning; raw links carry their
  NAME there, and `fyl download` parses raw and E2EE links alike.
- Download retries: the browser core resumes the same decryptor through an `open(offset, error)` callback and leaves
  the retry policy (count, backoff, `If-Range`, 206) to the page, rather than running the Range retries itself.
- `maxPlaintextSize`: an exact midpoint up to 2^53 − 1, equal to the Rust result, rather than an extra clamp on the
  server's limit, which would make the two cores disagree.

## Interoperability evidence

Recorded 2026-10-30 on a Linux machine (Ubuntu 24.04, x86_64) for the cores of this commit. Browser: `dist/e2ee`
(WebCrypto, vendored `@noble/ciphers` 2.4.0) on Node v22.23.1 and in the vitest Workers runtime. Rust:
`cli-rs/src/e2ee.rs`, rustc 1.99.1, `chacha20poly1305` 0.10.1, `x25519-dalek` 2.0.1, `hkdf` 0.12.4, `hmac` 0.12.1,
`sha2` 0.10.9, `md-5` 0.10.6. Reference: `age`/`age-keygen` 1.1.1 (`apt-get download age`, Ubuntu
`1.1.1-1ubuntu0.24.04.3`, `.deb` SHA-256 `22ed034e16d8a7662d94dbb8d9f644f01284c6d87bc6b619903e38ba91125337` as in the
archive index, `dpkg-deb -x` into a scratch directory) and `age`/`age-keygen` v1.2.1 (`go install
filippo.io/age/cmd/...@v1.2.1`, go1.24.13 in `golang:1.24`, module `h1:X0TZjehAZylOIj4DubWYU1vWQxv9bJpo+Uu2/LGhi1o=`
verified against sum.golang.org).

**CI, without the reference binary.** `tests/vectors/e2ee/cross/{browser,rust,age}.json`, 8 vectors each, written once
by `node scripts/e2ee_interop.mjs write --age AGE… --keygen AGE_KEYGEN…` through each producer's production path:
browser `prepareUpload` and `encryptPart`; Rust `Identity::generate`, `AgeFile::create`, `new_meta` and `encrypt_part`
(ignored test `cross_write`); reference `age -r` over the plaintext and over the §5.1 text, to identities from the
browser core or from either `age-keygen`. Identities, plaintext seeds and transfer IDs are random; P = 1, 1000, 65535,
65536, 65537, 131072, 200003 and 1060921 with test part sizes from 100 to 262144 (boundaries inside the head, inside
chunks and inside a tag, up to 12 parts); names with `"`, Unicode, forbidden code points and the 2760-byte meta of 1024
quotes. `cargo test --locked e2ee::` (`cross_vectors`) and `npx vitest run tests/e2ee-core.test.ts` ("E2EE
interoperability") check every file: KEY, age identity string and recipient in both directions; the keyed link as
`shareLink()` and `share_link()` build it, parsed to ID and KEY, and every key-field form (KEY, link, `%23` form,
identity string in either case, padded with ASCII whitespace; another transfer's link refused); name normalisation; the
key check on head and meta; every part rebuilt from the producer's head with equal SHA-256, MD5 pin and `Content-MD5`,
and full bytes where C ≤ 4096; decryption to the plaintext, streamed with the verified head and whole with the
identity. All 24 pass in both suites; one changed digit in a recorded part MD5 fails both.

**CLI 1.0.0.** Re-checked 2026-11-09 after the Rust core moved to `chacha20poly1305` 0.11.0, `x25519-dalek` 3.0.0
(`curve25519-dalek` 5.0.0), `hkdf` 0.13.0, `hmac` 0.13.0, `sha2` 0.11.1 and `md-5` 0.11.0: `cargo test --locked`
passes every vector above (cross, CCTV, content, decrypt, key check, layout, link, meta, name) and the folder-zip
vectors: the vectors passed unchanged with the 1.0.0 crate versions, no file was rewritten. The oracle and 1 GiB runs below were not repeated.

**Locally.** `node scripts/e2ee_interop.mjs oracle --age AGE… --keygen AGE_KEYGEN…`: age 1.1.1 and v1.2.1 decrypt the
content and the meta of all 16 browser and Rust vectors to the exact plaintext, and both `age-keygen -y` give every
recorded recipient. That both cores decrypt reference output is the `age.json` part above (4 vectors per age version).
age's output fits the profile as is: one stanza, a 168-byte header, and a full final chunk for P = 65536.

`node scripts/e2ee_interop.mjs big --age AGE…` over 1 GiB of random data, peak RSS from `/usr/bin/time` (idle: Node
42 MiB, 53 MiB with `dist/e2ee` loaded; the Rust test binary 3 MiB):

| Step | Time | Peak RSS | Plaintext |
| --- | ---: | ---: | --- |
| browser `prepareUpload`, `encryptPart` per 50 MiB part (1 MiB reads) | 9.0 s | 175 MiB | |
| Rust `decrypt` (streaming) | 2.0 s | 3 MiB | identical |
| Rust `encrypt_part` per 50 MiB part | 2.5 s | 54 MiB | |
| browser `decryptReadable` (1 MiB pull reads) | 9.3 s | 98 MiB | identical |
| `age -d`, 1.1.1 / v1.2.1, of the browser file | 1.3 / 1.2 s | 16 / 11 MiB | identical |
| `age -d`, 1.1.1 / v1.2.1, of the Rust file | 1.3 / 1.2 s | 16 / 19 MiB | identical |
| `age -r`, v1.2.1, to a browser-core identity | 1.1 s | 6 MiB | |
| browser `decryptReadable` of the age file | 9.6 s | 98 MiB | identical |
| Rust `decrypt` of the age file | 1.9 s | 3 MiB | identical |

At 256 MiB the decryption peaks are the same (98 and 3 MiB) and encryption takes 157 and 54 MiB: memory follows the
part and chunk sizes, not the file size. Node stands in for the browser here; the browser matrix of
[§9.4](#94-limits) is still open. No mismatch was found between the cores or between either core and the reference age.

**End to end on the local Worker.** Recorded 2026-10-30 against `npm run dev -- --port 4300` (E2EE on,
`PUBLIC_BASE_URL` the local origin) with headless Chromium 156 (Playwright 1.64.1, every host but 127.0.0.1 unresolvable),
the CLI built from this commit (`cargo build --release`) and `age` 1.1.1 from the archive as above. Files: 1 KiB and
120 MiB of random data (3 parts). Every case compared SHA-256 of the result with the source:

| Case | Result |
| --- | --- |
| Browser encrypts (1 KiB, 120 MiB) → `fyl download '<link#key>'` | identical |
| `fyl FILE --encrypt` (1 KiB, 120 MiB) → download page, service-worker path | identical, "Decrypted and verified, saved by your browser as …" |
| Same, service workers blocked (in-memory fallback), one-time | identical; `/done` sent, link 410 `consumed` afterwards |
| Password both ways: page unlock (Basic to the info route and on `?dl=1`), `FYL_PASSWORD` for the CLI | identical; no password: exit 2; wrong: exit 1 with tries left |
| Link without key: key field plus password | wrong key → `key_wrong`, right key → identical |
| One-time: wrong key in the page, in the link and in `FYL_KEY` | nothing consumed (info `ready`, `downloads` 0) |
| One-time: right key (page; CLI) | identical once; second attempt: page "This link was used", CLI exit 1 |
| curl `-OJ '?dl=1'` → `age -d -i key.txt` and `fyl decrypt` (browser and CLI uploads) | identical; saved as `fyl-<ID[0:8]>.age`; curl without `?dl=1` gets 409 |
| Browser upload interrupted after a part: reload (key in the tab); new tab with the link pasted | resumed under the same link, identical |
| CLI upload, SIGINT after a part: `--resume -` with `ID.TOKEN.KEY.MTIME`; with `ID.TOKEN.MTIME` and `FYL_KEY` | identical |
| Early link while the browser upload runs (also protected): page and `fyl download` wait | identical |
| Download cut after 30 MiB by a proxy in front of the Worker: page (plain, one-time, protected) and `fyl download` (E2EE, E2EE one-time, raw) | continued with `Range: bytes=31399592-` (184 + 65552·479; raw: the bytes written) and `If-Range`, 206, identical |
| Raw spot check: named link, curl `-OJ`, Range 206, protected `/d/ID` with 401 `WWW-Authenticate` and `-u`, one-time 410, page button, key-shaped fragment on a raw link | as 2.3.0; the keyed raw link shows "This link doesn't fit the file" |

Every request of every browser session was recorded (URL, all sent headers, and the bodies Playwright exposes; part
bodies are Blobs it doesn't expose, so the stored ciphertext they add up to was searched instead): no KEY anywhere, no
`%23` or `#` in a URL or header, no `/d/ID#…` in a body, no host other than 127.0.0.1:4300. The Worker's request log
holds no `#` or `%23` and none of the cases' keys, and no stored ciphertext contains KEY or the identity string.

**Re-run after the review fixes** (2026-10-30, `npm run dev -- --port 4320` with the Worker serving every page's
policy, a cut-and-throttle proxy in front of it, headless Chromium with Playwright 1.64, the CLI built from this commit),
each result compared by SHA-256 with its source:

| Case | Result |
| --- | --- |
| Browser encrypts 1 KiB and 60 MiB under the upload page's new policy → `fyl download '<link#key>'` | identical; link, key row and command carry `translate="no"` |
| `fyl FILE --encrypt` (1 KiB, 60 MiB) → page, streaming path | identical; while it ran the button kept keyboard focus (`aria-disabled`) and the keep-open line showed |
| Service workers blocked, one-time | in-memory fallback identical; `/done` sent, 410 afterwards |
| Page closed 2 s into a throttled 20 MB service-worker download | the browser's download failed after 30 s (before: still open after 420 s) |
| Connection cut after 1 MB | continued with `Range: bytes=917912-` (184 + 65552·14) and `If-Range`, identical |
| `/e2ee/age.js` blocked while the key is checked | "Couldn’t load the decryption code…", title "Encrypted file"; *Try again* reloaded with the key and opened the file |
| WebCrypto X25519 refused | "This browser can’t decrypt files", no key field, the terminal command with the key |
| `/_dl/sw.js` delayed 3 s, click at once | the click waited for the worker and streamed (before: in-memory or "up to 256 MB") |
| `/`, `/report`, `/privacy`, a raw download page | no CSP violation; `scripts/smoke.py`'s page check passed against the local Worker |

Across these 408 requests no URL, header or body held a key, `#` or `%23`, no host other than the two local ports was
asked, and no policy violation was reported.

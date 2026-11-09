# Folder upload as one zip, profile `fyl-folder-zip-1`

Status: specification for the browser (`dist/app.js`, `dist/api.js`, `dist/zip.js`, §12) and the Rust CLI (`cli-rs/src/folder.rs`, [CLI.md](CLI.md#folders)). Both implement it and are checked against the vectors.
MUST/SHOULD/MAY as in RFC 2119/8174. Reference implementation: `scripts/folder_zip.py` (stdlib only); test vectors:
[tests/vectors/folder-zip/](../tests/vectors/folder-zip/README.md); CLI: [CLI.md](CLI.md#folders).

A folder becomes **one file on fyl.at**: one file per link stays the product rule. The client builds a deterministic,
uncompressed (STORE) ZIP/ZIP64 stream from the folder and uploads it like any file named `<folder>.zip`. Because nothing
is compressed and every byte follows from the folder, the client knows the exact size before `/api/upload/init`
(multipart needs it), can build any 50 MiB part on its own in any order, and rebuilds every part byte for byte on
resume. Passwords, one-time links, expiry, E2EE ([E2EE.md](E2EE.md): the zip is the plaintext), receipts and resume
tokens are unchanged. **No server change**: the server sees a file named `<folder>.zip` of a given size.

Notation: integers little-endian; `0x…` hex; sizes binary (GiB = 1024³ bytes); `n` the UTF-8 byte length of an entry's
path, `s` its size; `[x]` is 1 if x holds, else 0. `U16 = 0xFFFF`, `U32 = 0xFFFFFFFF`.

## 1. Goals and non-goals

Goals: one rule set for both clients, so the same folder gives the same bytes (vectors bind both); size before reading
content; random access by part; resume that notices a changed folder; safe names in the archive; every common unzip opens
it (Info-ZIP `unzip`, Python `zipfile`, Windows Explorer, macOS Archive Utility, 7-Zip, libarchive).

Non-goals: compression (most large folders are already-compressed media, and compression would make the size unknown
before reading); empty folders, symlinks, permissions, owners, extended attributes, resource forks or ACLs; archive
comments; encryption inside the zip (E2EE encrypts the whole zip); several folders or a folder plus files in one upload;
a server-side zip.

## 2. Collecting the folder

### 2.1 Walk

The client walks the folder recursively. Each item is a **regular file** (an entry), a **directory** (descended into, no
entry of its own), a **symlink** or a **special file** (FIFO, socket, device; both skipped, reason `symlink` /
`special`). Symlinks are never followed, also not to folders (no loops, nothing from outside the folder). The folder the
user named MAY itself be a symlink: the CLI resolves it (`realpath`), like `find -H`.

- **CLI:** walks by directory handles: each folder is opened inside the one that listed it (`openat` with
  `O_NOFOLLOW | O_DIRECTORY`) and must still be the folder (device, inode) that listing saw; its items come from that
  handle (`fdopendir`, `fstatat` without following), size and mtime from it. Every later read of a file (pre-pass,
  parts) opens it the same way, folder by folder from the root's handle and the file itself with `O_NOFOLLOW`, and
  checks its device and inode, size and mtime against the walk. So a folder swapped for a symlink after it was listed
  stops the run instead of bringing in files from outside the folder. A folder that is also one of the folders it is
  in (a bind mount of a folder above it) stops the run as a loop. Hidden files (`.git`, `.DS_Store`) are files
  like any other: there is no exclusion list, because both clients would have to share it. Another file system mounted
  inside is walked like the rest. An item that can't be listed, opened or read stops the run with its path (exit 2), so a
  zip never misses a file silently.
- **Browser:** `<input type="file" webkitdirectory>` lists files with `webkitRelativePath` (`root/sub/a.txt`); dropping
  one folder gives a `FileSystemDirectoryEntry` (`webkitGetAsEntry()`), whose reader MUST be called until it returns an
  empty batch (Chromium returns 100 entries at a time). Browsers don't expose symlinks or special files: they list what
  they resolve as files. So a folder with symlinks can give a different zip in the browser than with the CLI; that is
  accepted, since a browser upload is never resumed by the CLI or the other way round. A drop of exactly one folder
  becomes a zip; anything else keeps today's one-file behaviour. iOS can't pick folders.

### 2.2 Root

Every entry path starts with the **root**, the folder's own name, so unzipping gives one folder, not loose files. The
root is the last component of the resolved path (CLI: `fyl .` uses the current folder's name) or the first segment of
`webkitRelativePath` / the dropped entry's `name` (browser), cleaned by [§2.3](#23-names). If it is skipped by those
rules (or `/` has no name), the root is `folder`. The upload's file name is `<root>.zip` (at most 259 bytes, within the
server's 1024; it passes the server's raw-name rule and E2EE §5.3 unchanged).

### 2.3 Names

Each path component as the platform gives it (bytes on Unix, UTF-16 in the browser and on Windows):

1. Not valid Unicode (Unix bytes that aren't UTF-8, a lone surrogate) → skip (reason `name`).
2. Drop bidi controls U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069: the server's rule for file names
   (`src/index.ts`, upload init), so `invoice_<RLO>fdp.exe` can't pose as `invoice_exe.pdf` inside the zip either, and
   WhatsApp exports (`‪+43 …‬`) keep their files.
3. Skip (reason `name`) a component that is then empty or only dots and spaces (`.`, `..`, `...`, `. `, `.. `, ` ..`:
   Windows strips trailing dots and spaces, so `.. ` could become `..` in an extractor that relies on that), contains
   `/` or `\` (a separator for Windows extractors: zip-slip), a C0 or C1 control (U+0000–U+001F, U+007F–U+009F) or
   U+2028/U+2029, or is longer than 255 UTF-8 bytes. A skipped directory is listed once and not descended into.
4. Nothing else changes: no Unicode normalisation, no case folding, no replacement characters.

Names Windows reserves for devices are **not** refused or changed: `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
`LPT1`–`LPT9` (also with an extension, `nul.txt`, and the superscript digits `COM¹`–`COM³`), and names ending in a dot
or a space (`notes.`, `draft `), which Windows strips. They are valid on every other system and in the zip format, so
both clients keep them byte for byte; a Windows extractor renames or refuses them (Explorer says it can't create the
file, 7-Zip writes `_CON`). A client MAY add a device check that only warns; it MUST NOT change the bytes.

**No NFC normalisation**, deliberately: (a) the names stay exactly what the sender's system shows; (b) a name never
changes, so two entries in the zip are never equal unless rule 2 merges them (refused as `collision`); (c) normalisation
tables differ between Unicode versions (the browser's ICU, the Rust crate), which would break byte-identical output
across clients; (d) neither Finder's *Compress*, Windows nor Info-ZIP normalises. APFS keeps names as typed (usually
NFC); old HFS+ volumes give NFD names, which then reach the zip in NFD, as with every other zip tool. Linux can hold
`ä.txt` in NFC and NFD side by side: they stay two entries (vector `names`).

Entries that differ in the zip can still meet when unzipped: names that differ only in case (`README.txt`,
`readme.txt`) on Windows and macOS, only in Unicode normalisation on macOS (APFS and HFS+ ignore it) and with
libarchive/bsdtar on Linux (which folds names to NFC when extracting, so an NFD name also comes out in NFC), and only in
trailing dots or spaces (`a.`, `a `, `a`) on Windows. There one file overwrites the other or the extractor asks. Such
folders come from case-sensitive Linux file systems; a client MAY warn about them, like the device check above; it MUST
NOT refuse them or change the bytes, which the vectors pin.

Entry path: `root + "/" + c₁ + "/" + … + "/" + name`, `/` separators, no leading or trailing `/`, at most **4095 UTF-8
bytes** (Info-ZIP `unzip` truncates longer names; one byte below Linux's `PATH_MAX`); a longer path is skipped (reason
`name`). A folder whose path is longer than 4093 bytes can hold no file that fits (`/` and a name of one byte): it is
skipped as a whole (reason `name`), like a folder with an unsafe name, and not walked into (vector `lengths`). The
limit is on the path in the zip, not on disk: the CLI reads every file folder by folder from the root's handle, so a
file whose absolute path is longer than `PATH_MAX` (a deep folder under a long home path) is read like any other.
Windows extracts paths over 260 characters only with long-path support; that is the extractor's limit, not ours.

### 2.4 Order

Entries are sorted by the **bytewise order of their UTF-8 paths**. Browsers MUST compare encoded bytes, not JS strings:
`<` and `localeCompare` order UTF-16 code units, which puts U+1F600 before U+FF5E; UTF-8 puts it after (vector `names`).
Rust's `str` order is bytewise. Because `/` (0x2F) is just a byte, `a-b.txt`, `a.txt`, `a/b.txt`, `a0` is the order; a
folder's entries stay contiguous (prefix property).

### 2.5 Skipped items

The client tells the user what it left out before the upload starts: CLI one line on stderr (`Skipped 2 symlinks and 1
file with an unsafe name.`; with `--verbose` one line per path, escaped), browser one quiet line under the size. Skipped
items never stop the upload.

### 2.6 Refusals

Checked in this order after the walk; each refuses the whole folder before anything is read or sent (CLI exit 2):

| Code | When | Message (CLI; the browser says the same) |
| --- | --- | --- |
| `empty` | no entries (also when everything was skipped) | The folder has no files to send. |
| `too_many` | more than **100,000 entries** | The folder has more than 100,000 files. Zip it yourself or send it in parts. |
| `collision` | two paths equal after [§2.3](#23-names) rule 2 (they are adjacent after sorting), or a file's path is also the folder of another entry (a file `a<U+200E>` next to a folder `a` gives `root/a` and `root/a/b`, which are not adjacent when `root/a-b` sorts between them); PATH is the first such path in zip order | Two items in the folder would get the same name: PATH. |
| `too_large` | the zip size ([§6](#6-size-formula)) exceeds the limit: `maxFileBytes` (50 GiB) raw, P_max (53,673,987,000 B, [E2EE.md §6](E2EE.md#6-ciphertext-layout)) with E2EE | The folder makes a zip larger than 50 GB. |

The entry limit is not a format limit (ZIP64 holds 2^64): it bounds the client's entry list and the browser's file
handles. 100,000 files with short names make a central directory of about 10 MB. Both clients stop walking once they
have more than 100,000 entries (the CLI lists no further folder, the browser opens no file), so a huge tree is refused
without being walked to the end. The CLI also stops past 100,000 folders to walk into (a tree of empty folders) and
refuses the folder: "The folder has more than 100,000 folders. Zip it yourself or send it in parts."

## 3. Byte layout

```text
[local header 1][data 1] … [local header N][data N] [central header 1] … [central header N] [ZIP64 end record + locator]? [end record]
```

No data descriptors (general-purpose bit 3 is never set): sizes and CRC are in the local header, which is why the CRC
pre-pass exists ([§7](#7-building-and-verifying)). No archive comment, no encryption headers, no "digital signature",
single disk. An entry is **large** if `s ≥ U32`, **far** if its local header offset `o ≥ U32`. An entry is a **ZIP64
entry** if it is large or far.

### 3.1 Local file header (30 bytes + name + extra)

| Offset | Size | Field | Value |
| ---: | ---: | --- | --- |
| 0 | 4 | signature | `0x04034B50` |
| 4 | 2 | version needed | 45 for a ZIP64 entry, else 20 |
| 6 | 2 | flags | `0x0800` (bit 11: name is UTF-8), always, also for ASCII names |
| 8 | 2 | method | 0 (STORE) |
| 10 | 2 | mod time | DOS time ([§5.1](#51-modification-time)) |
| 12 | 2 | mod date | DOS date |
| 14 | 4 | CRC-32 | of the data (ISO-HDLC, zlib's `crc32`); 0 for an empty file |
| 18 | 4 | compressed size | `U32` if large, else `s` |
| 22 | 4 | uncompressed size | `U32` if large, else `s` |
| 26 | 2 | name length | `n` |
| 28 | 2 | extra length | 29 if large, else 9 |
| 30 | n | name | the UTF-8 path |
| 30+n | | extra | if large: ZIP64 `0x0001`, length 16, `s` (8), `s` (8); then always UT ([§3.3](#33-extra-fields)) |

A far entry that is not large has no ZIP64 field in its local header (it holds no offset) but says version 45, like its
central header.

### 3.2 Central directory header (46 bytes + name + extra)

| Offset | Size | Field | Value |
| ---: | ---: | --- | --- |
| 0 | 4 | signature | `0x02014B50` |
| 4 | 2 | version made by | `0x0300` \| version needed (host 3 = Unix, so the mode below applies): `0x0314` or `0x032D` |
| 6 | 2 | version needed | 45 for a ZIP64 entry, else 20 |
| 8 | 2 | flags | `0x0800` |
| 10 | 2 | method | 0 |
| 12 | 4 | mod time, mod date | as in the local header |
| 16 | 4 | CRC-32 | as in the local header |
| 20 | 4 | compressed size | `U32` if large, else `s` |
| 24 | 4 | uncompressed size | `U32` if large, else `s` |
| 28 | 2 | name length | `n` |
| 30 | 2 | extra length | `9 + (4 + 8k if k > 0)`, `k = 2·[large] + [far]` |
| 32 | 2 | comment length | 0 |
| 34 | 2 | disk number start | 0 |
| 36 | 2 | internal attributes | 0 |
| 38 | 4 | external attributes | `0x81A40000` (`0o100644 << 16`: regular file, rw-r--r--) |
| 42 | 4 | local header offset | `U32` if far, else `o` |
| 46 | n | name | as in the local header |
| 46+n | | extra | if `k > 0`: ZIP64 `0x0001`, length `8k`, then `s`, `s` (if large) and `o` (if far), in this order; then UT |

The ZIP64 field holds exactly the values whose 32-bit field is `U32`, in APPNOTE 4.5.3 order (uncompressed, compressed,
offset; never the disk number). Sizes in the ZIP64 field, not only the overflowing one: both 32-bit sizes are `U32`
together because they are equal.

### 3.3 Extra fields

In both headers, after the ZIP64 field if any, the **extended timestamp** (Info-ZIP "UT"): `0x5455`, length 5, flags
`0x01` (mtime only), mtime as unsigned 32-bit Unix seconds `t` ([§5.1](#51-modification-time)): 9 bytes. The central
copy carries the same 5 data bytes (APPNOTE allows the central field to carry only mtime; with flag 0x01 the two are
equal). No other extra fields (no NTFS `0x000A`, no Unix `0x7875` owner field: owners are not shared).

### 3.4 End records

Let `B` be the central directory's offset (the sum of all local headers and data), `D` its size and `N` the entry count.
The archive needs the ZIP64 end records iff **`N ≥ U16` or `D ≥ U32` or `B ≥ U32`**. Then, right after the central
directory:

| Record | Bytes | Fields |
| --- | ---: | --- |
| ZIP64 end of central directory | 56 | `0x06064B50`; size of the rest 44 (8 bytes); made by `0x032D`; needed 45; disk 0; disk with CD 0 (4 bytes each); entries on this disk `N`; entries `N`; CD size `D`; CD offset `B` (8 bytes each) |
| ZIP64 end locator | 20 | `0x07064B50`; disk with the ZIP64 record 0 (4); its offset `B + D` (8); total disks 1 (4) |

The end of central directory record always closes the file (22 bytes): `0x06054B50`; disk 0; disk with CD 0; entries on
this disk; entries; CD size; CD offset; comment length 0. With the ZIP64 records, **all four** count/size/offset fields
are their maximum (`U16`, `U16`, `U32`, `U32`) so every reader takes the ZIP64 values (Go's `archive/zip` does the same;
Python clamps each field separately, which would also be valid but is a second variant); without them, the real values.

Versions: 20 is what Go, Python and Java write for a plain STORE entry (1.0 would suffice; nothing gains from it), 45 is
APPNOTE's value for ZIP64. One rule per entry keeps the local and central headers equal. Thresholds use `≥ U32` (not
Python's 2^31 − 1 for writing) because `U32` itself is the escape value; vectors pin both sides of every threshold.

## 4. Entries carry only files

No directory entries, also not for empty folders. Reasons: the browser's folder picker lists only files, so it couldn't
produce them, and both clients must give the same bytes; every common extractor creates parent folders from the paths;
directory entries would need their own mtimes and attributes. Empty folders are therefore not kept (said once in the
help, not per upload). A folder that held only empty folders is refused as `empty`.

## 5. Timestamps and attributes

### 5.1 Modification time

`t = clamp(floor(mtime in seconds), 315532800, 2147483647)`: the file's mtime rounded down to whole seconds (CLI from
`st_mtime` with its fraction, browser `floor(File.lastModified / 1000)`, both floor towards −∞), clamped to
1980-01-01T00:00:00Z … 2038-01-19T03:14:07Z, the range both DOS time and a signed 32-bit UT value hold, so they never
disagree and every reader reads UT the same way. Earlier files (Nix stores and some unpackers set 0 or 1) get
1980-01-01; later ones 2038-01-19.

DOS time and date are `t` in **UTC**: `hour << 11 | minute << 5 | second / 2` (seconds rounded down to even) and
`(year − 1980) << 9 | month << 5 | day`. UTC, not local time, because local time would make the bytes depend on the
sender's time zone (no determinism across machines and a leak of the zone). Readers that use UT (Info-ZIP `unzip`,
libarchive/bsdtar) restore the exact second in any zone (checked for `unzip` by the vectors); readers that ignore UT and
read DOS as local time (Windows Explorer, Python `zipfile`) show the UTC wall time, so up to a few hours off.

Why mtimes and not a fixed date: a folder of photos or documents is often sorted by date after unzipping, and a fixed
1980 date on every file breaks that. Resume stays deterministic because `t` is part of the fingerprint
([§9](#9-resume)). Privacy: the mtimes show when each file was last changed, to the second, and nothing about the time
zone; that leaks little next to the file contents and names, which the recipient (and, for raw uploads, fyl.at) has
anyway, and with E2EE they are inside the encrypted zip. There is no option to drop them.

### 5.2 Attributes

Every entry: made-by host Unix, external attributes `0o100644 << 16`, internal attributes 0. Executable bits are not kept
(the browser can't read them, and the two clients must agree); a script needs `chmod +x` after unzipping. No owner, no
setuid, no symlinks, so extracting never creates anything but plain files and folders.

## 6. Size formula

Everything except the CRCs follows from paths and sizes. For entries `i = 1 … N` in order, with `n_i` path bytes and
size `s_i`:

```text
large_i  = [s_i ≥ U32]
L_i      = 30 + n_i + 9 + 20·large_i                       local header
o_1      = 0;  o_{i+1} = o_i + L_i + s_i                    local header offsets
far_i    = [o_i ≥ U32]
k_i      = 2·large_i + far_i
C_i      = 46 + n_i + 9 + (k_i > 0 ? 4 + 8·k_i : 0)         central header
B        = o_{N+1}                                          central directory offset
D        = Σ C_i                                            central directory size
Z        = [N ≥ U16 or D ≥ U32 or B ≥ U32]
size     = B + D + 22 + 76·Z
```

Per entry the overhead is `94 + 2n` bytes (`+ 40` if large, `+ 12` if far, `+ 48` if both), plus 22 or 98 bytes per
archive. All values stay below 2^53, so JavaScript numbers are exact; JS code MUST write the 64-bit fields
with `DataView.setBigUint64` (or two 32-bit halves), never with bit operators, which are 32-bit signed.

Worked examples (all in the vectors):

| Case | Entries | `B` | `D` | ZIP64 | size |
| --- | --- | ---: | ---: | --- | ---: |
| `basic` | 5 files, 292 bytes of data | 568 | 356 | none | 946 |
| `below` | `big/a.bin` of `U32 − 1` B | 4,294,967,342 | 64 | end records only | 4,294,967,504 |
| `exact` | `big/a.bin` of `U32` B | 4,294,967,363 | 84 | entry (large), end | 4,294,967,545 |
| `offset-exact` | `far/a.bin` of 4,294,967,247 B, `far/b.txt` at offset `U32` | 4,294,967,349 | 140 | b.txt far, end | 4,294,967,587 |
| `5gib` | `video/clip.mov` 5 GiB, `video/notes.txt` 100 B | 5,368,709,347 | 171 | clip large, notes far, end | 5,368,709,616 |
| `limit` | `max/a.bin` of 53,687,090,950 B | 53,687,091,018 | 84 | large, end | 53,687,091,200 = 50 GiB |
| `count-65535` | 65,535 empty files `many/00000` … | 3,211,215 | 4,259,775 | end (count) | 7,471,088 |

`basic` by hand: paths of 14, 12, 16, 16, 23 bytes give `L` = 53, 51, 55, 55, 62 (276) and `C` = 69, 67, 71, 71, 78
(356); `B = 276 + 292 = 568`; `568 + 356 + 22 = 946`. The largest single file a raw folder upload can hold is
`50 GiB − 250 − 2n'` bytes (`n'` = path bytes beyond `max/a.bin`'s 9), with E2EE `P_max − 250 − 2n'`.

## 7. Building and verifying

### 7.1 CRC pre-pass

After the walk and the refusal checks, the client reads every file once from start to end and computes its CRC-32. It
MUST see exactly the listed size (fewer or more bytes: "A file changed while the folder was read: PATH.", exit 2); the CLI
also compares size and mtime after reading each file. Progress: "Preparing folder… N %" by bytes (the CLI counts files: "Preparing folder… N/M files"). This is a full extra
read of the folder (the price of no data descriptors: they would need a known CRC at the end of each entry, but a
resumed part must be byte-identical, and readers handle STORE with descriptors poorly). Then `/api/upload/init` with
`size` from [§6](#6-size-formula) (raw: `filename: "<root>.zip"`; E2EE: `C(size)` and the name in the metadata).

### 7.2 Parts

Part p covers zip bytes `[PART·(p−1), min(PART·p, size))` and is built on its own from the layout: header bytes are
generated from the entry list (find the first entry by binary search over `o_i`, and over the central offsets
`B + Σ_{j<i} C_j` for the central directory), data are read from the file at `offset − o_i − L_i`. The CLI reads into its
part buffer as for a file; the browser can send a raw part as `new Blob([headerBytes, file.slice(a, b), …])` without
copying; E2EE reads the zip's plaintext span exactly as it reads a file ([E2EE.md §7](E2EE.md#7-upload-flow) step 4).
Header bytes need not be held for the whole archive: a client MAY generate the central directory per part. Before
reading a file's data for a part, the CLI compares the file's size and mtime with the walk ([E2EE.md
§7](E2EE.md#7-upload-flow) step 6 for files) and stops on a change.

### 7.3 CRC check before completing

A client that holds a part's bytes (the CLI always; the browser's E2EE path, which builds the plaintext in memory) MUST
compute, for each entry segment inside the part, the CRC-32 of the bytes it actually put there, combine an entry's
segments in order (`crc32_combine`, zlib's GF(2) method, about 30 lines: `crc32_combine()` in the reference, vectors in
`zip64.json`; cli-rs uses `crc32fast` and its `Hasher::combine`) and compare the result with the pre-pass CRC **before `/api/upload/complete`**. With E2EE the 64 KiB chunk at a part boundary is read by both parts: the CLI cuts its runs at the first and last 64 KiB boundary of every read, so both reads give the same run, and a run read twice with another CRC fails the check too. A
mismatch stops without completing: "A file in the folder changed while it was uploaded. Start a new upload." On resume,
confirmed parts are rebuilt for their MD5 check anyway ([CLI-API.md](CLI-API.md#clients), E2EE §8.4), so
every segment is seen in every run. The browser's raw path sends `File` slices it doesn't read; it relies on `File`
snapshots instead (a changed file fails to read: `NotReadableError`, `ERR_UPLOAD_FILE_CHANGED`). Without this check a
file edited between the pre-pass and its part would reach the recipient as a CRC error in their unzip; with it the
upload never completes with such an entry (raw browser: unless size and mtime stayed the same).

## 8. Upload, E2EE, password, one-time

The zip is a file: the existing flows run unchanged with `name = "<root>.zip"`, `size` from §6 and the part reader of
§7.2. E2EE encrypts the zip as plaintext P (never empty: at least one entry); its metadata carries `<root>.zip` and the zip
size; the recipient's `fyl download` / the page decrypt it to `<root>.zip`. Passwords, one-time links, expiry, the
receipt check and the 50 MiB part size are untouched. The download side doesn't unzip: the recipient gets `<root>.zip`.
Download pages and previews treat it as any `.zip` (no preview, not a risky extension).

CLI output ([CLI.md](CLI.md#folders)): the link as for a file; `--json` adds `"folder": {"files": N, "skipped": M}` with `name` = `<root>.zip`
and `size` the zip's. `fyl FOLDER` no longer exits 2 for a folder ([CLI.md](CLI.md) exit codes change with the release).

## 9. Resume

**Fingerprint** `F = b64url(SHA-256(M)[0:16])` (22 characters, no padding), with

```text
M = "fyl-folder-zip-1\n" ‖ for each entry in zip order: path ‖ 0x00 ‖ decimal(s) ‖ 0x00 ‖ decimal(t) ‖ 0x0A
```

Paths can't contain 0x00 or 0x0A ([§2.3](#23-names)), so `M` is unambiguous. `F` changes when a file is added, removed,
renamed (root included), resized or touched to another second; it changes neither for skipped items nor for content
edits that keep size and second (the part MD5 checks catch those). It is change detection, not a secret or a security
boundary: the pins, part MD5s and §7.3 are the guarantee.

- **CLI** keeps no upload state on disk, so `F` travels in the resume value, as the last field in place of E2EE's MTIME: raw
  `ID.TOKEN.F` (`echo <id>.<token>.<F> | fyl './photos' --resume -`), E2EE `ID.TOKEN.KEY.F`, or `ID.TOKEN.F` with
  `--encrypt` and the key from `FYL_KEY` or the prompt. A folder argument always expects `F`; a file argument never.
- **Browser:** the pending `fyl-upload` record keeps `F` where a file's record keeps its date; name `<root>.zip`, size
  the zip's, and the head/tail SHA-256 fingerprint computed over the zip stream after the CRC pass. The user picks the
  folder again; nothing resumes without that.

Procedure: walk and refuse as in §2; compare `F` (before any file is read, so a changed folder is refused at once);
compare the layout size with `status.size` (E2EE: `C(size)`, and `meta.size == size`); run the CRC pre-pass; then
continue as for a file (confirmed parts rebuilt and checked by MD5, E2EE pins, §7.3 before completing). Any difference
refuses with "The folder changed since this upload started. Start a new upload." (exit 2), never aborts, and keeps the
upload resumable, as [E2EE.md §8.4](E2EE.md#84-resume) does for files. A renamed folder is a changed folder: the root is
in every path.

## 10. Compatibility

Checked with the vectors (`scripts/folder_zip.py`, and `tests/test_folder_zip.py` in `npm run ci`): Python 3.12
`zipfile` (`testzip()`, names, DOS times, attributes, contents) and Info-ZIP UnZip 6.00 (Debian) `unzip -t`, plus
extraction with the UT mtimes restored. The six > 4 GiB cases up to the 50 GiB limit were written as sparse files and
passed `zipfile.testzip()` and `unzip -t` on 2026-11-06 (`--big`, about 6 minutes; not in CI). Also on Linux in a
review (2026-11-06): 7-Zip 23.01 and bsdtar 3.7.2 (libarchive) list and test every zip; 7-Zip, `unzip` and `zipfile` extract
names byte for byte, while bsdtar folds names to NFC, so the NFC and NFD `ä.txt` of a folder extract there as one file
(the second overwrites the first; [§2.3](#23-names)). **Open item:** not yet checked on real devices, although
folder zips shipped in 2.5.0 and in the public 1.0.0 and 1.0.1: Windows Explorer, macOS Archive Utility and `ditto`,
each with a ZIP64 zip over 4 GiB too (where old Archive Utility versions had trouble). Record the results here once
they are done.

## 11. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Compression | STORE only | size known before reading; parts regenerate; media is already compressed |
| Data descriptors | never; CRC pre-pass | sizes/CRC in the local header, resume is byte-identical; costs one extra read |
| ZIP64 per entry | only when `s ≥ U32` (sizes) or `o ≥ U32` (offset); version 45 then, else 20 | widest reader support for normal entries; thresholds exact and tested |
| ZIP64 end records | iff `N ≥ 65535`, `D ≥ U32` or `B ≥ U32`; classic fields then all at maximum | one variant; Go does the same |
| Entry order | bytewise UTF-8 path order | language-independent (JS must compare bytes) |
| Normalisation | none | names as shown; no collisions in the zip; no Unicode-version drift |
| Unsafe names | skipped with a notice; bidi controls dropped (server rule); a resulting collision refuses | data loss stays visible; nothing disguises an extension |
| Directories | no entries; empty folders dropped | the browser can't list them; extractors create parents |
| Root | entries under `<root>/`; file `<root>.zip` | unzipping gives one folder |
| Timestamps | mtime, whole seconds, UTC DOS time + UT field, clamped to 1980…2038-01-19 | useful dates; deterministic; no time zone; small leak, inside E2EE |
| Attributes | Unix host, `0o100644` for all | deterministic, the browser can't read modes; nothing executable or special |
| Limits | zip ≤ 50 GiB raw / P_max E2EE; ≤ 100,000 entries; name ≤ 255 B; path ≤ 4095 B | existing size rule; bounded client memory; what extractors take |
| Resume | 22-character fingerprint over path, size, t; in the CLI resume value | early, clear refusal; CLI keeps no upload state |
| Server | unchanged | the zip is just a file |

## 12. Browser implementation

- `dist/zip.js` (`window.FylZip`): names (§2.3), order (§2.4, comparing encoded bytes), refusals (§2.6), layout (§6),
  headers and end records (§3), the fingerprint F (§9), and the zip as a `File` composed of header bytes and the
  folder's own `File`s, so `slice()` gives any part without copying data and a resume rebuilds it from the folder.
  `tests/folder-zip.test.ts` builds every tree vector byte for byte (and SHA-256), the ZIP64 formula segments, the
  65,534/65,535 cases and the refusals.
- CRC-32 is `dist/e2ee/crc32.js` (slicing by 8, and `crc32Combine()`). It lives under `/e2ee/` because the part worker
  loads only modules from there (both pages' CSP name it); it handles no key. The pre-pass (§7.1) is `crcFiles()` in
  `dist/e2ee/jobs.js`, run as a `crc` job in the E2EE part worker (`FylAPI.crcPass()` in `dist/api.js`; on the page where
  no module worker starts): 4 MiB pieces, small files up to 512 to a read, a file that can't be read or isn't its
  listed size names its index. No new worker path, so no CSP change.
- §7.3 on the E2EE path: `buildPart()` takes the plaintext spans of the entry data in its part and returns their CRCs
  over exactly the bytes it encrypted. Each part counts the chunks that start in it (a chunk on a part boundary is
  read by both parts), so every byte counts once; before `/api/upload/complete` each entry's pieces must cover its data
  and combine to its pre-pass CRC, or the upload stops as refused ("A file in the folder changed while it was uploaded.
  Start a new upload."), kept for Resume or Discard like any E2EE refusal.
- Picking (`dist/app.js`): exactly one dropped folder (`webkitGetAsEntry()`); "Choose a folder" in the drop zone's
  picker menu uses `showDirectoryPicker()` where it exists, else `<input webkitdirectory>`. Not shown on iOS and iPadOS. Chromium
  writes a `\` in a name as `/` in `webkitRelativePath`, so the last component is the `File`'s own `name` (otherwise
  `back\slash.txt` would become `back/slash.txt` instead of being skipped). The walk doesn't enter a folder whose name
  is skipped or whose path is already too long for any file in it (which also ends a loop through a linked folder) and
  stops past 100,000 files without opening any.
- The card shows `<root>.zip`, the zip's size and "Folder · N files", and "Left out N items with unsafe names." when
  names were skipped (also read to screen readers, with the folder's line, when it is ready); the disabled Upload
  button says "Reading the folder…" while it is listed and then counts the pre-pass ("Preparing the folder… N %"). The pending
  record keeps F in `lastModified` and the head/tail SHA-256 of the zip in `print`; its notice asks for the same folder,
  and choosing it again resumes only when both match.
- Checked in Chromium against `npm run dev` (2026-11-06): the folder input, a dropped folder and the directory picker,
  raw, with a password and encrypted (two parts), each downloaded from its `/d/` page byte-identical to
  `scripts/folder_zip.py --zip` and passing `unzip -t` with the mtimes restored.

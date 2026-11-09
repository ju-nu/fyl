# CCTV age vectors (vendored)

The 67 files without an extension are copied unchanged from C2SP/CCTV, <https://github.com/C2SP/CCTV>,
`age/testdata` at commit `50a8ecf2a220f4c8bdc4f085789b8e85c26829e7` (2026-09-25; tree `2aacad391c11b3f0ce6e3313f7cdcad6fa80f63e`). They are the vectors with an X25519
identity (`AGE-SECRET-KEY-1…`) and no armor or passphrase, as docs/E2EE.md §4.3 selects them; the other 80 files of
that directory are left out. Licence: [LICENSE](LICENSE) (0BSD, CC0-1.0 or Unlicense; no attribution required).

`manifest.json` lists each file with its SHA-256, CCTV's `expect`, the profile result of docs/E2EE.md §4.2 and the
plaintext released before it. Format of the files: CCTV's age/README.md (textual header, blank line, age file;
`compressed: zlib` means the age file is zlib-compressed). Regenerate with `scripts/e2ee_vectors.py`, which checks the
source directory's git tree hash before copying.

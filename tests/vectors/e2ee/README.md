# E2EE test vectors (profile `fyl-e2ee-1`)

Shared by the browser (vitest) and the Rust CLI (`cfg(test)` only) per docs/E2EE.md §16; both must reach exactly these
results. Bytes are lowercase hex, `key` and `headSha256` are b64url as in the protocol, and `result` is a client code of
§13 (`key_invalid`, `key_wrong`, `unsupported`, `corrupt`, `truncated`, `trailing_data`) or `success`.

| File | Covers |
| --- | --- |
| `content.json` | §4.1, §6: content age files for P = 0, 1, 65535, 65536, 65537, 131072, 196608, 50 MiB (part boundary inside a chunk) and 52,415,824 (C = 52,428,808, boundary inside the last chunk's tag), with every intermediate value of the header, whole-file SHA-256, chunk tags, and each part's SHA-256, MD5 (pin) and `Content-MD5`. `slices` repeat the part check with a small `partSize`, a test-only parameter of the §6 formula, so part-by-part encryption is tested without 50 MiB buffers. |
| `decrypt.json` | §4.2 on whole files: success, wrong key, header order, every header field damaged, truncation, missing final flag, trailing data, swapped/duplicated/extra chunks, a second stanza, an oversize header, a 200,000-byte stanza type, meta served as content and a re-wrapped head against the verified one (with `plaintextSize`, the content file a download decrypts with). |
| `meta.json` | §5: metadata blobs (exact bytes for valid names, padding buckets 512–2560, the 2,143-byte longest case) and blobs whose JSON breaks a §5.3 rule. |
| `keycheck.json` | §9.1: the key check over head and meta, including which failure wins, a head longer than 184 bytes, meta reusing the content's randomness and sizes beyond 2^53 − 1; `heads`: a stored head checked alone. |
| `keys.json` | §3: KEY and age identity string encodings, invalid KEYs and identity strings. |
| `links.json` | §2.2, §2.4, §10 step 1: links with and without `#KEY`, `%23` (and whether the key was exposed that way), segments, `?dl=1`; key-field input; `share`: the keyed link built from the client's origin against the server's `url`. |
| `names.json` | §7 step 1: sender name normalisation. |
| `layout.json` | §6: sizes, P(C), invalid C, part-to-chunk ranges, P_max, also for other limits up to 2^53 − 1. |
| `cctv/` | §4.3: the 67 vendored C2SP CCTV age vectors, their manifest and licence. |

Plaintext of P bytes: byte i is `i mod 251`. The fixed inputs (identities, file keys, ephemeral secrets, nonces) are
`SHA-256("fyl-e2ee-1 test vectors: " + label)` cut to length, labels in `scripts/e2ee_vectors.py`; injecting them is
test-only (§4.1: Rust under `cfg(test)`, the browser tests by replacing `crypto.getRandomValues`). All content sizes
share one identity, file key, ephemeral secret and nonce, so they share the head, and a file can be spliced from slices
of several: a `decrypt.json` input is the concatenation of `{"hex": …}`, `{"repeat": byte, "count": n}` and
`{"content": P, "start"?, "end"?}` segments, the last a slice of the content file for P (rebuild it from
`content.json`, `inputSha256` checks the result). Full ciphertext is stored only for C ≤ 4 KiB (§16 allows up to
1 MiB) to keep this directory small; larger files are rebuilt by the deterministic encryption and pinned by hashes.

Verification: `scripts/e2ee_vectors.py` contains its own §4.2/§5.3/§9.1 reference decoder (Python, OpenSSL primitives
via `cryptography`), asserts every expected result and the §6 table and worked examples, and runs every file through
the reference age CLI: age 1.1.1 (Ubuntu 24.04 package `1.1.1-1ubuntu0.24.04.3`, SHA-256 matching the archive index)
and age v1.2.1 (`go install filippo.io/age/cmd/age@v1.2.1`, module hash matching sum.golang.org). Both decrypt every
content vector, 50 MiB ones included, and every meta blob to the exact plaintext; give the recorded `age` outcome for
every `decrypt.json` file ("decrypts" marks the three refusals that are the profile's own), with the partial output of
each refused file equal to `released`; and give CCTV's `expect` for all 67 CCTV files.

Regenerate (rewrites identical files; needs Python's `cryptography`, not used in CI):

```sh
python3 scripts/e2ee_vectors.py --cctv CCTV/age/testdata --age "$(command -v age)"
```

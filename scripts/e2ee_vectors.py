#!/usr/bin/env python3
"""Regenerates tests/vectors/e2ee/ (docs/E2EE.md §4.3, §16) and checks every vector against the reference age CLI.

  python3 scripts/e2ee_vectors.py --cctv CCTV/age/testdata [--age PATH ...] [--work DIR]

Needs the `cryptography` package; CI never runs this, the tests read the JSON. All values are fixed functions of this
file, so a rerun writes identical files. --cctv is age/testdata of C2SP/CCTV at the pinned commit (its git tree hash is
checked). Each --age binary must decrypt every positive vector to its plaintext and give the recorded "age" outcome for
every negative one ("decrypts" marks refusals that belong to the profile, not to age).
"""
import argparse
import base64
import hashlib
import hmac
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unicodedata
import zlib

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

OUT = Path(__file__).resolve().parents[1] / "tests" / "vectors" / "e2ee"
CCTV_COMMIT = "50a8ecf2a220f4c8bdc4f085789b8e85c26829e7"
CCTV_TREE = "2aacad391c11b3f0ce6e3313f7cdcad6fa80f63e"  # git tree hash of age/testdata at CCTV_COMMIT
H, CHUNK, S, PART, MAX_FILE_BYTES = 184, 65536, 65552, 52428800, 50 * 1024**3
MAX_SAFE = 2**53 - 1  # JavaScript's largest exact integer: C beyond it is corrupt in both cores (§5.3)
ORIGIN = "https://fyl.at"


def fixed(label, n):
    return hashlib.sha256(b"fyl-e2ee-1 test vectors: " + label.encode()).digest()[:n]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def b64(data):
    return base64.b64encode(data).rstrip(b"=")


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64(text, n, url=False):
    """Canonical unpadded base64 of exactly n bytes, else None (docs/E2EE.md Notation)."""
    if len(text) != (4 * n + 2) // 3 or not re.fullmatch(r"[A-Za-z0-9_-]*" if url else r"[A-Za-z0-9+/]*", text):
        return None
    raw = (base64.urlsafe_b64decode if url else base64.b64decode)(text + "=" * (-len(text) % 4))
    return raw if (b64url(raw) if url else b64(raw).decode()) == text else None


CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
URL64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


def polymod(values):
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i, g in enumerate((0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)):
            chk ^= g if top >> i & 1 else 0
    return chk


def hrp_expand(hrp):
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def regroup(data, frm, to, pad):
    acc = nbits = 0
    out = []
    for v in data:
        acc = acc << frm | v
        nbits += frm
        while nbits >= to:
            nbits -= to
            out.append(acc >> nbits & (1 << to) - 1)
    if pad and nbits:
        out.append(acc << to - nbits & (1 << to) - 1)
    elif not pad and (nbits >= frm or acc << to - nbits & (1 << to) - 1):
        return None
    return out


def bech32(hrp, words, const=1):
    pm = polymod(hrp_expand(hrp) + words + [0] * 6) ^ const
    return hrp + "1" + "".join(CHARSET[w] for w in words + [pm >> 5 * (5 - i) & 31 for i in range(6)])


def age_identity(identity):
    return bech32("age-secret-key-", regroup(identity, 8, 5, True)).upper()


def age_recipient(identity):
    return bech32("age", regroup(public(identity), 8, 5, True))


def parse_age_identity(text):
    """docs/E2EE.md §3.2: Bech32 (BIP 173 constant 1), one case, HRP age-secret-key-, 32 bytes, zero padding."""
    if text != text.upper() and text != text.lower():
        return None
    text = text.lower()
    pos = text.rfind("1")
    if pos < 1 or len(text) - pos < 7 or any(c not in CHARSET for c in text[pos + 1:]):
        return None
    hrp, words = text[:pos], [CHARSET.index(c) for c in text[pos + 1:]]
    if hrp != "age-secret-key-" or polymod(hrp_expand(hrp) + words) != 1:
        return None
    data = regroup(words[:-6], 5, 8, False)
    return bytes(data) if data is not None and len(data) == 32 else None


def public(secret):
    return X25519PrivateKey.from_private_bytes(secret).public_key().public_bytes_raw()


def x25519(secret, point):
    try:
        return X25519PrivateKey.from_private_bytes(secret).exchange(X25519PublicKey.from_public_bytes(point))
    except ValueError:  # OpenSSL refuses an all-zero result itself
        return bytes(32)


def hkdf(ikm, salt, info):
    return HKDF(hashes.SHA256(), 32, salt, info).derive(ikm)


def nonce_for(i, final):
    return i.to_bytes(11, "big") + bytes([final])


def seal(pkey, i, final, plaintext):
    return ChaCha20Poly1305(pkey).encrypt(nonce_for(i, final), plaintext, None)


def nchunks(p):
    return max(1, -(-p // CHUNK))


def csize(p):
    return H + p + 16 * nchunks(p)


def psize(c):
    """docs/E2EE.md §6 P(C), None where undefined."""
    rest = c - H
    if rest < 16:
        return None
    n = max(1, -(-rest // S))
    p = rest - 16 * n
    return None if n >= 2 and p <= CHUNK * (n - 1) else p


def plaintext(p):
    return (bytes(range(251)) * (p // 251 + 1))[:p]


def stanza(kind, args, body):
    text = b64(body)
    lines = [text[i:i + 64] for i in range(0, len(text), 64)]
    if not lines or len(lines[-1]) == 64:
        lines.append(b"")
    return b"-> " + b" ".join([kind, *args]) + b"\n" + b"".join(line + b"\n" for line in lines)


def wrap_key(shared, share, recipient):
    return hkdf(shared, share + recipient, b"age-encryption.org/v1/X25519")


def header_key(file_key):
    return hkdf(file_key, b"", b"header")


def finish_header(file_key, hdr):
    return hdr + b" " + b64(hmac.new(header_key(file_key), hdr, "sha256").digest()) + b"\n"


class AgeFile:
    """One profile age file (docs/E2EE.md §4.1) with injected file key, ephemeral secret and payload nonce."""

    def __init__(self, identity, file_key, eph, nonce):
        self.identity, self.file_key, self.eph, self.nonce = identity, file_key, eph, nonce
        self.recipient, self.share = public(identity), public(eph)
        self.shared = x25519(eph, self.recipient)
        self.wrap = wrap_key(self.shared, self.share, self.recipient)
        self.body = ChaCha20Poly1305(self.wrap).encrypt(bytes(12), file_key, None)
        self.hdr = b"age-encryption.org/v1\n" + stanza(b"X25519", [b64(self.share)], self.body) + b"---"
        self.mac = hmac.new(header_key(file_key), self.hdr, "sha256").digest()
        self.head = finish_header(file_key, self.hdr) + nonce
        self.pkey = hkdf(file_key, nonce, b"payload")
        assert len(self.hdr) == 123 and len(self.head) == H

    def chunk(self, pt, i):
        return seal(self.pkey, i, i == nchunks(len(pt)) - 1, pt[CHUNK * i:CHUNK * (i + 1)])

    def encrypt(self, pt):
        return self.head + b"".join(self.chunk(pt, i) for i in range(nchunks(len(pt))))

    def part(self, pt, p, part_size):
        """Part p computed on its own from the chunks it overlaps (docs/E2EE.md §6), not cut from the stream."""
        c, n = csize(len(pt)), nchunks(len(pt))
        start, end = part_size * (p - 1), min(part_size * p, c)
        first = 0 if p == 1 else (start - H) // S
        last = min(n - 1, (end - 1 - H) // S)
        base = 0 if p == 1 else H + S * first
        buf = (self.head if p == 1 else b"") + b"".join(self.chunk(pt, i) for i in range(first, last + 1))
        return buf[start - base:end - base], first, last

    def details(self):
        return {"fileKey": self.file_key.hex(), "eph": self.eph.hex(), "nonce": self.nonce.hex(), "share": self.share.hex(),
                "sharedSecret": self.shared.hex(), "wrapKey": self.wrap.hex(), "body": self.body.hex(),
                "hdr": self.hdr.decode(), "headerKey": header_key(self.file_key).hex(), "mac": self.mac.hex(),
                "head": self.head.hex(), "headSha256": b64url(hashlib.sha256(self.head).digest()), "payloadKey": self.pkey.hex()}


# Reference decoder: docs/E2EE.md §4.2 (steps in order, first failure wins), §5.3 and §9.1.
class Fail(Exception):
    pass


SHAPE = re.compile(rb"age-encryption\.org/v1\n-> X25519 ([A-Za-z0-9+/]{43})\n([A-Za-z0-9+/]{43})\n--- ([A-Za-z0-9+/]{43})\n")


def header_steps(data, identity):
    """§4.2 steps 1-5."""
    lf = data[:H].find(b"\n")
    if lf < 0:
        raise Fail("truncated" if len(data) < H else "corrupt")
    version = data[:lf]
    if not re.fullmatch(rb"age-encryption\.org/[\x21-\x7e]+", version):
        raise Fail("corrupt")
    if version != b"age-encryption.org/v1":
        raise Fail("unsupported")
    rest = data[lf + 1:]
    if not rest.startswith(b"-> "):
        raise Fail("truncated" if b"-> ".startswith(rest) else "corrupt")
    arg = re.match(rb"[^ \n]*[ \n]", rest[3:])
    if not arg:
        raise Fail("truncated")
    if arg.group()[:-1] != b"X25519":
        raise Fail("unsupported")
    if len(data) < H:
        raise Fail("truncated")
    m = SHAPE.fullmatch(data[:168])
    fields = [unb64(g.decode(), 32) for g in m.groups()] if m else [None]
    if None in fields:
        raise Fail("corrupt")
    share, body, mac = fields
    shared = x25519(identity, share)
    if shared == bytes(32):
        raise Fail("corrupt")
    return shared, share, body, mac


def unwrap(identity, shared, share, body):
    """§4.2 step 6; None when the stanza doesn't open."""
    try:
        return ChaCha20Poly1305(wrap_key(shared, share, public(identity))).decrypt(bytes(12), body, None)
    except InvalidTag:
        return None


def check_mac(data, file_key, mac):
    if not hmac.compare_digest(hmac.new(header_key(file_key), data[:123], "sha256").digest(), mac):
        raise Fail("corrupt")


def open_payload(data, file_key, out):
    """§4.2 step 8; appends each released chunk to out."""
    pkey, pos, i = hkdf(file_key, data[168:H], b"payload"), H, 0
    while True:
        chunk = data[pos:pos + S]
        pos += len(chunk)
        if not chunk:
            raise Fail("truncated")
        if len(chunk) < 16:
            raise Fail("corrupt")
        pt = None
        for final in (1,) if len(chunk) < S else (0, 1):
            try:
                pt = ChaCha20Poly1305(pkey).decrypt(nonce_for(i, final), chunk, None)
                break
            except InvalidTag:
                pass
        if pt is None or final and not pt and i:
            raise Fail("corrupt")
        out.append(pt)
        if final:
            if pos < len(data):
                raise Fail("trailing_data")
            return
        i += 1


def open_head(identity, head):
    """§4.2 steps 1-7 on a stored head, which is exactly H bytes (§9.1)."""
    try:
        shared, share, body, mac = header_steps(head, identity)
        if len(head) != H:
            raise Fail("corrupt")
        file_key = unwrap(identity, shared, share, body)
        if file_key is None:
            raise Fail("key_wrong")
        check_mac(head, file_key, mac)
        return "success"
    except Fail as e:
        return e.args[0]


def decrypt(data, identity, verified_head=None):
    out = []
    try:
        if verified_head is not None and data[:H] != verified_head:  # §9.2 / §10 step 7, before §4.2
            raise Fail("corrupt")
        shared, share, body, mac = header_steps(data, identity)
        file_key = unwrap(identity, shared, share, body)
        if file_key is None:
            raise Fail("key_wrong")
        check_mac(data, file_key, mac)
        open_payload(data, file_key, out)
        code = "success"
    except Fail as e:
        code = e.args[0]
    return code, b"".join(out)


def meta_text(name, size, head):
    return ('{"v":1,"name":"' + name.replace('"', '\\"') + '","size":' + str(size) + ',"headSha256":"'
            + b64url(hashlib.sha256(head).digest()) + '"}').encode()


def pad(text):
    return text + b" " * (-len(text) % 512)


NAME_BAD = re.compile("[\x00-\x1f\x7f-\x9f/\\\\؜‎‏  ‪-‮⁦-⁩\ud800-\udfff]")


def name_ok(name):
    return 1 <= len(name.encode("utf-8", "surrogatepass")) <= 1024 and not re.fullmatch(r"\.+", name) and not NAME_BAD.search(name)


def check_meta(pt, head, c):
    """§5.3 on decrypted meta; returns (name, size)."""
    if len(pt) % 512 or len(pt) > 2560:
        raise Fail("corrupt")
    t = pt.rstrip(b" ")
    if len(pt) - len(t) >= 512:
        raise Fail("corrupt")
    v = re.match(rb'\{"v":([0-9]+)[,}]', t)
    if v and v.group(1) != b"1":
        raise Fail("unsupported")
    try:
        obj = json.loads(t.decode("utf-8"))
    except ValueError:
        raise Fail("corrupt") from None
    if re.search(rb'\\(?!")', t) or not isinstance(obj, dict) or list(obj) != ["v", "name", "size", "headSha256"]:
        raise Fail("corrupt")
    name, size = obj["name"], obj["size"]
    if not isinstance(name, str) or type(size) is not int or not name_ok(name) or meta_text(name, size, head) != t:
        raise Fail("corrupt")
    if c > MAX_SAFE or psize(c) != size:
        raise Fail("corrupt")
    return name, size


REUSE = ((32, 75), (76, 119), (168, H))  # share, stanza body, payload nonce (§12.1 step 6)


def key_check(identity, head, meta, c):
    """§9.1: steps 1-5 on head (exactly H bytes) then meta, step 6 on both, step 7 on head then meta, no randomness
    shared between them, then meta's payload and §5.3."""
    try:
        h = header_steps(head, identity)
        if len(head) != H:
            raise Fail("corrupt")
        m = header_steps(meta, identity)
        keys = [unwrap(identity, *h[:3]), unwrap(identity, *m[:3])]
        if keys == [None, None]:
            raise Fail("key_wrong")
        if None in keys:
            raise Fail("corrupt")
        check_mac(head, keys[0], h[3])
        check_mac(meta, keys[1], m[3])
        if any(head[a:b] == meta[a:b] for a, b in REUSE):
            raise Fail("corrupt")
        out = []
        open_payload(meta, keys[1], out)
        return ("success", *check_meta(b"".join(out), head, c))
    except Fail as e:
        return e.args[0], None, None


# Fixed inputs. Real uploads draw every one of these from the CSPRNG.
I1, I2 = fixed("identity", 32), fixed("other identity", 32)
CONTENT = AgeFile(I1, fixed("content file key", 16), fixed("content ephemeral", 32), fixed("content payload nonce", 16))
META = AgeFile(I1, fixed("meta file key", 16), fixed("meta ephemeral", 32), fixed("meta payload nonce", 16))
OTHER = AgeFile(I2, fixed("other content file key", 16), fixed("other content ephemeral", 32), fixed("other content payload nonce", 16))
OTHER_META = AgeFile(I2, fixed("other meta file key", 16), fixed("other meta ephemeral", 32), fixed("other meta payload nonce", 16))
CCTV_IDENTITY = "AGE-SECRET-KEY-1EGTZVFFV20835NWYV6270LXYVK2VKNX2MMDKWYKLMGR48UAWX40Q2P2LM0"


def largest_plaintext(limit):
    if limit < csize(0):
        return -1
    lo, hi = 0, limit
    while lo < hi:
        mid = (lo + hi + 1) // 2
        lo, hi = (mid, hi) if csize(mid) <= limit else (lo, mid - 1)
    return lo


P_MAX = largest_plaintext(MAX_FILE_BYTES)


def meta_blob(text, file=META):
    return file.encrypt(text)


def escape(ch):
    """Raw UTF-8 for visible characters; \\u escapes for controls, bidi and other format or invisible ones."""
    if 0x20 <= ord(ch) < 0x7F or ord(ch) >= 0x80 and unicodedata.category(ch)[0] in "LNPS":
        return ch
    units = ch.encode("utf-16-be", "surrogatepass")
    return "".join("\\u%04x" % int.from_bytes(units[i:i + 2], "big") for i in range(0, len(units), 2))


def compact(v):
    return "".join(escape(ch) for ch in json.dumps(v, ensure_ascii=False))


def dump(name, obj):
    def value(v, depth):
        if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            return "[\n" + ",\n".join(" " * (depth + 1) + compact(x) for x in v) + "\n" + " " * depth + "]"
        if isinstance(v, dict) and depth == 1:
            return "{\n" + ",\n".join("  " + json.dumps(k) + ": " + value(x, 2) for k, x in v.items()) + "\n }"
        return compact(v)
    text = "{\n" + ",\n".join(" " + json.dumps(k) + ": " + value(v, 1) for k, v in obj.items()) + "\n}\n"
    (OUT / name).write_text(text, encoding="utf-8")
    return text


def part_entries(pt, part_size, file=CONTENT):
    """Each part computed independently, checked against the slice of the sequential stream."""
    stream, c = file.encrypt(pt), csize(len(pt))
    parts, boundaries = [], []
    for p in range(1, -(-c // part_size) + 1):
        data, first, last = file.part(pt, p, part_size)
        assert data == stream[part_size * (p - 1):part_size * p], (len(pt), part_size, p)
        md5 = hashlib.md5(data).digest()
        parts.append({"part": p, "start": part_size * (p - 1), "end": part_size * (p - 1) + len(data), "firstChunk": first,
                      "lastChunk": last, "sha256": sha256(data), "md5": md5.hex(), "contentMd5": base64.b64encode(md5).decode()})
    for b in range(part_size, c, part_size):
        k = (b - H) // S
        within = b - H - S * k
        boundaries.append({"offset": b, "chunk": k, "within": within, "inTag": within >= min(S, c - H - S * k) - 16})
    return stream, parts, boundaries


def content_vectors():
    vectors, slices = [], []
    for p in (0, 1, 65535, 65536, 65537, 131072, 196608, 52428800, 52415824):
        pt = plaintext(p)
        stream, parts, boundaries = part_entries(pt, PART)
        n = nchunks(p)
        assert len(stream) == csize(p) and psize(len(stream)) == p and decrypt(stream, I1) == ("success", pt)
        v = {"name": f"P{p}", "plaintextSize": p, "ciphertextSize": len(stream), "chunks": n,
             "lastChunkPlaintext": p - CHUNK * (n - 1), "sha256": sha256(stream)}
        if n <= 16:
            v["tags"] = [stream[H + S * i:H + S * i + min(S, len(stream) - H - S * i)][-16:].hex() for i in range(n)]
        if len(stream) <= 4096:
            v["ciphertext"] = stream.hex()
        v["parts"] = parts
        if boundaries:
            v["boundaries"] = boundaries
        vectors.append(v)
    for p, size in ((1, 185), (1, 200), (65537, 65736), (65537, 65745), (196608, 65728), (196608, 65736), (196608, 30000)):
        stream, parts, boundaries = part_entries(plaintext(p), size)
        slices.append({"name": f"P{p}-part{size}", "plaintextSize": p, "partSize": size, "sha256": sha256(stream),
                       "parts": parts, "boundaries": boundaries})
    # docs/E2EE.md §6 worked examples
    big = next(v for v in vectors if v["plaintextSize"] == 52428800)
    assert big["ciphertextSize"] == 52441784 and big["boundaries"][0] == {"offset": PART, "chunk": 799, "within": 52568, "inTag": False}
    tag = next(v for v in vectors if v["plaintextSize"] == 52415824)
    assert tag["ciphertextSize"] == 52428808 and tag["boundaries"][0]["inTag"]
    return {
        "about": "docs/E2EE.md §4.1 and §6: the content age file over plaintext byte i = i mod 251, for each size, with "
                 "the fixed identity, fileKey, eph and nonce below (all sizes share them, so all share the head). "
                 "parts use PART = 52428800; slices use a small partSize, a test-only parameter of the §6 part formula. "
                 "Each part must be computed on its own from the chunks firstChunk..lastChunk and equal the slice "
                 "[start, end) of the sequential stream. ciphertext (hex) only where ciphertextSize <= 4096; tags are "
                 "each chunk's last 16 bytes, to find a differing chunk.",
        "identity": I1.hex(), "key": b64url(I1), "recipient": public(I1).hex(), "file": CONTENT.details(),
        "vectors": vectors, "slices": slices,
    }


NAMES = [
    ("hello.txt", 1), ("Grüße – 你好 \U0001f389.pdf", 65537), ('say "hi".txt', 131072),
    ("a b#c?d%e'f&g(1).tar.gz", 65536), ("été NFD.txt", 196608), ("zero​width.txt", 1),
    ("..a", 1), ("x" * 1020 + ".bin", 52428800), ('"' * 1024, P_MAX), ("big.bin", P_MAX), ("empty-file-format-only", 0),
]


def meta_vectors():
    head = CONTENT.head
    valid = []
    names = list(NAMES)
    filler = 512 - len(meta_text("", 1, head))
    names += [("n" * filler, 1), ("n" * (filler + 1), 1)]  # text exactly 512 bytes (no padding), and 513
    for name, p in names:
        text = meta_text(name, p, head)
        assert text == json.dumps({"v": 1, "name": name, "size": p, "headSha256": b64url(hashlib.sha256(head).digest())},
                                  ensure_ascii=False, separators=(",", ":")).encode()
        blob = meta_blob(pad(text))
        assert key_check(I1, head, blob, csize(p)) == ("success", name, p)
        valid.append({"name": name, "plaintextSize": p, "ciphertextSize": csize(p), "text": text.decode(),
                      "paddedLength": len(pad(text)), "meta": blob.hex()})
    assert len(valid[-2]["text"]) == 512 and valid[-2]["paddedLength"] == 512 and valid[-1]["paddedLength"] == 1024
    assert len(meta_text('"' * 1024, P_MAX, head)) == 2143

    good = meta_text("a.txt", 1, head)
    tail = good[good.index(b',"size"'):]
    sumv = b64url(hashlib.sha256(head).digest())

    def doc(name_json):  # a text with the given raw JSON string token as name
        return b'{"v":1,"name":' + name_json + tail

    cases = [
        ("unsupported", '"v" is 2', b'{"v":2' + good[6:]), ("unsupported", '"v" is 01 (digits other than exactly 1)', b'{"v":01' + good[6:]),
        ("unsupported", '"v" is 10, rest malformed', b'{"v":10,garbage'), ("unsupported", '{"v":2} alone', b'{"v":2}'),
        ("corrupt", '"v" is 1.0', b'{"v":1.0' + good[6:]), ("corrupt", '"v" is "1"', b'{"v":"1"' + good[6:]),
        ("corrupt", '{"v":1} alone (missing members)', b'{"v":1}'), ("corrupt", "space after a comma", good.replace(b',"name"', b', "name"')),
        ("corrupt", "members reordered", b'{"v":1,"size":1,"name":"a.txt","headSha256":"' + sumv.encode() + b'"}'),
        ("corrupt", "duplicate member", good.replace(b'"name":"a.txt"', b'"name":"b.txt","name":"a.txt"')),
        ("corrupt", "unknown member", good[:-1] + b',"type":"text/plain"}'), ("corrupt", "missing headSha256", good[:good.index(b',"headSha256"')] + b"}"),
        ("corrupt", "size 1.0", good.replace(b'"size":1,', b'"size":1.0,')), ("corrupt", "size 1e0", good.replace(b'"size":1,', b'"size":1e0,')),
        ("corrupt", 'size "1"', good.replace(b'"size":1,', b'"size":"1",')), ("corrupt", "size -1", good.replace(b'"size":1,', b'"size":-1,')),
        ("corrupt", "size 2^53+1", meta_text("a.txt", 2**53 + 1, head)), ("corrupt", "size mismatch (2, content has 1)", meta_text("a.txt", 2, head)),
        ("corrupt", "headSha256 of another head", meta_text("a.txt", 1, OTHER.head)),
        ("corrupt", "headSha256 of the meta's own head", meta_text("a.txt", 1, META.head)),
        ("corrupt", "escape \\u0041", doc(b'"\\u0041.txt"')), ("corrupt", "escape \\ud800", doc(b'"\\ud800.txt"')),
        ("corrupt", "escape \\/", doc(b'"a\\/b.txt"')), ("corrupt", "escape \\\\", doc(b'"a\\\\b.txt"')), ("corrupt", "escape \\n", doc(b'"a\\nb.txt"')),
        ("corrupt", "raw U+202E in name", meta_text("a‮txt.exe", 1, head)), ("corrupt", "raw U+2028 in name", meta_text("a b", 1, head)),
        ("corrupt", "raw U+061C in name", meta_text("a؜b", 1, head)), ("corrupt", "raw U+2066 in name", meta_text("a⁦b", 1, head)),
        ("corrupt", "raw U+200E in name", meta_text("a‎b", 1, head)),
        ("corrupt", "raw C0 0x01 in name", meta_text("a\x01b", 1, head)), ("corrupt", "raw tab in name", meta_text("a\tb", 1, head)),
        ("corrupt", "raw DEL 0x7F in name (\\p{Cc})", meta_text("a\x7fb", 1, head)), ("corrupt", "raw C1 U+0085 in name", meta_text("a\x85b", 1, head)),
        ("corrupt", "slash in name", meta_text("a/b.txt", 1, head)), ("corrupt", "name only dots", meta_text("..", 1, head)),
        ("corrupt", "name a single dot", meta_text(".", 1, head)), ("corrupt", "empty name", meta_text("", 1, head)),
        ("corrupt", "1025-byte name", meta_text("x" * 1021 + ".bin", 1, head)),
        ("corrupt", "invalid UTF-8 byte 0xFF in name", doc(b'"a\xffb"')), ("corrupt", "overlong UTF-8 0xC0 0xAF in name", doc(b'"a\xc0\xafb"')),
        ("corrupt", "UTF-8-encoded surrogate ED A0 80 in name", doc(b'"a\xed\xa0\x80b"')),
        ("corrupt", "byte order mark before the text", b"\xef\xbb\xbf" + good), ("corrupt", "space before the text", b" " + good),
        ("corrupt", "newline after the text", good + b"\n"), ("corrupt", "garbage after the text", good + b"x"),
        ("corrupt", "NUL padding instead of spaces", good + b"\0" * (512 - len(good))),
    ]
    invalid = []
    for want, why, text in cases:
        assert len(text) <= 2048, why
        invalid.append((want, why, pad(text)))
    invalid += [
        ("corrupt", "plaintext of 600 bytes (not a multiple of 512)", good + b" " * (600 - len(good))),
        ("corrupt", "plaintext of 3072 bytes (over 2560)", good + b" " * (3072 - len(good))),
        ("corrupt", "512 or more padding bytes", good + b" " * (1024 - len(good))),
        ("corrupt", "empty plaintext", b""),
    ]
    out = []
    for want, why, pt in invalid:
        blob = meta_blob(pt)
        assert decrypt(blob, I1) == ("success", pt), why
        got = key_check(I1, head, blob, 201)[0]
        assert got == want, (why, got)
        t = pt.rstrip(b" ")
        try:
            shown = {"text": t.decode()}
        except UnicodeDecodeError:
            shown = {"textHex": t.hex()}
        out.append({"why": why, **shown, "paddedLength": len(pt), "ciphertextSize": 201, "meta": blob.hex(), "result": want})
    return {
        "about": "docs/E2EE.md §5: meta age files to the content identity, with the fixed fileKey, eph and nonce of file "
                 "(so all share file.head). valid: the exact blob for the text padded with spaces to paddedLength; "
                 "decrypting it, checked per §5.3 against head and ciphertextSize, yields name and plaintextSize. "
                 "invalid: blobs that decrypt (as age files) to text plus spaces up to paddedLength (textHex where the "
                 "text isn't UTF-8) and fail §5.3 with result, given head and ciphertextSize.",
        "identity": I1.hex(), "head": head.hex(), "headSha256": sumv, "file": META.details(), "valid": valid, "invalid": out,
    }


def flip(data, offset, mask=1):
    return data[:offset] + bytes([data[offset] ^ mask]) + data[offset + 1:]


def next_char(data, offset):
    alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    return data[:offset] + bytes([alphabet[(alphabet.index(data[offset]) + 1) % 64]]) + data[offset + 1:]


def assemble(segments):
    out = b""
    for s in segments:
        if "hex" in s:
            out += bytes.fromhex(s["hex"])
        elif "repeat" in s:
            out += bytes.fromhex(s["repeat"]) * s["count"]
        else:
            stream = CONTENT.encrypt(plaintext(s["content"]))
            out += stream[s.get("start", 0):s.get("end", len(stream))]
    return out


def decrypt_vectors():
    p1 = CONTENT.encrypt(plaintext(1))
    share_at, body_at, mac_at = 32, 76, 124

    def c(p, start=None, end=None):
        s = {"content": p}
        if start is not None:
            s["start"] = start
        if end is not None:
            s["end"] = end
        return s

    def hx(data):
        return {"hex": data.hex()}

    eph2 = fixed("second stanza ephemeral", 32)
    body2 = ChaCha20Poly1305(wrap_key(x25519(eph2, public(I2)), public(eph2), public(I2))).encrypt(bytes(12), CONTENT.file_key, None)
    two = finish_header(CONTENT.file_key, CONTENT.hdr[:-3] + stanza(b"X25519", [b64(public(eph2))], body2) + b"---")
    grease = finish_header(CONTENT.file_key, CONTENT.hdr[:-3] + stanza(b"fyl-grease", [b"x"], fixed("grease", 32) * 40) + b"---")
    zero_share = p1[:share_at] + b"A" * 43 + p1[share_at + 43:]
    meta_pt = pad(meta_text("a.txt", 1, CONTENT.head))
    # Same file key and nonce (so the same payload), a new ephemeral key: a valid age file with another head.
    rewrapped = AgeFile(I1, CONTENT.file_key, fixed("re-wrapped ephemeral", 32), CONTENT.nonce)
    assert rewrapped.pkey == CONTENT.pkey and rewrapped.head != CONTENT.head
    ok, ref = "decrypts", "refuses"
    cases = [  # why, identity, segments, expected code, what age does, verified head
        ("P=0: one empty final chunk", I1, [c(0)], "success", ok, None),
        ("P=1", I1, [c(1)], "success", ok, None),
        ("P=65535", I1, [c(65535)], "success", ok, None),
        ("P=65536: one full chunk, flagged final", I1, [c(65536)], "success", ok, None),
        ("P=65537: full chunk, then a 1-byte final chunk", I1, [c(65537)], "success", ok, None),
        ("P=131072", I1, [c(131072)], "success", ok, None),
        ("P=196608", I1, [c(196608)], "success", ok, None),
        ("wrong key: another identity", I2, [c(1)], "key_wrong", ref, None),
        ("wrong key on a full chunk file", I2, [c(65536)], "key_wrong", ref, None),
        ("version line v3 (flipped bit)", I1, [hx(flip(p1, 20, 2))], "unsupported", ref, None),
        ("short file with another version: age-encryption.org/v2 + LF only", I1, [hx(b"age-encryption.org/v2\n")], "unsupported", ref, None),
        ("version line without a version: age-encryption.org/", I1, [hx(b"age-encryption.org/" + p1[21:])], "corrupt", ref, None),
        ("version line with a trailing space", I1, [hx(p1[:21] + b" " + p1[21:])], "corrupt", ref, None),
        ("not age, 5 bytes, no LF", I1, [hx(b"hello")], "truncated", ref, None),
        ("no LF in the first 184 bytes", I1, [hx(b"a" * 200)], "corrupt", ref, None),
        ("short file with another stanza type: -> scrypt + SP", I1, [hx(b"age-encryption.org/v1\n-> scrypt ")], "unsupported", ref, None),
        ("short file, stanza type not yet ended by SP or LF", I1, [hx(b"age-encryption.org/v1\n-> scrypt")], "truncated", ref, None),
        ("stanza type x25519 (lowercase, flipped bit)", I1, [hx(flip(p1, 25, 0x20))], "unsupported", ref, None),
        ("second line doesn't start with '-> '", I1, [hx(flip(p1, 22))], "corrupt", ref, None),
        ("cut to 22 bytes: version line only", I1, [c(1, 0, 22)], "truncated", ref, None),
        ("cut to 25 bytes: '-> ' without a type", I1, [c(1, 0, 25)], "truncated", ref, None),
        ("cut to 183 bytes", I1, [c(1, 0, 183)], "truncated", ref, None),
        ("cut to the 184-byte head: no chunk", I1, [c(1, 0, 184)], "truncated", ref, None),
        ("share: non-canonical base64 (last character's trailing bits set)", I1, [hx(next_char(p1, share_at + 42))], "corrupt", ref, None),
        ("share: another valid point", I1, [hx(next_char(p1, share_at + 10))], "key_wrong", ref, None),
        ("share: all-zero (low-order) point", I1, [hx(zero_share)], "corrupt", ref, None),
        ("stanza body changed", I1, [hx(next_char(p1, body_at + 10))], "key_wrong", ref, None),
        ("'---' changed to '--,'", I1, [hx(flip(p1, 122))], "corrupt", ref, None),
        ("space before the MAC changed", I1, [hx(flip(p1, 123))], "corrupt", ref, None),
        ("MAC changed", I1, [hx(next_char(p1, mac_at + 10))], "corrupt", ref, None),
        ("LF after the MAC changed", I1, [hx(flip(p1, 167))], "corrupt", ref, None),
        ("payload nonce: flipped bit", I1, [hx(flip(p1, 168))], "corrupt", ref, None),
        ("chunk 0 body: flipped bit", I1, [hx(flip(p1, 184))], "corrupt", ref, None),
        ("chunk 0 tag: flipped bit", I1, [hx(flip(p1, 200, 0x80))], "corrupt", ref, None),
        ("chunk 1 body: flipped bit (chunk 0 released)", I1, [c(65537, 0, H + S), hx(flip(CONTENT.encrypt(plaintext(65537))[H + S:], 0))], "corrupt", ref, None),
        ("P=1 cut to 200 bytes: 16-byte final chunk", I1, [c(1, 0, 200)], "corrupt", ref, None),
        ("P=1 cut to 199 bytes: 15-byte chunk", I1, [c(1, 0, 199)], "corrupt", ref, None),
        ("P=1 with one extra byte (absorbed into the short final chunk)", I1, [c(1), hx(b"\0")], "corrupt", ref, None),
        ("P=0 with one extra byte", I1, [c(0), hx(b"\0")], "corrupt", ref, None),
        ("P=65537 without its last byte: truncated last chunk", I1, [c(65537, 0, 65752)], "corrupt", ref, None),
        ("P=65537 without its last 2 bytes: 15-byte last chunk", I1, [c(65537, 0, 65751)], "corrupt", ref, None),
        ("cut at a chunk boundary / missing final flag on a full chunk: non-final chunk 0, then EOF", I1, [c(131072, 0, H + S)], "truncated", ref, None),
        ("two full non-final chunks, then EOF", I1, [c(196608, 0, H + 2 * S)], "truncated", ref, None),
        ("missing final flag on a short chunk (P=1 sealed non-final)", I1, [hx(CONTENT.head + seal(CONTENT.pkey, 0, 0, plaintext(1)))], "corrupt", ref, None),
        ("P=65536 plus one trailing byte", I1, [c(65536), hx(b"\0")], "trailing_data", ref, None),
        ("P=131072 plus an extra chunk", I1, [c(131072), c(196608, H + 2 * S)], "trailing_data", ref, None),
        ("final flag on a middle chunk: final chunk 0, then chunk 1", I1, [c(65536), c(131072, H + S)], "trailing_data", ref, None),
        ("empty final chunk after a full chunk", I1, [c(131072, 0, H + S), hx(seal(CONTENT.pkey, 1, 1, b""))], "corrupt", ref, None),
        ("chunks 0 and 1 swapped", I1, [c(196608, 0, H), c(196608, H + S, H + 2 * S), c(196608, H, H + S), c(196608, H + 2 * S)], "corrupt", ref, None),
        ("chunks 1 and 2 swapped", I1, [c(196608, 0, H + S), c(196608, H + 2 * S), c(196608, H + S, H + 2 * S)], "corrupt", ref, None),
        ("chunk 0 duplicated", I1, [c(196608, 0, H + S), c(196608, H, H + S), c(196608, H + S)], "corrupt", ref, None),
        ("second recipient stanza (valid age)", I1, [hx(two + CONTENT.nonce + seal(CONTENT.pkey, 0, 1, plaintext(1)))], "corrupt", ok, None),
        ("oversize header: an extra 1280-byte unknown stanza after X25519 (valid age)", I1, [hx(grease + CONTENT.nonce + seal(CONTENT.pkey, 0, 1, plaintext(1)))], "corrupt", ok, None),
        ("meta served as content: first 184 bytes differ from the verified head", I1, [hx(meta_blob(meta_pt))], "corrupt", ok, CONTENT.head),
        ("head re-wrapped to a new ephemeral key, genuine payload: a valid age file, but not the verified head", I1,
         [hx(rewrapped.head), c(1, H)], "corrupt", ok, CONTENT.head),
        ("stanza type of 200,000 bytes, ended by SP", I1, [hx(b"age-encryption.org/v1\n-> "), {"repeat": "41", "count": 200000}, hx(b" x\n")],
         "unsupported", ref, None),
    ]
    age_output = {cases[-5][0]: plaintext(1), cases[-4][0]: plaintext(1), cases[-3][0]: meta_pt, cases[-2][0]: plaintext(1)}  # the profile-only refusals
    vectors = []
    for why, identity, segments, want, age, verified in cases:
        data = assemble(segments)
        code, released = decrypt(data, identity, verified)
        assert code == want, (why, code)
        v = {"why": why, "identity": identity.hex(), "input": segments, "inputSize": len(data), "inputSha256": sha256(data)}
        if verified is not None:  # the content file of that head is for P = 1 (§9.2: a download also checks P)
            v.update({"verifiedHead": verified.hex(), "plaintextSize": 1})
        v.update({"result": code, "released": len(released), "releasedSha256": sha256(released), "age": age})
        vectors.append((v, data, identity, age_output.get(why, released)))
    return vectors


def keycheck_vectors(meta_doc):
    head, meta = CONTENT.head, bytes.fromhex(meta_doc["valid"][0]["meta"])
    uni = bytes.fromhex(meta_doc["valid"][1]["meta"])
    other_meta = OTHER_META.encrypt(pad(meta_text("hello.txt", 1, OTHER.head)))
    v2 = bytes.fromhex(next(v for v in meta_doc["invalid"] if v["why"] == '"v" is 2')["meta"])
    head_v2, head_body = flip(head, 20, 2), next_char(head, 76 + 10)
    meta_scrypt = meta[:25] + b"scrypt" + meta[31:]
    long_head = head + b"\0"
    long_meta = meta_blob(pad(meta_text("a.txt", 1, long_head)))  # SUM over all 185 bytes

    def reusing(file_key, eph, nonce):  # a meta that shares head's randomness, otherwise valid
        return AgeFile(I1, file_key, eph, nonce).encrypt(pad(meta_text("a.txt", 1, head)))

    def huge(size):  # a meta for P beyond 2^53 - 1, or whose C is
        return meta_blob(pad(meta_text("a.txt", size, head))), csize(size)

    cases = [
        ("success", I1, head, meta, 201), ("success: Unicode name, P=65537", I1, head, uni, 65753),
        ("both unwraps fail: another identity", I2, head, meta, 201),
        ("head of another transfer, meta valid: exactly one unwrap fails", I1, OTHER.head, meta, 201),
        ("meta of another transfer, head valid", I1, head, other_meta, 201),
        ("head replaced by the meta's own head (headSha256 binds it)", I1, meta[:H], meta, 201),
        ("head stanza body damaged, meta valid", I1, head_body, meta, 201),
        ("both stanza bodies damaged: both unwraps fail", I1, head_body, next_char(meta, 76 + 10), 201),
        ("head MAC damaged", I1, next_char(head, 124 + 10), meta, 201),
        ("head MAC damaged and another identity: step 6 before step 7", I2, next_char(head, 124 + 10), meta, 201),
        ("head version v3", I1, head_v2, meta, 201),
        ("head version v3 and another identity: steps 1-5 before step 6", I2, head_v2, meta, 201),
        ("meta stanza type scrypt", I1, head, meta_scrypt, 201),
        ("head non-canonical share before meta's unsupported stanza: head first", I1, next_char(head, 32 + 42), meta_scrypt, 201),
        ("head with an all-zero share", I1, head[:32] + b"A" * 43 + head[75:], meta, 201),
        ("head cut to 183 bytes", I1, head[:183], meta, 201),
        ("meta v 2", I1, head, v2, 201),
        ("ciphertextSize 202 doesn't match size 1", I1, head, meta, 202),
        ("ciphertextSize 65740 has no P(C)", I1, head, meta, 65740),
        ("meta cut to its 184-byte head: no chunk", I1, head, meta[:H], 201),
        ("meta with one extra byte", I1, head, meta + b" ", 201),
        ("head with one extra byte, SUM over all of it: a stored head is exactly 184 bytes", I1, long_head, long_meta, 201),
        ("head with one extra byte and another identity: the length before step 6", I2, long_head, long_meta, 201),
        ("meta sealed with the content's file key, ephemeral key and nonce (one payload key for both)", I1, head,
         reusing(CONTENT.file_key, CONTENT.eph, CONTENT.nonce), 201),
        ("meta reusing the content's ephemeral key (one wrap key for both file keys)", I1, head,
         reusing(META.file_key, CONTENT.eph, META.nonce), 201),
        ("meta reusing the content's file key and nonce under a new ephemeral key", I1, head,
         reusing(CONTENT.file_key, META.eph, CONTENT.nonce), 201),
        ("meta size 2^53 + 2 with C of that size: beyond 2^53 - 1", I1, head, *huge(MAX_SAFE + 3)),
        ("meta size 2^53 - 2, a safe integer, but C beyond 2^53 - 1", I1, head, *huge(MAX_SAFE - 1)),
    ]
    out = []
    for why, identity, h, m, c in cases:
        code, name, size = key_check(identity, h, m, c)
        v = {"why": why, "identity": identity.hex(), "head": h.hex(), "meta": m.hex(), "ciphertextSize": c, "result": code}
        if code == "success":
            v.update({"name": name, "plaintextSize": size})
        out.append(v)
    expect = ["success", "success", "key_wrong", "corrupt", "corrupt", "corrupt", "corrupt", "key_wrong", "corrupt", "key_wrong",
              "unsupported", "unsupported", "unsupported", "corrupt", "corrupt", "truncated", "unsupported", "corrupt", "corrupt",
              "truncated", "corrupt", "corrupt", "corrupt", "corrupt", "corrupt", "corrupt", "corrupt", "corrupt"]
    assert [v["result"] for v in out] == expect, [v["result"] for v in out]
    assert key_check(I1, long_head[:H], long_meta, 201)[0] == "corrupt"  # the SUM, not the length, without the extra byte
    for _, _, _, m, _ in cases[23:26]:  # each passes everything but the reuse rule
        assert any(head[a:b] == m[a:b] for a, b in REUSE) and check_meta(decrypt(m, I1)[1], head, 201) == ("a.txt", 1)
    heads = [
        ("stored head", I1, head, "success"), ("another identity", I2, head, "key_wrong"),
        ("one extra byte", I1, long_head, "corrupt"), ("one extra byte, another identity: the length before step 6", I2, long_head, "corrupt"),
        ("a whole file is not a stored head", I1, CONTENT.encrypt(plaintext(1)), "corrupt"), ("cut to 183 bytes", I1, head[:183], "truncated"),
    ]
    for why, identity, h, want in heads:
        assert open_head(identity, h) == want, why
    return {
        "about": "docs/E2EE.md §9.1 (also §10 step 5 and §8.4 step 2): the key check over head and meta for a content "
                 "object of ciphertextSize, nothing downloaded. Steps 1-5 of §4.2 on head, which must be exactly 184 "
                 "bytes, then on meta; step 6 on both (both failing key_wrong, one failing corrupt); step 7 on head, "
                 "then meta; meta's share, stanza body and payload nonce each differing from head's; then meta's "
                 "payload and §5.3, C at most 2^53 - 1. The first failure wins. heads: steps 1-7 on a stored head "
                 "alone (the browser's openContent, the CLI's open_header).",
        "vectors": out,
        "heads": [{"why": w, "identity": i.hex(), "head": h.hex(), "result": r} for w, i, h, r in heads],
    }


def key_vectors():
    edge = bytes([0xFB, 0xFF, 0xBF] * 10 + [0xFB, 0xFF])
    valid = []
    for why, identity in (("fixed test identity", I1), ("other test identity", I2), ("CCTV test identity", parse_age_identity(CCTV_IDENTITY)),
                          ("all zero bytes", bytes(32)), ("all 0xff", b"\xff" * 32), ("'-' and '_' characters", edge)):
        valid.append({"why": why, "identity": identity.hex(), "key": b64url(identity), "ageIdentity": age_identity(identity),
                      "recipient": age_recipient(identity)})
    assert valid[2]["key"] == "yhYmJSxTzxpNxGaV5_zEZZTLTMre22cS39oHU_OuNV4" and valid[2]["ageIdentity"] == CCTV_IDENTITY
    assert valid[2]["recipient"] == "age1xmwwc06ly3ee5rytxm9mflaz2u56jjj36s0mypdrwsvlul66mv4q47ryef"
    assert "-" in valid[5]["key"] and "_" in valid[5]["key"]
    k = b64url(I1)
    bad_keys = [
        ("42 characters", k[:-1]), ("44 characters", k + "A"), ("padding", k + "="), ("empty", ""),
        ("trailing bits set (last character not in AEIMQUYcgkosw048)", k[:-1] + URL64[URL64.index(k[-1]) + 1]),
        ("standard base64 '+' and '/'", valid[5]["key"].replace("-", "+").replace("_", "/")),
        ("inner space", k[:20] + " " + k[21:]), ("non-ASCII", k[:-2] + "é" + k[-1]),
        ("age identity is not a KEY", age_identity(I1)),
    ]
    for _, text in bad_keys:
        assert unb64(text, 32, url=True) is None, text
    ident = age_identity(I1)
    words = regroup(I1, 8, 5, True)
    bad_ids = [
        ("mixed case", ident[:20] + ident[20:].lower()),
        ("checksum changed", ident[:-1] + ("Q" if ident[-1] != "Q" else "P")),
        ("Bech32m checksum", bech32("age-secret-key-", words, 0x2BC830A3).upper()),
        ("HRP age (a recipient)", age_recipient(I1)),
        ("HRP age-plugin-x-", bech32("age-plugin-x-", words).upper()),
        ("31 bytes", bech32("age-secret-key-", regroup(I1[:31], 8, 5, True)).upper()),
        ("33 bytes", bech32("age-secret-key-", regroup(I1 + b"\0", 8, 5, True)).upper()),
        ("non-zero padding bits", bech32("age-secret-key-", words[:-1] + [words[-1] | 1]).upper()),
        ("character outside the Bech32 set ('B')", ident[:30] + "B" + ident[31:]),
        ("no separator", ident.replace("1", "", 1)),
        ("leading space (the decoder itself doesn't trim)", " " + ident),
    ]
    assert words[-1] & 1 == 0
    for why, text in bad_ids:
        assert parse_age_identity(text) is None, why
    for v in valid:
        assert parse_age_identity(v["ageIdentity"]) == bytes.fromhex(v["identity"]) == parse_age_identity(v["ageIdentity"].lower())
    return {
        "about": "docs/E2EE.md §3: KEY = b64url(identity) (43 characters, canonical); ageIdentity = the §3.2 Bech32 "
                 "string (encoders write uppercase; decoders take all-uppercase or all-lowercase); recipient = age's "
                 "public form, never transmitted, for the standard-tool path only. invalidKeys fail KEY decoding "
                 "(key_invalid); invalidAgeIdentities fail §3.2 decoding (key_invalid).",
        "valid": valid,
        "invalidKeys": [{"why": w, "key": t} for w, t in bad_keys],
        "invalidAgeIdentities": [{"why": w, "ageIdentity": t} for w, t in bad_ids],
    }


SHARE_ORIGIN = re.compile(r"(?:https://(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])|http://(?:localhost|127\.0\.0\.1|\[::1\]))(?::[0-9]+)?")


def link_vectors():
    tid, other, k = b64url(fixed("transfer id", 32)), b64url(fixed("other transfer id", 32)), b64url(I1)
    base = f"{ORIGIN}/d/{tid}"
    ident = age_identity(I1)
    # AGE-SECRET-KEY-1 is 16 b64url characters: about 28% of identity strings cut to 43 characters decode as a KEY.
    cut = next(c for c in (age_identity(fixed(f"truncated identity {n}", 32))[:43] for n in range(100)) if unb64(c, 32, url=True))
    std = b64url(bytes([0xFB, 0xFF, 0xBF] * 10 + [0xFB, 0xFF]))

    def ok(text, key, why, exposed=False):
        return {"link": text, "why": why, "id": tid, "key": key, "exposed": exposed}

    def usage(text, why, code=None):
        return {"link": text, "why": why, "exit": 2, **({"code": code} if code else {})}

    link = [
        ok(f"{base}#{k}", k, "link with KEY"), ok(base, None, "link without key"), ok(f"{base}#", None, "empty fragment is no key"),
        ok(f"{base}%23{k}", k, "%23 right after the ID counts as #; the key was in the request path", True),
        ok(f"{base}%23", None, "%23 with nothing after it is no key"), ok(f"{base}%23#{k}", k, "empty %23, key after #: not exposed"),
        ok(f"{base}%23{k}#", k, "key after %23, empty fragment", True),
        ok(f"{base}/report.pdf#{k}", k, "segment ignored"), ok(f"{base}/report.pdf", None, "segment ignored"),
        ok(f"{base}?dl=1#{k}", k, "?dl=1 allowed"), ok(f"{base}?dl=1", None, "?dl=1 allowed"),
        ok(f"{base}/name%23{k}", None, "%23 inside the segment is not a fragment (the segment is never sent)"),
        ok(f"{base}/{k}", None, "a KEY-shaped segment is never a key (a raw link's NAME can look like one)"),
        usage(f"{base}?dl=2#{k}", "query other than ?dl=1"), usage(f"{base}?grant=x#{k}", "query other than ?dl=1"),
        usage(f"http://fyl.at/d/{tid}#{k}", "not the configured base (http)"),
        usage(f"https://fyl.at.example/d/{tid}#{k}", "not the configured base"), usage(f"https://example.com/d/{tid}#{k}", "not the configured base"),
        usage(f"{ORIGIN}/x/{tid}#{k}", "not /d/"),
        usage(f"{base}#{k[:-1]}", "fragment of 42 characters", "key_invalid"), usage(f"{base}#{k}A", "fragment of 44 characters", "key_invalid"),
        usage(f"{base}#{k}=", "padded fragment", "key_invalid"), usage(f"{base}#k={k}", "parameter name in the fragment", "key_invalid"),
        usage(f"{base}#{k}&x=1", "more than KEY in the fragment", "key_invalid"), usage(f"{base}#{ident}", "age identity in the fragment", "key_invalid"),
        usage(f"{base}#{std.replace('-', '+').replace('_', '/')}", "standard base64 in the fragment", "key_invalid"),
    ]
    assert "+" in link[-1]["link"].split("#")[1]

    def entry(text, why, **result):
        return {"input": text, "why": why, **result}

    entries = [
        entry(k, "KEY", key=k), entry(f"  {k}\n", "ASCII whitespace trimmed", key=k), entry(f"\t{k}\r\n", "ASCII whitespace trimmed", key=k),
        entry(f"{base}#{k}", "full link", key=k), entry(f"{base}%23{k}", "full link with %23", key=k), entry(f"{base}/report.pdf#{k}", "link with a segment", key=k),
        entry(ident, "age identity", key=k), entry(ident.lower(), "age identity, lowercase", key=k),
        entry(f"{ORIGIN}/d/{other}#{k}", "link for another transfer: 'This link is for another file'", otherTransfer=True),
        entry(base, "link without a key", code="key_invalid"), entry(f"#{k}", "fragment with '#'", code="key_invalid"),
        entry(k[:-1], "42 characters", code="key_invalid"), entry(k + " ", "no-break space isn't ASCII whitespace", code="key_invalid"),
        entry(ident[:20] + ident[20:].lower(), "age identity in mixed case", code="key_invalid"),
        entry(cut, "identity string cut to 43 characters that happen to be a valid KEY: the prefix decides", code="key_invalid"),
        entry(cut.lower(), "the same, lowercase", code="key_invalid"),
    ]

    def share(why, url, origin=ORIGIN, transfer=tid, key=k, code=None):
        v = {"why": why, "origin": origin, "id": transfer, "url": url, "key": key}
        v.update({"code": code} if code else {"link": url + "#" + key})
        return v

    loop = "http://localhost:8787"
    shares = [
        share("server url as expected", base), share("loopback over http, with a port", f"{loop}/d/{tid}", loop),
        share("127.0.0.1 over http", f"http://127.0.0.1:8787/d/{tid}", "http://127.0.0.1:8787"),
        share("[::1] over http", f"http://[::1]/d/{tid}", "http://[::1]"), share("https with a port", f"https://fyl.at:8443/d/{tid}", "https://fyl.at:8443"),
        share("https to an IPv6 address", f"https://[2001:db8::1]/d/{tid}", "https://[2001:db8::1]"),
        share("another origin", f"https://evil.example/d/{tid}", code="url_mismatch"),
        share("http instead of https", f"http://fyl.at/d/{tid}", code="url_mismatch"),
        share("a name segment", f"{base}/a.txt", code="url_mismatch"), share("a trailing slash", f"{base}/", code="url_mismatch"),
        share("another transfer", f"{ORIGIN}/d/{other}", code="url_mismatch"), share("a query", f"{base}?dl=1", code="url_mismatch"),
        share("a fragment", f"{base}#x", code="url_mismatch"), share("host in another case", f"https://FYL.AT/d/{tid}", code="url_mismatch"),
        share("origin over plain http, not loopback", f"http://fyl.at/d/{tid}", "http://fyl.at", code="url_mismatch"),
        share("loopback name as a prefix of another host", f"http://127.0.0.1.evil/d/{tid}", "http://127.0.0.1.evil", code="url_mismatch"),
        share("origin with a trailing slash", f"https://fyl.at//d/{tid}", "https://fyl.at/", code="url_mismatch"),
        share("origin with userinfo", f"https://user@fyl.at/d/{tid}", "https://user@fyl.at", code="url_mismatch"),
        share("origin with a path", f"https://fyl.at/x/d/{tid}", "https://fyl.at/x", code="url_mismatch"),
        share("origin without a host", f"https:///d/{tid}", "https://", code="url_mismatch"),
        share("origin with an empty port", f"https://fyl.at:/d/{tid}", "https://fyl.at:", code="url_mismatch"),
        share("origin with a space", f"https://fyl.at /d/{tid}", "https://fyl.at ", code="url_mismatch"),
        share("ID with '/'", f"{ORIGIN}/d/{tid}/x", transfer=f"{tid}/x", code="url_mismatch"),
        share("ID with %23", f"{ORIGIN}/d/{tid}%23x", transfer=f"{tid}%23x", code="url_mismatch"),
        share("empty ID", f"{ORIGIN}/d/", transfer="", code="url_mismatch"),
        share("KEY of 42 characters", base, key=k[:-1], code="key_invalid"), share("age identity as KEY", base, key=ident, code="key_invalid"),
    ]
    for v in shares:  # reference for §2.2; key_invalid only with a url that checks out, since the CLI parses KEY first
        url_ok = SHARE_ORIGIN.fullmatch(v["origin"]) and re.fullmatch(r"[A-Za-z0-9_-]+", v["id"]) and v["url"] == f"{v['origin']}/d/{v['id']}"
        assert (v.get("code") == "url_mismatch") == (not url_ok), v["why"]
        assert (v.get("code") == "key_invalid") == (unb64(v["key"], 32, url=True) is None), v["why"]
    return {
        "about": "docs/E2EE.md §2.2, §2.4 and §10 step 1, for the transfer id below on https://fyl.at. link: the CLI's "
                 "LINK argument with base https://fyl.at; gives id, key (null: no key, ask for it) and exposed (the key "
                 "came after %23, so it was in the request path), or exit 2 (usage; code key_invalid where the fragment "
                 "is the problem). %23 counts as # only right after the ID; a segment is never a key. entry: the page's "
                 "key field and the CLI key prompt for this transfer; gives key (always as KEY), code key_invalid, or "
                 "otherTransfer (the doc's 'This link is for another file'). share: the keyed link a client builds from "
                 "its own origin, the transfer id and KEY once the server's url checks out; gives link, or code "
                 "url_mismatch (show, copy and store nothing) or key_invalid.",
        "id": tid, "link": link, "entry": entries, "share": shares,
    }


def name_vectors():
    cases = [
        ("unchanged", "report.pdf", "report.pdf"), ("slash and backslash", "a/b\\c.txt", "a_b_c.txt"),
        ("bidi override", "x‮y.txt", "x_y.txt"), ("C0 and DEL", "\x07bell\x7f.txt", "_bell_.txt"), ("tab", "a\tb", "a_b"),
        ("C1, U+2028, U+061C, U+2066, U+200F", "a\x85b c؜d⁦e‏", "a_b_c_d_e_"),
        ("only dots", "...", "_"), ("single dot", ".", "_"), ("leading dot stays", ".hidden", ".hidden"),
        ("1025 bytes, ASCII", "x" * 1021 + ".txt", "x" * 1020 + ".txt"),
        ("1025 bytes, cut a whole 2-byte code point", "a" + "ä" * 510 + ".pdf", "a" + "ä" * 509 + ".pdf"),
        ("1025 bytes, cut a whole 4-byte code point", "a" + "\U0001f600" * 255 + ".bin", "a" + "\U0001f600" * 254 + ".bin"),
        ("1024 bytes stay", "\U0001f600" * 255 + ".bin", "\U0001f600" * 255 + ".bin"), ("1025 bytes, no extension", "x" * 1025, "x" * 1024),
    ]
    out = []
    for why, name, want in cases:
        assert name_ok(want) and len(want.encode()) <= 1024, why
        out.append({"why": why, "input": name, "name": want})
    for why, units, want in (("lone high surrogate", [0x61, 0xD800, 0x62], "a_b"), ("lone low surrogate", [0xDC00], "_"),
                             ("surrogate pair stays", [0xD83D, 0xDE00], "\U0001f600")):
        out.append({"why": why, "utf16": units, "name": want})
    return {
        "about": "docs/E2EE.md §7 step 1, sender name normalisation to the §5.3 rules: each forbidden code point and each "
                 "lone surrogate becomes '_', a name of only dots becomes '_', a name over 1024 UTF-8 bytes loses whole "
                 "code points before its extension. utf16 entries (lone surrogates) exist only in JavaScript strings and "
                 "are given as UTF-16 code units, since a JSON string can't carry them portably.",
        "vectors": out,
    }


def layout_vectors():
    rows = [(0, 200, 1, 0, 1, 200), (1, 201, 1, 1, 1, 201), (65536, 65736, 1, 65536, 1, 65736), (65537, 65753, 2, 1, 1, 65753),
            (52428800, 52441784, 800, 65536, 2, 12984), (1024**3, 1074004152, 16384, 65536, 21, 25428152),
            (50 * 1024**3, 53700198584, 819200, 65536, 1025, None), (53673987000, 53687091200, 819001, 3000, 1024, 52428800)]
    sizes = []
    for p, c, n, last, parts, last_part in rows:  # docs/E2EE.md §6 table
        assert csize(p) == c and psize(c) == p and nchunks(p) == n and p - CHUNK * (n - 1) == last
        assert -(-c // PART) == parts and (last_part is None) == (c > MAX_FILE_BYTES) and (last_part is None or c - PART * (parts - 1) == last_part)
        sizes.append({"plaintextSize": p, "ciphertextSize": c, "chunks": n, "lastChunkPlaintext": last, "parts": parts,
                      "uploadable": 1 <= p and c <= MAX_FILE_BYTES})
    assert P_MAX == 53673987000
    invalid = [0, 183, 199, 65737, 65744, 65752, 65552 * 2 + H + 16]
    for c in invalid:
        assert psize(c) is None, c
    for c in (200, 201, 65736, 65753, 65552 * 2 + H + 17):
        assert psize(c) is not None
    chunks = []
    for c, p in ((52441784, 1), (52441784, 2), (53687091200, 2), (53687091200, 1024), (52428808, 2)):
        n = nchunks(psize(c))
        chunks.append({"ciphertextSize": c, "part": p, "start": PART * (p - 1), "end": min(PART * p, c),
                       "firstChunk": 0 if p == 1 else (PART * (p - 1) - H) // S, "lastChunk": min(n - 1, (min(PART * p, c) - 1 - H) // S)})
    assert chunks[2]["firstChunk"] == 799 and chunks[2]["lastChunk"] == 1599 and chunks[3]["firstChunk"] == 818200 and chunks[3]["lastChunk"] == 819000
    # P_max for other server limits, up to 2^53 - 1, where a midpoint (lo + hi) / 2 in floating point would stop moving.
    limits = [0, 199, 200, 201, 216, 217, 65736, 65737, 65753, MAX_FILE_BYTES, 2**52, 8 * 10**15, 9 * 10**15, MAX_SAFE]
    maxima = [{"limit": limit, "maxPlaintextSize": largest_plaintext(limit)} for limit in limits]
    for v in maxima:
        p = v["maxPlaintextSize"]
        assert p == -1 and v["limit"] < 200 or csize(p) <= v["limit"] < csize(p + 1), v
    return {
        "about": "docs/E2EE.md §6: C(P), P(C), chunk and part arithmetic. invalidCiphertextSizes have no P(C). uploadable: "
                 "1 <= P and C <= MAX_FILE_BYTES (50 GiB); maxPlaintextSize is P_max, and maxPlaintext gives it for "
                 "other limits (-1: not even an empty file fits).",
        "constants": {"H": H, "CHUNK": CHUNK, "S": S, "PART": PART, "MAX_FILE_BYTES": MAX_FILE_BYTES, "maxPlaintextSize": P_MAX},
        "sizes": sizes, "invalidCiphertextSizes": invalid, "partChunks": chunks, "maxPlaintext": maxima,
    }


def git_tree(directory):
    entries = b""
    for path in sorted(directory.iterdir(), key=lambda q: q.name.encode()):
        blob = path.read_bytes()
        entries += b"100644 " + path.name.encode() + b"\0" + hashlib.sha1(b"blob %d\0" % len(blob) + blob).digest()
    return hashlib.sha1(b"tree %d\0" % len(entries) + entries).hexdigest()


OUT_OF_PROFILE = {"x25519_grease": "unsupported", "stanza_valid_characters": "unsupported", "x25519_lowercase": "unsupported",
                  "x25519_multiple_recipients": "corrupt", "stanza_empty_body": "corrupt", "stanza_empty_last_line": "corrupt"}
MAPPING = {"success": {"success"}, "no match": {"key_wrong"}, "HMAC failure": {"corrupt"},
           "header failure": {"corrupt", "truncated", "unsupported"}, "payload failure": {"corrupt", "truncated", "trailing_data"}}


def cctv(directory):
    assert git_tree(directory) == CCTV_TREE, "not age/testdata at the pinned CCTV commit"
    target = OUT / "cctv"
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir()
    manifest = []
    for path in sorted(directory.iterdir()):
        raw = path.read_bytes()
        head, _, body = raw.partition(b"\n\n")
        fields = {}
        for line in head.decode().splitlines():
            key, _, value = line.partition(": ")
            fields.setdefault(key, []).append(value)
        x25519_ids = [i for i in fields.get("identity", []) if i.startswith("AGE-SECRET-KEY-1")]
        if not x25519_ids or "armored" in fields or "passphrase" in fields:
            continue
        if fields.get("compressed") == ["zlib"]:
            body = zlib.decompress(body)
        expect = fields["expect"][0]
        code, released = decrypt(body, parse_age_identity(x25519_ids[0]))
        if path.name in OUT_OF_PROFILE:
            assert code == OUT_OF_PROFILE[path.name], (path.name, expect, code)  # x25519_lowercase is CCTV "no match"
        else:
            assert code in MAPPING[expect], (path.name, expect, code)
        if code in ("success", "corrupt", "truncated", "trailing_data") and path.name not in OUT_OF_PROFILE and "payload" in fields:
            assert sha256(released) == fields["payload"][0], path.name
        (target / path.name).write_bytes(raw)
        manifest.append({"file": path.name, "sha256": sha256(raw), "compressed": "compressed" in fields, "identity": x25519_ids[0],
                         "expect": expect, "result": code, "released": len(released), "releasedSha256": sha256(released)})
    assert len(manifest) == 67 and sum(m["compressed"] for m in manifest) == 19
    (target / "LICENSE").write_text(LICENSE)
    (target / "README.md").write_text(CCTV_README)
    (target / ".gitattributes").write_text("# byte-exact vectors (header_crlf has CR LF): never convert line endings\n* -text\n")
    dump("cctv/manifest.json", {
        "about": f"C2SP/CCTV age/testdata at {CCTV_COMMIT}: the 67 vectors with an X25519 identity and no armor or "
                 "passphrase, unchanged (compressed: zlib-inflate the age file after the blank line). result is the "
                 "docs/E2EE.md §4.2 code with identity; released/releasedSha256 is the plaintext released before it "
                 "(CCTV's payload hash wherever the profile reaches the payload). expect is CCTV's own outcome.",
        "commit": CCTV_COMMIT, "tree": CCTV_TREE, "vectors": manifest,
    })
    return manifest


CCTV_README = f"""# CCTV age vectors (vendored)

The 67 files without an extension are copied unchanged from C2SP/CCTV, <https://github.com/C2SP/CCTV>,
`age/testdata` at commit `{CCTV_COMMIT}` (2026-09-25; tree `{CCTV_TREE}`). They are the vectors with an X25519
identity (`AGE-SECRET-KEY-1…`) and no armor or passphrase, as docs/E2EE.md §4.3 selects them; the other 80 files of
that directory are left out. Licence: [LICENSE](LICENSE) (0BSD, CC0-1.0 or Unlicense; no attribution required).

`manifest.json` lists each file with its SHA-256, CCTV's `expect`, the profile result of docs/E2EE.md §4.2 and the
plaintext released before it. Format of the files: CCTV's age/README.md (textual header, blank line, age file;
`compressed: zlib` means the age file is zlib-compressed). Regenerate with `scripts/e2ee_vectors.py`, which checks the
source directory's git tree hash before copying.
"""

LICENSE = """The files without an extension in this directory are test vectors from C2SP/CCTV
(https://github.com/C2SP/CCTV, age/testdata at commit 50a8ecf2a220f4c8bdc4f085789b8e85c26829e7), available under the
terms of the Zero-Clause BSD (reproduced below), CC0 1.0 or Unlicense license, at your choice.

Copyright (c) 2022 The age Authors

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
"""


class Oracle:
    """The reference age CLI: `age -d -i KEYFILE FILE`, plaintext on stdout."""

    def __init__(self, binary, work):
        self.binary, self.work = binary, work
        self.version = subprocess.run([binary, "--version"], capture_output=True, text=True, check=True).stdout.strip()

    def run(self, data, identity):
        key, src = self.work / "identity.txt", self.work / "input.age"
        key.write_text(age_identity(identity) + "\n")
        src.write_bytes(data)
        run = subprocess.run([self.binary, "-d", "-i", str(key), str(src)], capture_output=True)
        return run.returncode == 0, run.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cctv", type=Path, required=True)
    parser.add_argument("--age", action="append", default=[])
    parser.add_argument("--work", type=Path)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    work = args.work or Path(tempfile.mkdtemp())
    work.mkdir(parents=True, exist_ok=True)
    oracles = [Oracle(b, work) for b in args.age]

    manifest = cctv(args.cctv)
    content = content_vectors()
    meta = meta_vectors()
    decrypts = decrypt_vectors()
    dump("content.json", content)
    dump("meta.json", meta)
    dump("decrypt.json", {
        "about": "docs/E2EE.md §4.2 on whole files, with the §13 code in result and the plaintext released before it "
                 "(released bytes, releasedSha256). input is concatenated in order: {hex}, or {content: P, start?, end?}, "
                 "a slice of content.json's age file over P plaintext bytes (rebuild it with the fixed values there; "
                 "inputSha256 checks the result). verifiedHead, where present, is compared with the first 184 bytes "
                 "before §4.2 (§9.2, §10 step 7). age: what the reference age CLI does with the file; \"decrypts\" on a "
                 "failing vector marks a refusal that is the profile's own.",
        "vectors": [v for v, *_ in decrypts],
    })
    dump("keycheck.json", keycheck_vectors(meta))
    dump("keys.json", key_vectors())
    dump("links.json", link_vectors())
    dump("names.json", name_vectors())
    dump("layout.json", layout_vectors())

    for oracle in oracles:
        tally = {"content": 0, "meta": 0, "decrypt": 0, "cctv": 0}
        for v in content["vectors"]:
            pt = plaintext(v["plaintextSize"])
            assert oracle.run(CONTENT.encrypt(pt), I1) == (True, pt), (oracle.version, v["name"])
            tally["content"] += 1
        for v in meta["valid"] + meta["invalid"]:
            blob = bytes.fromhex(v["meta"])
            ok, out = oracle.run(blob, I1)
            assert ok and out == decrypt(blob, I1)[1], (oracle.version, v.get("why", v.get("name")))
            tally["meta"] += 1
        for v, data, identity, expected in decrypts:
            ok, out = oracle.run(data, identity)
            assert ok == (v["age"] == "decrypts"), (oracle.version, v["why"], ok)
            # age writes each chunk as it verifies, so a refused file leaves exactly the released plaintext
            assert out == expected, (oracle.version, v["why"])
            tally["decrypt"] += 1
        for m in manifest:
            raw = (OUT / "cctv" / m["file"]).read_bytes()
            body = raw.partition(b"\n\n")[2]
            ok, out = oracle.run(zlib.decompress(body) if m["compressed"] else body, parse_age_identity(m["identity"]))
            assert ok == (m["expect"] == "success"), (oracle.version, m["file"])
            tally["cctv"] += 1
        print(f"age {oracle.version}: all checks passed {tally}")
    if not oracles:
        print("No --age binary given: vectors written, reference CLI checks skipped.")
    total = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(f"{OUT}: {total} bytes")


if __name__ == "__main__":
    main()

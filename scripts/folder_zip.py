#!/usr/bin/env python3
"""Reference implementation of docs/FOLDER-ZIP.md (profile `fyl-folder-zip-1`) and generator of tests/vectors/folder-zip/.

  python3 scripts/folder_zip.py               # rewrite the vectors, then check them with zipfile and unzip -t
  python3 scripts/folder_zip.py --check       # only check the committed vectors
  python3 scripts/folder_zip.py --big DIR     # also write the > 4 GiB cases as sparse zips into DIR and test them
  python3 scripts/folder_zip.py --zip FOLDER OUT   # zip a real folder (manual checks)

Stdlib only. Every value is a fixed function of this file, so a rerun writes identical files. Clients don't import
this: the browser (dist/api.js) and the CLI (cli-rs) implement the spec and test against the JSON.
"""
import argparse
import base64
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile
import zlib

OUT = Path(__file__).resolve().parents[1] / 'tests' / 'vectors' / 'folder-zip'
PROFILE = b'fyl-folder-zip-1'
MAX_FILE_BYTES, E2EE_P_MAX = 50 * 1024**3, 53_673_987_000  # wrangler.jsonc; docs/E2EE.md §6
MAX_ENTRIES, MAX_PATH_BYTES, MAX_NAME_BYTES = 100_000, 4095, 255  # unzip truncates paths of 4096+ bytes
U16, U32 = 0xFFFF, 0xFFFFFFFF
T_MIN, T_MAX = 315532800, 2**31 - 1  # 1980-01-01T00:00:00Z, 2038-01-19T03:14:07Z
MODE = 0o100644  # regular file, rw-r--r--
FIXED_MS = 1793260800000  # 2026-10-29T08:00:00Z, the vectors' default mtime
# The server's rules for a file name (src/index.ts, upload init): bidi controls are dropped, these are refused.
BIDI = re.compile('[؜‎‏‪-‮⁦-⁩]')
UNSAFE = re.compile('[\x00-\x1f\x7f-\x9f  /\\\\]')


class Refused(Exception):
    """The whole folder is refused (§2.6): code is empty, too_many, collision or too_large."""
    def __init__(self, code, detail=''):
        super().__init__(f'{code}: {detail}' if detail else code)
        self.code, self.detail = code, detail


@dataclass(frozen=True)
class Entry:
    path: str      # full path in the zip, root folder first, '/' separators
    size: int
    mtime: int     # seconds since the epoch, clamped (§5.1)
    source: object = None  # bytes for the vectors, (folder, raw names below it) for collect()


@dataclass(frozen=True)
class Row:
    offset: int    # of the local header
    local: int     # local header length
    central: int   # central header length
    large: bool    # size ≥ 0xFFFFFFFF
    far: bool      # offset ≥ 0xFFFFFFFF


@dataclass(frozen=True)
class Layout:
    entries: tuple
    rows: tuple
    cd_offset: int
    cd_size: int
    zip64_end: bool
    size: int


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def clean(name):
    """One path component as the platform gives it (str or bytes) → its name in the zip, or None to skip it (§2.3)."""
    if isinstance(name, bytes):
        try:
            name = name.decode('utf-8')
        except UnicodeDecodeError:
            return None
    try:
        name.encode('utf-8')
    except UnicodeEncodeError:  # a lone surrogate
        return None
    name = BIDI.sub('', name)
    if not name.rstrip('. ') or UNSAFE.search(name) or len(name.encode()) > MAX_NAME_BYTES:
        return None
    return name


def seconds(mtime_ns):
    """§5.1: whole seconds, rounded down, clamped to what both DOS time and a signed 32-bit UT field hold."""
    return min(max(mtime_ns // 10**9, T_MIN), T_MAX)


def gather(root, listdir):
    """§2: walks a folder through listdir(rel) → [(raw name, kind, size, mtime_ns, source)], kind one of file, dir,
    symlink or special; rel is the tuple of raw names below the root. Returns (entries in zip order, skipped)."""
    root = clean(root) or 'folder'
    entries, skipped, todo = [], [], [((), root)]
    while todo:
        rel, prefix = todo.pop()
        for name, kind, size, mtime_ns, source in listdir(rel):
            raw = b'/'.join(n if isinstance(n, bytes) else n.encode('utf-8', 'surrogatepass') for n in (*rel, name))
            if kind in ('symlink', 'special'):
                skipped.append((raw, kind))
                continue
            safe = clean(name)
            path = safe and prefix + '/' + safe
            # A folder whose path leaves no room for '/' and a name can hold no file that is kept: skipped as a whole.
            if not safe or len(path.encode()) + (2 if kind == 'dir' else 0) > MAX_PATH_BYTES:
                skipped.append((raw, 'name'))
            elif kind == 'dir':
                todo.append(((*rel, name), path))
            else:
                entries.append(Entry(path, size, seconds(mtime_ns), source))
    entries.sort(key=lambda e: e.path.encode())
    skipped.sort()
    return entries, skipped


def check(entries, limit=MAX_FILE_BYTES):
    """§2.6, in this order. Returns the layout of a folder that may be uploaded."""
    if not entries:
        raise Refused('empty')
    if len(entries) > MAX_ENTRIES:
        raise Refused('too_many', str(len(entries)))
    # The first path the next one repeats, or that is also a folder of another entry ('a' and 'a/b').
    folders = {e.path[:i] for e in entries for i, c in enumerate(e.path) if c == '/'}
    for i, e in enumerate(entries):
        if (i + 1 < len(entries) and entries[i + 1].path == e.path) or e.path in folders:
            raise Refused('collision', e.path)
    out = layout(entries)
    if out.size > limit:
        raise Refused('too_large', str(out.size))
    return out


def open_dir(folder, rel):
    """The folder at rel (raw names) below folder, opened name by name without following a symlink: no path is longer
    than one name, so paths beyond PATH_MAX work too."""
    fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
    for name in rel:
        try:
            below = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        finally:
            os.close(fd)
        fd = below
    return fd


def open_source(source):
    """A file of collect(), (folder, raw names below it), opened inside its folder without following a symlink."""
    folder, parts = source
    fd = open_dir(folder, parts[:-1])
    try:
        return open(os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd), 'rb')
    finally:
        os.close(fd)


def collect(folder):
    """§2 on a real folder, by directory handles. The root may be a symlink; nothing below it is followed."""
    real = os.path.realpath(os.fsencode(folder))
    if not os.path.isdir(real):
        raise NotADirectoryError(folder)

    def listdir(rel):
        out, fd = [], open_dir(real, rel)
        try:
            with os.scandir(fd) as found:
                for item in found:
                    info = item.stat(follow_symlinks=False)
                    kind = ('symlink' if stat.S_ISLNK(info.st_mode) else 'dir' if stat.S_ISDIR(info.st_mode)
                            else 'file' if stat.S_ISREG(info.st_mode) else 'special')
                    name = os.fsencode(item.name)
                    out.append((name, kind, info.st_size, info.st_mtime_ns, (real, (*rel, name))))
        finally:
            os.close(fd)
        return out
    return gather(os.path.basename(real), listdir)


def layout(entries):
    """§6: everything but the CRCs follows from the paths and sizes."""
    rows, offset = [], 0
    for e in entries:
        n = len(e.path.encode())
        large, far = e.size >= U32, offset >= U32
        k = 2 * large + far
        rows.append(Row(offset, 30 + n + 9 + 20 * large, 46 + n + 9 + (4 + 8 * k if k else 0), large, far))
        offset += rows[-1].local + e.size
    cd_size = sum(r.central for r in rows)
    zip64_end = len(entries) >= U16 or cd_size >= U32 or offset >= U32
    return Layout(tuple(entries), tuple(rows), offset, cd_size, zip64_end, offset + cd_size + 22 + 76 * zip64_end)


def dos(t):
    d = datetime.fromtimestamp(t, timezone.utc)
    return d.hour << 11 | d.minute << 5 | d.second // 2, (d.year - 1980) << 9 | d.month << 5 | d.day


def local_header(e, row, crc):
    name, (time, date) = e.path.encode(), dos(e.mtime)
    extra = (struct.pack('<HHQQ', 0x0001, 16, e.size, e.size) if row.large else b'') + struct.pack('<HHBI', 0x5455, 5, 1, e.mtime)
    size = U32 if row.large else e.size
    return struct.pack('<IHHHHHIIIHH', 0x04034B50, 45 if row.large or row.far else 20, 0x0800, 0, time, date, crc, size, size,
                       len(name), len(extra)) + name + extra


def central_header(e, row, crc):
    name, (time, date) = e.path.encode(), dos(e.mtime)
    fields = [e.size, e.size] * row.large + [row.offset] * row.far
    extra = (struct.pack('<HH', 0x0001, 8 * len(fields)) + struct.pack(f'<{len(fields)}Q', *fields) if fields else b'') \
        + struct.pack('<HHBI', 0x5455, 5, 1, e.mtime)
    version, size = 45 if fields else 20, U32 if row.large else e.size
    return struct.pack('<IHHHHHHIIIHHHHHII', 0x02014B50, 0x0300 | version, version, 0x0800, 0, time, date, crc, size, size,
                       len(name), len(extra), 0, 0, 0, MODE << 16, U32 if row.far else row.offset) + name + extra


def end_records(out):
    count, size, offset = len(out.entries), out.cd_size, out.cd_offset
    records = b''
    if out.zip64_end:
        records += struct.pack('<IQHHIIQQQQ', 0x06064B50, 44, 0x032D, 45, 0, 0, count, count, size, offset)
        records += struct.pack('<IIQI', 0x07064B50, 0, offset + size, 1)
        count, size, offset = U16, U32, U32
    return records + struct.pack('<IHHHHIIH', 0x06054B50, 0, 0, count, count, size, offset, 0)


def segments(out, crcs):
    """The zip as ('bytes', b) and ('data', index, length) in stream order, adjacent header bytes merged."""
    pending = []
    for i, (e, row) in enumerate(zip(out.entries, out.rows, strict=True)):
        pending.append(local_header(e, row, crcs[i]))
        if e.size:
            yield 'bytes', b''.join(pending)
            yield 'data', i, e.size
            pending = []
    pending += [central_header(e, row, crcs[i]) for i, (e, row) in enumerate(zip(out.entries, out.rows, strict=True))]
    yield 'bytes', b''.join(pending) + end_records(out)


def read_range(out, crcs, read, start, end):
    """Bytes [start, end) of the zip, read(i, offset, length) giving entry i's data: how a client builds part p."""
    chunks, pos = [], 0
    for seg in segments(out, crcs):
        length = len(seg[1]) if seg[0] == 'bytes' else seg[2]
        lo, hi = max(start, pos), min(end, pos + length)
        if lo < hi:
            chunks.append(seg[1][lo - pos:hi - pos] if seg[0] == 'bytes' else read(seg[1], lo - pos, hi - lo))
        pos += length
    return b''.join(chunks)


def read_source(e, offset, length):
    if isinstance(e.source, bytes):
        return e.source[offset:offset + length]
    with open_source(e.source) as f:
        f.seek(offset)
        data = f.read(length)
    if len(data) != length:
        raise OSError(f'{e.path} changed while it was read')
    return data


def crc_pass(entries):
    """§7.1: the CRC pre-pass, which also checks that each file still has its listed size."""
    crcs = []
    for e in entries:
        crc, seen = 0, 0
        if isinstance(e.source, bytes):
            crc, seen = zlib.crc32(e.source), len(e.source)
        else:
            with open_source(e.source) as f:
                while block := f.read(1 << 20):
                    crc, seen = zlib.crc32(block, crc), seen + len(block)
        if seen != e.size:
            raise OSError(f'{e.path} changed while it was read')
        crcs.append(crc)
    return crcs


def write_zip(entries, path):
    """The zip into the file at path, each entry's data copied in blocks: any size, in little memory."""
    out = check(entries)
    crcs = crc_pass(entries)
    with open(path, 'wb') as f:
        for seg in segments(out, crcs):
            if seg[0] == 'bytes':
                f.write(seg[1])
                continue
            e, left = out.entries[seg[1]], seg[2]
            if isinstance(e.source, bytes):
                f.write(e.source)
                continue
            with open_source(e.source) as src:
                while left:
                    block = src.read(min(left, 1 << 20))
                    if not block:
                        raise OSError(f'{e.path} changed while it was read')
                    f.write(block)
                    left -= len(block)


def zip_bytes(entries):
    out = check(entries)
    crcs = crc_pass(entries)
    return read_range(out, crcs, lambda i, o, n: read_source(out.entries[i], o, n), 0, out.size)


def fingerprint(entries):
    """§9: F over the entry list, 22 characters."""
    h = hashlib.sha256(PROFILE + b'\n')
    for e in entries:
        h.update(e.path.encode() + b'\0' + str(e.size).encode() + b'\0' + str(e.mtime).encode() + b'\n')
    return b64url(h.digest()[:16])


def _gf2_times(mat, vec):
    total, i = 0, 0
    while vec:
        if vec & 1:
            total ^= mat[i]
        vec, i = vec >> 1, i + 1
    return total


def _gf2_square(mat):
    return [_gf2_times(mat, mat[n]) for n in range(32)]


def crc32_combine(crc1, crc2, len2):
    """CRC-32 of A‖B from crc(A), crc(B) and len(B) (zlib's crc32_combine): §7.3 checks the parts' bytes with it."""
    if len2 <= 0:
        return crc1
    odd = [0xEDB88320] + [1 << n for n in range(31)]
    even = _gf2_square(odd)
    odd = _gf2_square(even)
    while True:
        even = _gf2_square(odd)
        if len2 & 1:
            crc1 = _gf2_times(even, crc1)
        len2 >>= 1
        if not len2:
            break
        odd = _gf2_square(even)
        if len2 & 1:
            crc1 = _gf2_times(odd, crc1)
        len2 >>= 1
        if not len2:
            break
    return crc1 ^ crc2


def crc32_zeros(n):
    """CRC-32 of n zero bytes without reading them (the > 4 GiB vectors' data)."""
    crc, block, size = 0, zlib.crc32(b'\0'), 1
    while n:
        if n & 1:
            crc = crc32_combine(crc, block, size)
        n >>= 1
        if n:
            block, size = crc32_combine(block, block, size), size * 2
    return crc


# Vectors ---------------------------------------------------------------------------------------------------------

def node_raw(node):
    return bytes.fromhex(node['pathHex']) if 'pathHex' in node else node['path'].encode()


def node_data(node):
    return base64.b64decode(node['base64']) if 'base64' in node else node.get('text', '').encode()


def tree_listdir(tree):
    """listdir() for a vector's tree, as collect() would see it on disk (parent folders implied)."""
    dirs = {(): {}}
    for node in tree:
        parts = tuple(node_raw(node).split(b'/'))
        for i in range(1, len(parts)):
            dirs.setdefault(parts[:i], {})
            dirs[parts[:i - 1]][parts[i - 1]] = ('dir', 0, 0, None)
        kind = node.get('type', 'file')
        if kind == 'dir':
            dirs.setdefault(parts, {})
        data = node_data(node) if kind == 'file' else None
        kind = {'fifo': 'special'}.get(kind, kind)
        dirs[parts[:-1]][parts[-1]] = (kind, len(data or b''), node.get('mtimeMs', FIXED_MS) * 10**6, data)
    return lambda rel: [(name, *value) for name, value in dirs[rel].items()]


def materialise(tree, root, base):
    """Writes a vector's tree under base/root (Linux; mtimes in ns), folder by folder from its handle, so also paths
    beyond PATH_MAX. Returns the folder."""
    folder = os.path.join(os.fsencode(base), os.fsencode(root))
    os.mkdir(folder)
    for node in tree:
        *dirs, name = node_raw(node).split(b'/')
        fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in dirs:
                try:
                    os.mkdir(part, dir_fd=fd)
                except FileExistsError:
                    pass
                below = os.open(part, os.O_RDONLY | os.O_DIRECTORY, dir_fd=fd)
                os.close(fd)
                fd = below
            kind = node.get('type', 'file')
            if kind == 'dir':
                try:
                    os.mkdir(name, dir_fd=fd)
                except FileExistsError:
                    pass
            elif kind == 'symlink':
                os.symlink(os.fsencode(node['target']), name, dir_fd=fd)
            elif kind == 'fifo':
                os.mkfifo(name, dir_fd=fd)
            else:
                ns = node.get('mtimeMs', FIXED_MS) * 10**6
                with open(os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644, dir_fd=fd), 'wb') as f:
                    f.write(node_data(node))
                    f.flush()
                    os.utime(f.fileno(), ns=(ns, ns))
        finally:
            os.close(fd)
    return folder


def show(raw):
    try:
        return {'path': raw.decode('utf-8')}
    except UnicodeDecodeError:
        return {'pathHex': raw.hex()}


def expected(root, tree):
    entries, skipped = gather(root, tree_listdir(tree))
    out = check(entries)
    crcs = crc_pass(entries)
    data = read_range(out, crcs, lambda i, o, n: read_source(entries[i], o, n), 0, out.size)
    return {
        'entries': [{'path': e.path, 'size': e.size, 'mtime': e.mtime, 'crc32': f'{c:08x}', 'offset': r.offset}
                    for e, r, c in zip(entries, out.rows, crcs, strict=True)],
        'skipped': [{**show(raw), 'reason': reason} for raw, reason in skipped],
        'fingerprint': fingerprint(entries), 'size': out.size, 'sha256': hashlib.sha256(data).hexdigest(), 'zip': data.hex(),
    }


def tree_vectors():
    basic = [
        {'path': 'a.txt', 'text': 'hello\n'},
        {'path': 'sub/b.txt', 'text': 'second file\n', 'mtimeMs': 1793260801500},
        {'path': 'sub/deeper/c.bin', 'base64': base64.b64encode(bytes(range(256))).decode(), 'mtimeMs': 1700000000000},
        {'path': 'empty.txt', 'text': ''},
        {'path': '.hidden', 'text': 'dotfiles are kept\n'},
        {'path': 'emptydir', 'type': 'dir'},
        {'path': 'sub/onlydirs/inner', 'type': 'dir'},
        {'path': 'link-to-a', 'type': 'symlink', 'target': 'a.txt'},
        {'path': 'sub/link-to-dir', 'type': 'symlink', 'target': '..'},
        {'path': 'pipe', 'type': 'fifo'},
    ]
    names = [
        {'path': 'Z.txt', 'text': 'Z'},
        {'path': 'a.txt', 'text': 'a'},
        {'path': 'a-b.txt', 'text': 'a-b'},
        {'path': 'a/b.txt', 'text': 'a/b'},
        {'path': 'a0', 'text': 'a0'},
        {'path': 'ä.txt', 'text': 'NFC a-umlaut'},
        {'path': 'ä.txt', 'text': 'NFD a-umlaut'},
        {'path': '～.txt', 'text': 'U+FF5E sorts before U+1F600 in UTF-8, after it in UTF-16'},
        {'path': '\U0001f600.txt', 'text': 'emoji'},
        {'path': 'WhatsApp Chat mit ‪+43 660 1234567‬.txt', 'text': 'bidi controls are dropped'},
        {'path': 'invoice_‮fdp.exe', 'text': 'cannot pose as invoice_exe.pdf'},
        {'path': 'Mappe ‏/x.txt', 'text': 'a folder name loses its bidi control too'},
        {'path': '...dots', 'text': 'not only dots'},
        {'path': 'trailing.', 'text': 'kept as it is'},
        {'path': 'line\nbreak.txt', 'text': 'C0 control'},
        {'path': 'del\x7f.txt', 'text': 'DEL'},
        {'path': 'nel\u0085.txt', 'text': 'C1 control'},
        {'path': 'para .txt', 'text': 'paragraph separator'},
        {'path': 'back\\slash.txt', 'text': 'a separator on Windows'},
        {'path': '...', 'text': 'only dots'},
        {'path': '. ', 'text': 'a dot and a space: Windows strips the space'},
        {'path': '.. /x.txt', 'text': 'a folder Windows would read as ..'},
        {'path': ' ..', 'text': 'only spaces and dots'},
        {'path': 'draft ', 'text': 'a trailing space is kept'},
        {'path': '‎', 'text': 'nothing left after the bidi control'},
        {'path': 'bad\nfolder/inside.txt', 'text': 'skipped with its folder'},
        {'pathHex': (b'latin1-\xe9.txt').hex(), 'text': 'not UTF-8'},
    ]
    times = [
        {'path': '1970.txt', 'mtimeMs': 0},
        {'path': 'before-1970.txt', 'mtimeMs': -1500},
        {'path': '1980-plus-1s.txt', 'mtimeMs': 315532801000},
        {'path': 'odd-second.txt', 'mtimeMs': 1793260801999},
        {'path': 'leap-day.txt', 'mtimeMs': 1835481599000},
        {'path': '2038-last.txt', 'mtimeMs': 2147483647999},
        {'path': '2038-after.txt', 'mtimeMs': 2147483648000},
        {'path': '2100.txt', 'mtimeMs': 4102444800000},
    ]
    for node in times:
        node['text'] = node['path']
    deep = '/'.join(['x' * 250] * 16)  # 16 × 251 − 1 = 4015 bytes; "long/" + deep + "/" leaves 74 bytes to 4095
    lengths = [
        {'path': 'n' * 255, 'text': '255-byte name'},
        {'path': 'n' * 256, 'text': '256-byte name'},
        {'path': 'd' * 256 + '/inside.txt', 'text': 'folder name too long'},
        {'path': deep + '/' + 'p' * 74, 'text': 'path of 4095 bytes'},
        {'path': deep + '/' + 'q' * 75, 'text': 'path of 4096 bytes'},
        {'path': deep + '/' + 's' * 72 + '/x', 'text': 'in a folder of a 4093-byte path: 4095 bytes'},
        {'path': deep + '/' + 't' * 73 + '/x', 'text': 'a folder of a 4094-byte path holds no file that fits'},
    ]
    return [
        ('basic', 'photos', True, 'Files at several depths, an empty file, a hidden file; empty folders, symlinks and a FIFO are left out.', basic),
        ('names', 'Mappe ü', True, 'Entry order is the bytewise order of the UTF-8 paths (not UTF-16, no normalisation: NFC and NFD stay two entries); bidi controls are dropped; unsafe or non-UTF-8 names are skipped.', names),
        ('times', 'times', True, 'Modification times: whole seconds rounded down, clamped to 1980-01-01..2038-01-19T03:14:07Z; DOS time has 2-second steps, the UT field keeps the second.', times),
        ('lengths', 'long', False, 'Name limit 255 UTF-8 bytes per component, path limit 4095 bytes including the root folder; a folder of a path over 4093 bytes is skipped as a whole (not extracted: these paths exceed PATH_MAX on disk).', lengths),
    ]


def zip64_cases():
    """Formula cases: data are zero bytes, so the CRC is that of zeros and only header bytes are stored."""
    cases = [
        ('below', 'One entry of 0xFFFFFFFE bytes: no ZIP64 entry, but the central directory starts beyond 4 GiB.', 'big', [('a.bin', U32 - 1)]),
        ('exact', 'One entry of 0xFFFFFFFF bytes: the smallest ZIP64 entry.', 'big', [('a.bin', U32)]),
        ('offset-below', 'The second local header at offset 0xFFFFFFFE: not far.', 'far', [('a.bin', U32 - 1 - 48), ('b.txt', 6)]),
        ('offset-exact', 'The second local header at offset 0xFFFFFFFF: its central header carries a ZIP64 offset only.', 'far', [('a.bin', U32 - 48), ('b.txt', 6)]),
        ('5gib', 'A 5 GiB entry followed by a small one: ZIP64 sizes, then a ZIP64 offset.', 'video', [('clip.mov', 5 * 1024**3), ('notes.txt', 100)]),
        ('limit', 'The largest single-file folder for raw uploads: the zip is exactly 50 GiB.', 'max', [('a.bin', MAX_FILE_BYTES - 68 - 84 - 98)]),
    ]
    out = []
    for name, description, root, files in cases:
        entries = sorted((Entry(root + '/' + p, s, seconds(FIXED_MS * 10**6)) for p, s in files), key=lambda e: e.path.encode())
        lay = layout(entries)
        crcs = [crc32_zeros(e.size) for e in entries]
        segs = [{'hex': s[1].hex()} if s[0] == 'bytes' else {'zeros': s[2]} for s in segments(lay, crcs)]
        out.append({
            'name': name, 'description': description, 'root': root,
            'files': [{'path': p, 'size': s, 'mtimeMs': FIXED_MS} for p, s in files],
            'entries': [{'path': e.path, 'size': e.size, 'crc32': f'{c:08x}', 'offset': r.offset, 'local': r.local, 'central': r.central,
                         'zip64Sizes': r.large, 'zip64Offset': r.far} for e, r, c in zip(entries, lay.rows, crcs, strict=True)],
            'centralOffset': lay.cd_offset, 'centralSize': lay.cd_size, 'zip64End': lay.zip64_end, 'size': lay.size,
            'fits': {'raw': lay.size <= MAX_FILE_BYTES, 'e2ee': lay.size <= E2EE_P_MAX}, 'segments': segs,
        })
    return out


def count_entries(count):
    return [Entry(f'many/{i:05d}', 0, seconds(FIXED_MS * 10**6), b'') for i in range(count)]


def count_cases():
    """Built cases for the entry count: 65,534 entries keep the classic end record, 65,535 need the ZIP64 one."""
    out = []
    for count in (U16 - 1, U16):
        entries = count_entries(count)
        data = zip_bytes(entries)
        lay = layout(entries)
        out.append({'name': f'count-{count}', 'description': f'{count} empty files many/00000 … many/{count - 1:05d}, all at mtimeMs {FIXED_MS}.',
                    'count': count, 'centralOffset': lay.cd_offset, 'centralSize': lay.cd_size, 'zip64End': lay.zip64_end,
                    'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'tail': data[-98:].hex()})
    return out


def refusal_cases():
    collision = [{'path': 'a.txt', 'text': 'one'}, {'path': 'a‎.txt', 'text': 'two'}]
    # A file 'a' (after dropping U+200E) and a folder 'a': not adjacent once sorted ('-' comes before '/').
    prefix = [{'path': 'a‎', 'text': 'file'}, {'path': 'a-b.txt', 'text': 'between'}, {'path': 'a/b.txt', 'text': 'inside'}]
    only_skipped = [{'path': 'link', 'type': 'symlink', 'target': '/etc/hostname'}, {'path': 'empty', 'type': 'dir'}, {'path': 'bad\tname', 'text': 'x'}]
    return {
        'trees': [
            {'name': 'collision', 'root': 'clash', 'tree': collision, 'code': 'collision', 'detail': 'clash/a.txt'},
            {'name': 'prefix', 'root': 'clash', 'tree': prefix, 'code': 'collision', 'detail': 'clash/a'},
            {'name': 'empty', 'root': 'nothing', 'tree': only_skipped, 'code': 'empty'},
        ],
        'counts': [{'files': MAX_ENTRIES, 'code': None}, {'files': MAX_ENTRIES + 1, 'code': 'too_many'}],
        'sizes': [
            {'description': 'One file making the zip exactly 50 GiB', 'root': 'max', 'files': [{'path': 'a.bin', 'size': MAX_FILE_BYTES - 250}], 'limit': MAX_FILE_BYTES, 'code': None},
            {'description': 'One byte more', 'root': 'max', 'files': [{'path': 'a.bin', 'size': MAX_FILE_BYTES - 249}], 'limit': MAX_FILE_BYTES, 'code': 'too_large'},
            {'description': 'The largest E2EE plaintext (P_max) as the zip', 'root': 'max', 'files': [{'path': 'a.bin', 'size': E2EE_P_MAX - 250}], 'limit': E2EE_P_MAX, 'code': None},
            {'description': 'One byte more than P_max', 'root': 'max', 'files': [{'path': 'a.bin', 'size': E2EE_P_MAX - 249}], 'limit': E2EE_P_MAX, 'code': 'too_large'},
        ],
    }


def crc_cases():
    """crc32_combine: a split of a known input, and zeros (what a client checks before completing, §7.3)."""
    data = bytes(i * 7 % 251 for i in range(100_000))
    return [{'length': len(data), 'split': s, 'crc1': f'{zlib.crc32(data[:s]):08x}', 'crc2': f'{zlib.crc32(data[s:]):08x}',
             'crc': f'{zlib.crc32(data):08x}'} for s in (0, 1, 65536, 99_999, 100_000)]


def write(name, value):
    (OUT / name).write_text(json.dumps(value, indent=1, ensure_ascii=False) + '\n')


def generate():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, root, disk, description, tree in tree_vectors():
        write(f'{name}.json', {'description': description, 'root': root, 'disk': disk, 'tree': tree, **expected(root, tree)})
    write('zip64.json', {'description': 'ZIP64 decisions by formula (data are zero bytes; segments give every other byte) and by building 65,534/65,535 entries.',
                         'mtimeMs': FIXED_MS, 'formula': zip64_cases(), 'built': count_cases(), 'crc32Combine': crc_cases()})
    write('refusals.json', {'description': 'Folders refused as a whole (§2.6).', **refusal_cases()})


# Checks ------------------------------------------------------------------------------------------------------------

def readers_accept(data, entries, where, extract=True):
    """Python's zipfile and Info-ZIP's unzip -t must open the zip, list exactly these entries and find no CRC error;
    unzip must restore each file's mtime from the UT field (extract: paths that fit PATH_MAX under a temporary folder)."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        assert z.testzip() is None, where
        infos = z.infolist()
        assert [i.filename for i in infos] == [e.path for e in entries], where
        for i, e in zip(infos, entries, strict=True):
            d = datetime.fromtimestamp(e.mtime, timezone.utc)
            assert i.date_time == (d.year, d.month, d.day, d.hour, d.minute, d.second // 2 * 2), (where, i.filename)
            assert i.external_attr >> 16 == MODE and i.flag_bits == 0x0800 and i.compress_type == 0, where
            if isinstance(e.source, bytes):
                assert z.read(i) == e.source, where
    if not shutil.which('unzip'):
        print('unzip not found: skipped unzip -t', file=sys.stderr)
        return
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, 'v.zip')
        with open(path, 'wb') as f:
            f.write(data)
        result = subprocess.run(['unzip', '-tq', path], capture_output=True, text=True)
        assert result.returncode == 0, (where, result.stdout, result.stderr)
        if extract and len(entries) <= 100:
            out = os.path.join(tmp, 'x')
            subprocess.run(['unzip', '-q', path, '-d', out], check=True, env={**os.environ, 'UNZIP': '', 'TZ': 'UTC'})
            for e in entries:
                assert int(os.stat(os.path.join(os.fsencode(out), e.path.encode())).st_mtime) == e.mtime, (where, e.path)


def verify():
    for name, _root, _disk, _description, _tree in tree_vectors():
        vector = json.loads((OUT / f'{name}.json').read_text())
        assert {k: vector[k] for k in ('entries', 'skipped', 'fingerprint', 'size', 'sha256', 'zip')} == expected(vector['root'], vector['tree']), name
        entries, _ = gather(vector['root'], tree_listdir(vector['tree']))
        readers_accept(bytes.fromhex(vector['zip']), entries, name, vector['disk'])
        print(f'{name}.json: {len(entries)} entries, {vector["size"]} bytes, zipfile and unzip -t pass')
    zip64 = json.loads((OUT / 'zip64.json').read_text())
    assert zip64['formula'] == zip64_cases() and zip64['crc32Combine'] == crc_cases()
    built = count_cases()
    assert zip64['built'] == built
    for case in built:
        entries = count_entries(case['count'])
        readers_accept(zip_bytes(entries), entries, case['name'])
        print(f'{case["name"]}: zip64End {case["zip64End"]}, zipfile and unzip -t pass')
    refusals = json.loads((OUT / 'refusals.json').read_text())
    assert {k: v for k, v in refusals.items() if k != 'description'} == json.loads(json.dumps(refusal_cases(), ensure_ascii=False))
    for case in refusals['trees']:
        try:
            check(gather(case['root'], tree_listdir(case['tree']))[0])
            raise AssertionError(case['name'])
        except Refused as refused:
            assert (refused.code, refused.detail or None) == (case['code'], case.get('detail')), case['name']
    for case in refusals['counts'] + refusals['sizes']:
        entries = count_entries(case['files']) if 'limit' not in case else [Entry(case['root'] + '/' + f['path'], f['size'], T_MIN) for f in case['files']]
        try:
            check(entries, case.get('limit', MAX_FILE_BYTES))
            assert case['code'] is None, case
        except Refused as refused:
            assert refused.code == case['code'], case
    print('refusals.json: every case gives its code')


def big(directory):
    """Writes each formula case as a sparse file (the zero data are holes) and runs zipfile and unzip -t on it."""
    for case in json.loads((OUT / 'zip64.json').read_text())['formula']:
        path = os.path.join(directory, case['name'] + '.zip')
        with open(path, 'wb') as f:
            for seg in case['segments']:
                if 'hex' in seg:
                    f.write(bytes.fromhex(seg['hex']))
                else:
                    f.seek(seg['zeros'], os.SEEK_CUR)
            f.truncate()
        assert os.path.getsize(path) == case['size']
        with zipfile.ZipFile(path) as z:
            assert [i.filename for i in z.infolist()] == [e['path'] for e in case['entries']]
            assert z.testzip() is None, case['name']
        result = subprocess.run(['unzip', '-tq', path], capture_output=True, text=True)
        assert result.returncode == 0, (case['name'], result.stdout, result.stderr)
        print(f'{case["name"]}: {case["size"]} bytes, zipfile testzip and unzip -t pass: {result.stdout.strip()}')
        os.remove(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--check', action='store_true', help='only check the committed vectors')
    parser.add_argument('--big', metavar='DIR', help='also test the > 4 GiB cases as sparse files in DIR')
    parser.add_argument('--zip', nargs=2, metavar=('FOLDER', 'OUT'), help='zip a real folder')
    args = parser.parse_args()
    if args.zip:
        entries, skipped = collect(args.zip[0])
        write_zip(entries, args.zip[1])
        for raw, reason in skipped:
            print(f'skipped ({reason}): {raw!r}', file=sys.stderr)
        print(f'{len(entries)} files, fingerprint {fingerprint(entries)}')
        return
    if not args.check:
        generate()
    verify()
    if args.big:
        big(args.big)


if __name__ == '__main__':
    main()

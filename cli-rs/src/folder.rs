//! `fyl FOLDER`: a folder as one zip (docs/FOLDER-ZIP.md, profile `fyl-folder-zip-1`). The zip is uncompressed (STORE)
//! and every byte of it follows from the folder, so its size is known before /api/upload/init, any 50 MiB part is built
//! on its own straight from the files (no temporary file), and a resumed run builds the same bytes again. The browser
//! builds the same bytes: tests/vectors/folder-zip/ binds both.

use crate::{base64url, civil};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::{CStr, CString, OsStr};
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// §2.6: more entries are refused, so the entry list and the central directory (about 10 MB) stay bounded.
const MAX_ENTRIES: usize = 100_000;
/// §2.6: the CLI lists no more folders than this, so a tree of empty folders can't make the walk run on and on.
const MAX_FOLDERS: usize = 100_000;
/// §2.3: a component's and a path's UTF-8 bytes (Info-ZIP `unzip` truncates longer paths).
const MAX_NAME: usize = 255;
const MAX_PATH: usize = 4095;
const U16: u64 = 0xFFFF;
const U32: u64 = 0xFFFF_FFFF;
/// §5.1: 1980-01-01T00:00:00Z to 2038-01-19T03:14:07Z, which DOS time and a signed 32-bit UT field both hold.
const T_MIN: i64 = 315_532_800;
const T_MAX: i64 = 2_147_483_647;
/// §5.2: a regular file, rw-r--r--, for every entry.
const MODE: u64 = 0o100_644;
/// The E2EE chunk (docs/E2EE.md §4): where runs of data are cut for the check before completing.
const CUT: u64 = crate::e2ee::CHUNK as u64;

pub(crate) const CHANGED: &str = "A file in the folder changed while it was uploaded. Start a new upload.";
/// §9: a resume whose folder no longer gives the same zip (exit 2; the upload stays as it is).
pub(crate) const RESUME_CHANGED: &str = "The folder changed since this upload started. Start a new upload.";

/// What a walk found under a folder (§2.1).
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Kind { File, Dir, Symlink, Special }

/// One item of a folder: its name as the system gives it, its kind, size and modification time (seconds and
/// nanoseconds), and which file it is (device and inode).
pub(crate) struct Item {
    pub(crate) name: Vec<u8>,
    pub(crate) kind: Kind,
    pub(crate) size: u64,
    pub(crate) mtime: (i64, i64),
    pub(crate) id: (u64, u64),
}

/// A file in the zip: its path (root folder first), size, t of §5.1, and where and as what the walk saw it: `source`
/// is its path below the root as the system gives it, read folder by folder from the root's handle, so a file deeper
/// than PATH_MAX is read too. `id` (device, inode) makes sure a read gets that very file, also when a folder on its way
/// was replaced since.
pub(crate) struct Entry {
    pub(crate) path: String,
    pub(crate) size: u64,
    pub(crate) t: u32,
    source: PathBuf,
    mtime: (i64, i64),
    id: (u64, u64),
}

/// Why an item was left out (§2.5).
#[derive(Clone, Copy, PartialEq, PartialOrd, Eq, Ord)]
pub(crate) enum Reason { Name { dir: bool }, Special, Symlink }

impl Reason {
    pub(crate) fn code(self) -> &'static str {
        match self { Reason::Name { .. } => "name", Reason::Special => "special", Reason::Symlink => "symlink" }
    }
}

/// An item left out, by its path below the folder as the system gives it.
pub(crate) struct Skipped {
    pub(crate) raw: Vec<u8>,
    pub(crate) reason: Reason,
}

/// A folder refused as a whole (§2.6), before anything is read or sent.
#[derive(Debug, PartialEq)]
pub(crate) enum Refusal { Empty, TooMany, TooManyFolders, Collision(String), TooLarge }

impl Refusal {
    pub(crate) fn message(&self) -> String {
        match self {
            Refusal::Empty => "The folder has no files to send.".into(),
            Refusal::TooMany => "The folder has more than 100,000 files. Zip it yourself or send it in parts.".into(),
            Refusal::TooManyFolders => "The folder has more than 100,000 folders. Zip it yourself or send it in parts.".into(),
            Refusal::Collision(path) => format!("Two items in the folder would get the same name: {path}."),
            Refusal::TooLarge => "The folder makes a zip larger than 50 GB.".into(),
        }
    }
}

/// Bidi controls: dropped from names, as the server drops them from file names (§2.3 rule 2).
fn bidi(c: char) -> bool {
    matches!(c, '\u{61C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// One path component → its name in the zip, or None to skip it (§2.3): valid UTF-8, bidi controls dropped, then not
/// only dots and spaces (Windows strips trailing ones, so `.. ` would become `..`), no separator, C0/C1 control or
/// line/paragraph separator, at most 255 bytes. Nothing else changes.
pub(crate) fn clean_name(raw: &[u8]) -> Option<String> {
    let name: String = std::str::from_utf8(raw).ok()?.chars().filter(|c| !bidi(*c)).collect();
    let unsafe_char = |c: char| c.is_control() || matches!(c, '/' | '\\' | '\u{2028}' | '\u{2029}');
    (!name.trim_end_matches(['.', ' ']).is_empty() && !name.chars().any(unsafe_char) && name.len() <= MAX_NAME).then_some(name)
}

/// A path as the system gives it, for a message: anything that could move the cursor or disguise a name escaped.
pub(crate) fn escaped(raw: &[u8]) -> String {
    let mut out = String::new();
    for chunk in raw.utf8_chunks() {
        for c in chunk.valid().chars() {
            if c.is_control() || bidi(c) || matches!(c, '\u{2028}' | '\u{2029}') { out.extend(c.escape_debug()) } else { out.push(c) }
        }
        for byte in chunk.invalid() { out += &format!("\\x{byte:02x}"); }
    }
    out
}

/// What a walk found: the entries in zip order, the items left out, and how many folders it went into. `root` is the
/// folder's handle, which files are read from (none for a walk in memory).
pub(crate) struct Found {
    pub(crate) entries: Vec<Entry>,
    pub(crate) skipped: Vec<Skipped>,
    folders: usize,
    root: Option<Arc<File>>,
}

/// §2: walks a folder through `list(rel)`, the items below the root at `rel` (raw names), down every directory whose
/// name is kept and whose path leaves room for a file in it (§2.3). Returns the entries in zip order (bytewise by
/// path, §2.4) and the items left out. Past 100,000 files or folders it lists no further folder: the folder is refused
/// anyway (§2.6).
pub(crate) fn gather<E>(root: &[u8], mut list: impl FnMut(&[Vec<u8>]) -> Result<Vec<Item>, E>) -> Result<Found, E> {
    let root = clean_name(root).unwrap_or_else(|| "folder".into());
    let (mut entries, mut skipped, mut todo, mut folders) = (Vec::new(), Vec::new(), vec![(Vec::new(), root)], 0);
    while let Some((rel, prefix)) = todo.pop() {
        if entries.len() > MAX_ENTRIES || folders > MAX_FOLDERS { break }
        for item in list(&rel)? {
            let below = [rel.clone(), vec![item.name.clone()]].concat();
            let reason = match item.kind {
                Kind::Symlink => Reason::Symlink,
                Kind::Special => Reason::Special,
                kind => match clean_name(&item.name).map(|name| format!("{prefix}/{name}")) {
                    // "/" and a name of at least one byte: a folder of a longer path can hold no file that is kept.
                    Some(path) if kind == Kind::Dir && path.len() + 2 <= MAX_PATH => { folders += 1; todo.push((below, path)); continue }
                    Some(path) if kind == Kind::File && path.len() <= MAX_PATH => {
                        let source = PathBuf::from(OsStr::from_bytes(&below.join(&b'/')));
                        entries.push(Entry { path, size: item.size, t: item.mtime.0.clamp(T_MIN, T_MAX) as u32, source, mtime: item.mtime, id: item.id });
                        continue
                    }
                    _ => Reason::Name { dir: kind == Kind::Dir },
                },
            };
            skipped.push(Skipped { raw: below.join(&b'/'), reason });
        }
    }
    entries.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    skipped.sort_unstable_by(|a, b| (&a.raw, a.reason.code()).cmp(&(&b.raw, b.reason.code())));
    Ok(Found { entries, skipped, folders, root: None })
}

/// A directory `name` inside `at` (a directory, or AT_FDCWD for a path), opened without following a symlink.
fn open_dir(at: libc::c_int, name: &[u8]) -> io::Result<File> {
    let name = CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    // SAFETY: a NUL-terminated name and a directory descriptor (or AT_FDCWD), which openat only reads.
    let fd = unsafe { libc::openat(at, name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 { return Err(io::Error::last_os_error()) }
    // SAFETY: openat just returned this descriptor, and nothing else owns it.
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// errno set to 0, to tell the end of a directory from an error in readdir.
fn clear_errno() {
    // SAFETY: the calling thread's errno, which only this thread writes.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    unsafe { *libc::__errno_location() = 0 }
    // SAFETY: as above.
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    unsafe { *libc::__error() = 0 }
}

/// The items in an open directory, each as lstat sees it relative to that directory (fstatat without following).
fn list_dir(dir: File) -> io::Result<Vec<(Vec<u8>, libc::stat)>> {
    let fd = dir.into_raw_fd();
    // SAFETY: fdopendir takes over the descriptor, which this function owns now; closedir below closes it.
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        let error = io::Error::last_os_error();
        // SAFETY: fdopendir failed, so the descriptor is still this function's to close.
        unsafe { libc::close(fd) };
        return Err(error);
    }
    let found = || -> io::Result<Vec<(Vec<u8>, libc::stat)>> {
        let mut items = Vec::new();
        loop {
            clear_errno();
            // SAFETY: a stream from fdopendir that stays open until closedir below.
            let next = unsafe { libc::readdir(stream) };
            if next.is_null() {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(0) { Ok(items) } else { Err(error) };
            }
            // SAFETY: readdir returned an entry, whose d_name is NUL-terminated and valid until the next readdir.
            let name = unsafe { CStr::from_ptr((*next).d_name.as_ptr()) };
            if matches!(name.to_bytes(), b"." | b"..") { continue }
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            // SAFETY: the stream's descriptor, a NUL-terminated name and room for one stat, which fstatat fills.
            if unsafe { libc::fstatat(libc::dirfd(stream), name.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) } != 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: fstatat succeeded, so it filled the stat.
            items.push((name.to_bytes().to_vec(), unsafe { stat.assume_init() }));
        }
    };
    let items = found();
    // SAFETY: the stream from fdopendir, closed once (with its descriptor).
    unsafe { libc::closedir(stream) };
    items
}

/// A file's (device, inode).
type Id = (u64, u64);

/// §2 on disk, by directory handles: every folder is opened inside the one it was listed in, without following a
/// symlink, and must still be the folder (device, inode) that listing saw. So a folder swapped for a symlink while the
/// walk runs stops it instead of bringing in files from elsewhere; a folder that is also one it is in (a bind mount
/// of a folder above it) stops it too, instead of going round in circles.
pub(crate) struct Walk {
    real: PathBuf,
    root: File,
    root_id: Id,
    /// Each folder the walk listed, by the folder it is in and its raw name.
    dirs: HashMap<Id, HashMap<Vec<u8>, Id>>,
}

impl Walk {
    /// The folder named may be a symlink, which is resolved; nothing below it is followed.
    pub(crate) fn new(folder: &Path) -> Result<Walk, (PathBuf, io::Error)> {
        let real = fs::canonicalize(folder).map_err(|error| (folder.to_path_buf(), error))?;
        let root = open_dir(libc::AT_FDCWD, real.as_os_str().as_bytes()).map_err(|error| (real.clone(), error))?;
        let meta = root.metadata().map_err(|error| (real.clone(), error))?;
        Ok(Walk { real, root, root_id: (meta.dev(), meta.ino()), dirs: HashMap::new() })
    }

    /// The items of the folder at `rel` below the root.
    pub(crate) fn list(&mut self, rel: &[Vec<u8>]) -> Result<Vec<Item>, (PathBuf, io::Error)> {
        let mut path = self.real.clone();
        let mut dir = self.root.try_clone().map_err(|error| (path.clone(), error))?;
        let mut above = vec![self.root_id];
        for name in rel {
            path.push(OsStr::from_bytes(name));
            let next = open_dir(dir.as_raw_fd(), name).map_err(|error| (path.clone(), error))?;
            let meta = next.metadata().map_err(|error| (path.clone(), error))?;
            let id = (meta.dev(), meta.ino());
            if self.dirs.get(&above[above.len() - 1]).and_then(|names| names.get(name)) != Some(&id) {
                return Err((path, io::Error::other("it was replaced while fyl read the folder")));
            }
            if above.contains(&id) { return Err((path, io::Error::other("it is a folder it is in (a loop)"))) }
            above.push(id);
            dir = next;
        }
        let here = above[above.len() - 1];
        let mut items = Vec::new();
        for (name, stat) in list_dir(dir).map_err(|error| (path.clone(), error))? {
            let item = Item { name, ..item(&stat) };
            if item.kind == Kind::Dir { self.dirs.entry(here).or_default().insert(item.name.clone(), item.id); }
            items.push(item);
        }
        Ok(items)
    }
}

/// An item's kind, size, modification time and (device, inode) from its lstat; name still empty.
// The field types differ between Linux and macOS (dev_t is i32 there, the nanoseconds a c_long).
#[allow(clippy::unnecessary_cast)]
fn item(stat: &libc::stat) -> Item {
    let kind = match stat.st_mode & libc::S_IFMT {
        libc::S_IFLNK => Kind::Symlink,
        libc::S_IFDIR => Kind::Dir,
        libc::S_IFREG => Kind::File,
        _ => Kind::Special,
    };
    Item { name: Vec::new(), kind, size: stat.st_size as u64, mtime: (stat.st_mtime as i64, stat.st_mtime_nsec as i64),
           id: (stat.st_dev as u64, stat.st_ino as u64) }
}

/// §2 on disk ([Walk]). An item that can't be listed comes back with its path.
pub(crate) fn collect(folder: &Path) -> Result<Found, (PathBuf, io::Error)> {
    let mut walk = Walk::new(folder)?;
    let root = walk.real.file_name().map_or(&b""[..], OsStr::as_bytes).to_vec();
    let found = gather(&root, |rel| walk.list(rel))?;
    Ok(Found { root: Some(Arc::new(walk.root)), ..found })
}

/// "Skipped 2 symlinks and 1 file with an unsafe name." (§2.5), or None when nothing was left out.
pub(crate) fn skipped_note(skipped: &[Skipped]) -> Option<String> {
    let count = |reason: Reason| skipped.iter().filter(|item| item.reason == reason).count();
    let kinds = [(Reason::Symlink, "symlink", "symlinks"), (Reason::Special, "special file", "special files"),
                 (Reason::Name { dir: false }, "file with an unsafe name", "files with an unsafe name"),
                 (Reason::Name { dir: true }, "folder with an unsafe name", "folders with an unsafe name")];
    let parts: Vec<String> = kinds.iter().map(|&(reason, one, many)| (count(reason), one, many)).filter(|(n, ..)| *n > 0)
        .map(|(n, one, many)| format!("{n} {}", if n == 1 { one } else { many })).collect();
    let (last, rest) = parts.split_last()?;
    Some(if rest.is_empty() { format!("Skipped {last}.") } else { format!("Skipped {} and {last}.", rest.join(", ")) })
}

/// Where an entry's headers go (§6).
pub(crate) struct Row {
    pub(crate) offset: u64,
    pub(crate) local: u64,
    pub(crate) central: u64,
    pub(crate) large: bool,
    pub(crate) far: bool,
}

/// The zip's layout, which follows from the paths and sizes alone (§6): where each header starts, the central
/// directory, whether the ZIP64 end records are needed, and the size.
pub(crate) struct Layout {
    pub(crate) rows: Vec<Row>,
    /// Each central header's start within the central directory.
    centrals: Vec<u64>,
    pub(crate) cd_offset: u64,
    pub(crate) cd_size: u64,
    pub(crate) zip64_end: bool,
    pub(crate) size: u64,
}

/// What reads an entry's data for a part: `read(entry, offset in its file, buffer)`.
pub(crate) type Reader<'a> = dyn FnMut(usize, u64, &mut [u8]) -> io::Result<()> + 'a;

/// A run of an entry's data that went into a buffer: from `offset` in the file, `len` bytes with this CRC-32.
pub(crate) struct Segment {
    pub(crate) entry: usize,
    pub(crate) offset: u64,
    pub(crate) len: u64,
    pub(crate) crc: u32,
}

/// Appends each value as a little-endian integer of its width in bytes.
fn put(out: &mut Vec<u8>, fields: &[(u64, usize)]) {
    for &(value, width) in fields { out.extend_from_slice(&value.to_le_bytes()[..width]); }
}

/// DOS time and date of t, in UTC (§5.1).
fn dos(t: u32) -> (u64, u64) {
    let (year, month, day, hour, minute, second) = civil(u64::from(t) * 1000);
    (hour << 11 | minute << 5 | (second / 2), ((year - 1980) << 9 | month << 5 | day) as u64)
}

/// §2.6, in this order, then §6. `limit` is maxFileBytes for a raw upload, P_max with E2EE. A collision names the
/// first path in zip order that the next one repeats or that is also a folder of another entry (`a` and `a/b`).
pub(crate) fn check(entries: &[Entry], limit: u64) -> Result<Layout, Refusal> {
    if entries.is_empty() { return Err(Refusal::Empty) }
    if entries.len() > MAX_ENTRIES { return Err(Refusal::TooMany) }
    let folders: HashSet<&str> = entries.iter().flat_map(|entry| entry.path.match_indices('/').map(|(at, _)| &entry.path[..at])).collect();
    let clash = |(i, entry): &(usize, &Entry)| entries.get(i + 1).is_some_and(|next| next.path == entry.path) || folders.contains(entry.path.as_str());
    if let Some((_, entry)) = entries.iter().enumerate().find(clash) { return Err(Refusal::Collision(entry.path.clone())) }
    let layout = Layout::new(entries);
    if layout.size > limit { return Err(Refusal::TooLarge) }
    Ok(layout)
}

impl Layout {
    pub(crate) fn new(entries: &[Entry]) -> Layout {
        let (mut rows, mut centrals, mut offset, mut cd_size) = (Vec::with_capacity(entries.len()), Vec::with_capacity(entries.len()), 0, 0);
        for entry in entries {
            let n = entry.path.len() as u64;
            let (large, far) = (entry.size >= U32, offset >= U32);
            let k = 2 * u64::from(large) + u64::from(far);
            let row = Row { offset, local: 30 + n + 9 + 20 * u64::from(large), central: 46 + n + 9 + if k > 0 { 4 + 8 * k } else { 0 }, large, far };
            offset += row.local + entry.size;
            centrals.push(cd_size);
            cd_size += row.central;
            rows.push(row);
        }
        let zip64_end = entries.len() as u64 >= U16 || cd_size >= U32 || offset >= U32;
        Layout { rows, centrals, cd_offset: offset, cd_size, zip64_end, size: offset + cd_size + 22 + 76 * u64::from(zip64_end) }
    }

    /// §3.1: 30 bytes, the path, the ZIP64 sizes of a large entry, the UT field.
    fn local_header(entry: &Entry, row: &Row, crc: u32) -> Vec<u8> {
        let ((time, date), n, s) = (dos(entry.t), entry.path.len() as u64, entry.size);
        let size = if row.large { U32 } else { s };
        let mut out = Vec::with_capacity(row.local as usize);
        put(&mut out, &[(0x0403_4B50, 4), (if row.large || row.far { 45 } else { 20 }, 2), (0x0800, 2), (0, 2), (time, 2), (date, 2),
                        (u64::from(crc), 4), (size, 4), (size, 4), (n, 2), (if row.large { 29 } else { 9 }, 2)]);
        out.extend_from_slice(entry.path.as_bytes());
        if row.large { put(&mut out, &[(1, 2), (16, 2), (s, 8), (s, 8)]) }
        put(&mut out, &[(0x5455, 2), (5, 2), (1, 1), (u64::from(entry.t), 4)]);
        out
    }

    /// §3.2: 46 bytes, the path, the ZIP64 field with exactly the values whose 32-bit field is 0xFFFFFFFF, the UT field.
    fn central_header(entry: &Entry, row: &Row, crc: u32) -> Vec<u8> {
        let ((time, date), n, s) = (dos(entry.t), entry.path.len() as u64, entry.size);
        let zip64: Vec<u64> = [s, s].into_iter().filter(|_| row.large).chain(row.far.then_some(row.offset)).collect();
        let (version, size) = (if zip64.is_empty() { 20 } else { 45 }, if row.large { U32 } else { s });
        let extra = 9 + if zip64.is_empty() { 0 } else { 4 + 8 * zip64.len() as u64 };
        let mut out = Vec::with_capacity(row.central as usize);
        put(&mut out, &[(0x0201_4B50, 4), (0x0300 | version, 2), (version, 2), (0x0800, 2), (0, 2), (time, 2), (date, 2), (u64::from(crc), 4),
                        (size, 4), (size, 4), (n, 2), (extra, 2), (0, 2), (0, 2), (0, 2), (MODE << 16, 4), (if row.far { U32 } else { row.offset }, 4)]);
        out.extend_from_slice(entry.path.as_bytes());
        if !zip64.is_empty() {
            put(&mut out, &[(1, 2), (8 * zip64.len() as u64, 2)]);
            for value in zip64 { put(&mut out, &[(value, 8)]) }
        }
        put(&mut out, &[(0x5455, 2), (5, 2), (1, 1), (u64::from(entry.t), 4)]);
        out
    }

    /// §3.4: the ZIP64 end record and locator when needed (the classic fields then all at their maximum), and the end
    /// of central directory record.
    fn end_records(&self, count: u64) -> Vec<u8> {
        let (mut count16, mut size, mut offset, mut out) = (count, self.cd_size, self.cd_offset, Vec::new());
        if self.zip64_end {
            put(&mut out, &[(0x0606_4B50, 4), (44, 8), (0x032D, 2), (45, 2), (0, 4), (0, 4), (count, 8), (count, 8), (size, 8), (offset, 8)]);
            put(&mut out, &[(0x0706_4B50, 4), (0, 4), (offset + size, 8), (1, 4)]);
            (count16, size, offset) = (U16, U32, U32);
        }
        put(&mut out, &[(0x0605_4B50, 4), (0, 2), (0, 2), (count16, 2), (count16, 2), (size, 4), (offset, 4), (0, 2)]);
        out
    }

    /// Bytes [start, start + buf.len()) of the zip (§7.2): headers from the layout, data through `read(entry, offset
    /// in its file, buffer)`. Returns the data runs read, for the check before completing (§7.3). Runs are cut at the
    /// first and the last 64 KiB boundary of the zip inside the range: the chunk two neighbouring encrypted parts share
    /// is read by both (docs/E2EE.md §7 step 4), and so gives the very same run twice.
    pub(crate) fn read(&self, entries: &[Entry], crcs: &[u32], start: u64, buf: &mut [u8],
                       read: &mut Reader) -> io::Result<Vec<Segment>> {
        let end = start + buf.len() as u64;
        // The bytes of `bytes`, which start at `at` in the zip, that fall into the buffer.
        let copy = |buf: &mut [u8], at: u64, bytes: &[u8]| {
            let (from, to) = (at.max(start), (at + bytes.len() as u64).min(end));
            if from < to { buf[(from - start) as usize..(to - start) as usize].copy_from_slice(&bytes[(from - at) as usize..(to - at) as usize]) }
        };
        let mut segments = Vec::new();
        let mut i = self.rows.partition_point(|row| row.offset <= start).saturating_sub(1);
        while i < entries.len() && self.rows[i].offset < end {
            let (entry, row) = (&entries[i], &self.rows[i]);
            if start < row.offset + row.local { copy(buf, row.offset, &Layout::local_header(entry, row, crcs[i])) }
            let data = row.offset + row.local;
            let (from, to) = (data.max(start), (data + entry.size).min(end));
            if from < to {
                let span = &mut buf[(from - start) as usize..(to - start) as usize];
                read(i, from - data, span)?;
                let (first, last) = ((start / CUT + 1) * CUT, (end - 1) / CUT * CUT);
                let mut at = from;
                for cut in [first.min(last), first.max(last), to] {
                    if at < cut && cut <= to {
                        let crc = crc32fast::hash(&span[(at - from) as usize..(cut - from) as usize]);
                        segments.push(Segment { entry: i, offset: at - data, len: cut - at, crc });
                        at = cut;
                    }
                }
            }
            i += 1;
        }
        if end > self.cd_offset {
            let mut j = self.centrals.partition_point(|at| self.cd_offset + at <= start).saturating_sub(1);
            while j < entries.len() && self.cd_offset + self.centrals[j] < end {
                copy(buf, self.cd_offset + self.centrals[j], &Layout::central_header(&entries[j], &self.rows[j], crcs[j]));
                j += 1;
            }
            let tail = self.cd_offset + self.cd_size;
            if end > tail { copy(buf, tail, &self.end_records(entries.len() as u64)) }
        }
        Ok(segments)
    }
}

/// §9: F over the entry list, 22 characters: changes when a file is added, removed, renamed, resized or touched.
pub(crate) fn fingerprint(entries: &[Entry]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"fyl-folder-zip-1\n");
    for entry in entries { hash.update(format!("{}\0{}\0{}\n", entry.path, entry.size, entry.t)); }
    base64url(&hash.finalize()[..16])
}

/// Runs of data read, by entry and offset in its file: (length, CRC-32).
type Runs = BTreeMap<(usize, u64), (u64, u32)>;

/// Why the pre-pass stopped: a file changed, or couldn't be read.
pub(crate) enum Prep {
    Changed(String),
    Unreadable(String, io::Error),
}

/// A folder to upload as one zip.
pub(crate) struct Folder {
    /// `<root>.zip`, the upload's file name.
    pub(crate) name: String,
    pub(crate) entries: Vec<Entry>,
    pub(crate) skipped: Vec<Skipped>,
    pub(crate) layout: Layout,
    /// From the pre-pass (§7.1); empty before it.
    crcs: Vec<u32>,
    /// What this run's parts read of each file, by entry and offset: (length, CRC-32) (§7.3), and whether a run read
    /// twice came back different.
    seen: Mutex<(Runs, bool)>,
    /// The folder's handle, and the folder below it that the last file was read from (its raw path and handle).
    root: Option<Arc<File>>,
    last: Mutex<Option<(Vec<u8>, Arc<File>)>>,
}

impl Folder {
    pub(crate) fn new(found: Found, limit: u64) -> Result<Folder, Refusal> {
        if found.folders > MAX_FOLDERS { return Err(Refusal::TooManyFolders) }
        let Found { entries, skipped, root: handle, .. } = found;
        let layout = check(&entries, limit)?;
        let root = entries[0].path.split('/').next().unwrap_or("folder");
        Ok(Folder { name: format!("{root}.zip"), entries, skipped, layout, crcs: Vec::new(), seen: Mutex::new((BTreeMap::new(), false)), root: handle,
                    last: Mutex::new(None) })
    }

    /// The folder `rel` below the root (raw names joined by `/`), opened name by name from the root's handle without
    /// following a symlink: no path is longer than one name. None once one of them isn't a folder any more.
    fn dir(&self, rel: &[u8]) -> io::Result<Option<Arc<File>>> {
        let mut last = self.last.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((at, dir)) = last.as_ref() {
            if at == rel { return Ok(Some(dir.clone())) }
        }
        let mut dir = self.root.clone().ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?;
        for name in rel.split(|&b| b == b'/').filter(|name| !name.is_empty()) {
            match open_dir(dir.as_raw_fd(), name) {
                Ok(next) => dir = Arc::new(next),
                Err(error) if matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)) => return Ok(None),
                Err(error) => return Err(error),
            }
        }
        *last = Some((rel.to_vec(), dir.clone()));
        Ok(Some(dir))
    }

    /// A file as the walk listed it, opened inside its folder without following a symlink or waiting on a FIFO swapped
    /// in meanwhile; None once it isn't that file any more: another file (device and inode, so also one reached
    /// through a folder replaced since the walk), kind, size or modification time.
    fn open(&self, entry: &Entry) -> io::Result<Option<File>> {
        let raw = entry.source.as_os_str().as_bytes();
        let (rel, name) = raw.iter().rposition(|&b| b == b'/').map_or((&b""[..], raw), |at| (&raw[..at], &raw[at + 1..]));
        let Some(dir) = self.dir(rel)? else { return Ok(None) };
        let name = CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        // SAFETY: a folder's descriptor and a NUL-terminated name, which openat only reads.
        let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC) };
        if fd < 0 { return Err(io::Error::last_os_error()) }
        // SAFETY: openat just returned this descriptor, and nothing else owns it.
        let file = unsafe { File::from_raw_fd(fd) };
        let meta = file.metadata()?;
        let same = (meta.dev(), meta.ino()) == entry.id && meta.is_file() && meta.len() == entry.size && (meta.mtime(), meta.mtime_nsec()) == entry.mtime;
        Ok(same.then_some(file))
    }

    pub(crate) fn fingerprint(&self) -> String {
        fingerprint(&self.entries)
    }

    /// §7.1: every file read once from start to end for its CRC-32; it must have exactly its listed size, and its size
    /// and modification time afterwards too. `progress(files done)` after each.
    pub(crate) fn prepare(&mut self, mut progress: impl FnMut(usize)) -> Result<(), Prep> {
        let mut buf = vec![0; 1 << 20];
        for (index, entry) in self.entries.iter().enumerate() {
            let unreadable = |error| Prep::Unreadable(entry.path.clone(), error);
            let Some(mut file) = self.open(entry).map_err(unreadable)? else { return Err(Prep::Changed(entry.path.clone())) };
            let (mut crc, mut seen) = (crc32fast::Hasher::new(), 0);
            loop {
                match file.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => { crc.update(&buf[..n]); seen += n as u64; }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(error) => return Err(unreadable(error)),
                }
            }
            if seen != entry.size || self.open(entry).map_err(unreadable)?.is_none() { return Err(Prep::Changed(entry.path.clone())) }
            self.crcs.push(crc.finalize());
            progress(index + 1);
        }
        Ok(())
    }

    /// Bytes [offset, offset + buf.len()) of the zip, read right before they are sent (§7.2). A file whose size or
    /// modification time changed since the walk stops the run (exit 1), the upload kept.
    pub(crate) fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<()> {
        let mut read = |index: usize, at: u64, out: &mut [u8]| match self.open(&self.entries[index])? {
            Some(file) => file.read_exact_at(out, at),
            None => crate::halt(CHANGED),
        };
        let segments = self.layout.read(&self.entries, &self.crcs, offset, buf, &mut read)?;
        let mut seen = self.seen.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for segment in segments {
            let run = (segment.len, segment.crc);
            seen.1 |= seen.0.insert((segment.entry, segment.offset), run).is_some_and(|before| before != run);
        }
        Ok(())
    }

    /// §7.3, before completing: the runs this run's parts read of each file, in order, add up to the whole file with its
    /// pre-pass CRC-32. A run that read no part (a completed upload replayed) has nothing to check.
    pub(crate) fn intact(&self) -> bool {
        if self.crcs.is_empty() { return true }
        let seen = self.seen.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        !seen.1 && self.entries.iter().enumerate().all(|(index, entry)| {
            let (mut crc, mut covered) = (crc32fast::Hasher::new(), 0);
            for (&(_, offset), &(len, part)) in seen.0.range((index, 0)..(index + 1, 0)) {
                if offset != covered { return false }
                crc.combine(&crc32fast::Hasher::new_with_initial_len(part, len));
                covered += len;
            }
            covered == entry.size && crc.finalize() == self.crcs[index]
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::collections::HashMap;

    const FIXED_MS: i64 = 1_793_260_800_000;

    fn vector(name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/vectors/folder-zip").join(format!("{name}.json"));
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
    }

    fn unbase64(text: &str) -> Vec<u8> {
        let value = |c: u8| b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".iter().position(|&x| x == c).unwrap() as u32;
        let digits: Vec<u32> = text.bytes().filter(|&c| c != b'=').map(value).collect();
        digits.chunks(4).flat_map(|group| {
            let n = group.iter().enumerate().fold(0, |acc, (i, d)| acc | d << (18 - 6 * i));
            (0..group.len() - 1).map(move |i| (n >> (16 - 8 * i)) as u8)
        }).collect()
    }

    fn raw(node: &Value) -> Vec<u8> {
        node["pathHex"].as_str().map_or_else(|| node["path"].as_str().unwrap().as_bytes().to_vec(), unhex)
    }

    fn data(node: &Value) -> Vec<u8> {
        node["base64"].as_str().map_or_else(|| node["text"].as_str().unwrap_or("").as_bytes().to_vec(), unbase64)
    }

    fn mtime(node: &Value) -> (i64, i64) {
        let ms = node["mtimeMs"].as_i64().unwrap_or(FIXED_MS);
        (ms.div_euclid(1000), ms.rem_euclid(1000) * 1_000_000)
    }

    type Listings = HashMap<Vec<Vec<u8>>, Vec<(Vec<u8>, Kind, (i64, i64))>>;

    /// A vector's tree as listings by folder, the way collect() would see it on disk (parent folders implied); sources
    /// are the raw paths, which `contents` maps to the bytes.
    fn listings(tree: &[Value]) -> (Listings, HashMap<PathBuf, Vec<u8>>) {
        let (mut dirs, mut contents) = (HashMap::from([(Vec::new(), Vec::new())]), HashMap::new());
        let add = |dirs: &mut Listings, parts: &[Vec<u8>], kind, time| {
            let list = dirs.entry(parts[..parts.len() - 1].to_vec()).or_default();
            if !list.iter().any(|(name, ..)| *name == parts[parts.len() - 1]) { list.push((parts[parts.len() - 1].clone(), kind, time)) }
            if kind == Kind::Dir { dirs.entry(parts.to_vec()).or_default(); }
        };
        for node in tree {
            let parts: Vec<Vec<u8>> = raw(node).split(|&b| b == b'/').map(<[u8]>::to_vec).collect();
            for depth in 1..parts.len() { add(&mut dirs, &parts[..depth], Kind::Dir, (0, 0)) }
            let kind = match node["type"].as_str() { Some("dir") => Kind::Dir, Some("symlink") => Kind::Symlink, Some("fifo") => Kind::Special, _ => Kind::File };
            add(&mut dirs, &parts, kind, mtime(node));
            if kind == Kind::File { contents.insert(PathBuf::from(OsStr::from_bytes(&raw(node))), data(node)); }
        }
        (dirs, contents)
    }

    fn in_memory(root: &str, tree: &[Value]) -> (Vec<Entry>, Vec<Skipped>, HashMap<PathBuf, Vec<u8>>) {
        let (dirs, contents) = listings(tree);
        let found = gather(root.as_bytes(), |rel| -> Result<_, ()> {
            Ok(dirs[rel].iter().map(|(name, kind, mtime)| {
                let source = PathBuf::from(OsStr::from_bytes(&[rel.to_vec(), vec![name.clone()]].concat().join(&b'/')));
                Item { name: name.clone(), kind: *kind, size: contents.get(&source).map_or(0, |data| data.len() as u64), mtime: *mtime, id: (0, 0) }
            }).collect())
        }).unwrap();
        (found.entries, found.skipped, contents)
    }

    /// The whole zip, with the CRCs computed from `contents`, read in pieces of `step` bytes.
    fn zip(entries: &[Entry], contents: &HashMap<PathBuf, Vec<u8>>, step: usize) -> Vec<u8> {
        let layout = check(entries, 50 << 30).unwrap();
        let crcs: Vec<u32> = entries.iter().map(|entry| crc32fast::hash(&contents[&entry.source])).collect();
        let mut out = vec![0; layout.size as usize];
        let mut read = |index: usize, at: u64, buf: &mut [u8]| {
            buf.copy_from_slice(&contents[&entries[index].source][at as usize..at as usize + buf.len()]);
            Ok(())
        };
        for (n, piece) in out.chunks_mut(step).enumerate() {
            let segments = layout.read(entries, &crcs, (n * step) as u64, piece, &mut read).unwrap();
            for segment in segments { assert!(segment.len > 0 && segment.offset + segment.len <= entries[segment.entry].size); }
        }
        out
    }

    fn hex(bytes: &[u8]) -> String {
        crate::hex(bytes)
    }

    fn expected_entries(entries: &[Entry], layout: &Layout, contents: &HashMap<PathBuf, Vec<u8>>) -> Value {
        Value::Array(entries.iter().zip(&layout.rows).map(|(entry, row)| serde_json::json!({
            "path": entry.path, "size": entry.size, "mtime": entry.t, "crc32": format!("{:08x}", crc32fast::hash(&contents[&entry.source])), "offset": row.offset,
        })).collect())
    }

    fn shown(raw: &[u8]) -> Value {
        match std::str::from_utf8(raw) { Ok(path) => serde_json::json!({"path": path}), Err(_) => serde_json::json!({"pathHex": hex(raw)}) }
    }

    #[test]
    fn tree_vectors_give_the_same_zip_byte_for_byte() {
        for name in ["basic", "names", "times", "lengths"] {
            let vector = vector(name);
            let (entries, skipped, contents) = in_memory(vector["root"].as_str().unwrap(), vector["tree"].as_array().unwrap());
            let layout = check(&entries, 50 << 30).unwrap();
            assert_eq!(expected_entries(&entries, &layout, &contents), vector["entries"], "{name}");
            let skipped: Vec<Value> = skipped.iter().map(|item| {
                let mut shown = shown(&item.raw);
                shown["reason"] = item.reason.code().into();
                shown
            }).collect();
            assert_eq!(Value::Array(skipped), vector["skipped"], "{name}");
            assert_eq!(fingerprint(&entries), vector["fingerprint"].as_str().unwrap(), "{name}");
            assert_eq!(layout.size, vector["size"].as_u64().unwrap(), "{name}");
            // Any piece size builds the same bytes: whole, in parts that cut through headers and data, a byte at a time.
            for step in [layout.size as usize, 7, 1] {
                let bytes = zip(&entries, &contents, step);
                assert_eq!(hex(&bytes), vector["zip"].as_str().unwrap(), "{name} in pieces of {step}");
                assert_eq!(hex(&Sha256::digest(&bytes)), vector["sha256"].as_str().unwrap(), "{name}");
            }
        }
    }

    /// A folder `name` inside `dir`, made if it isn't there yet.
    fn mkdir_at(dir: &File, name: &[u8]) -> File {
        let c = CString::new(name).unwrap();
        // SAFETY: a directory descriptor and a NUL-terminated name, which mkdirat only reads.
        let made = unsafe { libc::mkdirat(dir.as_raw_fd(), c.as_ptr(), 0o755) };
        assert!(made == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST));
        open_dir(dir.as_raw_fd(), name).unwrap()
    }

    /// Writes a vector's tree into `folder`, folder by folder from its handle, so also paths beyond PATH_MAX.
    fn materialise(folder: &Path, tree: &[Value]) {
        for node in tree {
            let raw = raw(node);
            let parts: Vec<&[u8]> = raw.split(|&b| b == b'/').collect();
            let (last, dirs) = parts.split_last().unwrap();
            let dir = dirs.iter().fold(open_dir(libc::AT_FDCWD, folder.as_os_str().as_bytes()).unwrap(), |dir, name| mkdir_at(&dir, name));
            let c = CString::new(*last).unwrap();
            match node["type"].as_str() {
                Some("dir") => { mkdir_at(&dir, last); }
                Some("symlink") => {
                    let target = CString::new(node["target"].as_str().unwrap()).unwrap();
                    // SAFETY: two NUL-terminated strings and a directory descriptor, which symlinkat only reads.
                    assert_eq!(unsafe { libc::symlinkat(target.as_ptr(), dir.as_raw_fd(), c.as_ptr()) }, 0);
                }
                // SAFETY: a directory descriptor and a NUL-terminated name, which mkfifoat only reads.
                Some("fifo") => assert_eq!(unsafe { libc::mkfifoat(dir.as_raw_fd(), c.as_ptr(), 0o644) }, 0),
                _ => {
                    // SAFETY: a directory descriptor and a NUL-terminated name, which openat only reads.
                    let fd = unsafe { libc::openat(dir.as_raw_fd(), c.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC, 0o644) };
                    assert!(fd >= 0, "{}", io::Error::last_os_error());
                    // SAFETY: openat just returned this descriptor, and nothing else owns it.
                    let mut file = unsafe { File::from_raw_fd(fd) };
                    io::Write::write_all(&mut file, &data(node)).unwrap();
                    let (secs, nanos) = mtime(node);
                    let time = if secs >= 0 { std::time::UNIX_EPOCH + std::time::Duration::new(secs as u64, nanos as u32) }
                               else { std::time::UNIX_EPOCH - std::time::Duration::from_secs(secs.unsigned_abs()) + std::time::Duration::from_nanos(nanos as u64) };
                    file.set_times(fs::FileTimes::new().set_accessed(time).set_modified(time)).unwrap();
                }
            }
        }
    }

    #[test]
    fn tree_vectors_on_disk_give_the_same_entries_and_skips() {
        // `lengths` too: its 4095-byte paths are longer than PATH_MAX under the temporary folder, so only reading folder
        // by folder from the root's handle gets at them. Its names over 255 bytes (NAME_MAX), which no file system
        // holds, stay out.
        let fits = |raw: &[u8]| raw.split(|&b| b == b'/').all(|part| part.len() <= MAX_NAME);
        for name in ["basic", "names", "times", "lengths"] {
            let vector = vector(name);
            let base = std::env::temp_dir().join(format!("fyl-folder-{}-{}", std::process::id(), hex(&crate::random_bytes::<8>())));
            let folder = base.join(vector["root"].as_str().unwrap());
            fs::create_dir_all(&folder).unwrap();
            let tree: Vec<Value> = vector["tree"].as_array().unwrap().iter().filter(|node| fits(&raw(node))).cloned().collect();
            materialise(&folder, &tree);
            // Through a symlink to the folder, which is resolved (its own name doesn't count).
            let link = base.join("link");
            std::os::unix::fs::symlink(&folder, &link).unwrap();
            let found = collect(&link).unwrap_or_else(|(path, error)| panic!("{}: {error}", path.display()));
            let mut folder = Folder::new(found, 50 << 30).unwrap();
            assert_eq!(folder.name, format!("{}.zip", vector["root"].as_str().unwrap()));
            folder.prepare(|_| {}).unwrap_or_else(|_| panic!("{name}: pre-pass"));
            let paths: Vec<&str> = folder.entries.iter().map(|entry| entry.path.as_str()).collect();
            let listed: Vec<&str> = vector["entries"].as_array().unwrap().iter().map(|entry| entry["path"].as_str().unwrap()).collect();
            assert_eq!(paths, listed, "{name}");
            assert_eq!(folder.skipped.len(), vector["skipped"].as_array().unwrap().iter().filter(|item| fits(&raw(item))).count(), "{name}");
            assert_eq!(folder.fingerprint(), vector["fingerprint"].as_str().unwrap(), "{name}");
            let mut bytes = vec![0; folder.layout.size as usize];
            for (n, piece) in bytes.chunks_mut(100).enumerate() { folder.read_at(piece, n as u64 * 100).unwrap(); }
            assert_eq!(hex(&bytes), vector["zip"].as_str().unwrap(), "{name}");
            assert!(folder.intact(), "{name}");
            fs::remove_dir_all(&base).unwrap();
        }
    }

    #[test]
    fn a_file_that_changes_after_the_pre_pass_fails_the_check_before_completing() {
        let base = std::env::temp_dir().join(format!("fyl-folder-{}-{}", std::process::id(), hex(&crate::random_bytes::<8>())));
        let folder = base.join("docs");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("a.txt"), b"first version").unwrap();
        let content: Vec<u8> = (0..5 * CUT as usize + 100).map(|i| (i * 7 % 251) as u8).collect();
        fs::write(folder.join("b.bin"), &content).unwrap();
        let prepared = || {
            let found = collect(&folder).unwrap_or_else(|(path, error)| panic!("{}: {error}", path.display()));
            let mut zip = Folder::new(found, 50 << 30).unwrap();
            zip.prepare(|_| {}).unwrap_or_else(|_| panic!("pre-pass"));
            zip
        };
        // Two encrypted parts, which both read the chunk at their boundary: the same run twice.
        let parts = |zip: &Folder| {
            let mut one = vec![0; 3 * CUT as usize];
            zip.read_at(&mut one, 0).unwrap();
            assert!(!zip.intact());
            let mut two = vec![0; (zip.layout.size - 2 * CUT) as usize];
            zip.read_at(&mut two, 2 * CUT).unwrap();
            [one, two[CUT as usize..].to_vec()].concat()
        };
        let (zip, later) = (prepared(), prepared());
        // Nothing read yet: the check has nothing to go on.
        assert!(!zip.intact());
        let bytes = parts(&zip);
        assert!(zip.intact());
        let mut whole = vec![0; zip.layout.size as usize];
        zip.layout.read(&zip.entries, &zip.crcs, 0, &mut whole, &mut |index, at, buf| {
            buf.copy_from_slice(&fs::read(folder.join(&zip.entries[index].source)).unwrap()[at as usize..at as usize + buf.len()]);
            Ok(())
        }).unwrap();
        assert_eq!(bytes, whole);
        // Same size and modification time, other bytes: only the CRCs notice, against the pre-pass's and between reads.
        let meta = fs::metadata(folder.join("a.txt")).unwrap();
        fs::write(folder.join("a.txt"), b"other version").unwrap();
        File::options().write(true).open(folder.join("a.txt")).unwrap().set_modified(meta.modified().unwrap()).unwrap();
        parts(&later);
        assert!(!later.intact());
        parts(&zip);
        assert!(!zip.intact());
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_folder_swapped_for_a_symlink_brings_in_nothing_from_outside() {
        let base = std::env::temp_dir().join(format!("fyl-folder-{}-{}", std::process::id(), hex(&crate::random_bytes::<8>())));
        let (folder, outside) = (base.join("docs"), base.join("outside"));
        for dir in [folder.join("sub"), outside.clone()] { fs::create_dir_all(&dir).unwrap(); }
        // The same name, size and modification time inside and outside: only (device, inode) tells them apart.
        for dir in [folder.join("sub"), outside.clone()] {
            fs::write(dir.join("a.txt"), if dir == outside { b"secret!" } else { b"public." }).unwrap();
            File::options().write(true).open(dir.join("a.txt")).unwrap().set_modified(std::time::UNIX_EPOCH).unwrap();
        }
        let swap = |to: &Path| {
            fs::rename(folder.join("sub"), base.join("kept")).unwrap();
            std::os::unix::fs::symlink(to, folder.join("sub")).unwrap();
        };
        let restore = || {
            fs::remove_file(folder.join("sub")).unwrap();
            fs::rename(base.join("kept"), folder.join("sub")).unwrap();
        };
        // After the walk listed `sub`, it becomes a symlink: listing it stops the walk with its path.
        let mut walk = Walk::new(&folder).unwrap();
        assert!(walk.list(&[]).unwrap().iter().any(|item| item.name == b"sub" && item.kind == Kind::Dir));
        swap(&outside);
        let (path, error) = walk.list(&[b"sub".to_vec()]).err().unwrap();
        assert_eq!(path, fs::canonicalize(&folder).unwrap().join("sub"));
        assert!(matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)), "{error}");
        restore();
        // Another real folder moved in its place isn't the one listed either.
        let mut walk = Walk::new(&folder).unwrap();
        walk.list(&[]).unwrap();
        fs::rename(folder.join("sub"), base.join("kept")).unwrap();
        fs::rename(&outside, folder.join("sub")).unwrap();
        let (_, error) = walk.list(&[b"sub".to_vec()]).err().unwrap();
        assert_eq!(error.to_string(), "it was replaced while fyl read the folder");
        fs::rename(folder.join("sub"), &outside).unwrap();
        fs::rename(base.join("kept"), folder.join("sub")).unwrap();
        // After the whole walk: the pre-pass, and a part, read only the file the walk saw.
        let found = collect(&folder).unwrap_or_else(|(path, error)| panic!("{}: {error}", path.display()));
        let mut zip = Folder::new(found, 50 << 30).unwrap();
        swap(&outside);
        assert!(zip.open(&zip.entries[0]).unwrap().is_none());
        assert!(matches!(zip.prepare(|_| {}), Err(Prep::Changed(path)) if path == "docs/sub/a.txt"));
        restore();
        zip.crcs.clear();
        zip.prepare(|_| {}).unwrap_or_else(|_| panic!("pre-pass"));
        let mut bytes = vec![0; zip.layout.size as usize];
        zip.read_at(&mut bytes, 0).unwrap();
        assert!(zip.intact() && bytes.windows(7).any(|w| w == b"public.") && !bytes.windows(7).any(|w| w == b"secret!"));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn the_walk_stops_listing_once_past_100000_files() {
        let (mut listed, per) = (0, 1000);
        let found = gather(b"many", |rel| -> Result<_, ()> {
            listed += 1;
            Ok(if rel.is_empty() {
                (0..200).map(|i| Item { name: format!("d{i:03}").into_bytes(), kind: Kind::Dir, size: 0, mtime: (0, 0), id: (0, 0) }).collect()
            } else {
                (0..per).map(|i| Item { name: format!("f{i:04}").into_bytes(), kind: Kind::File, size: 0, mtime: (0, 0), id: (0, 0) }).collect()
            })
        }).unwrap();
        // The root and 101 folders of 1,000 files: the 101st brings it past 100,000, and the other 99 aren't listed.
        assert_eq!((listed, found.entries.len()), (102, 101 * per));
        assert_eq!(check(&found.entries, 50 << 30).err(), Some(Refusal::TooMany));
    }

    #[test]
    fn the_walk_stops_past_100000_folders_and_at_a_loop() {
        // A tree of empty folders: 200 at the top with 1,000 each. The 101st of them brings it past 100,000 folders.
        let mut listed = 0;
        let found = gather(b"many", |rel| -> Result<_, ()> {
            listed += 1;
            Ok((0..if rel.is_empty() { 200 } else { 1000 }).map(|i| Item { name: format!("d{i:04}").into_bytes(), kind: Kind::Dir, size: 0, mtime: (0, 0), id: (0, 0) }).collect())
        }).unwrap();
        assert_eq!((listed, found.entries.len()), (1 + 100, 0));
        assert_eq!(Folder::new(found, 50 << 30).err(), Some(Refusal::TooManyFolders));
        // A folder that is one it is in (a bind mount of a folder above it) stops the walk, as if `sub` were the root.
        let base = std::env::temp_dir().join(format!("fyl-folder-{}-{}", std::process::id(), hex(&crate::random_bytes::<8>())));
        fs::create_dir_all(base.join("top/sub")).unwrap();
        let mut walk = Walk::new(&base.join("top")).unwrap();
        walk.list(&[]).unwrap();
        let sub = fs::metadata(base.join("top/sub")).unwrap();
        walk.root_id = (sub.dev(), sub.ino());
        walk.dirs = HashMap::from([(walk.root_id, HashMap::from([(b"sub".to_vec(), walk.root_id)]))]);
        let (path, error) = walk.list(&[b"sub".to_vec()]).err().unwrap();
        assert_eq!((path, error.to_string()), (fs::canonicalize(base.join("top/sub")).unwrap(), "it is a folder it is in (a loop)".into()));
        fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn zip64_thresholds_and_header_bytes_match_the_formula_cases() {
        let vectors = vector("zip64");
        for case in vectors["formula"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let entries: Vec<Entry> = case["entries"].as_array().unwrap().iter().map(|entry| Entry {
                path: entry["path"].as_str().unwrap().into(), size: entry["size"].as_u64().unwrap(), t: (FIXED_MS / 1000) as u32,
                source: PathBuf::new(), mtime: (0, 0), id: (0, 0),
            }).collect();
            let crcs: Vec<u32> = case["entries"].as_array().unwrap().iter().map(|entry| u32::from_str_radix(entry["crc32"].as_str().unwrap(), 16).unwrap()).collect();
            let layout = Layout::new(&entries);
            for (row, entry) in layout.rows.iter().zip(case["entries"].as_array().unwrap()) {
                assert_eq!((row.offset, row.local, row.central, row.large, row.far),
                           (entry["offset"].as_u64().unwrap(), entry["local"].as_u64().unwrap(), entry["central"].as_u64().unwrap(),
                            entry["zip64Sizes"].as_bool().unwrap(), entry["zip64Offset"].as_bool().unwrap()), "{name}");
            }
            assert_eq!((layout.cd_offset, layout.cd_size, layout.zip64_end, layout.size),
                       (case["centralOffset"].as_u64().unwrap(), case["centralSize"].as_u64().unwrap(), case["zip64End"].as_bool().unwrap(),
                        case["size"].as_u64().unwrap()), "{name}");
            let fits = |limit| check(&entries, limit).is_ok();
            assert_eq!((fits(50 << 30), fits(crate::e2ee::max_plaintext(50 << 30).unwrap())),
                       (case["fits"]["raw"].as_bool().unwrap(), case["fits"]["e2ee"].as_bool().unwrap()), "{name}");
            // Every header byte where the segments put it; the data are zeros, read where they fall.
            let mut zeros = |_: usize, _: u64, buf: &mut [u8]| { buf.fill(0); Ok(()) };
            let mut at = 0;
            for segment in case["segments"].as_array().unwrap() {
                if let Some(text) = segment["hex"].as_str() {
                    let mut buf = vec![0xAA; text.len() / 2];
                    layout.read(&entries, &crcs, at, &mut buf, &mut zeros).unwrap();
                    assert_eq!(hex(&buf), text, "{name} at {at}");
                    at += buf.len() as u64;
                } else {
                    at += segment["zeros"].as_u64().unwrap();
                }
            }
            assert_eq!(at, layout.size, "{name}");
        }
    }

    #[test]
    fn the_zip64_end_records_start_at_65535_entries() {
        let vectors = vector("zip64");
        for case in vectors["built"].as_array().unwrap() {
            let count = case["count"].as_u64().unwrap();
            let entries: Vec<Entry> = (0..count).map(|i| Entry {
                path: format!("many/{i:05}"), size: 0, t: (FIXED_MS / 1000) as u32, source: PathBuf::new(), mtime: (0, 0), id: (0, 0),
            }).collect();
            let layout = check(&entries, 50 << 30).unwrap();
            let mut bytes = vec![0; layout.size as usize];
            let segments = layout.read(&entries, &vec![0; entries.len()], 0, &mut bytes, &mut |_, _, _| unreachable!()).unwrap();
            assert!(segments.is_empty());
            assert_eq!((layout.cd_offset, layout.cd_size, layout.zip64_end, layout.size),
                       (case["centralOffset"].as_u64().unwrap(), case["centralSize"].as_u64().unwrap(), case["zip64End"].as_bool().unwrap(),
                        case["size"].as_u64().unwrap()));
            assert_eq!(hex(&Sha256::digest(&bytes)), case["sha256"].as_str().unwrap());
            assert_eq!(hex(&bytes[bytes.len() - 98..]), case["tail"].as_str().unwrap());
        }
    }

    #[test]
    fn crcs_of_runs_combine_into_the_files() {
        for case in vector("zip64")["crc32Combine"].as_array().unwrap() {
            let crc = |field: &str| u32::from_str_radix(case[field].as_str().unwrap(), 16).unwrap();
            let (length, split) = (case["length"].as_u64().unwrap(), case["split"].as_u64().unwrap());
            let mut combined = crc32fast::Hasher::new_with_initial_len(crc("crc1"), split);
            combined.combine(&crc32fast::Hasher::new_with_initial_len(crc("crc2"), length - split));
            assert_eq!(combined.finalize(), crc("crc"), "{case}");
        }
    }

    #[test]
    fn whole_folders_are_refused_in_order() {
        let vectors = vector("refusals");
        for case in vectors["trees"].as_array().unwrap() {
            let (entries, ..) = in_memory(case["root"].as_str().unwrap(), case["tree"].as_array().unwrap());
            let expected = match case["code"].as_str().unwrap() {
                "collision" => Refusal::Collision(case["detail"].as_str().unwrap().into()),
                "empty" => Refusal::Empty,
                code => panic!("{code}"),
            };
            assert_eq!(check(&entries, 50 << 30).err(), Some(expected), "{case}");
        }
        for case in vectors["counts"].as_array().unwrap() {
            let entries: Vec<Entry> = (0..case["files"].as_u64().unwrap()).map(|i| Entry {
                path: format!("many/{i:06}"), size: 0, t: T_MIN as u32, source: PathBuf::new(), mtime: (0, 0), id: (0, 0),
            }).collect();
            assert_eq!(check(&entries, 50 << 30).err(), case["code"].as_str().map(|_| Refusal::TooMany), "{} files", entries.len());
        }
        for case in vectors["sizes"].as_array().unwrap() {
            let entries: Vec<Entry> = case["files"].as_array().unwrap().iter().map(|file| Entry {
                path: format!("{}/{}", case["root"].as_str().unwrap(), file["path"].as_str().unwrap()), size: file["size"].as_u64().unwrap(),
                t: T_MIN as u32, source: PathBuf::new(), mtime: (0, 0), id: (0, 0),
            }).collect();
            assert_eq!(check(&entries, case["limit"].as_u64().unwrap()).err(), case["code"].as_str().map(|_| Refusal::TooLarge), "{case}");
        }
        // The E2EE limit is P_max (docs/E2EE.md §6).
        assert_eq!(crate::e2ee::max_plaintext(50 << 30), Some(53_673_987_000));
    }

    #[test]
    fn skips_are_said_in_one_line_and_names_shown_escaped() {
        let skip = |reason| Skipped { raw: Vec::new(), reason };
        assert_eq!(skipped_note(&[]), None);
        assert_eq!(skipped_note(&[skip(Reason::Symlink), skip(Reason::Symlink), skip(Reason::Name { dir: false })]).unwrap(),
                   "Skipped 2 symlinks and 1 file with an unsafe name.");
        assert_eq!(skipped_note(&[skip(Reason::Special), skip(Reason::Name { dir: true }), skip(Reason::Symlink)]).unwrap(),
                   "Skipped 1 symlink, 1 special file and 1 folder with an unsafe name.");
        assert_eq!(escaped(b"a\x1b[2J\n\xe9 \xe2\x80\xae.txt"), "a\\u{1b}[2J\\n\\xe9 \\u{202e}.txt");
        assert_eq!(escaped("report & '旅行'.zip".as_bytes()), "report & '旅行'.zip");
    }
}

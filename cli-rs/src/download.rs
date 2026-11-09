//! `fyl download` and `fyl decrypt` (docs/E2EE.md §10): a file from a link, raw or encrypted, or saved ciphertext,
//! written to a temporary file next to its target and moved there without replacing anything, an encrypted one only
//! once its final chunk verified. The key, the password and the target are checked before the request that can use up
//! a one-time link. The key never travels in a request and is never printed: messages name only `/d/<ID>`.

use crate::e2ee::{self, EntryError, Identity, LinkError, StreamError};
use crate::{ask_hidden, class, clean, die, emit, hex, jittered, on_signal, random_bytes, secret, stop, unwritten, user_agent, utc_label, Api, Class,
            Reply, PASSWORD_RULE};
use serde_json::Value;
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::mem::MaybeUninit;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

pub(crate) struct Download {
    pub(crate) link: String,
    pub(crate) output: Option<String>,
    pub(crate) endpoint: String,
    pub(crate) verbose: bool,
}

pub(crate) struct Decrypt {
    pub(crate) file: String,
    pub(crate) output: Option<String>,
    pub(crate) endpoint: String,
}

/// Range requests after interruptions (§10 step 8).
const RESUMES: u32 = 5;
/// Typed keys in all, malformed or wrong (§10 step 5).
pub(crate) const KEY_TRIES: u32 = 3;
const KEY_PROMPT: &str = "Key (or the whole link): ";
const ENDPOINT: &str = "Use an HTTPS API URL without credentials or query parameters.";
const NO_KEY: &str = "This link has no key. Type the key at a terminal, or set FYL_KEY.";
const NO_STDOUT: &str = "An encrypted file isn't written to standard output: what was written couldn't be taken back if a later part \
                         failed to verify. Use -o with a folder or a file name.";
const INTERRUPTED: &str = "Download interrupted. Try again.";

// ---------------------------------------------------------------------------------------------
// The temporary file, failures and signals (§10 steps 7, 9, 10)

/// The temporary file of the download or decryption in progress, and whether it holds the verified file. A failure
/// or a signal removes it only before that; whoever holds the lock decides, and keeps it until the process ends.
static TEMP: Mutex<Option<(PathBuf, bool)>> = Mutex::new(None);

fn temp() -> MutexGuard<'static, Option<(PathBuf, bool)>> {
    TEMP.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn discard(temp: &mut Option<(PathBuf, bool)>) {
    if let Some((path, false)) = temp.as_ref() {
        let _ = fs::remove_file(path);
        *temp = None;
    }
}

/// Ctrl+C or termination: no partial file stays behind, and the exit is the signal's (128 + n).
fn interrupted(signal: i32) -> ! {
    let mut temp = temp();
    discard(&mut temp);
    die(signal)
}

/// A failure (exit 1): an unverified temporary file goes, a verified one stays.
fn failed(message: &str) -> ! {
    let mut temp = temp();
    discard(&mut temp);
    note!("fyl: {message}");
    process::exit(1)
}

/// A write past RLIMIT_FSIZE raises SIGXFSZ, whose default action ends the process before it can remove its temporary
/// file. Ignored, the write fails with EFBIG and the failure path cleans up.
fn keep_writes_failing() {
    // SAFETY: setting a signal's disposition to SIG_IGN has no preconditions.
    unsafe { libc::signal(libc::SIGXFSZ, libc::SIG_IGN) };
}

// ---------------------------------------------------------------------------------------------
// Keys (§2.4, §10 steps 3 and 5)

/// What a key entry error says (§13).
pub(crate) fn entry_message(error: EntryError) -> &'static str {
    match error {
        EntryError::KeyInvalid => "This key is incomplete or damaged.",
        EntryError::OtherTransfer => "This link is for another file.",
    }
}

/// A key that came after `%23` was in a request path, so it reached the server (§2.4, §9.5).
fn exposed(host: &str) {
    note!("fyl: This key was sent to {host} in the address. For sensitive files, upload again and share the new link.");
}

/// A key entry that parsed: a link among them with its key after `%23` gets the same note as such a link given to
/// `fyl download` (§2.4), never showing the key. `base` is the configured origin, which such a link is on.
fn entered(identity: Identity, text: &str, base: &str) -> Identity {
    let text = text.trim_ascii();
    if text.contains('/') && e2ee::parse_link(text, base).is_ok_and(|link| link.exposed) {
        exposed(base.split_once("://").map_or(base, |(_, host)| host));
    }
    identity
}

/// The key in FYL_KEY, in any form the key prompt takes; a malformed one stops (exit 2).
pub(crate) fn env_key(parse: &dyn Fn(&str) -> Result<Identity, EntryError>, base: &str) -> Option<Identity> {
    match std::env::var("FYL_KEY") {
        Ok(text) => match parse(&text) {
            Ok(identity) => Some(entered(identity, &text, base)),
            Err(error) => stop(&format!("FYL_KEY: {}", entry_message(error))),
        },
        Err(std::env::VarError::NotUnicode(_)) => stop("FYL_KEY: This key is incomplete or damaged."),
        Err(std::env::VarError::NotPresent) => None,
    }
}

/// A key typed on the terminal without echo, asked again while it is malformed, KEY_TRIES typed keys in all; without
/// a terminal, `missing` (exit 2). Never read from stdin, which may carry the link: two secrets never share it.
pub(crate) fn typed_key(parse: &dyn Fn(&str) -> Result<Identity, EntryError>, base: &str, tries: &mut u32, missing: &str) -> Identity {
    loop {
        let Some(text) = ask_hidden(KEY_PROMPT) else { stop(missing) };
        *tries += 1;
        match parse(&text) {
            Ok(identity) => return entered(identity, &text, base),
            Err(error) if *tries < KEY_TRIES => note!("fyl: {}", entry_message(error)),
            Err(error) => stop(entry_message(error)),
        }
    }
}

/// §10 step 5: the key check on head and meta (§9.1), with nothing consumed yet. A typed key that doesn't open the file
/// may be typed again; one from the link or FYL_KEY ends the run (exit 1), as does any other failure.
fn check_key(info: &Value, mut identity: Identity, typed: bool, parse: &dyn Fn(&str) -> Result<Identity, EntryError>, base: &str, tries: &mut u32)
             -> e2ee::Checked {
    let blob = |field: &str| info["e2ee"][field].as_str().and_then(e2ee::b64url_decode);
    let (Some(head), Some(meta), Some(size)) = (blob("head"), blob("meta"), info["size"].as_u64()) else {
        failed("The server sent no encryption header for this file.")
    };
    loop {
        match e2ee::key_check(&identity, &head, &meta, size) {
            Ok(checked) => return checked,
            Err(e2ee::Error::KeyWrong) if typed && *tries < KEY_TRIES => {
                note!("fyl: {}", e2ee::Error::KeyWrong);
                identity = typed_key(parse, base, tries, NO_KEY);
            }
            Err(error) => failed(&error.to_string()),
        }
    }
}

/// `fyl decrypt`'s key entry: as the download prompt's (§2.4), but with no transfer at hand. A link's ID must fit the
/// saved name `fyl-<ID[0:8]>.age` when the file has one ("This link is for another file").
fn file_key(input: &str, base: &str, prefix: Option<&str>) -> Result<Identity, EntryError> {
    let text = input.trim_ascii();
    let id = if text.contains('/') { e2ee::parse_link(text, base).map(|link| link.id).unwrap_or_default() } else { String::new() };
    if prefix.is_some_and(|prefix| !id.is_empty() && !id.starts_with(prefix)) {
        return Err(EntryError::OtherTransfer);
    }
    e2ee::parse_entry(text, base, &id)
}

// ---------------------------------------------------------------------------------------------
// The info route and passwords (§10 steps 2 and 4, §11)

/// HTTP Basic credentials as `curl -u fyl` sends them; the server ignores the user name.
fn basic(password: &str) -> String {
    const STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::from("Basic ");
    for group in format!("fyl:{password}").as_bytes().chunks(3) {
        let n = group.iter().enumerate().fold(0u32, |acc, (i, &b)| acc | u32::from(b) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= group.len() { STD[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// A reply that ends the download: the file is missing, gone, under review or refused (exit 1).
fn refused(reply: &Reply) -> ! {
    let said = reply.body["error"].as_str().map(clean).filter(|said| !said.is_empty());
    match (reply.status, said) {
        (403 | 404 | 410, Some(said)) => failed(&said),
        (404, None) => failed("No file with this link exists."),
        (410, None) => failed("This file is no longer available."),
        (status, said) => failed(&format!("Download failed (HTTP {status}): {}", said.as_deref().unwrap_or("the service refused the request."))),
    }
}

/// The file is still uploading: say how far it got and wait (Retry-After, else 10 s), as `curl --retry` would.
fn waiting(reply: &Reply) {
    let progress = match (reply.body["received"].as_u64(), reply.body["size"].as_u64()) {
        (Some(received), Some(size)) if size > 0 => format!(", {} % done", received.min(size) * 100 / size),
        _ => String::new(),
    };
    let delay = jittered(Duration::from_secs(reply.retry_after.map_or(10, |seconds| seconds.clamp(1, 60))));
    note!("fyl: Still uploading{progress}. Waiting {:.0}s.", delay.as_secs_f64());
    thread::sleep(delay);
}

/// GET /api/transfers/<ID>, with the password as Basic once there is one. Waits while the file is still uploading; a
/// file that is missing, gone or under review ends the run. Password refusals come back.
fn transfer_info(api: &Api, id: &str, auth: Option<&str>, quiet: bool) -> Result<Value, Reply> {
    let url = format!("{}/api/transfers/{id}", api.origin);
    let headers: Vec<(&str, String)> = auth.map(|auth| ("Authorization", auth.to_string())).into_iter().collect();
    loop {
        let reply = api.retried("GET", &url, None, true, &headers, quiet);
        match reply.status {
            200 if reply.body["state"] == "uploading" => waiting(&reply),
            200 => return Ok(reply.body),
            401 | 429 if auth.is_some() && matches!(reply.body["code"].as_str(), Some("password_wrong" | "password_paused")) => return Err(reply),
            _ => refused(&reply),
        }
    }
}

/// Whether `password` can't be any file's password (the server's rule, `PASSWORD_RULE`), judged without the Unicode
/// tables of NFC: empty or with a control character (NFC never adds or removes one), or written only in characters
/// below U+0300, which NFC leaves as they are, and shorter than 6 or longer than 200. Sent, it would only use up a try.
fn impossible(password: &str) -> bool {
    let unchanged = password.chars().all(|c| c < '\u{300}');
    password.is_empty() || password.chars().any(char::is_control) || (unchanged && !(6..=200).contains(&password.chars().count()))
}

/// §10 step 4: the password from FYL_PASSWORD or typed without echo, sent as Basic to the info route, which then
/// releases the name or the encryption header. A wrong typed one is asked again while tries remain; one that can't be
/// right is never sent, so it costs no try. Returns the Authorization value for the download and the info it unlocked.
fn unlock(api: &Api, id: &str, quiet: bool) -> (String, Value) {
    let given = match std::env::var("FYL_PASSWORD") {
        Ok(password) if impossible(&password) => stop(&format!("FYL_PASSWORD: {PASSWORD_RULE}")),
        Ok(password) => Some(password),
        Err(std::env::VarError::NotUnicode(_)) => stop("FYL_PASSWORD must be UTF-8 text."),
        Err(std::env::VarError::NotPresent) => None,
    };
    loop {
        let password = match &given {
            Some(password) => password.clone(),
            None => match ask_hidden("Password: ") {
                Some(typed) if impossible(&typed) => {
                    note!("fyl: {PASSWORD_RULE}");
                    continue;
                }
                Some(typed) => typed,
                None => stop("This file is protected. Type its password at a terminal, or set FYL_PASSWORD."),
            },
        };
        let auth = basic(&password);
        let reply = match transfer_info(api, id, Some(&auth), quiet) {
            Ok(info) => return (auth, info),
            Err(reply) => reply,
        };
        if reply.body["code"] == "password_paused" {
            let until = match (reply.body["pausedUntil"].as_u64(), reply.retry_after) {
                (Some(ms), _) => format!("after {}", utc_label(ms)),
                (None, Some(seconds)) => format!("in {} minutes", seconds.div_ceil(60).max(1)),
                (None, None) => "later".to_string(),
            };
            failed(&format!("Too many wrong passwords for this file. Try again {until}."));
        }
        let left = reply.body["triesLeft"].as_u64();
        let tries = left.map_or(String::new(), |n| format!(" {n} {} left.", if n == 1 { "try" } else { "tries" }));
        if given.is_some() || left == Some(0) { failed(&format!("Wrong password.{tries}")) }
        note!("fyl: Wrong password.{tries}");
    }
}

// ---------------------------------------------------------------------------------------------
// Targets and saving (§10 steps 6 and 9)

/// Where a file goes, and the folder its temporary file goes in.
struct Target {
    dir: PathBuf,
    path: PathBuf,
}

impl Target {
    /// PATH an existing folder (default `fallback`): `<folder>/<name>`; otherwise PATH is the file, in a folder that
    /// exists (a PATH ending in `/` is a folder, which must exist). Checked before anything is consumed: nothing is
    /// there yet (not even a dangling symlink), the name can be created on that filesystem, and there is room for
    /// `size` bytes.
    fn new(output: Option<&str>, fallback: &Path, name: &str, size: u64) -> Target {
        let (dir, path) = match output {
            Some(path) if Path::new(path).is_dir() => (PathBuf::from(path), Path::new(path).join(saved_name(name))),
            // Path drops a trailing `/` or `/.`, which name a folder, not a file in the current one.
            Some(path) if path.ends_with('/') || path.ends_with("/.") => stop(&format!("The folder '{path}' doesn't exist.")),
            Some(path) => {
                let path = PathBuf::from(path);
                let dir = path.parent().filter(|dir| !dir.as_os_str().is_empty()).map_or_else(|| PathBuf::from("."), Path::to_path_buf);
                if !dir.is_dir() { stop(&format!("The folder for '{}' doesn't exist.", path.display())) }
                (dir, path)
            }
            None => (fallback.to_path_buf(), fallback.join(saved_name(name))),
        };
        let exists = || -> ! { stop(&format!("'{}' already exists. Choose another name or folder with -o.", path.display())) };
        if fs::symlink_metadata(&path).is_ok() { exists() }
        match exclusive(&path) {
            Ok(_) => { let _ = fs::remove_file(&path); }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => exists(),
            Err(error) => failed(&format!("Can't create '{}': {error}.", path.display())),
        }
        if free_space(&dir).is_some_and(|free| free < size) {
            failed(&format!("Not enough free space for '{}': it needs {size} bytes.", path.display()));
        }
        Target { dir, path }
    }
}

/// The metadata's or the server's name as one path component: forbidden code points replaced (§5.3), a leading dot
/// as `_` as browsers do (no hidden or startup file such as .bashrc), at most 255 bytes keeping the extension. A
/// change is said, naming the original.
fn saved_name(name: &str) -> String {
    let mut saved = if e2ee::name_ok(name) { name.to_string() } else { e2ee::normalize_name(name) };
    if saved.starts_with('.') { saved.replace_range(..1, "_"); }
    let saved = e2ee::shorten_name(&saved, 255);
    if saved != name { note!("fyl: Saving '{}' as '{saved}'.", clean(name)); }
    saved
}

/// Creates `path` exclusively (O_CREAT|O_EXCL|O_NOFOLLOW), readable by its owner only.
fn exclusive(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(path)
}

fn c_path(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

/// Bytes available to this user on the filesystem of `dir`, if statvfs says.
#[allow(clippy::unnecessary_cast)] // the field types differ between Linux and macOS
fn free_space(dir: &Path) -> Option<u64> {
    let path = c_path(dir).ok()?;
    let mut stat = MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: a NUL-terminated path and a buffer of the right type, which statvfs fills when it returns 0.
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 { return None; }
    // SAFETY: initialised by the successful call above.
    let stat = unsafe { stat.assume_init() };
    Some((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

/// The temporary file `<dir>/.fyl-<16 hex digits>.part` (0600, created exclusively, no symlink followed), registered
/// so a failure or signal before verification removes it.
fn temp_file(dir: &Path) -> File {
    let path = dir.join(format!(".fyl-{}.part", hex(&random_bytes::<8>())));
    let file = exclusive(&path).unwrap_or_else(|error| failed(&format!("Can't create a temporary file in '{}': {error}.", dir.display())));
    *temp() = Some((path, false));
    file
}

fn unsupported(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Unsupported
        || error.raw_os_error().is_some_and(|code| code == libc::EINVAL || code == libc::ENOSYS || code == libc::ENOTSUP || code == libc::EOPNOTSUPP)
}

#[cfg(target_os = "linux")]
fn native_rename(from: &Path, to: &Path) -> io::Result<()> {
    let (from, to) = (c_path(from)?, c_path(to)?);
    // The system call itself (Linux 3.15+): the libc wrapper is recent in musl.
    // SAFETY: NUL-terminated paths relative to the working directory; renameat2 reads them and nothing else.
    let result = unsafe { libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, from.as_ptr(), libc::AT_FDCWD, to.as_ptr(), libc::RENAME_NOREPLACE) };
    if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(target_os = "macos")]
fn native_rename(from: &Path, to: &Path) -> io::Result<()> {
    let (from, to) = (c_path(from)?, c_path(to)?);
    // SAFETY: NUL-terminated paths; renamex_np reads them and nothing else.
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn native_rename(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

/// Moves `from` to `to` unless `to` exists: renameat2(RENAME_NOREPLACE) on Linux, renamex_np(RENAME_EXCL) on macOS,
/// else portable_rename().
fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    match native_rename(from, to) {
        Err(error) if unsupported(&error) => portable_rename(from, to),
        result => result,
    }
}

/// Where the filesystem has no such rename: link() and unlink(); where it has no hard links either (FAT, exFAT), an
/// exclusively created placeholder that the rename replaces, racing only a process that replaces it in between.
fn portable_rename(from: &Path, to: &Path) -> io::Result<()> {
    match fs::hard_link(from, to) {
        Ok(()) => return fs::remove_file(from),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Err(error),
        Err(_) => {}
    }
    drop(exclusive(to)?);
    fs::rename(from, to)
}

/// Marks a downloaded file as browsers do, so Gatekeeper checks it before it runs.
#[cfg(target_os = "macos")]
fn quarantine(path: &Path) {
    let Ok(path) = c_path(path) else { return };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_secs());
    let value = format!("0081;{now:08x};fyl;");
    // SAFETY: NUL-terminated path and attribute name, and a value of the given length.
    unsafe { libc::setxattr(path.as_ptr(), c"com.apple.quarantine".as_ptr(), value.as_ptr().cast(), value.len(), 0, 0) };
}

#[cfg(not(target_os = "macos"))]
fn quarantine(_: &Path) {}

/// §10 step 9: the complete file is synced, moved to its target without replacing anything, marked as downloaded,
/// and its path printed; `then` runs after that (closing a one-time session). If the target appeared meanwhile or the
/// move fails, the verified file stays under its temporary name, which the message gives.
fn save(file: File, target: &Target, then: impl FnOnce()) {
    if let Err(error) = file.sync_all() { failed(&format!("Could not write the file: {error}.")) }
    drop(file);
    let verified = temp().as_mut().map(|(path, verified)| {
        *verified = true;
        path.clone()
    });
    let Some(verified) = verified else { failed("The temporary file is gone.") };
    if let Err(error) = rename_noreplace(&verified, &target.path) {
        let why = if error.kind() == io::ErrorKind::AlreadyExists {
            format!("'{}' appeared during the download", target.path.display())
        } else {
            format!("The file couldn't be moved to '{}': {error}", target.path.display())
        };
        failed(&format!("{why}. The verified file is kept as '{}'.", verified.display()));
    }
    *temp() = None;
    quarantine(&target.path);
    if let Ok(dir) = File::open(&target.dir) { let _ = dir.sync_all(); }
    let printed = emit(&format!("{}\n", target.path.display()));
    then();
    if let Err(error) = printed {
        note!("{}", target.path.display());
        unwritten(error)
    }
}

// ---------------------------------------------------------------------------------------------
// The download (§10 steps 7-8)

/// Where the bytes of a download go.
enum Sink {
    /// A raw file to standard output (`-o -`).
    Stdout { out: BufWriter<io::StdoutLock<'static>>, written: u64, total: u64 },
    /// A raw file, as it arrives.
    Plain { out: BufWriter<File>, written: u64, total: u64 },
    /// An encrypted file: plaintext as its chunks verify.
    Sealed { out: BufWriter<File>, decryptor: Box<e2ee::Decryptor> },
}

/// Why a response's body ended early.
enum Halt {
    /// The connection: go on with Range.
    Network,
    /// The file or the disk: give up.
    Failed(String),
    /// Standard output is full or closed (exit 74).
    Output(io::Error),
}

/// Copies `reader` to `out`, counting `written` up to `total`; Ok once all of it arrived.
fn copy(reader: &mut impl Read, out: &mut impl Write, written: &mut u64, total: u64, failed_write: fn(io::Error) -> Halt) -> Result<(), Halt> {
    let mut buf = vec![0; 1 << 16];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(Halt::Network),
        };
        if *written + n as u64 > total { return Err(Halt::Failed("The server sent more than the file's size.".into())); }
        out.write_all(&buf[..n]).map_err(failed_write)?;
        *written += n as u64;
    }
    if *written == total { Ok(()) } else { Err(Halt::Network) }
}

fn halted(halt: Halt) -> ! {
    match halt {
        Halt::Network => failed(INTERRUPTED),
        Halt::Failed(message) => failed(&message),
        Halt::Output(error) => unwritten(error),
    }
}

fn write_failed(error: io::Error) -> Halt {
    Halt::Failed(format!("Could not write the file: {error}."))
}

impl Sink {
    fn encrypted(&self) -> bool {
        matches!(self, Sink::Sealed { .. })
    }

    /// The offset of the stored file the next request starts at.
    fn offset(&self) -> u64 {
        match self {
            Sink::Stdout { written, .. } | Sink::Plain { written, .. } => *written,
            Sink::Sealed { decryptor, .. } => decryptor.offset(),
        }
    }

    fn pump(&mut self, reader: &mut impl Read) -> Result<(), Halt> {
        match self {
            Sink::Stdout { out, written, total } => copy(reader, out, written, *total, Halt::Output),
            Sink::Plain { out, written, total } => copy(reader, out, written, *total, write_failed),
            Sink::Sealed { out, decryptor } => match decryptor.run(reader, out) {
                Ok(_) => Ok(()),
                Err(StreamError::Read(_)) => Err(Halt::Network),
                Err(StreamError::Write(error)) => Err(write_failed(error)),
                Err(StreamError::Crypto(error)) => Err(Halt::Failed(error.to_string())),
            },
        }
    }

    /// Before a Range request: what was written is out, and an encrypted file is cut back to the plaintext of the
    /// chunks that verified, where the decryptor goes on.
    fn rewind(&mut self) -> Result<(), Halt> {
        match self {
            Sink::Stdout { out, .. } => out.flush().map_err(Halt::Output),
            Sink::Plain { out, .. } => out.flush().map_err(write_failed),
            Sink::Sealed { out, decryptor } => {
                let keep = decryptor.plaintext();
                out.flush().and_then(|()| out.get_ref().set_len(keep)).and_then(|()| out.seek(SeekFrom::Start(keep))).map(drop).map_err(write_failed)
            }
        }
    }

    /// The complete file, flushed, or None for standard output.
    fn finish(self) -> Option<File> {
        let out = match self {
            Sink::Stdout { mut out, .. } => { out.flush().unwrap_or_else(|error| unwritten(error)); return None; }
            Sink::Plain { out, .. } | Sink::Sealed { out, .. } => out,
        };
        Some(out.into_inner().unwrap_or_else(|error| failed(&format!("Could not write the file: {}.", error.error()))))
    }
}

/// What a wrong Content-Length says: for an encrypted file the §13 code it amounts to.
fn wrong_length(length: Option<u64>, total: u64, encrypted: bool) -> String {
    match (length, encrypted) {
        (Some(length), true) if length < total => e2ee::Error::Truncated.to_string(),
        (_, true) => e2ee::Error::Corrupt.to_string(),
        (Some(length), false) => format!("The server sent {length} bytes for a file of {total}."),
        (None, false) => "The server didn't say how large the file is.".to_string(),
    }
}

/// An interruption: wait a little longer each time, then go on with Range; after RESUMES of them, `exhausted`.
fn pause(interruptions: &mut u32, retry_after: Option<u64>, quiet: bool, exhausted: &str) {
    *interruptions += 1;
    if *interruptions > RESUMES { failed(exhausted) }
    let delay = jittered(Duration::from_secs(retry_after.map_or(1 << (*interruptions - 1), |seconds| seconds.clamp(1, 60))));
    if !quiet { note!("Download interrupted, continuing in {:.0}s ({}/{RESUMES})", delay.as_secs_f64(), *interruptions); }
    thread::sleep(delay);
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        // Requests, and the password they carry, go only to the configured origin.
        .max_redirects(0)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(120)))
        // No limit for a whole body, which may take hours, but two silent minutes count as an interruption.
        .timeout_per_read(Some(Duration::from_secs(120)))
        .max_idle_connections(0)
        .max_idle_connections_per_host(0)
        .user_agent(user_agent())
        .build()
        .into()
}

/// `GET /d/<ID>?dl=1` into `sink`: first a 200 of exactly `total` bytes, then after interruptions Range and If-Range
/// from where the sink can go on, up to RESUMES times (§10 step 8). Basic goes with it when there is a password.
fn fetch(api: &Api, id: &str, auth: Option<&str>, total: u64, sink: &mut Sink, quiet: bool) {
    let agent = agent();
    let url = format!("{}/d/{id}?dl=1", api.origin);
    let (mut etag, mut started, mut interruptions) = (None::<String>, false, 0);
    loop {
        let offset = sink.offset();
        let mut request = agent.get(&url).header("Accept", "*/*");
        if let Some(auth) = auth { request = request.header("Authorization", auth); }
        if started {
            request = request.header("Range", &format!("bytes={offset}-"));
            if let Some(etag) = &etag { request = request.header("If-Range", etag); }
        }
        let Ok(mut response) = request.call() else {
            pause(&mut interruptions, None, quiet, INTERRUPTED);
            continue;
        };
        let status = response.status().as_u16();
        let header = |name: &str| response.headers().get(name).and_then(|value| value.to_str().ok()).map(|value| value.trim().to_string());
        let (length, range, tag) = (header("content-length").and_then(|value| value.parse::<u64>().ok()), header("content-range"), header("etag"));
        match status {
            200 if !started => {
                if length != Some(total) { failed(&wrong_length(length, total, sink.encrypted())) }
                (etag, started) = (tag, true);
            }
            // A 200 to a Range request means the stored file changed (§9.2).
            200 if sink.encrypted() => failed(&e2ee::Error::Corrupt.to_string()),
            200 => failed("The file changed on the server during the download."),
            206 if started => {
                if range.as_deref() != Some(format!("bytes {offset}-{}/{total}", total - 1).as_str()) || length != Some(total - offset) {
                    failed("The server sent another part of the file than asked for.");
                }
            }
            _ => {
                let text = response.body_mut().read_to_string().unwrap_or_default();
                let retry_after = response.headers().get("retry-after").and_then(|value| value.to_str().ok()).and_then(|value| value.trim().parse().ok());
                let reply = Reply { status, body: serde_json::from_str(&text).unwrap_or(Value::Null), retry_after };
                if status == 503 && reply.body["code"] == "uploading" {
                    waiting(&reply);
                    continue;
                }
                if class(status, reply.body["code"].as_str()) == Class::Retry {
                    let exhausted = if reply.body["code"] == "unsupported_mode" { "This file needs a newer fyl.at." } else { INTERRUPTED };
                    pause(&mut interruptions, reply.retry_after, quiet, exhausted);
                    continue;
                }
                refused(&reply)
            }
        }
        let mut reader = response.into_body().into_reader();
        match sink.pump(&mut reader) {
            Ok(()) => return,
            Err(Halt::Network) => {
                sink.rewind().unwrap_or_else(|halt| halted(halt));
                pause(&mut interruptions, None, quiet, INTERRUPTED);
            }
            Err(halt) => halted(halt),
        }
    }
}

/// Closes a one-time session at once (§11), best effort: otherwise it idles out 15 minutes after the download.
fn close_session(api: &Api, id: &str) {
    let _ = api.send_bytes("POST", &format!("{}/api/transfers/{id}/done", api.origin), None, false, &[]);
}

pub(crate) fn download(options: Download) {
    let api = Api::new(&options.endpoint).unwrap_or_else(|| stop(ENDPOINT));
    on_signal(interrupted);
    keep_writes_failing();
    let quiet = !options.verbose;
    // §10 step 1. Messages never repeat the link: it may hold the key.
    let text = secret(options.link, "Link");
    let link = e2ee::parse_link(text.trim(), &api.origin).unwrap_or_else(|error| match error {
        LinkError::KeyInvalid => stop(&e2ee::Error::KeyInvalid.to_string()),
        _ => stop(&format!("That isn't a download link of {}. Links look like {}/d/<id>.", api.host(), api.origin)),
    });
    if link.exposed { exposed(api.host()) }
    let id = link.id;
    // §10 steps 2-3: a link with a key never yields a file that wasn't encrypted.
    let mut info = transfer_info(&api, &id, None, quiet).unwrap_or_else(|reply| refused(&reply));
    let encrypted = match info["mode"].as_str() {
        None | Some("raw") => false,
        Some("e2ee") => true,
        Some(_) => failed(&e2ee::Error::Unsupported.to_string()),
    };
    if !encrypted && link.key.is_some() { failed("This link has a key, but the file isn't encrypted.") }
    // §10 step 6's refusal, before any key or password is asked for or tried.
    let output = options.output.as_deref();
    if encrypted && output == Some("-") { stop(NO_STDOUT) }
    let parse = |text: &str| e2ee::parse_entry(text, &api.origin, &id);
    let mut tries = 0;
    let key = encrypted.then(|| match link.key {
        Some(key) => (key, false),
        None => match env_key(&parse, &api.origin) {
            Some(key) => (key, false),
            None => (typed_key(&parse, &api.origin, &mut tries, NO_KEY), true),
        },
    });
    // §10 step 4.
    let auth = (info["protected"] == true).then(|| {
        let (auth, unlocked) = unlock(&api, &id, quiet);
        info = unlocked;
        auth
    });
    // §10 step 5, still before anything is consumed.
    let checked = key.map(|(identity, typed)| check_key(&info, identity, typed, &parse, &api.origin, &mut tries));
    let total = info["size"].as_u64().filter(|size| *size > 0).unwrap_or_else(|| failed("The server sent no size for this file."));
    let (name, size) = match &checked {
        Some(checked) => (checked.name.clone(), checked.size),
        None => (info["name"].as_str().unwrap_or_else(|| failed("The server sent no name for this file.")).to_string(), total),
    };
    // §10 step 6.
    if output == Some("-") {
        let mut sink = Sink::Stdout { out: BufWriter::new(io::stdout().lock()), written: 0, total };
        fetch(&api, &id, auth.as_deref(), total, &mut sink, quiet);
        sink.finish();
        return;
    }
    let target = Target::new(output, Path::new("."), &name, size);
    if !quiet { note!("Downloading {} ({:.2} MB{})", target.path.display(), size as f64 / 1_048_576.0, if encrypted { ", encrypted" } else { "" }); }
    // §10 steps 7-8.
    let file = temp_file(&target.dir);
    let mut sink = match checked {
        Some(checked) => Sink::Sealed { out: BufWriter::new(file), decryptor: Box::new(checked.content.decryptor()) },
        None => Sink::Plain { out: BufWriter::new(file), written: 0, total },
    };
    fetch(&api, &id, auth.as_deref(), total, &mut sink, quiet);
    let Some(file) = sink.finish() else { return };
    // §10 step 9.
    let once = encrypted && info["once"] == true;
    save(file, &target, || if once { close_session(&api, &id) });
}

// ---------------------------------------------------------------------------------------------
// fyl decrypt (§10, last paragraphs)

pub(crate) fn decrypt(options: Decrypt) {
    let base = Api::new(&options.endpoint).map(|api| api.origin).unwrap_or_else(|| stop(ENDPOINT));
    on_signal(interrupted);
    keep_writes_failing();
    let input = Path::new(&options.file);
    let meta = fs::metadata(input).unwrap_or_else(|_| stop(&format!("Can't find '{}'. Check the path and try again.", options.file)));
    if !meta.is_file() { stop(&format!("'{}' is not a regular file.", options.file)) }
    let file = File::open(input).unwrap_or_else(|_| stop(&format!("Can't read '{}'. Check its permissions.", options.file)));
    // The original name isn't in the file (it is in the metadata, which a saved file doesn't carry).
    let base_name = input.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = base_name.strip_suffix(".age").filter(|stem| !stem.is_empty());
    let size = e2ee::plaintext_size(meta.len()).unwrap_or(meta.len());
    let target = match (options.output.as_deref(), stem) {
        (Some("-"), _) => stop(NO_STDOUT),
        (None, None) => stop(&format!("'{}' doesn't end in .age: name the decrypted file with -o.", options.file)),
        (output, stem) => {
            let folder = input.parent().filter(|dir| !dir.as_os_str().is_empty()).unwrap_or(Path::new("."));
            Target::new(output, folder, stem.unwrap_or(&base_name), size)
        }
    };
    let prefix = stem.and_then(|stem| stem.strip_prefix("fyl-")).filter(|prefix| prefix.len() == 8);
    let parse = |text: &str| file_key(text, &base, prefix);
    let mut tries = 0;
    let (mut identity, typed) = match env_key(&parse, &base) {
        Some(key) => (key, false),
        None => (typed_key(&parse, &base, &mut tries, "Type the key at a terminal, or set FYL_KEY."), true),
    };
    // The key is tried on the header first, so a mistyped one is asked for again before anything is written.
    let mut head = [0; e2ee::H];
    let mut read = 0;
    while read < head.len() {
        match file.read_at(&mut head[read..], read as u64) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => failed(&format!("Could not read '{}': {error}.", options.file)),
        }
    }
    while matches!(e2ee::decrypt(&identity, &mut &head[..read], &mut io::sink()), Err(StreamError::Crypto(e2ee::Error::KeyWrong))) {
        if !typed || tries >= KEY_TRIES { failed(&e2ee::Error::KeyWrong.to_string()) }
        note!("fyl: {}", e2ee::Error::KeyWrong);
        identity = typed_key(&parse, &base, &mut tries, NO_KEY);
    }
    let mut out = BufWriter::new(temp_file(&target.dir));
    match e2ee::decrypt(&identity, &mut BufReader::new(&file), &mut out) {
        Ok(_) => {}
        Err(StreamError::Crypto(error)) => failed(&error.to_string()),
        Err(StreamError::Read(error)) => failed(&format!("Could not read '{}': {error}.", options.file)),
        Err(StreamError::Write(error)) => failed(&format!("Could not write the file: {error}.")),
    }
    let file = out.into_inner().unwrap_or_else(|error| failed(&format!("Could not write the file: {}.", error.error())));
    save(file, &target, || {});
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "yhYmJSxTzxpNxGaV5_zEZZTLTMre22cS39oHU_OuNV4";

    #[test]
    fn basic_credentials_are_what_curl_sends() {
        for (password, header) in [("tide-lamp-moss-41", "Basic ZnlsOnRpZGUtbGFtcC1tb3NzLTQx"), ("a", "Basic ZnlsOmE="), ("", "Basic ZnlsOg=="),
                                   ("pässwörd:x", "Basic ZnlsOnDDpHNzd8O2cmQ6eA==")] {
            assert_eq!(basic(password), header, "{password}");
        }
    }

    /// tests/vectors/passwords.json, shared with the server: a password fyl keeps to itself is one the server refuses
    /// too, and where NFC changes nothing (below U+0300) fyl judges exactly as the server does.
    #[test]
    fn only_passwords_the_server_would_refuse_are_kept_back() {
        let cases: Value = serde_json::from_str(include_str!("../../tests/vectors/passwords.json")).unwrap();
        let cases = cases.as_array().expect("a list of cases");
        let mut exact = 0;
        for case in cases {
            let (input, valid) = (case["input"].as_str().unwrap(), case["valid"].as_bool().unwrap());
            if impossible(input) { assert!(!valid, "{case}") }
            if input.chars().all(|c| c < '\u{300}') {
                assert_eq!(impossible(input), !valid, "{case}");
                exact += 1;
            }
        }
        assert!(cases.len() >= 25 && exact >= 15, "{exact} of {} cases", cases.len());
        assert!(impossible("") && impossible("abc") && impossible("pässw") && !impossible("pässwö") && !impossible("क़क़क़"));
    }

    #[test]
    fn decrypt_takes_any_key_form_and_a_link_only_for_its_own_file() {
        let base = "https://fyl.at";
        let link = |id: &str| format!("{base}/d/{id}#{KEY}");
        let own = format!("abcdefgh{}", "x".repeat(35));
        let opens = |input: &str, prefix| file_key(input, base, prefix).map(|identity| identity.key());
        for input in [KEY.to_string(), format!(" {KEY}\n"), link(&own), format!("{base}/d/{own}%23{KEY}"),
                      "age-secret-key-1egtzvffv20835nwyv6270lxyvk2vknx2mmdkwyklmgr48uawx40q2p2lm0".to_string()] {
            assert_eq!(opens(&input, Some("abcdefgh")), Ok(KEY.to_string()), "{input}");
        }
        assert_eq!(opens(&link(&"z".repeat(43)), Some("abcdefgh")), Err(EntryError::OtherTransfer));
        assert_eq!(opens(&link(&"z".repeat(43)), None), Ok(KEY.to_string()));
        for input in ["", "short", "https://fyl.at/d/abcdefgh123", "https://other.example/d/abcdefghxxxxxxxx#x", "AGE-SECRET-KEY-1", &KEY[..42]] {
            assert_eq!(opens(input, Some("abcdefgh")), Err(EntryError::KeyInvalid), "{input}");
        }
    }

    #[test]
    fn saved_names_are_one_harmless_path_component() {
        for (name, saved) in [("report.pdf", "report.pdf"), ("Bericht \"Q3\" 📊.pdf", "Bericht \"Q3\" 📊.pdf"), (".bashrc", "_bashrc"),
                              (".", "_"), ("..", "_"), ("a/b\\c", "a_b_c"), ("x\u{202e}gpj.exe", "x_gpj.exe"), ("", "_")] {
            assert_eq!(saved_name(name), saved, "{name}");
        }
        let saved = saved_name(&format!("{}.tar.gz", "é".repeat(200)));
        assert!(saved.len() <= 255 && saved.len() > 250 && saved.starts_with('é') && saved.ends_with("é.gz"), "{saved}");
    }

    #[test]
    fn a_move_never_replaces_what_is_there() {
        let dir = std::env::temp_dir().join(format!("fyl-move-{}-{}", process::id(), hex(&random_bytes::<8>())));
        fs::create_dir(&dir).unwrap();
        for rename in [rename_noreplace as fn(&Path, &Path) -> io::Result<()>, portable_rename] {
            let (from, to) = (dir.join("from"), dir.join("to"));
            fs::write(&from, b"new").unwrap();
            fs::write(&to, b"old").unwrap();
            assert_eq!(rename(&from, &to).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
            assert_eq!((fs::read(&from).unwrap(), fs::read(&to).unwrap()), (b"new".to_vec(), b"old".to_vec()));
            // A dangling symlink is there too.
            fs::remove_file(&to).unwrap();
            std::os::unix::fs::symlink(dir.join("missing"), &to).unwrap();
            assert_eq!(rename(&from, &to).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
            fs::remove_file(&to).unwrap();
            rename(&from, &to).unwrap();
            assert!(!from.exists());
            assert_eq!(fs::read(&to).unwrap(), b"new");
            fs::remove_file(&to).unwrap();
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_wrong_length_says_what_it_means_for_an_encrypted_file() {
        assert_eq!(wrong_length(Some(10), 200, true), e2ee::Error::Truncated.to_string());
        assert_eq!(wrong_length(Some(300), 200, true), e2ee::Error::Corrupt.to_string());
        assert_eq!(wrong_length(None, 200, true), e2ee::Error::Corrupt.to_string());
        assert_eq!(wrong_length(Some(10), 200, false), "The server sent 10 bytes for a file of 200.");
    }
}

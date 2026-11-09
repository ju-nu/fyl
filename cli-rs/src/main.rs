//! fyl — command-line client for https://fyl.at.
//!
//! `fyl FILE` uploads a file in 50 MiB parts (four in parallel by default, up to eight) and prints only the
//! download link; with `--encrypt` the parts are encrypted on this machine first (docs/E2EE.md). `fyl FOLDER` uploads a
//! folder as one zip built from its files as the parts go out (docs/FOLDER-ZIP.md). `fyl download LINK`
//! saves a file from a link, decrypting an encrypted one, and `fyl decrypt FILE.age` opens saved ciphertext.
//! `fyl rm LINK` deletes an upload using its private management link. Nothing is written to disk but downloads and
//! the time of the last update check (update.rs).

use md5::{Digest, Md5};
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashMap;
use std::fs::{self, File, Metadata};
use std::io::{self, IsTerminal, Write};
use std::ops::RangeInclusive;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

// The E2EE core (docs/E2EE.md). The CLI uses most of it; the few items only the tests and the interoperability vectors
// use carry their own allow(dead_code) outside tests, so clippy still reports anything else that falls out of use.
mod e2ee;

/// Cargo.toml's version.
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The User-Agent every request sends: `fyl-cli/<version>`, then FYL_UA_SUFFIX when it is a short plain token. fyl's
/// own checks set `fyl-smoke`, so the server's statistics count their uploads and downloads as its own; anything else in
/// the variable is ignored. It never changes what the server allows.
pub(crate) fn user_agent() -> String {
    agent_with(std::env::var("FYL_UA_SUFFIX").ok().as_deref())
}

fn agent_with(suffix: Option<&str>) -> String {
    let base = format!("fyl-cli/{VERSION}");
    match suffix.map(str::trim) {
        Some(token) if !token.is_empty() && token.len() <= 40
            && token.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/')) => format!("{base} {token}"),
        _ => base,
    }
}
const DEFAULT_API: &str = "https://fyl.at/api/upload";
/// The part size of every upload, raw or encrypted: the one the E2EE layout is defined with (docs/E2EE.md).
const PART_BYTES: u64 = e2ee::PART;
/// The service's limit (MAX_FILE_BYTES), checked before anything is sent.
const MAX_BYTES: u64 = 50 << 30;
const WORKERS: usize = 4;
const ATTEMPTS: u32 = 3;
/// How often a completion whose reply broke off or isn't this upload's receipt is sent again.
const UNCLEAR_REPEATS: u32 = 5;
/// The service's own words for a password it refuses. It counts the length in NFC, which needs Unicode tables fyl
/// doesn't carry, so fyl leaves the length to it and refuses only control characters before anything is sent.
const PASSWORD_RULE: &str = "Password must be 6 to 200 characters, without control characters.";
/// Exit code when stdout is full or closed, or stderr can't show a generated password (EX_IOERR).
const OUTPUT_FAILED: i32 = 74;
/// Generated passwords are three of these words and two digits, e.g. tide-lamp-moss-41: about 30 bits, and the
/// service pauses a link for 15 minutes after 5 wrong tries.
const WORDS: [&str; 256] = [
    "acorn", "amber", "apple", "arrow", "aspen", "atlas", "badge", "bagel", "baker", "banjo", "basil", "beach", "beam",
    "bean", "bell", "berry", "bird", "bison", "blaze", "bloom", "boat", "bolt", "book", "bread", "brick", "brook",
    "brush", "cabin", "cake", "camel", "candy", "cape", "cargo", "cedar", "chair", "chalk", "chess", "cider", "clay",
    "cliff", "clock", "cloud", "coast", "comet", "coral", "corn", "crane", "creek", "crow", "crown", "cube", "daisy",
    "dawn", "delta", "desk", "dial", "dove", "dream", "drum", "dune", "eagle", "earth", "echo", "elbow", "elm",
    "ember", "fern", "field", "fig", "finch", "flame", "flask", "flint", "flute", "foam", "fog", "fox", "frost",
    "fruit", "gate", "gecko", "gem", "globe", "glove", "goat", "gold", "grape", "grass", "grove", "gull", "harp",
    "hawk", "hazel", "heart", "hill", "hippo", "honey", "horn", "house", "igloo", "iris", "iron", "ivory", "ivy",
    "jade", "jam", "jar", "jazz", "jelly", "jewel", "kayak", "kite", "kiwi", "koala", "ladle", "lake", "lamp", "lava",
    "leaf", "lemon", "lemur", "lily", "lime", "linen", "lion", "llama", "lotus", "mango", "maple", "marsh", "medal",
    "melon", "metal", "mint", "mist", "moon", "moss", "moth", "motor", "mouse", "mug", "nest", "north", "nut", "oak",
    "oasis", "ocean", "olive", "onion", "opal", "orbit", "otter", "oven", "owl", "palm", "panda", "paper", "pasta",
    "peach", "pearl", "pecan", "penny", "petal", "piano", "pilot", "pine", "pizza", "plaza", "plum", "pond", "poppy",
    "prism", "puppy", "quail", "quest", "radar", "raft", "rain", "ranch", "raven", "reef", "rhino", "ridge", "river",
    "robin", "robot", "rock", "ruby", "sage", "salt", "sand", "scarf", "scout", "seal", "seed", "shark", "sheep",
    "shell", "shore", "silk", "skate", "sky", "slate", "sloth", "snack", "snow", "sofa", "spark", "spice", "spoon",
    "squid", "stamp", "star", "stone", "stork", "storm", "sugar", "swan", "table", "taco", "tango", "tempo", "tent",
    "thorn", "tide", "tiger", "toast", "tofu", "topaz", "torch", "tower", "train", "tree", "tulip", "tuna", "twig",
    "vault", "video", "vine", "viola", "wagon", "waltz", "wave", "whale", "wheat", "wheel", "wind", "wing", "wolf",
    "yacht", "yarn", "yoga", "yolk", "zebra", "zest", "zinc",
];

const HINT: &str = "fyl uploads a file and prints its download link.

  fyl ./archive.zip                 upload; the link expires after 1 day
  fyl ./photos                      upload a folder as one zip (photos.zip)
  fyl ./archive.zip --expires 3h    pick a lifetime from 5m to 7d
  fyl ./archive.zip --once          allow a single download
  fyl ./archive.zip --password      require a password to download
  fyl ./archive.zip --encrypt       encrypt it on this device before the upload
  fyl ./archive.zip --json          print the link and its details as JSON
  fyl download <link>               save a file from a link (and decrypt it)
  fyl rm <management-link>          delete an upload
  fyl update                        install the current version of fyl

An interrupted upload prints a --resume command that continues it within 24 hours.

All options: fyl --help
";

const HELP: &str = "fyl: Fyl for now. Uploads a file and prints only its download link. No account needed.

Usage:
  fyl FILE [options]
  fyl FOLDER [options]
  fyl download LINK [-o PATH]
  fyl decrypt FILE.age [-o PATH]
  fyl rm MANAGEMENT-LINK
  fyl update [--check] [--force]

Options:
  --expires LIFETIME   Link lifetime from 5m to 7d, e.g. 30m, 12h, 3d (default: 1d)
  --once               Allow a single download
  --password           Require a password to download (FYL_PASSWORD for scripts)
  --encrypt            Encrypt the file on this device before the upload. The key is the
                       part of the link after #, which browsers don't send to fyl.at.
                       Anyone with the full link can open the file; a lost key can't be
                       recovered
  -m, --manage         Also print the private management link (needed for `fyl rm`)
  -v, --verbose        Show progress and the expiry time on stderr
  -q, --quiet          Print only the link (the default)
  --json               Print one JSON object instead of the links (url, name, size,
                       expiresAt, once; managementUrl with --manage; protected with
                       --password, and the password if fyl generated it; encrypted
                       with --encrypt)
  --workers N          Parallel part uploads, 1-8 (default: 4)
  --resume VALUE       Continue an interrupted upload of the same file or folder (fyl
                       prints the command when an upload is interrupted; valid for 24
                       hours)
  -h, --help           Show this help
  --version            Show the version

Upload a folder:
  fyl ./photos         Sends the folder as one zip, photos.zip, which unzips to the
                       folder. Its files are stored as they are (not compressed) with
                       their modification times; fyl reads them once first to check
                       them. Symlinks, special files, empty folders and names that are
                       unsafe in a zip are left out, and fyl says so. Up to 100,000 files.

Download a file:
  fyl download 'https://fyl.at/d/<id>#<key>'
  Saves the file in this folder under its own name (-o FOLDER, or -o FILE for another
  name) and prints its path. An encrypted file appears only once it is decrypted and
  verified. Without the key in the link, fyl asks for it (FYL_KEY for scripts), and a
  protected file asks for its password (FYL_PASSWORD). fyl never sends the key anywhere.

Open an encrypted file saved with curl ('…?dl=1'):
  fyl decrypt fyl-<id>.age      (asks for the key; -o names the output)

Delete an upload:
  fyl rm 'https://fyl.at/#manage/<id>/<key>'

Update fyl:
  fyl update           Replaces this fyl with the current version for this system,
                       checked against its published SHA-256 (run it with sudo where
                       the folder needs it). --check only says whether there is one;
                       --force also installs the same or an older version.
  Once a day, after a command, fyl says on the terminal when a newer version is available
  (FYL_NO_UPDATE_CHECK=1 turns that off).

A link, resume value or management link given as - is read from stdin, which keeps it
out of the process list other users can see. To upload a file or folder named
download, decrypt or update, write it as ./download, ./decrypt or ./update.
";

// ---------------------------------------------------------------------------------------------
// Messages and exit codes: argument mistakes exit 2, failures exit 1, a full or closed stdout 74 (and a stderr
// that can't show a generated password). Nothing reads as a stack dump.

/// eprintln! without its panic, which aborts the process (panic = "abort") when stderr is full or closed.
macro_rules! note {
    ($($arg:tt)*) => {{ let _ = writeln!(io::stderr(), $($arg)*); }};
}

// After note!, which they use.
mod download;
mod folder;
mod update;

/// Writes `text` to stdout in one piece and flushes it.
fn emit(text: &str) -> io::Result<()> {
    let mut out = io::stdout().lock();
    out.write_all(text.as_bytes())?;
    out.flush()
}

/// Server text without control characters, so a reply can't drive the terminal (escape sequences, carriage returns):
/// every message that repeats what a server said goes through it.
fn clean(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).collect()
}

fn unwritten(error: io::Error) -> ! {
    note!("fyl: Could not write to standard output: {error}.");
    process::exit(OUTPUT_FAILED)
}

fn usage_error(message: &str) -> ! {
    usage(message, "fyl ./archive.zip")
}

fn usage(message: &str, example: &str) -> ! {
    note!("fyl: {message}\nTry: {example}   (all options: fyl --help)");
    process::exit(2)
}

fn stop(message: &str) -> ! {
    note!("fyl: {message}");
    process::exit(2)
}

/// A resume that can't go on safely (docs/E2EE.md §8.4): exit 2, and the upload stays as it is, never cancelled.
/// Worker threads may refuse at the same time, so only the first one speaks.
fn refuse(message: &str) -> ! {
    let _exiting = EXITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    stop(message)
}

const CHANGED: &str = "The file changed since this upload started. Start a new upload.";

/// The bytes of an encrypted part differ from what this upload already pinned (§8.2): stop before anything is sent.
/// Not cancelled: only the server's part_changed or an explicit cancel discards an upload (§8.4).
fn changed() -> ! {
    halt(CHANGED)
}

/// A stop that keeps the upload as it is, without a resume command (exit 1). Only the first thread speaks.
fn halt(message: &str) -> ! {
    let _exiting = EXITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    note!("fyl: {message}");
    process::exit(1)
}

/// The upload in progress, so a failure that cannot be resumed can ask the server to discard its parts.
static ACTIVE: Mutex<Option<(Api, String, String)>> = Mutex::new(None);
/// How to continue the upload in progress (a note and the command), printed when it is interrupted.
static RESUME: Mutex<Option<String>> = Mutex::new(None);
/// Held by the first thread that exits; later failures wait here so they cannot cut the abort short.
static EXITING: Mutex<()> = Mutex::new(());
/// Set while a hidden prompt runs: it reads Ctrl+C as a key, restores the terminal and then raises SIGINT.
static PROMPTING: AtomicBool = AtomicBool::new(false);
/// The terminal and its settings from before the hidden prompt that runs, which a termination signal restores: the
/// prompt can't, since the process ends before its read returns.
static TERMINAL: Mutex<Option<(File, libc::termios)>> = Mutex::new(None);

fn fail(message: &str) -> ! {
    let _exiting = EXITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let active = ACTIVE.lock().map(|mut guard| guard.take()).unwrap_or(None);
    note!("fyl: {message}");
    if let Some((api, id, key)) = active {
        // Best effort, single attempt: the server also expires incomplete uploads after 24 hours.
        let body = json!({"uploadId": id, "key": key}).to_string();
        let _ = api.send_bytes("POST", &api.upload("/abort"), Some(body.as_bytes()), true, &[]);
    }
    process::exit(1)
}

/// Network trouble or Ctrl+C: keep the server-side upload and tell the user how to continue it.
fn interrupt(message: &str) -> ! {
    let _exiting = EXITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    note!("fyl: {message}");
    if let Some(resume) = RESUME.lock().ok().and_then(|guard| guard.clone()) { note!("{resume}"); }
    process::exit(1)
}

/// What a part's ETag says about the bytes the server stored.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Check { Match, Mismatch, Unverifiable }

/// R2's ETag for a part is its MD5 (32 hex digits, maybe quoted). Any other ETag, such as the local R2 simulator's,
/// can't be compared: whether it counts is Api::verifies()'s call.
fn check_etag(etag: &str, md5: &str) -> Check {
    let etag = etag.trim_matches('"');
    if etag.len() != 32 || !etag.bytes().all(|byte| byte.is_ascii_hexdigit()) { Check::Unverifiable }
    else if etag.eq_ignore_ascii_case(md5) { Check::Match }
    else { Check::Mismatch }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// A secret given as `-` is read from stdin, so it stays out of the process list other users can read: one line, or
/// at a terminal typed without echo. Call on_signal() first, so Ctrl+C at the prompt restores the terminal.
fn secret(value: String, prompt: &str) -> String {
    if value != "-" { return value; }
    if io::stdin().is_terminal() { return ask_hidden(&format!("{prompt}: ")).unwrap_or_default().trim().to_string(); }
    let mut line = String::new();
    let _ = io::stdin().read_line(&mut line);
    line.trim().to_string()
}

/// rpassword's prompt on /dev/tty, with PROMPTING set and the terminal's settings saved for restore_terminal().
fn prompt_hidden(prompt: &str) -> io::Result<String> {
    let terminal = File::options().read(true).write(true).custom_flags(libc::O_NOCTTY).open("/dev/tty").ok().and_then(|tty| {
        let mut settings = std::mem::MaybeUninit::<libc::termios>::uninit();
        // SAFETY: an open descriptor and a buffer of the right type, which tcgetattr fills when it returns 0.
        (unsafe { libc::tcgetattr(tty.as_raw_fd(), settings.as_mut_ptr()) } == 0).then(|| (tty, unsafe { settings.assume_init() }))
    });
    *TERMINAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = terminal;
    PROMPTING.store(true, Ordering::SeqCst);
    let answer = rpassword::prompt_password(prompt);
    PROMPTING.store(false, Ordering::SeqCst);
    TERMINAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
    answer
}

/// A signal other than Ctrl+C ends the process during a hidden prompt: the terminal echoes again, on a new line.
fn restore_terminal() {
    if let Some((tty, settings)) = TERMINAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref() {
        // SAFETY: an open descriptor and settings tcgetattr returned for it.
        unsafe { libc::tcsetattr(tty.as_raw_fd(), libc::TCSANOW, settings) };
        let _ = (&*tty).write_all(b"\n");
    }
}

/// A secret typed on the terminal (/dev/tty) without echo, or None when nobody would see the prompt: neither stdin
/// nor stderr is a terminal (scripts, CI), or there is no terminal to ask on. Ctrl+C there is a key: rpassword
/// restores the terminal and raises SIGINT, which on_signal() leaves to this function; Ctrl+D cancels too.
fn ask_hidden(prompt: &str) -> Option<String> {
    if !io::stdin().is_terminal() && !io::stderr().is_terminal() { return None; }
    match prompt_hidden(prompt) {
        Ok(answer) => Some(answer),
        Err(error) if matches!(error.kind(), io::ErrorKind::Interrupted | io::ErrorKind::UnexpectedEof) => die(signal_hook::consts::SIGINT),
        Err(_) => None,
    }
}

/// Ctrl+C or termination runs `handler`, which ends the process; at a hidden prompt, which reads Ctrl+C as a key and
/// raises SIGINT itself after restoring the terminal, SIGINT is left to the prompt, and termination restores the
/// terminal first.
fn on_signal(handler: fn(i32) -> !) {
    use signal_hook::consts::{SIGINT, SIGTERM};
    if let Ok(mut signals) = signal_hook::iterator::Signals::new([SIGINT, SIGTERM]) {
        thread::spawn(move || for signal in signals.forever() {
            if PROMPTING.load(Ordering::SeqCst) {
                if signal == SIGINT { continue; }
                restore_terminal();
            }
            handler(signal)
        });
    }
}

// ---------------------------------------------------------------------------------------------
// Arguments

struct Upload {
    file: String,
    /// Only when given: a resumed upload keeps its own lifetime.
    expires: Option<u64>,
    once: bool,
    password: bool,
    /// Encrypt before the upload (docs/E2EE.md); on resume only a check that the upload is encrypted.
    encrypt: bool,
    manage: bool,
    verbose: bool,
    json: bool,
    workers: usize,
    endpoint: String,
    resume: Option<String>,
}

enum Command {
    Upload(Upload),
    Remove(String),
    Download(download::Download),
    Decrypt(download::Decrypt),
    Update(update::Update),
}

fn default_endpoint() -> String {
    std::env::var("FYL_API_URL").unwrap_or_else(|_| DEFAULT_API.to_string())
}

/// Whether a first argument `download`, `decrypt` or `update` is that command rather than a file to upload: the
/// command when a link or file follows it (or `-o`, `--check`, `--force`), or when no regular file of that name exists.
/// So `fyl download LINK` always downloads, `fyl download --once` still uploads an existing file named download, and
/// `./download` always uploads. A folder of that name doesn't count: `fyl update`
/// next to a folder named update updates fyl rather than send the folder, which takes `./update`.
fn names_the_command(args: &[String], exists: impl Fn(&str) -> bool) -> bool {
    let mut rest = args[1..].iter();
    let mut options_done = false;
    while let Some(arg) = rest.next() {
        if options_done || !arg.starts_with('-') || arg == "-" { return true; }
        match arg.split_once('=').map_or(arg.as_str(), |(name, _)| name) {
            "--" => options_done = true,
            "-o" | "--output" | "--check" | "--force" => return true,
            // Options of either command that take a value: the value is no link or file.
            name @ ("--expires" | "--workers" | "-e" | "--endpoint" | "--resume") if !arg.contains('=') || !name.starts_with("--") => { rest.next(); }
            _ => {}
        }
    }
    !exists(&args[0])
}

/// `fyl download LINK [-o PATH]` and `fyl decrypt FILE [-o PATH]` (docs/E2EE.md §10).
fn parse_saving(args: Vec<String>) -> Command {
    let decrypting = args[0] == "decrypt";
    let example = if decrypting { "fyl decrypt ./fyl-<id>.age" } else { "fyl download 'https://fyl.at/d/<id>#<key>'" };
    let (mut output, mut endpoint, mut verbose) = (None, default_endpoint(), false);
    let mut positional = Vec::new();
    let mut iter = args.into_iter().skip(1);
    let mut options_done = false;
    while let Some(arg) = iter.next() {
        if options_done || !arg.starts_with('-') || arg == "-" {
            positional.push(arg);
            continue;
        }
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name.to_string(), Some(value.to_string())),
            _ => (arg.clone(), None),
        };
        let mut value = |label: &str| inline.clone().or_else(|| iter.next()).unwrap_or_else(|| usage(&format!("{label} needs a value."), example));
        let switch = || inline.is_none() || usage(&format!("{name} takes no value."), example);
        match name.as_str() {
            "--" => options_done = true,
            "-h" | "--help" => { emit(HELP).unwrap_or_else(|e| unwritten(e)); process::exit(0) }
            "--version" => { emit(&format!("fyl {VERSION}\n")).unwrap_or_else(|e| unwritten(e)); process::exit(0) }
            "-o" | "--output" => output = Some(value("--output")),
            "-e" | "--endpoint" => endpoint = value("--endpoint"),
            "-v" | "--verbose" => verbose = switch(),
            "-q" | "--quiet" => verbose = !switch(),
            other => usage(&format!("unknown option {other} for fyl {}", if decrypting { "decrypt" } else { "download" }), example),
        }
    }
    let one = match positional.len() {
        1 => positional.remove(0),
        0 if decrypting => usage("decrypt needs the saved file: fyl decrypt ./fyl-<id>.age", example),
        0 => usage("download needs a link: fyl download 'https://fyl.at/d/<id>#<key>'", example),
        _ if decrypting => usage("decrypt takes one file.", example),
        _ => usage("download takes one link.", example),
    };
    if decrypting { Command::Decrypt(download::Decrypt { file: one, output, endpoint }) }
    else { Command::Download(download::Download { link: one, output, endpoint, verbose }) }
}

/// `fyl update [--check] [--force]`.
fn parse_update(args: Vec<String>) -> Command {
    let example = "fyl update";
    let mut update = update::Update { check: false, force: false, endpoint: default_endpoint() };
    let mut iter = args.into_iter().skip(1);
    while let Some(arg) = iter.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name.to_string(), Some(value.to_string())),
            _ => (arg.clone(), None),
        };
        let switch = || inline.is_none() || usage(&format!("{name} takes no value."), example);
        match name.as_str() {
            "-h" | "--help" => { emit(HELP).unwrap_or_else(|e| unwritten(e)); process::exit(0) }
            "--version" => { emit(&format!("fyl {VERSION}\n")).unwrap_or_else(|e| unwritten(e)); process::exit(0) }
            "--check" => update.check = switch(),
            "--force" => update.force = switch(),
            "-e" | "--endpoint" => update.endpoint = inline.clone().or_else(|| iter.next()).unwrap_or_else(|| usage("--endpoint needs a value.", example)),
            other if other.starts_with('-') => usage(&format!("unknown option {other} for fyl update"), example),
            _ => usage("update takes no file or link.", example),
        }
    }
    Command::Update(update)
}

fn parse_lifetime(value: &str) -> Result<u64, String> {
    let invalid = || "--expires: Use a lifetime such as 30m, 1h or 3d.".to_string();
    let unit = value.chars().last().ok_or_else(invalid)?;
    let digits = &value[..value.len() - unit.len_utf8()];
    let factor = match unit { 'm' => 60, 'h' => 3600, 'd' => 86_400, _ => return Err(invalid()) };
    if digits.is_empty() || digits.len() > 5 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid());
    }
    let seconds = digits.parse::<u64>().map_err(|_| invalid())? * factor;
    if !(300..=604_800).contains(&seconds) {
        return Err("--expires: Lifetime must be between 5 minutes and 7 days.".into());
    }
    Ok(seconds)
}

fn parse_args(args: Vec<String>) -> Command {
    if args.is_empty() {
        let _ = write!(io::stderr(), "{HINT}");
        process::exit(2);
    }
    if args[0] == "rm" || args[0] == "delete" {
        match args.len() {
            2 => return Command::Remove(args[1].clone()),
            1 => usage_error("rm needs the management link: fyl rm 'https://fyl.at/#manage/…'"),
            _ => usage_error("rm takes exactly one management link."),
        }
    }
    let named = |args: &[String]| names_the_command(args, |name| fs::metadata(name).is_ok_and(|meta| meta.is_file()));
    if matches!(args[0].as_str(), "download" | "decrypt") && named(&args) { return parse_saving(args); }
    if args[0] == "update" && named(&args) { return parse_update(args); }
    let mut upload = Upload {
        file: String::new(),
        expires: None,
        once: false,
        password: false,
        encrypt: false,
        manage: false,
        verbose: false,
        json: false,
        workers: WORKERS,
        endpoint: default_endpoint(),
        resume: None,
    };
    let mut files = Vec::new();
    let mut iter = args.into_iter();
    let mut options_done = false;
    while let Some(arg) = iter.next() {
        if options_done || !arg.starts_with('-') || arg == "-" {
            files.push(arg);
            continue;
        }
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name.to_string(), Some(value.to_string())),
            _ => (arg.clone(), None),
        };
        let mut value = |label: &str| inline.clone().or_else(|| iter.next()).unwrap_or_else(|| usage_error(&format!("{label} needs a value.")));
        // Switches take no value: `--once=false` must not create a one-time link.
        let switch = || inline.is_none() || usage_error(&format!("{name} takes no value."));
        match name.as_str() {
            "--" => options_done = true,
            "-h" | "--help" => { emit(HELP).unwrap_or_else(|e| unwritten(e)); process::exit(0) }
            "--version" => { emit(&format!("fyl {VERSION}\n")).unwrap_or_else(|e| unwritten(e)); process::exit(0) }
            "--expires" => upload.expires = Some(parse_lifetime(&value("--expires")).unwrap_or_else(|e| usage_error(&e))),
            "--once" => upload.once = switch(),
            "--password" => upload.password = switch(),
            "--encrypt" => upload.encrypt = switch(),
            "-m" | "--manage" => upload.manage = switch(),
            "-v" | "--verbose" => upload.verbose = switch(),
            "-q" | "--quiet" => upload.verbose = !switch(),
            "--json" => upload.json = switch(),
            "--workers" => {
                upload.workers = match value("--workers").parse() {
                    Ok(n @ 1..=8) => n,
                    _ => usage_error("--workers: choose a number from 1 to 8."),
                }
            }
            "-e" | "--endpoint" => upload.endpoint = value("--endpoint"),
            // `-` is read once the upload has its signal handling: at a terminal it is typed without echo.
            "--resume" => upload.resume = Some(value("--resume")),
            other => usage_error(&format!("unknown option {other}")),
        }
    }
    match files.len() {
        0 => { let _ = write!(io::stderr(), "{HINT}"); process::exit(2) }
        1 => upload.file = files.remove(0),
        _ => usage_error("upload one file or folder at a time. Put several files in a folder first."),
    }
    Command::Upload(upload)
}

// ---------------------------------------------------------------------------------------------
// HTTP

#[derive(Clone)]
struct Api {
    agent: ureq::Agent,
    /// Upload API base, e.g. https://fyl.at/api/upload
    base: String,
    /// Origin for other routes, e.g. https://fyl.at
    origin: String,
    /// The API runs on this machine (see loopback()), e.g. `wrangler dev` with its local R2 simulator.
    local: bool,
}

/// A reply's status, or 0 when none arrived intact: no connection, a body that broke off, or a success whose body
/// isn't a JSON object.
struct Reply {
    status: u16,
    body: Value,
    retry_after: Option<u64>,
}

#[derive(Debug, PartialEq)]
enum Class { Done, Retry, Permanent }

/// What a reply means for its request (the table in tests/vectors/errors.json, shared with the server and the
/// browser). An exhausted part keeps failing however often it is sent, whatever its status says, and so does a
/// password paused after wrong tries until its pause ends (docs/E2EE.md §12.3).
fn class(status: u16, code: Option<&str>) -> Class {
    match status {
        _ if matches!(code, Some("part_limit" | "password_paused")) => Class::Permanent,
        200..=299 => Class::Done,
        0 | 408 | 429 | 500..=599 => Class::Retry,
        _ => Class::Permanent,
    }
}

impl Reply {
    fn class(&self) -> Class {
        class(self.status, self.body["code"].as_str())
    }

    /// The body of a successful reply. A refusal fails, or interrupts when trying again later may help.
    fn accepted(self) -> Value {
        let class = self.class();
        if class == Class::Done { return self.body; }
        let detail = self.body.get("error").and_then(Value::as_str).map_or_else(|| "the service rejected the request.".to_string(), clean);
        let message = format!("Upload failed (HTTP {}): {detail}", self.status);
        if class == Class::Retry { interrupt(&message) } else { fail(&message) }
    }
}

/// `base` plus up to a fifth more, so clients that failed together don't come back together; at most 60 s.
fn jittered(base: Duration) -> Duration {
    let [low, high] = random_bytes::<2>();
    (base + base.mul_f64(f64::from(u16::from_le_bytes([low, high])) / f64::from(u16::MAX) / 5.0)).min(Duration::from_secs(60))
}

/// The host of a URL's authority, without its port or an IPv6 address's brackets.
fn host_of(authority: &str) -> Option<&str> {
    if authority.starts_with('[') { authority.split(']').next().map(|host| host.trim_start_matches('[')) } else { authority.split(':').next() }
}

/// This machine, by the names a local server is reached under.
fn loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

/// Splits an http(s) URL into (origin, rest). Only HTTPS is accepted, except plain HTTP on loopback.
fn split_url(url: &str) -> Option<(String, String)> {
    let (scheme, rest) = url.split_once("://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let local = loopback(host_of(authority)?);
    if authority.is_empty() || authority.contains('@') || !(scheme == "https" || (scheme == "http" && local)) {
        return None;
    }
    Some((format!("{scheme}://{authority}"), tail.to_string()))
}

impl Api {
    fn new(base: &str) -> Option<Api> {
        let (origin, path) = split_url(base)?;
        if path.contains(['?', '#']) {
            return None;
        }
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            // Requests, and the credentials they carry, go only to the configured origin (docs/E2EE.md §10).
            .max_redirects(0)
            // Per-phase limits instead of a global one, so slow but working uplinks can finish a 50 MiB part.
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_send_body(Some(Duration::from_secs(1800)))
            .timeout_recv_response(Some(Duration::from_secs(120)))
            .timeout_recv_body(Some(Duration::from_secs(120)))
            // One connection per request: a pooled connection the server already closed would fail the
            // next request (seen with HTTP/1.0 servers and idle timeouts). Requests are few and large.
            .max_idle_connections(0)
            .max_idle_connections_per_host(0)
            .user_agent(user_agent())
            .build()
            .into();
        let local = origin.split_once("://").and_then(|(_, authority)| host_of(authority)).is_some_and(loopback);
        Some(Api { agent, base: base.trim_end_matches('/').to_string(), origin, local })
    }

    fn upload(&self, route: &str) -> String {
        format!("{}{route}", self.base)
    }

    fn host(&self) -> &str {
        self.origin.split("://").nth(1).unwrap_or(&self.origin)
    }

    /// Whether a part's ETag proves the server stored the bytes sent. Only R2's MD5 ETag can; a server elsewhere that
    /// sends anything else leaves the part unverified (sent again, then the upload stops, resumable).
    fn verifies(&self, check: Check) -> bool {
        match check {
            Check::Match => true,
            Check::Mismatch => false,
            // Local compatibility: the R2 simulator of `wrangler dev` sends ETags that are not an MD5. They count only
            // for an API on this machine, where no network lies between fyl and the server.
            Check::Unverifiable => self.local,
        }
    }

    /// One HTTP request. HTTP errors are replies too; anything that doesn't arrive intact has status 0.
    fn send_bytes(&self, method: &str, url: &str, body: Option<&[u8]>, is_json: bool, extra: &[(&str, String)]) -> Reply {
        let result = match method {
            "GET" | "DELETE" => {
                let mut request = if method == "GET" { self.agent.get(url) } else { self.agent.delete(url) };
                request = request.header("Accept", "application/json");
                for (name, value) in extra { request = request.header(*name, value); }
                request.call()
            }
            _ => {
                let mut request = if method == "PUT" { self.agent.put(url) } else { self.agent.post(url) };
                request = request.header("Accept", "application/json")
                    .header("Content-Type", if is_json { "application/json" } else { "application/octet-stream" });
                for (name, value) in extra { request = request.header(*name, value); }
                request.send(body.unwrap_or_default())
            }
        };
        let lost = Reply { status: 0, body: Value::Null, retry_after: None };
        let Ok(mut response) = result else { return lost };
        let status = response.status().as_u16();
        let retry_after = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse().ok());
        // A body that breaks off is a network failure, never an empty reply. Error bodies may be anything (a proxy's
        // HTML page), but a success always carries a JSON object.
        let Ok(text) = response.body_mut().read_to_string() else { return lost };
        let body = serde_json::from_str(&text).unwrap_or(Value::Null);
        if (200..300).contains(&status) && !body.is_object() { return lost; }
        Reply { status, body, retry_after }
    }

    /// Request with retries, after the server's Retry-After or a growing pause, for what may pass when tried again.
    /// Returns the last reply; network failures that persist interrupt.
    fn retried(&self, method: &str, url: &str, body: Option<&[u8]>, is_json: bool, extra: &[(&str, String)], quiet: bool) -> Reply {
        self.retrying(quiet, |_| false, || self.send_bytes(method, url, body, is_json, extra))
    }

    /// The retry loop of retried(); a reply that `settles` comes back at once, whatever its class.
    fn retrying(&self, quiet: bool, settles: impl Fn(&Reply) -> bool, send: impl Fn() -> Reply) -> Reply {
        let mut attempt = 1;
        loop {
            let reply = send();
            if reply.class() != Class::Retry || settles(&reply) { return reply; }
            if attempt == ATTEMPTS {
                if reply.status == 0 { interrupt(&format!("Could not reach {}. Check your connection and try again.", self.host())) }
                return reply;
            }
            let delay = jittered(reply.retry_after.map_or(Duration::from_secs(1 << attempt), |s| Duration::from_secs(s.clamp(1, 60))));
            let what = if reply.status == 0 { "Network error".to_string() } else { format!("HTTP {} from the server", reply.status) };
            if !quiet { note!("{what}, retrying in {:.0}s ({attempt}/{})", delay.as_secs_f64(), ATTEMPTS - 1); }
            thread::sleep(delay);
            attempt += 1;
        }
    }

    fn call(&self, method: &str, url: &str, body: Option<&[u8]>, is_json: bool, extra: &[(&str, String)], quiet: bool) -> Value {
        self.retried(method, url, body, is_json, extra, quiet).accepted()
    }
}

// ---------------------------------------------------------------------------------------------
// Upload

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).unwrap_or_else(|_| fail("The system random number generator is unavailable."));
    bytes
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (*b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

/// The resume token for a management key, as the server derives it: it continues, completes or cancels
/// the upload, but can't delete the file or change its expiry.
fn resume_token(key: &str) -> String {
    base64url(&Sha256::digest(format!("fyl-resume:{key}")))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn percent_encode(value: &str) -> String {
    value.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect()
}

fn lifetime_label(seconds: u64) -> String {
    for (unit, size) in [("day", 86_400), ("hour", 3600), ("minute", 60)] {
        if seconds.is_multiple_of(size) {
            let n = seconds / size;
            return format!("{n} {unit}{}", if n == 1 { "" } else { "s" });
        }
    }
    format!("{seconds} seconds")
}

/// UTC (year, month, day, hour, minute, second) from a Unix timestamp in milliseconds.
fn civil(ms: u64) -> (i64, i64, i64, u64, u64, u64) {
    let secs = ms / 1000;
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // Civil-from-days (Howard Hinnant), valid for the proleptic Gregorian calendar.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day, rem / 3600, rem % 3600 / 60, rem % 60)
}

/// "Oct 28 14:05 UTC" from a Unix timestamp in milliseconds.
fn utc_label(ms: u64) -> String {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (_, month, day, hour, minute, _) = civil(ms);
    format!("{} {day} {hour:02}:{minute:02} UTC", MONTHS[(month - 1) as usize])
}

/// RFC 3339 in UTC, e.g. "2026-10-28T14:05:00Z", from a Unix timestamp in milliseconds.
fn rfc3339(ms: u64) -> String {
    let (year, month, day, hour, minute, second) = civil(ms);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn fingerprint(meta: &Metadata) -> (u64, u64, u64, i64, i64) {
    (meta.dev(), meta.ino(), meta.len(), meta.mtime(), meta.mtime_nsec())
}

/// Ends the process as the signal would have, so a calling shell sees it too.
fn die(signal: i32) -> ! {
    let _ = signal_hook::low_level::emulate_default_handler(signal);
    process::exit(128 + signal)
}

/// A generated password, e.g. tide-lamp-moss-41.
fn passphrase() -> String {
    let [a, b, c, low, high] = random_bytes::<5>();
    format!("{}-{}-{}-{:02}", WORDS[a as usize], WORDS[b as usize], WORDS[c as usize], u16::from_le_bytes([low, high]) % 100)
}

/// The password for --password, and whether fyl generated it: FYL_PASSWORD, or typed twice on the terminal without
/// echo, where Enter alone generates one. Only a generated password is ever printed.
fn ask_password() -> (String, bool) {
    // NFC never adds or removes a control character, so this check agrees with the server's.
    let check = |password: String| {
        if password.chars().any(char::is_control) { stop(PASSWORD_RULE) }
        password
    };
    let no_terminal = || -> ! { stop("--password needs a terminal to ask on, or FYL_PASSWORD.") };
    match std::env::var("FYL_PASSWORD") {
        Ok(password) => return (check(password), false),
        Err(std::env::VarError::NotUnicode(_)) => stop("FYL_PASSWORD must be UTF-8 text."),
        Err(_) if !io::stdin().is_terminal() => no_terminal(),
        Err(_) => {}
    }
    // rpassword asks on /dev/tty and restores it before returning. Ctrl+C there is a key; Ctrl+D cancels too.
    let ask = |prompt: &str| prompt_hidden(prompt).unwrap_or_else(|error| match error.kind() {
        io::ErrorKind::Interrupted | io::ErrorKind::UnexpectedEof => die(signal_hook::consts::SIGINT),
        _ => no_terminal(),
    });
    let typed = Some(ask("Password (press Enter to generate one): ")).filter(|typed| !typed.is_empty()).map(check);
    if typed.as_ref().is_some_and(|typed| ask("Repeat password: ") != *typed) { stop("The passwords don’t match.") }
    if let Some(typed) = typed { return (typed, false); }
    let generated = passphrase();
    // Unlike progress notes, the password must be seen: a file protected by a password nobody knows is lost, so a
    // full or closed stderr stops here, before anything is sent (--json would print it only at the end).
    let mut stderr = io::stderr();
    if writeln!(stderr, "Password: {generated}").and_then(|()| stderr.flush()).is_err() { process::exit(OUTPUT_FAILED) }
    (generated, true)
}

/// What the parts of an upload are made of: the file as it is, or its encryption (docs/E2EE.md §7).
enum Payload {
    Raw,
    Sealed(Box<Sealed>),
}

impl Payload {
    /// The size the server stores: the file's, or C(P) of its ciphertext (§6).
    fn stored(&self, size: u64) -> u64 {
        match self { Payload::Raw => size, Payload::Sealed(_) => e2ee::ciphertext_size(size) }
    }

    fn sealed(&self) -> Option<&Sealed> {
        match self { Payload::Raw => None, Payload::Sealed(sealed) => Some(sealed) }
    }
}

/// An encrypted upload: the identity behind KEY, the content age file bound to the file's size, the name in its
/// metadata, the last field of the resume value (a file's MTIME, §8.4, or a folder's F, docs/FOLDER-ZIP.md §9), and
/// the MD5 known for each part (by index) for the pre-send check (§8.2).
struct Sealed {
    identity: e2ee::Identity,
    content: e2ee::AgeFile,
    name: String,
    stamp: String,
    pins: Mutex<HashMap<usize, String>>,
}

impl Sealed {
    /// §8.2, immediately before a part request: the MD5 of the exact buffer must equal every MD5 known for its part
    /// (its pin, acknowledged or listed in the status, and earlier attempts of this run), or nothing is sent.
    fn check(&self, index: usize, md5: &str) {
        let mut pins = self.pins.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let differs = pins.entry(index).or_insert_with(|| md5.to_string()).as_str() != md5;
        if differs {
            drop(pins);
            changed()
        }
    }
}

/// What the system random number generator gave, or a stop before anything is sent.
fn random<T>(result: io::Result<T>) -> T {
    result.unwrap_or_else(|_| fail("The system random number generator is unavailable."))
}

/// The file's modification time in whole milliseconds since the epoch: MTIME of the resume value (§8.4).
fn mtime_ms(meta: &Metadata) -> i64 {
    meta.mtime().saturating_mul(1000).saturating_add(meta.mtime_nsec() / 1_000_000)
}

/// A new encrypted upload (§7 step 1): a fresh identity, the content head bound to the file's size, the metadata
/// blob (returned too) for the normalised name, and the recipient's key check on both, so a fault costs no upload.
fn seal(name: &str, size: u64, stamp: String) -> (Sealed, Vec<u8>) {
    let identity = random(e2ee::Identity::generate());
    let content = random(e2ee::AgeFile::create(&identity, size));
    let name = e2ee::normalize_name(name);
    let meta = random(e2ee::new_meta(&identity, &name, size, content.head()));
    if e2ee::key_check(&identity, content.head(), &meta, e2ee::ciphertext_size(size)).is_err() {
        fail("The encryption self-check failed. Nothing was uploaded.");
    }
    (Sealed { identity, content, name, stamp, pins: Mutex::new(HashMap::new()) }, meta)
}

const SEALED_CHANGED: &str = "The file changed during upload. An encrypted upload continues only with the unchanged file (same \
                              content and modification time); otherwise start a new upload.";

/// What an upload sends: a file as it is, or a folder as one zip built as its parts go out (docs/FOLDER-ZIP.md).
enum Source {
    /// The file, its path, and its metadata when this run started.
    File(File, PathBuf, Metadata),
    Folder(Box<folder::Folder>),
}

impl Source {
    fn size(&self) -> u64 {
        match self { Source::File(_, _, start) => start.len(), Source::Folder(folder) => folder.layout.size }
    }

    /// Bytes [offset, offset + buf.len()) of what is uploaded.
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<()> {
        match self { Source::File(file, ..) => file.read_exact_at(buf, offset), Source::Folder(folder) => folder.read_at(buf, offset) }
    }

    /// Whether a file still has the size and modification time this run started with. A folder's files are compared
    /// as they are read (docs/FOLDER-ZIP.md §7.2).
    fn unchanged(&self) -> bool {
        match self { Source::File(_, path, start) => fs::metadata(path).is_ok_and(|now| fingerprint(&now) == fingerprint(start)), Source::Folder(_) => true }
    }

    fn unreadable(&self, index: usize) -> ! {
        interrupt(&match self {
            Source::File(..) => format!("Could not read part {} of the file (did it change during upload?).", index + 1),
            Source::Folder(_) => format!("Could not read part {} of the folder (did a file change during upload?).", index + 1),
        })
    }
}

/// Part `index` (0-based) of an encrypted upload in one buffer, built from the source (§7 step 4) while a file still
/// has the size and modification time this run started with (step 6: an early warning; §8.2 is the guarantee).
fn build_sealed(sealed: &Sealed, source: &Source, index: usize) -> Vec<u8> {
    if !source.unchanged() { interrupt(SEALED_CHANGED) }
    sealed.content.encrypt_part(PART_BYTES, index as u64 + 1, |offset, buf| source.read_at(buf, offset)).unwrap_or_else(|_| source.unreadable(index))
}

/// Part `index` (0-based) of a raw upload, read right before it is sent: memory stays bounded at workers x 50 MiB.
fn read_part(source: &Source, index: usize, size: u64) -> Vec<u8> {
    let offset = index as u64 * PART_BYTES;
    let mut chunk = vec![0u8; PART_BYTES.min(size - offset) as usize];
    if source.read_at(&mut chunk, offset).is_err() { source.unreadable(index) }
    chunk
}

/// A --resume value: `ID.TOKEN` for a raw upload; `ID.TOKEN.KEY.MTIME` for an encrypted one, or `ID.TOKEN.MTIME`
/// with the key given apart (docs/E2EE.md §8.4). TOKEN is the resume token or the management key. A folder's value
/// ends in its fingerprint F in place of MTIME, also raw: `ID.TOKEN.F` (docs/FOLDER-ZIP.md §9).
struct ResumeValue {
    id: String,
    credential: String,
    key: Option<e2ee::Identity>,
    mtime: Option<i64>,
    folder: Option<String>,
}

fn token_ok(text: &str, lengths: RangeInclusive<usize>) -> bool {
    lengths.contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn parse_resume(value: &str, folder: bool) -> Option<ResumeValue> {
    let fields: Vec<&str> = value.split('.').collect();
    let (id, credential, key, last) = match fields[..] {
        [id, credential] if !folder => (id, credential, None, None),
        [id, credential, last] => (id, credential, None, Some(last)),
        [id, credential, key, last] => (id, credential, Some(key), Some(last)),
        _ => return None,
    };
    if !token_ok(id, 43..=64) || !token_ok(credential, 43..=43) { return None; }
    let key = match key { Some(key) => Some(e2ee::Identity::from_key(key).ok()?), None => None };
    let mtime = match last {
        Some(text) if !folder => {
            let digits = text.strip_prefix('-').unwrap_or(text);
            if digits.is_empty() || digits.len() > 18 || !digits.bytes().all(|b| b.is_ascii_digit()) { return None; }
            Some(text.parse().ok()?)
        }
        _ => None,
    };
    let folder = match last {
        Some(text) if folder => {
            if !token_ok(text, 22..=22) { return None; }
            Some(text.to_string())
        }
        _ => None,
    };
    Some(ResumeValue { id: id.to_string(), credential: credential.to_string(), key, mtime, folder })
}

/// §8.4 steps 1-2 for an encrypted upload: the status carries head, meta and pins; the key (from the value, FYL_KEY or
/// typed) passes the key check on them; the file has the upload's sizes and, while the upload runs, the value's
/// MTIME (`now`, the file's; None for a folder, whose F was compared before). Every refusal exits 2 and leaves the
/// upload as it is.
fn resume_sealed(api: &Api, state: &Value, value: ResumeValue, size: u64, now: Option<i64>, name: &str, uploading: bool) -> Sealed {
    let blob = |field: &str| state["e2ee"][field].as_str().and_then(e2ee::b64url_decode);
    let (Some(head), Some(blob), Some(listed)) = (blob("head"), blob("meta"), state["pins"].as_array()) else {
        refuse("This server can't resume an encrypted upload safely (its status lists no pins). Start a new upload.")
    };
    let hex_md5 = |md5: &str| md5.len() == 32 && md5.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let mut pins = HashMap::new();
    for pin in listed {
        match (pin["partNumber"].as_u64(), pin["md5"].as_str()) {
            (Some(number @ 1..), Some(md5)) if hex_md5(md5) => { pins.insert(number as usize - 1, md5.to_string()); }
            _ => refuse("The server sent a damaged list of pinned parts, so this upload can't be resumed safely. Start a new upload."),
        }
    }
    let stored = state["size"].as_u64().unwrap_or(0);
    let id = value.id.clone();
    let parse = |text: &str| e2ee::parse_entry(text, &api.origin, &id);
    let missing = "This resume value has no key. Type the key or the share link at a terminal, or set FYL_KEY.";
    let mut tries = 0;
    let (mut identity, typed) = match value.key {
        Some(key) => (key, false),
        None => match download::env_key(&parse, &api.origin) {
            Some(key) => (key, false),
            None => (download::typed_key(&parse, &api.origin, &mut tries, missing), true),
        },
    };
    let checked = loop {
        match e2ee::key_check(&identity, &head, &blob, stored) {
            Ok(checked) => break checked,
            Err(e2ee::Error::KeyWrong) if typed && tries < download::KEY_TRIES => {
                note!("fyl: This key doesn't open this upload.");
                identity = download::typed_key(&parse, &api.origin, &mut tries, missing);
            }
            Err(e2ee::Error::KeyWrong) => refuse("This key doesn't open this upload. Use the value its interrupted run printed."),
            Err(error) => refuse(&format!("This upload can't be resumed: {error}")),
        }
    };
    if size != checked.size || e2ee::ciphertext_size(size) != stored {
        refuse(if now.is_none() { folder::RESUME_CHANGED } else { "This file does not match the interrupted upload (its size differs)." });
    }
    let stamp = match value.folder {
        Some(print) => print,
        None => {
            let mtime = value.mtime.unwrap_or_else(|| refuse("This resume value has no modification time."));
            if uploading && now != Some(mtime) {
                refuse("The file changed since this upload started (its modification time differs). Start a new upload.");
            }
            mtime.to_string()
        }
    };
    if e2ee::normalize_name(name) != checked.name {
        note!("fyl: Resuming the encrypted upload of '{0}' with '{name}'; recipients see the name '{0}'.", checked.name);
    }
    Sealed { identity, content: checked.content, name: checked.name, stamp, pins: Mutex::new(pins) }
}

/// §8.4 step 3: every pinned or confirmed part, rebuilt from the file as it is now, must have its pin's MD5 (a
/// confirmed part without a pin, its ETag's, if that is an MD5), or the resume is refused. Confirmed parts that pass
/// are kept: their ETags come back by index. Runs on up to `workers` threads.
fn verify_sealed(api: &Api, sealed: &Sealed, source: &Source, state: &Value, workers: usize) -> Vec<Option<String>> {
    let total = e2ee::parts(e2ee::ciphertext_size(sealed.content.size()), PART_BYTES) as usize;
    let confirmed: HashMap<usize, String> = state["parts"].as_array().into_iter().flatten()
        .filter_map(|part| Some((part["partNumber"].as_u64()?.checked_sub(1)? as usize, part["etag"].as_str()?.to_string())))
        .collect();
    let pins = sealed.pins.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
    let mut indices: Vec<usize> = pins.keys().chain(confirmed.keys()).copied().filter(|index| *index < total).collect();
    indices.sort_unstable();
    indices.dedup();
    let etags = Mutex::new(vec![None; total]);
    let next = AtomicUsize::new(0);
    thread::scope(|scope| {
        for _ in 0..workers.min(indices.len()) {
            scope.spawn(|| while let Some(&index) = indices.get(next.fetch_add(1, Ordering::SeqCst)) {
                let md5 = hex(&Md5::digest(build_sealed(sealed, source, index)));
                let etag = confirmed.get(&index);
                let from_etag = || etag.map(|etag| etag.trim_matches('"').to_ascii_lowercase()).filter(|etag| check_etag(etag, &md5) != Check::Unverifiable);
                match pins.get(&index).cloned().or_else(from_etag) {
                    None => refuse(&format!("Part {} was sent without a checksum fyl can compare, so this upload can't be resumed safely. \
                                             Start a new upload.", index + 1)),
                    Some(expected) if expected != md5 => refuse(CHANGED),
                    Some(_) => {}
                }
                if let Some(etag) = etag.filter(|etag| api.verifies(check_etag(etag, &md5))) {
                    etags.lock().unwrap_or_else(|poisoned| poisoned.into_inner())[index] = Some(etag.clone());
                }
            });
        }
    });
    etags.into_inner().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What every part request of an upload needs.
struct Run {
    api: Api,
    id: String,
    key: String,
    quiet: bool,
    total: usize,
}

impl Run {
    fn token(&self) -> (&'static str, String) {
        ("Authorization", format!("Bearer {}", self.key))
    }

    fn part_url(&self, number: usize) -> String {
        self.api.upload(&format!("/part?uploadId={}&partNumber={number}", percent_encode(&self.id)))
    }

    /// The stop after a part went out twice without proof that the server stored it intact: resumable.
    fn unproven(&self, number: usize, check: Check) -> ! {
        interrupt(&if check == Check::Unverifiable {
            format!("Part {number} could not be verified: {} sent a checksum that is not an MD5. Run the command below to try again.", self.api.host())
        } else {
            format!("Part {number} arrived corrupted twice. Check your connection, then run the command below.")
        })
    }
}

/// Sends a raw part, verified by the ETag the server returns (R2's MD5 of the bytes it stored); a damaged part goes
/// out once more, then the upload stops, resumable. Returns the ETag.
fn send_raw(run: &Run, index: usize, chunk: &[u8]) -> String {
    let expected = hex(&Md5::digest(chunk));
    let number = index + 1;
    let url = run.part_url(number);
    let mut check = Check::Mismatch;
    for attempt in 1..=2 {
        let reply = run.api.call("PUT", &url, Some(chunk), false, &[run.token()], run.quiet);
        let Some(etag) = reply["etag"].as_str() else { fail(&format!("The server did not confirm part {number}.")) };
        // The Worker returns R2's ETag for the part: the MD5 of the bytes R2 stored.
        check = check_etag(etag, &expected);
        if run.api.verifies(check) { return etag.to_string(); }
        if !run.quiet && attempt == 1 {
            let why = if check == Check::Unverifiable { "Checksum can't be verified" } else { "Checksum mismatch" };
            note!("[{number}/{}] {why}, sending the part again", run.total);
        }
    }
    run.unproven(number, check)
}

/// Sends an encrypted part (§7 step 4, §8): the buffer passes the pre-send check, its MD5 is pinned, and the very same
/// buffer goes out with `Content-MD5` on every attempt. A part the server stored damaged (502 part_corrupt, or an
/// ETag other than the MD5) goes out once more, then the upload stops, resumable; part_changed cancels the upload.
/// Returns the ETag.
fn send_sealed(run: &Run, sealed: &Sealed, index: usize, buffer: &[u8]) -> String {
    let number = index + 1;
    let (md5, content_md5) = e2ee::md5_pin(buffer);
    let changed_there = |reply: &Reply| reply.body["code"] == "part_changed";
    sealed.check(index, &md5);
    let pin = json!({"uploadId": run.id, "partNumber": number, "md5": md5}).to_string();
    let reply = run.api.retried("POST", &run.api.upload("/pin"), Some(pin.as_bytes()), true, &[run.token()], run.quiet);
    if changed_there(&reply) { fail(CHANGED) }
    reply.accepted();
    let url = run.part_url(number);
    let headers = [run.token(), ("Content-MD5", content_md5)];
    let mut check = Check::Mismatch;
    for attempt in 1..=2 {
        // Before every attempt; within retrying() neither the buffer nor the MD5s known for its part can change.
        sealed.check(index, &md5);
        let reply = run.api.retrying(run.quiet, |reply| reply.body["code"] == "part_corrupt",
                                     || run.api.send_bytes("PUT", &url, Some(buffer), false, &headers));
        if changed_there(&reply) { fail(CHANGED) }
        if reply.body["code"] != "part_corrupt" {
            let body = reply.accepted();
            let Some(etag) = body["etag"].as_str() else { fail(&format!("The server did not confirm part {number}.")) };
            check = check_etag(etag, &md5);
            if run.api.verifies(check) { return etag.to_string(); }
        }
        if !run.quiet && attempt == 1 { note!("[{number}/{}] Checksum mismatch, sending the part again", run.total); }
    }
    run.unproven(number, check)
}

/// Ctrl+C or termination: keep an upload that exists so it can be resumed, and say how; until then stop as usual.
fn pause_upload(signal: i32) -> ! {
    if RESUME.lock().is_ok_and(|resume| resume.is_some()) { interrupt("Upload paused.") }
    die(signal)
}

/// A receipt whose link isn't `<origin>/d/<ID>` (docs/E2EE.md §2.2): the key goes on no link at all. The upload is
/// complete, so nothing is cancelled, and no resume command is printed: it would only get the same receipt.
fn foreign_link(api: &Api) -> ! {
    let _exiting = EXITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    note!("fyl: The server sent a link to another address than {}, so fyl shows no link.", api.origin);
    process::exit(1)
}

/// Links from a receipt that fyl won't print, so server text can't drive the terminal: one with anything but printable ASCII (a terminal escape, a line
/// break, a space) or that isn't https (http only on loopback), or a management link `fyl rm` wouldn't take. The upload is complete, so nothing is cancelled.
fn unprintable_link() -> ! {
    let _exiting = EXITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    note!("fyl: The server sent a link that isn't a plain https link, so fyl shows none.");
    process::exit(1)
}

/// A link fyl prints as the server sent it: http(s) as for the endpoint (HTTPS, or HTTP on loopback; no credentials),
/// printable ASCII only, so it can't drive the terminal.
fn printable_link(url: &str) -> bool {
    split_url(url).is_some() && url.bytes().all(|b| b.is_ascii_graphic())
}

/// A folder for `fyl FOLDER` (docs/FOLDER-ZIP.md §2): walked, what it leaves out said on stderr, and refused as a
/// whole where §2.6 says so (exit 2), before anything is read or sent.
fn open_folder(options: &Upload, limit: u64) -> folder::Folder {
    let found = folder::collect(Path::new(&options.file))
        .unwrap_or_else(|(path, error)| stop(&format!("Can't read '{}': {error}.", folder::escaped(path.as_os_str().as_bytes()))));
    if let Some(said) = folder::skipped_note(&found.skipped) { note!("fyl: {said}"); }
    if options.verbose {
        for item in &found.skipped { note!("  skipped ({}): {}", item.reason.code(), folder::escaped(&item.raw)); }
    }
    folder::Folder::new(found, limit).unwrap_or_else(|refusal| stop(&refusal.message()))
}

/// docs/FOLDER-ZIP.md §7.1: every file read once for its CRC-32 before any part is built, counted on a terminal
/// ("Preparing folder… 120/4031 files"). A file that changes or can't be read meanwhile stops the run (exit 2).
fn prepare(zip: &mut folder::Folder, verbose: bool) {
    let (total, live) = (zip.entries.len(), io::stderr().is_terminal());
    let mut shown: Option<std::time::Instant> = None;
    let result = zip.prepare(|done| {
        if live && (done == total || shown.is_none_or(|at| at.elapsed() >= Duration::from_millis(200))) {
            shown = Some(std::time::Instant::now());
            let _ = write!(io::stderr(), "\rPreparing folder… {done}/{total} files");
        }
    });
    // The progress line goes once the files are read: quiet runs end with only what they have to say.
    if live { let _ = write!(io::stderr(), "\r\x1b[K"); }
    match result {
        Ok(()) if verbose => note!("Prepared folder: {total} files"),
        Ok(()) => {}
        Err(folder::Prep::Changed(path)) => stop(&format!("A file changed while the folder was read: {path}.")),
        Err(folder::Prep::Unreadable(path, error)) => stop(&format!("Can't read '{path}': {error}.")),
    }
}

fn upload(options: Upload) {
    let path = Path::new(&options.file);
    let meta = fs::metadata(path).unwrap_or_else(|_| stop(&format!("Can't find '{}'. Check the path and try again.", options.file)));
    // Encryption adds 16 bytes per 64 KiB, and the limit counts what the server stores (§6).
    let sealed_max = e2ee::max_plaintext(MAX_BYTES).unwrap_or(0);
    let mut source = if meta.is_dir() {
        Source::Folder(Box::new(open_folder(&options, if options.encrypt { sealed_max } else { MAX_BYTES })))
    } else {
        if !meta.is_file() { stop(&format!("'{}' is not a regular file.", options.file)); }
        if meta.len() == 0 { stop(&format!("'{}' is empty. Choose a file with something in it.", options.file)); }
        if meta.len() > MAX_BYTES { stop(&format!("'{}' is larger than 50 GB, the most fyl.at accepts. Split or compress it first.", options.file)); }
        if options.encrypt && options.resume.is_none() && meta.len() > sealed_max {
            stop(&format!("'{}' is too large to encrypt: encrypted uploads take up to {sealed_max} bytes, about 12.5 MB less than 50 GB. \
                           Split or compress it first.", options.file));
        }
        let file = File::open(path).unwrap_or_else(|_| stop(&format!("Can't read '{}'. Check its permissions.", options.file)));
        Source::File(file, path.to_path_buf(), meta)
    };
    let api = Api::new(&options.endpoint).unwrap_or_else(|| stop("Use an HTTPS API URL without credentials or query parameters."));
    if options.password && options.resume.is_some() { stop("A resumed upload keeps its password setting. Leave out --password, or start a new upload.") }

    on_signal(pause_upload);
    // Asked before anything is sent.
    let resume = options.resume.clone().map(|value| secret(value, "Resume value"));
    let password = options.password.then(ask_password);

    let size = source.size();
    // A folder goes as `<root>.zip`, and its resume value ends in its fingerprint (docs/FOLDER-ZIP.md §9).
    let (name, print) = match &source {
        Source::Folder(zip) => (zip.name.clone(), Some(zip.fingerprint())),
        Source::File(..) => (path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| options.file.clone()), None),
    };
    let quiet = !options.verbose;
    let token = |key: &str| ("Authorization", format!("Bearer {key}"));
    let md5_of = |chunk: &[u8]| hex(&Md5::digest(chunk));

    // A new upload, or one continued from a --resume value. `key` is the management key of a new upload, or the
    // credential given to --resume: the key or its resume token, which `owner` tells apart.
    let (id, key, owner, expires, once, payload, etags) = if let Some(resume) = &resume {
        let value = parse_resume(resume, print.is_some()).unwrap_or_else(|| stop("That resume value is not valid. Copy it from the message of the interrupted upload."));
        // A folder that no longer gives the same zip is refused before anything is read.
        if print.is_some() && value.folder != print { stop(folder::RESUME_CHANGED) }
        let reply = api.retried("GET", &api.upload(&format!("/status?uploadId={}", percent_encode(&value.id))), None, true, &[token(&value.credential)], quiet);
        // Expired, cancelled or deleted (404 once the server drops its record after 7 days), or mistyped.
        let open = matches!(reply.body["status"].as_str(), Some("uploading" | "completing" | "ready"));
        if matches!(reply.status, 403 | 404) || (reply.status == 200 && !open) {
            fail("This resume command no longer works (the upload expired, was cancelled or deleted, or the token is mistyped). Start a new upload.");
        }
        let state = reply.accepted();
        // Finished parts of an unfinished upload count only if they still match the local file (see below). A finished
        // upload ('completing' or 'ready') replays its completion as it is.
        let uploading = state["status"] == "uploading";
        let encrypted = match state["mode"].as_str() {
            None | Some("raw") => false,
            Some("e2ee") => true,
            Some(_) => stop("This upload needs a newer fyl."),
        };
        if !encrypted && (options.encrypt || value.key.is_some() || value.mtime.is_some()) {
            stop("This upload isn't encrypted. Leave out --encrypt and use the value its interrupted run printed, or start a new upload.");
        }
        if encrypted && value.mtime.is_none() && value.folder.is_none() {
            stop("This upload is encrypted. Use the value its interrupted run printed, which ends in the key and the file's modification time.");
        }
        let (id, credential) = (value.id.clone(), value.credential.clone());
        let now = match &source { Source::File(_, _, meta) => Some(mtime_ms(meta)), Source::Folder(_) => None };
        let payload = if encrypted { Payload::Sealed(Box::new(resume_sealed(&api, &state, value, size, now, &name, uploading))) } else { Payload::Raw };
        if state["size"].as_u64() != Some(payload.stored(size)) {
            stop(if print.is_some() { folder::RESUME_CHANGED } else { "This file does not match the interrupted upload (its size differs)." });
        }
        let (expires, once) = (state["expiresIn"].as_u64().unwrap_or(86_400), state["once"].as_bool().unwrap_or(false));
        if options.expires.is_some_and(|e| e != expires) || (options.once && !once) {
            stop(&format!("A resumed upload keeps its lifetime and download mode ({}, {}). Leave out --expires and --once, or start a new upload.",
                lifetime_label(expires), if once { "one download" } else { "unlimited downloads" }));
        }
        if let Some(original) = state["name"].as_str().filter(|original| !encrypted && *original != name).map(clean) {
            note!("fyl: Resuming the upload of '{original}' with '{name}'; the link keeps the name '{original}'.");
        }
        // Every part a folder's run builds needs the CRCs, confirmed parts rebuilt for their check too.
        if let Source::Folder(zip) = &mut source {
            if uploading { prepare(zip, options.verbose) }
        }
        let total = payload.stored(size).div_ceil(PART_BYTES) as usize;
        let etags = match payload.sealed() {
            Some(sealed) if uploading => verify_sealed(&api, sealed, &source, &state, options.workers),
            _ => {
                // R2's ETag for a part is its MD5, and one that can't be checked is sent again, except for an API on
                // this machine (see Api::verifies).
                let mut etags = vec![None; total];
                for part in state["parts"].as_array().into_iter().flatten() {
                    let (Some(number @ 1..), Some(etag)) = (part["partNumber"].as_u64(), part["etag"].as_str()) else { continue };
                    let index = number as usize - 1;
                    if index < total && (!uploading || api.verifies(check_etag(etag, &md5_of(&read_part(&source, index, size))))) {
                        etags[index] = Some(etag.to_string());
                    }
                }
                etags
            }
        };
        if !quiet { note!("Resuming: {} of {total} parts already uploaded", etags.iter().filter(|e| e.is_some()).count()); }
        (id, credential, state["access"] == "owner", expires, once, payload, etags)
    } else {
        if let Source::Folder(zip) = &mut source { prepare(zip, options.verbose) }
        let client_key = base64url(&random_bytes::<32>());
        let expires = options.expires.unwrap_or(86_400);
        let stamp = match &source { Source::File(_, _, meta) => mtime_ms(meta).to_string(), Source::Folder(_) => print.clone().unwrap_or_default() };
        let fresh = options.encrypt.then(|| seal(&name, size, stamp));
        // §12.1: no file name reaches the server for an encrypted upload, only the head and the metadata blob.
        let mut init = match &fresh {
            Some((sealed, blob)) => json!({
                "mode": "e2ee", "size": e2ee::ciphertext_size(size), "e2ee": {"head": e2ee::b64url(sealed.content.head()), "meta": e2ee::b64url(blob)},
                "expiresIn": expires, "oneTime": options.once, "partSize": PART_BYTES, "clientKey": client_key,
            }),
            None => json!({
                "filename": name, "size": size, "expiresIn": expires, "oneTime": options.once,
                "partSize": PART_BYTES, "clientKey": client_key,
            }),
        };
        if let Some((password, _)) = &password { init["password"] = json!(password); }
        let init = init.to_string();
        let reply = api.retried("POST", &api.upload("/init"), Some(init.as_bytes()), true, &[("Idempotency-Key", hex(&random_bytes::<16>()))], quiet);
        if reply.body["code"] == "e2ee_disabled" { fail("This server doesn't accept encrypted uploads. Nothing was uploaded.") }
        let session = reply.accepted();
        let (Some(id), Some(key)) = (session["uploadId"].as_str(), session["key"].as_str()) else {
            fail("The server sent an invalid response to the upload request.");
        };
        *ACTIVE.lock().unwrap() = Some((api.clone(), id.to_string(), key.to_string()));
        // A server that ignores the password sends no link at init: never upload without the one asked for.
        if password.is_some() && session["url"].is_null() { fail("This server doesn't support download passwords. Nothing was uploaded."); }
        let payload = match fresh {
            None => Payload::Raw,
            Some((sealed, _)) => {
                // §7 steps 2-3, before any part: a server that ignored `mode` would store the parts as a raw file, and
                // the key goes only on a link to this origin.
                if session["mode"] != "e2ee" { fail("This server doesn't support encrypted uploads. Nothing was uploaded.") }
                if e2ee::share_link(&api.origin, id, session["url"].as_str().unwrap_or_default(), &sealed.identity).is_err() {
                    fail(&format!("The server sent a link to another address than {}, so fyl shows none. Nothing was uploaded.", api.origin));
                }
                Payload::Sealed(Box::new(sealed))
            }
        };
        let total = payload.stored(size).div_ceil(PART_BYTES) as usize;
        (id.to_string(), key.to_string(), true, expires, options.once, payload, vec![None; total])
    };
    *ACTIVE.lock().unwrap() = Some((api.clone(), id.clone(), key.clone()));
    let total = etags.len();
    if !quiet {
        let how = if payload.sealed().is_some() { ", encrypted" } else { "" };
        let from = match &source { Source::Folder(zip) => format!(" from {} files", zip.entries.len()), Source::File(..) => String::new() };
        note!("Uploading: {name} ({:.2} MB in {total} parts{how}){from}", size as f64 / 1_048_576.0);
    }
    // The resume command carries the resume token, which can't delete the file, or with --manage the key. A
    // run resumed with the token has no key to print, and its completion gets no management link.
    let manage = options.manage && owner;
    if options.manage && !owner { note!("fyl: The management link isn't available for this resume token."); }
    let credential = if owner && !manage { resume_token(&key) } else { key.clone() };
    let note = if manage { "it can also delete the upload" } else { "it can cancel the upload, but not delete the file" };
    // The command keeps this run's options, except --expires and --once: the upload keeps its own. Quoting protects
    // the file name from the shell, and ./ from fyl itself, which reads -notes.txt as an option and rm, download and
    // decrypt as its commands.
    let shown = if options.file.starts_with('-') || matches!(options.file.as_str(), "rm" | "delete" | "download" | "decrypt" | "update") {
        format!("./{}", options.file)
    } else {
        options.file.clone()
    };
    let mut flags = String::new();
    if manage { flags += " --manage"; }
    if options.json { flags += " --json"; }
    if options.verbose { flags += " --verbose"; }
    if options.workers != WORKERS { flags += &format!(" --workers {}", options.workers); }
    if options.endpoint != DEFAULT_API { flags += &format!(" --endpoint {}", shell_quote(&options.endpoint)); }
    let folder_print = print.as_ref().map_or(String::new(), |print| format!(".{print}"));
    *RESUME.lock().unwrap() = Some(match payload.sealed() {
        // echo is a shell builtin, so the credential never shows in the process list.
        None => format!("Resume within 24 hours with the command below. Keep it private: {note}.\n  echo {id}.{credential}{folder_print} | fyl {} --resume -{flags}",
                        shell_quote(&shown)),
        // The value holds the key: pasted at the prompt, it stays out of the shell history too (§8.4).
        Some(sealed) => format!("Resume within 24 hours: run the command below and paste the line under it when asked. Keep that line private: it holds \
                                 the file's key, and {note}.\n  fyl {} --resume - --encrypt{flags}\n  {id}.{credential}.{}.{}",
                                shell_quote(&shown), sealed.identity.key(), sealed.stamp),
    });

    let pending: Vec<usize> = (0..total).filter(|index| etags[*index].is_none()).collect();
    let run = Arc::new(Run { api: api.clone(), id: id.clone(), key: key.clone(), quiet, total });
    let (source, payload) = (Arc::new(source), Arc::new(payload));
    let next = Arc::new(AtomicUsize::new(0));
    let pending = Arc::new(pending);
    let etags = Arc::new(Mutex::new(etags));
    let workers: Vec<_> = (0..options.workers.min(pending.len().max(1))).map(|_| {
        let (source, payload, next, pending, etags, run) = (source.clone(), payload.clone(), next.clone(), pending.clone(), etags.clone(), run.clone());
        thread::spawn(move || loop {
            let slot = next.fetch_add(1, Ordering::SeqCst);
            let Some(&index) = pending.get(slot) else { break };
            // Each part is read (and encrypted) right before it is sent, once: retries resend the same buffer.
            let etag = match payload.sealed() {
                None => send_raw(&run, index, &read_part(&source, index, size)),
                Some(sealed) => send_sealed(&run, sealed, index, &build_sealed(sealed, &source, index)),
            };
            etags.lock().unwrap()[index] = Some(etag);
            if !run.quiet { note!("[{}/{}] Part uploaded and verified", index + 1, run.total); }
        })
    }).collect();
    // A worker only returns: a panic aborts the whole process (panic = "abort").
    for worker in workers { let _ = worker.join(); }

    // Resuming checks every finished part against the file again, so a change keeps the upload too. A folder's parts
    // must carry the CRCs of its pre-pass (docs/FOLDER-ZIP.md §7.3), or the upload doesn't complete.
    match &*source {
        Source::Folder(zip) if !zip.intact() => halt(folder::CHANGED),
        _ if source.unchanged() => {}
        _ if payload.sealed().is_some() => interrupt(SEALED_CHANGED),
        _ => interrupt("The file changed during upload. Once it is unchanged again, the command below sends only the parts that differ."),
    }
    let parts: Vec<Value> = etags.lock().unwrap().iter().enumerate()
        .map(|(i, etag)| json!({"partNumber": i + 1, "etag": etag}))
        .collect();
    if !quiet { note!("Finalizing the upload..."); }
    let complete = json!({"uploadId": id, "key": key, "parts": parts}).to_string();
    let sealed = payload.sealed();
    let stored = payload.stored(size);
    // An encrypted upload's receipt also says so, and carries no name (§7 step 5); its link is checked below.
    let valid = |body: &Value| receipt(body, &id, stored, manage) && (sealed.is_none() || (body["mode"] == "e2ee" && body["name"].is_null()));
    let completed = finish(&api, &complete, &id, &[token(&key)], valid, quiet);
    let url = completed["url"].as_str().unwrap_or_default();
    let link = match sealed {
        None => url.to_string(),
        Some(sealed) => e2ee::share_link(&api.origin, &id, url, &sealed.identity).unwrap_or_else(|_| foreign_link(&api)),
    };

    if !quiet {
        let expires = completed["expiresAt"].as_u64()
            .map(|ms| format!("in {} ({})", lifetime_label(expires), utc_label(ms)))
            .unwrap_or_else(|| format!("in {}", lifetime_label(expires)));
        note!("Ready. Expires {expires}. {}", if once { "One download only." } else { "Unlimited downloads until then." });
    }
    let management = completed["managementUrl"].as_str().filter(|_| manage);
    if !printable_link(&link) || management.is_some_and(|manage| !printable_link(manage) || management_parts(manage).is_none()) { unprintable_link() }
    let output = if options.json {
        // The server's name, without the control characters JSON leaves as they are (DEL, C1 such as CSI), so it can't drive the terminal.
        let shown_name = sealed.map_or_else(|| completed["name"].as_str().map_or_else(|| name.clone(), clean), |sealed| sealed.name.clone());
        let mut receipt = json!({
            "url": link, "name": shown_name, "size": if sealed.is_some() { size } else { completed["size"].as_u64().unwrap_or(size) },
            "expiresAt": completed["expiresAt"].as_u64().map(rfc3339), "once": completed["once"].as_bool().unwrap_or(once),
        });
        if let Some(manage) = management { receipt["managementUrl"] = json!(manage); }
        // A resumed upload has no password here, but the server says whether it has one.
        if completed["protected"].as_bool().unwrap_or(password.is_some()) { receipt["protected"] = json!(true); }
        if let Some((password, true)) = &password { receipt["password"] = json!(password); }
        if sealed.is_some() { receipt["encrypted"] = json!(true); }
        if let Source::Folder(zip) = &*source { receipt["folder"] = json!({"files": zip.entries.len(), "skipped": zip.skipped.len()}); }
        format!("{receipt}\n")
    } else {
        management.map_or(format!("{link}\n"), |manage| format!("{link}\n{manage}\n"))
    };
    // The recovery state stays until the link is out. When stdout is full or closed, stderr gets the links instead.
    if let Err(error) = emit(&output) {
        let _exiting = EXITING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        note!("{link}");
        if let Some(manage) = management { note!("{manage}"); }
        unwritten(error)
    }
    ACTIVE.lock().unwrap().take();
    RESUME.lock().unwrap().take();
}

/// Whether a completion's reply is this upload's receipt: its download link, its ID and size, an expiry, and the
/// management link when it was asked for (and the key completed the upload).
fn receipt(body: &Value, id: &str, size: u64, manage: bool) -> bool {
    body["url"].as_str().is_some_and(download_link) && body["transferId"].as_str() == Some(id) && body["expiresAt"].is_number()
        && body["size"].as_u64() == Some(size) && (!manage || body["managementUrl"].as_str().is_some())
}

/// ^https?://[^/]+/d/[A-Za-z0-9_-]{43,64}(/[^?#]*)?$
fn download_link(url: &str) -> bool {
    let Some((host, path)) = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")).and_then(|rest| rest.split_once('/')) else { return false };
    let Some(path) = path.strip_prefix("d/") else { return false };
    let (id, name) = path.split_once('/').map_or((path, None), |(id, name)| (id, Some(name)));
    !host.is_empty() && (43..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && name.is_none_or(|name| !name.contains(['?', '#']))
}

/// Completes the upload and returns its receipt. Completing is idempotent: a reply that breaks off or isn't this
/// upload's receipt is asked for again, and after that the upload's status says whether one more try can help.
/// Still unclear, fyl prints the resume command, which replays the completion, instead of losing the upload.
fn finish(api: &Api, body: &str, id: &str, auth: &[(&str, String)], valid: impl Fn(&Value) -> bool, quiet: bool) -> Value {
    let (mut busy, mut unclear) = (1, 0);
    loop {
        let reply = api.send_bytes("POST", &api.upload("/complete"), Some(body.as_bytes()), true, &[]);
        match reply.class() {
            Class::Done if valid(&reply.body) => return reply.body,
            // A refusal, or a busy server that stays busy, as for any other request.
            Class::Retry if reply.status != 0 && busy < ATTEMPTS => {
                let delay = jittered(reply.retry_after.map_or(Duration::from_secs(1 << busy), |s| Duration::from_secs(s.clamp(1, 60))));
                if !quiet { note!("HTTP {} from the server, retrying in {:.0}s ({busy}/{})", reply.status, delay.as_secs_f64(), ATTEMPTS - 1); }
                thread::sleep(delay);
                busy += 1;
            }
            Class::Permanent | Class::Retry if reply.status != 0 => return reply.accepted(),
            // No reply, or not this upload's receipt.
            _ if unclear < UNCLEAR_REPEATS => {
                unclear += 1;
                let delay = jittered(Duration::from_millis(500 << (unclear - 1)));
                if !quiet { note!("No clear answer to the completion, asking again in {:.0}s", delay.as_secs_f64()); }
                thread::sleep(delay);
            }
            _ if unclear == UNCLEAR_REPEATS => {
                unclear += 1;
                let status = api.retried("GET", &api.upload(&format!("/status?uploadId={}", percent_encode(id))), None, true, auth, quiet);
                if status.status != 200 || !matches!(status.body["status"].as_str(), Some("ready" | "completing")) {
                    interrupt("The upload did not complete. The command below completes it.")
                }
            }
            _ => interrupt("The upload may be complete, but its link didn't arrive intact. The command below gets it."),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Delete

fn invalid_link() -> ! {
    stop("That doesn't look like a management link. It looks like https://fyl.at/#manage/<id>/<key>.")
}

/// A management link's origin, transfer ID and key: `<origin>/#manage/<id>/<key>`, as `fyl rm` takes it.
fn management_parts(link: &str) -> Option<(String, &str, &str)> {
    let (origin, _) = split_url(link)?;
    let tail = &link[origin.len()..];
    let (id, key) = tail.strip_prefix('/').unwrap_or(tail).strip_prefix("#manage/")?.split_once('/')?;
    (token_ok(id, 43..=64) && token_ok(key, 43..=43)).then_some((origin, id, key))
}

/// Returns the API of the link's server, for the update notice.
fn remove(link: String) -> String {
    on_signal(die);
    let link = secret(link, "Management link");
    let (origin, id, key) = management_parts(link.trim()).unwrap_or_else(|| invalid_link());

    let api = Api::new(&format!("{origin}/api/upload")).unwrap_or_else(|| invalid_link());
    let url = format!("{origin}/api/transfers/{id}");
    let auth = [("Authorization", format!("Bearer {key}"))];
    // GET and DELETE are idempotent, so they are retried like upload requests.
    let request = |method: &str| api.retried(method, &url, None, true, &auth, true);
    let info = request("GET");
    let quarantined = |reply: &Reply| reply.status == 403 && reply.body["code"] == "quarantined";
    let explain = |reply: &Reply| -> ! {
        let message = match reply.status {
            403 if quarantined(reply) => "The service did not delete this upload: a report about it is under review.".to_string(),
            403 => "That management link is not valid for this upload.".to_string(),
            404 => "No upload with that link exists.".to_string(),
            410 => "This upload is already gone (expired, used up or deleted).".to_string(),
            status => format!("Delete failed (HTTP {status}): {}", reply.body.get("error").and_then(Value::as_str).map_or_else(|| "the service rejected the request.".to_string(), clean)),
        };
        note!("fyl: {message}");
        process::exit(1)
    };
    // An upload still in progress has no info for its owner yet (410 unavailable; a gone file keeps its own reason,
    // such as expired or deleted), or a newer server may show it as uploading. Its owner may delete it all the same.
    let unfinished = |reply: &Reply| match reply.status {
        200 => reply.body["state"] == "uploading",
        410 => reply.body["code"] == "unavailable",
        _ => false,
    };
    // A file under review hides its info from its owner too, but the owner may still delete it. The server checks
    // the key first (a wrong one is 403 denied), so `quarantined` and `unavailable` also prove the link is valid.
    if info.status != 200 && !quarantined(&info) && !unfinished(&info) { explain(&info); }
    let deleted = request("DELETE");
    if deleted.status != 200 { explain(&deleted); }
    // Without the info (under review, or not uploaded yet), the name is unknown.
    let done = match info.body["name"].as_str().map(clean) {
        Some(name) if unfinished(&info) => format!("Deleted the unfinished upload of {name}."),
        Some(name) => format!("Deleted {name}."),
        None if unfinished(&info) => "Deleted the unfinished upload.".to_string(),
        None => "Deleted the file.".to_string(),
    };
    emit(&format!("{done}\n")).unwrap_or_else(|error| { note!("{done}"); unwritten(error) });
    format!("{origin}/api/upload")
}

fn main() {
    // A command that fails ends the process on its own; one that returns succeeded.
    let endpoint = match parse_args(std::env::args().skip(1).collect()) {
        Command::Upload(options) => { let endpoint = options.endpoint.clone(); upload(options); endpoint }
        Command::Remove(link) => remove(link),
        Command::Download(options) => { let endpoint = options.endpoint.clone(); download::download(options); endpoint }
        // Offline: it reads a file and asks no server, so no update notice either.
        Command::Decrypt(options) => return download::decrypt(options),
        Command::Update(options) => return update::update(options),
    };
    update::notice(&endpoint);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_user_agent_takes_a_plain_suffix_only() {
        assert_eq!(agent_with(None), format!("fyl-cli/{VERSION}"));
        assert_eq!(agent_with(Some("fyl-smoke")), format!("fyl-cli/{VERSION} fyl-smoke"));
        assert_eq!(agent_with(Some("  fyl-smoke ")), format!("fyl-cli/{VERSION} fyl-smoke"));
        for ignored in ["", "   ", "two words", "x\r\nX-Injected: 1", "ü", &"a".repeat(41)] {
            assert_eq!(agent_with(Some(ignored)), format!("fyl-cli/{VERSION}"), "{ignored:?}");
        }
    }

    #[test]
    fn replies_are_classified_like_the_shared_table() {
        let table: Value = serde_json::from_str(include_str!("../../tests/vectors/errors.json")).unwrap();
        let cases = table.as_array().or_else(|| table.as_object()?.values().find_map(Value::as_array)).expect("a list of cases");
        let mut checked = 0;
        for case in cases {
            // `unclear` is about a completion's body, which receipt() checks.
            let expected = match case["class"].as_str() { Some("retry") => Class::Retry, Some("permanent") => Class::Permanent, _ => continue };
            // No status: no reply at all, as send_bytes() reports it.
            let status = case["status"].as_u64().map_or(0, |status| status as u16);
            assert_eq!(class(status, case["code"].as_str()), expected, "{case}");
            checked += 1;
        }
        assert!(checked >= 15, "only {checked} cases");
        assert_eq!(class(200, None), Class::Done);
    }

    #[test]
    fn only_this_uploads_receipt_counts() {
        let id = "u".repeat(43);
        let good = json!({"url": format!("https://fyl.at/d/{id}/report%20%26.zip"), "transferId": id, "expiresAt": 1793000000000u64,
            "size": 14, "managementUrl": format!("https://fyl.at/#manage/{id}/key")});
        assert!(receipt(&good, &id, 14, true));
        let with = |field: &str, value: Value| { let mut body = good.clone(); body[field] = value; body };
        assert!(receipt(&with("managementUrl", Value::Null), &id, 14, false));
        assert!(receipt(&with("url", json!(format!("http://localhost:8787/d/{id}"))), &id, 14, true));
        for broken in [with("managementUrl", Value::Null), with("transferId", json!("t".repeat(43))), with("size", json!(15)),
                       with("size", json!("14")), with("expiresAt", Value::Null), with("expiresAt", json!("soon")), with("url", Value::Null),
                       json!({}), Value::Null] {
            assert!(!receipt(&broken, &id, 14, true), "{broken}");
        }
        assert!(!receipt(&good, &id, 13, false));
        for url in ["https://fyl.at/d/", "https://fyl.at/d/short/file.zip", "ftp://fyl.at/d/{id}", "https:///d/{id}", "https://fyl.at/x/{id}",
                    "https://fyl.at/d/{id}?dl=1", "https://fyl.at/d/{id}/file.zip#top", "https://fyl.at/d/{id}./file.zip", "https://fyl.at/d/{id}!",
                    "https://fyl.at/d/{long}", "fyl.at/d/{id}"] {
            let url = url.replace("{id}", &id).replace("{long}", &"a".repeat(65));
            assert!(!download_link(&url), "{url}");
        }
        for url in ["https://fyl.at/d/{id}", "https://fyl.at/d/{id}/", "https://dl.fyl.at:8443/d/{id}/a/b.zip", "https://fyl.at/d/{long}"] {
            let url = url.replace("{id}", &id).replace("{long}", &"a".repeat(64));
            assert!(download_link(&url), "{url}");
        }
    }

    /// tests/vectors/receipts.json, shared with the server and the browser; read when the test runs, not compiled in.
    fn receipt_vectors() -> Vec<Value> {
        let text = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/vectors/receipts.json"))
            .expect("tests/vectors/receipts.json");
        let table: Value = serde_json::from_str(&text).unwrap();
        // A list of cases, or an object that holds it next to its notes.
        table.as_array().or_else(|| table.as_object()?.values().find_map(Value::as_array)).expect("a list of cases").clone()
    }

    #[test]
    fn receipts_are_judged_like_the_shared_vectors() {
        let cases = receipt_vectors();
        for case in &cases {
            let body = case.get("receipt").or_else(|| case.get("body")).expect("a receipt");
            let id = case["uploadId"].as_str().or_else(|| case["transferId"].as_str()).expect("the session's uploadId");
            let size = case["size"].as_u64().expect("the file size");
            let manage = case["manage"].as_bool().unwrap_or(false);
            assert_eq!(receipt(body, id, size, manage), case["valid"].as_bool().expect("valid"), "{case}");
        }
        let valid = cases.iter().filter(|case| case["valid"] == true).count();
        assert!(valid >= 5 && cases.len() - valid >= 15, "{valid} valid of {} cases", cases.len());
    }

    #[test]
    fn only_an_md5_etag_proves_a_part_except_on_this_machine() {
        let md5 = hex(&Md5::digest(b"fyl.at fixture"));
        assert_eq!(check_etag(&md5, &md5), Check::Match);
        assert_eq!(check_etag(&format!("\"{}\"", md5.to_uppercase()), &md5), Check::Match);
        assert_eq!(check_etag(&"0".repeat(32), &md5), Check::Mismatch);
        for etag in [String::new(), "\"\"".into(), "local-simulator-0f3a".into(), "g".repeat(32), md5[1..].into(), format!("{md5}0"),
                     format!("{md5}-1"), format!("W/\"{md5}\"")] {
            assert_eq!(check_etag(&etag, &md5), Check::Unverifiable, "{etag}");
        }
        // Local compatibility only for an API on this machine; every other ETag that can't be checked leaves the part unverified.
        for base in ["http://127.0.0.1:8787/api/upload", "http://localhost:8787/api/upload", "https://[::1]:8443/api/upload", "https://localhost/api/upload"] {
            let api = Api::new(base).unwrap();
            assert_eq!((api.verifies(Check::Match), api.verifies(Check::Mismatch), api.verifies(Check::Unverifiable)), (true, false, true), "{base}");
        }
        for base in ["https://fyl.at/api/upload", "https://localhost.fyl.at/api/upload", "https://127.0.0.1.nip.io/api/upload",
                     "https://127.0.0.2/api/upload", "https://[::2]/api/upload", "https://dl.fyl.at:8443/api/upload"] {
            let api = Api::new(base).unwrap();
            assert_eq!((api.verifies(Check::Match), api.verifies(Check::Mismatch), api.verifies(Check::Unverifiable)), (true, false, false), "{base}");
        }
    }

    #[test]
    fn resume_values_carry_a_key_and_mtime_only_for_encrypted_uploads() {
        let (id, token, key) = ("u".repeat(43), "t".repeat(43), "yhYmJSxTzxpNxGaV5_zEZZTLTMre22cS39oHU_OuNV4");
        let raw = parse_resume(&format!("{id}.{token}"), false).unwrap();
        assert_eq!((raw.id.as_str(), raw.credential.as_str(), raw.key.is_none(), raw.mtime), (id.as_str(), token.as_str(), true, None));
        let sealed = parse_resume(&format!("{id}.{token}.{key}.1793000000123"), false).unwrap();
        assert_eq!((sealed.key.map(|key| key.key()), sealed.mtime), (Some(key.to_string()), Some(1_793_000_000_123)));
        let keyless = parse_resume(&format!("{id}.{token}.-5"), false).unwrap();
        assert_eq!((keyless.key.is_none(), keyless.mtime), (true, Some(-5)));
        for bad in [String::new(), id.clone(), format!("{id}.{token}.{key}"), format!("{id}.{token}.{key}.x"), format!("{id}.{token}.short.1"),
                    format!("{id}.{token}.{key}.1.2"), format!("{id}.short"), format!("{id}.{token}.{key}."), format!("{id}.{token}.1e3"),
                    format!("{id}.{token}.{}", "9".repeat(19))] {
            assert!(parse_resume(&bad, false).is_none(), "{bad}");
        }
    }

    #[test]
    fn a_folders_resume_value_always_ends_in_its_fingerprint() {
        let (id, token, key, print) = ("u".repeat(43), "t".repeat(43), "yhYmJSxTzxpNxGaV5_zEZZTLTMre22cS39oHU_OuNV4", "Mx1H8i-AaQf3kQ4Wb2b_Zg");
        let raw = parse_resume(&format!("{id}.{token}.{print}"), true).unwrap();
        assert_eq!((raw.key.is_none(), raw.mtime, raw.folder.as_deref()), (true, None, Some(print)));
        let sealed = parse_resume(&format!("{id}.{token}.{key}.{print}"), true).unwrap();
        assert_eq!((sealed.key.map(|key| key.key()), sealed.mtime, sealed.folder.as_deref()), (Some(key.to_string()), None, Some(print)));
        for bad in [format!("{id}.{token}"), format!("{id}.{token}.1793000000123"), format!("{id}.{token}.{key}"), format!("{id}.{token}.{print}x"),
                    format!("{id}.{token}.{key}.{print}.1")] {
            assert!(parse_resume(&bad, true).is_none(), "{bad}");
        }
        // A file's value never carries one.
        assert!(parse_resume(&format!("{id}.{token}.{print}"), false).is_none());
    }

    #[test]
    fn download_and_decrypt_are_commands_unless_a_file_of_that_name_stands_alone() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        let (there, missing) = (|_: &str| true, |_: &str| false);
        for list in [&["download", "https://fyl.at/d/x"][..], &["download", "-"], &["download", "-o", "dir"], &["download", "--output=dir"],
                     &["download", "--", "-x"], &["decrypt", "--endpoint", "http://localhost/api/upload", "fyl-x.age"], &["decrypt", "-v", "x.age"]] {
            assert!(names_the_command(&args(list), there), "{list:?}");
        }
        for list in [&["download"][..], &["download", "--once", "--expires", "1h", "-e", "http://localhost/api/upload"],
                     &["decrypt", "--expires=1h", "--json"], &["download", "--resume", "-"], &["download", "--workers", "2", "--"]] {
            assert!(!names_the_command(&args(list), there), "{list:?}");
            assert!(names_the_command(&args(list), missing), "{list:?}");
        }
    }

    #[test]
    fn a_paused_password_is_final_like_an_exhausted_part() {
        assert_eq!(class(429, Some("password_paused")), Class::Permanent);
        assert_eq!(class(401, Some("password_wrong")), Class::Permanent);
        assert_eq!(class(502, Some("part_corrupt")), Class::Retry);
        assert_eq!(class(503, Some("unsupported_mode")), Class::Retry);
        assert_eq!(class(429, Some("rate_limited")), Class::Retry);
    }

    #[test]
    fn retries_wait_a_little_longer_but_never_past_a_minute() {
        for _ in 0..100 {
            let delay = jittered(Duration::from_secs(10));
            assert!(delay >= Duration::from_secs(10) && delay <= Duration::from_secs(12), "{delay:?}");
        }
        assert_eq!(jittered(Duration::from_secs(60)), Duration::from_secs(60));
    }
}

//! `fyl update` and the update notice (docs/CLI.md). Both read the server's /cli/version.json, which names the current
//! version and each binary's SHA-256. The notice says at most once a day, after a command that succeeded, on a
//! terminal, when a newer fyl exists; the only state fyl keeps is the time of that check. `fyl update` replaces this
//! binary with the one for this system, checked against version.json and SHA256SUMS and run once before it moves in.

use crate::{die, emit, hex, on_signal, random_bytes, split_url, stop, unwritten, user_agent, VERSION};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fs::{self, File, OpenOptions};
use std::io::{self, IsTerminal, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) struct Update {
    pub(crate) check: bool,
    pub(crate) force: bool,
    pub(crate) endpoint: String,
}

/// The notice's state file, in the cache folder: the Unix time of the last check, nothing else.
const STATE: &str = "update-check";
const DAY: u64 = 86_400;

/// A version as its three numbers, e.g. 1.0.1; None for anything else.
pub(crate) fn version(text: &str) -> Option<(u64, u64, u64)> {
    let numbers: Vec<u64> = text.split('.').map(|part| {
        (!part.is_empty() && part.len() <= 9 && part.bytes().all(|b| b.is_ascii_digit())).then(|| part.parse().ok()).flatten()
    }).collect::<Option<_>>()?;
    match numbers[..] { [major, minor, patch] => Some((major, minor, patch)), _ => None }
}

/// $XDG_CACHE_HOME/fyl (when absolute), else ~/Library/Caches/fyl on macOS and ~/.cache/fyl elsewhere.
fn cache_dir() -> Option<PathBuf> {
    let absolute = |name: &str| std::env::var_os(name).map(PathBuf::from).filter(|path| path.is_absolute());
    if let Some(cache) = absolute("XDG_CACHE_HOME") { return Some(cache.join("fyl")); }
    let home = absolute("HOME")?;
    Some(if cfg!(target_os = "macos") { home.join("Library/Caches/fyl") } else { home.join(".cache/fyl") })
}

fn agent(timeout: Option<Duration>) -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        // Only the configured origin, as for every other request.
        .max_redirects(0)
        .timeout_global(timeout)
        .timeout_connect(Some(Duration::from_secs(30)))
        .timeout_recv_response(Some(Duration::from_secs(120)))
        .timeout_per_read(Some(Duration::from_secs(120)))
        // One connection per request, as for the API: a pooled one the server already closed would fail the next.
        .max_idle_connections(0)
        .max_idle_connections_per_host(0)
        .user_agent(user_agent())
        .build()
        .into()
}

/// GET `<origin>/cli/version.json` (`{name, version, path, files: {name: sha256}}`, docs/CLI-API.md): its JSON and the
/// version it names, or None when no usable answer arrived.
pub(crate) fn current(agent: &ureq::Agent, origin: &str) -> Option<(Value, (u64, u64, u64))> {
    let mut response = agent.get(&format!("{origin}/cli/version.json")).header("Accept", "application/json").call().ok()?;
    if response.status() != 200 { return None }
    let index: Value = serde_json::from_slice(&response.body_mut().with_config().limit(1 << 16).read_to_vec().ok()?).ok()?;
    let found = version(index["version"].as_str()?)?;
    (index["name"] == "fyl").then_some((index, found))
}

/// Whether the notice may run now: stderr is a terminal (someone reads it), neither FYL_NO_UPDATE_CHECK=1 nor CI is
/// set, and the last check is a day ago or more. Records this check before it is made, so a server that doesn't answer
/// is asked again only tomorrow.
fn due() -> bool {
    let set = |name: &str| std::env::var_os(name).is_some_and(|value| !value.is_empty() && value != "0");
    if !io::stderr().is_terminal() || set("FYL_NO_UPDATE_CHECK") || set("CI") { return false }
    let (Some(dir), Ok(now)) = (cache_dir(), SystemTime::now().duration_since(UNIX_EPOCH)) else { return false };
    let (file, now) = (dir.join(STATE), now.as_secs());
    let last = fs::read_to_string(&file).ok().and_then(|text| text.trim().parse::<u64>().ok());
    if last.is_some_and(|last| last <= now && now - last < DAY) { return false }
    fs::create_dir_all(&dir).is_ok() && fs::write(&file, format!("{now}\n")).is_ok()
}

/// After a command that succeeded: "fyl 1.1.0 is available: run fyl update" on stderr when the server of `endpoint`
/// names a newer version. Waits at most 2 seconds, once a day, and never changes the command's outcome.
pub(crate) fn notice(endpoint: &str) {
    let Some((origin, _)) = split_url(endpoint) else { return };
    if !due() { return }
    let Some((_, offered @ (major, minor, patch))) = current(&agent(Some(Duration::from_secs(2))), &origin) else { return };
    if version(VERSION).is_some_and(|this| offered > this) {
        note!("fyl {major}.{minor}.{patch} is available: run fyl update");
    }
}

// ---------------------------------------------------------------------------------------------
// fyl update

/// The new binary while it is written next to this one; a failure or a signal removes it.
static TEMP: Mutex<Option<PathBuf>> = Mutex::new(None);

fn discard() {
    if let Some(path) = TEMP.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() { let _ = fs::remove_file(path); }
}

/// A failure (exit 1): the binary in place stays as it is.
fn failed(message: &str) -> ! {
    discard();
    note!("fyl: {message}");
    process::exit(1)
}

fn interrupted(signal: i32) -> ! {
    discard();
    die(signal)
}

/// The binary for this system, as /cli/<version>/ names it.
fn asset() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("fyl-linux-x86_64"),
        ("linux", "aarch64") => Some("fyl-linux-arm64"),
        ("macos", "x86_64") => Some("fyl-macos-x86_64"),
        ("macos", "aarch64") => Some("fyl-macos-arm64"),
        _ => None,
    }
}

/// A file under /cli/ of the server, whole, up to `limit` bytes; None when it doesn't arrive intact.
fn fetch(agent: &ureq::Agent, url: &str, limit: u64) -> Option<Vec<u8>> {
    let mut response = agent.get(url).call().ok()?;
    if response.status() != 200 { return None }
    response.body_mut().with_config().limit(limit).read_to_vec().ok()
}

/// Folder `dir` can't take the new binary: as which user to run it again, or the installer.
fn denied(dir: &Path, origin: &str) -> ! {
    failed(&format!("Can't write to {}. Run sudo fyl update, or install again: curl -fsSL {origin}/cli/install | sh", dir.display()))
}

fn permission(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied || error.raw_os_error() == Some(libc::EROFS)
}

/// `fyl update [--check] [--force]`: the version /cli/version.json names, and unless that is this one (or older,
/// without --force) its binary for this system in place of this one. The download must have the SHA-256 that
/// version.json and /cli/<version>/SHA256SUMS both give, and run as that version, before it replaces this file in one
/// rename (written next to it and synced first, so a crash leaves either the old binary or the new one).
pub(crate) fn update(options: Update) {
    let Some((origin, _)) = split_url(&options.endpoint) else { stop("Use an HTTPS API URL without credentials or query parameters.") };
    let host = origin.split_once("://").map_or(origin.as_str(), |(_, host)| host).to_string();
    on_signal(interrupted);
    let agent = agent(None);
    let Some((index, latest)) = current(&agent, &origin) else { failed(&format!("Could not read the current version from {host}. Try again later.")) };
    let (this, shown) = (version(VERSION).unwrap_or_default(), format!("{}.{}.{}", latest.0, latest.1, latest.2));
    if options.check {
        let said = if latest > this { format!("fyl {shown} is available (this is {VERSION}): run fyl update\n") } else { format!("fyl {VERSION} is up to date.\n") };
        return emit(&said).unwrap_or_else(|error| unwritten(error));
    }
    match latest.cmp(&this) {
        Ordering::Equal if !options.force => return emit(&format!("fyl {VERSION} is already up to date.\n")).unwrap_or_else(|error| unwritten(error)),
        Ordering::Less if !options.force => failed(&format!("{host} offers fyl {shown}, older than this fyl {VERSION}. Nothing was changed; \
                                                             fyl update --force installs it anyway.")),
        _ => {}
    }
    let Some(asset) = asset() else { failed("fyl update has no binary for this system (macOS or Linux on x86_64 or arm64).") };
    let digest = index["files"][asset].as_str().filter(|digest| digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    let (Some(digest), true) = (digest, index["path"] == format!("/cli/{shown}/")) else {
        failed(&format!("{host} lists no binary of fyl {shown} for this system. Nothing was changed."))
    };
    // The same release's SHA256SUMS must name the same digest: two files that never change, from the same folder.
    let sums = fetch(&agent, &format!("{origin}/cli/{shown}/SHA256SUMS"), 1 << 16).and_then(|sums| String::from_utf8(sums).ok());
    let listed = sums.as_deref().and_then(|sums| sums.lines().find_map(|line| line.split_once("  ").filter(|(_, name)| *name == asset).map(|(sum, _)| sum.to_string())));
    if listed.as_deref() != Some(digest) {
        failed(&format!("The checksums of fyl {shown} on {host} disagree (version.json and SHA256SUMS). Nothing was changed."));
    }
    let exe = std::env::current_exe().and_then(fs::canonicalize)
        .unwrap_or_else(|_| failed(&format!("Can't tell where this fyl is installed. Install again: curl -fsSL {origin}/cli/install | sh")));
    let dir = exe.parent().unwrap_or(Path::new("/")).to_path_buf();
    let temp = dir.join(format!(".fyl-update-{}", hex(&random_bytes::<8>())));
    let mut file = match OpenOptions::new().write(true).create_new(true).mode(0o755).custom_flags(libc::O_NOFOLLOW).open(&temp) {
        Ok(file) => file,
        Err(error) if permission(&error) => denied(&dir, &origin),
        Err(error) => failed(&format!("Can't write to {}: {error}.", dir.display())),
    };
    *TEMP.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(temp.clone());
    let Some(binary) = fetch(&agent, &format!("{origin}/cli/{shown}/{asset}"), 64 << 20) else { failed("The download broke off. Nothing was changed. Try again.") };
    if hex(&Sha256::digest(&binary)) != digest { failed("The download did not match its checksum. Nothing was changed.") }
    // rwxr-xr-x whatever the umask (0o077 would make it 0700, which other users of a shared binary can't run).
    let written = file.write_all(&binary).and_then(|()| file.set_permissions(fs::Permissions::from_mode(0o755))).and_then(|()| file.sync_all());
    if let Err(error) = written { failed(&format!("Could not write the new fyl: {error}. Nothing was changed.")) }
    drop(file);
    // As the installer does: it must run here and say it is that version.
    let ran = process::Command::new(&temp).arg("--version").stdin(process::Stdio::null()).stderr(process::Stdio::null()).output();
    if !ran.is_ok_and(|ran| ran.status.success() && ran.stdout == format!("fyl {shown}\n").as_bytes()) {
        failed(&format!("The downloaded fyl does not run on this system as fyl {shown}. Nothing was changed."));
    }
    match fs::rename(&temp, &exe) {
        Ok(()) => { TEMP.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take(); }
        Err(error) if permission(&error) => denied(&dir, &origin),
        Err(error) => failed(&format!("Could not replace {}: {error}. Nothing was changed.", exe.display())),
    }
    if let Ok(dir) = File::open(&dir) { let _ = dir.sync_all(); }
    emit(&format!("Updated fyl {VERSION} to {shown}: {}\n", exe.display())).unwrap_or_else(|error| unwritten(error));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_three_numbers() {
        assert_eq!(version("1.5.1"), Some((1, 5, 1)));
        assert_eq!(version("10.0.12"), Some((10, 0, 12)));
        assert!(version("1.5.1") > version("1.4.10") && version("1.10.0") > version("1.9.9"));
        for bad in ["", "1.5", "1.5.1.1", "1.5.x", "v1.5.1", "1.5.1-rc1", "1..1", " 1.5.1", "1.5.+1", "1234567890.0.0"] {
            assert_eq!(version(bad), None, "{bad}");
        }
        assert!(version(VERSION).is_some());
    }
}

//! End-to-end encryption core, profile fyl-e2ee-1 (docs/E2EE.md): age v1 files with exactly one X25519 stanza and a
//! STREAM payload of 64 KiB chunks. KEY and the age identity string (§3), the head (§4.1) and the decoder (§4.2), the
//! metadata blob (§5), the ciphertext layout (§6), deterministic part encryption (§7, §8), the key check (§9.1), a
//! streaming decryptor that holds one chunk (§10) and the link and key-entry rules (§2.4, §10 step 1). Nothing here
//! touches files or the network beyond the Read/Write it is handed, and nothing formats a key unless asked to.

use chacha20poly1305::aead::AeadInOut;
use chacha20poly1305::{ChaCha20Poly1305, Key, KeyInit, Nonce, Tag};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::fmt;
use std::io::{self, Read, Write};
use x25519_dalek::{PublicKey, SharedSecret, StaticSecret};

/// Head: the 168-byte age header plus the 16-byte payload nonce.
pub const H: usize = 184;
pub const CHUNK: usize = 65536;
/// A chunk with its tag.
pub const S: usize = CHUNK + 16;
pub const PART: u64 = 50 * 1024 * 1024;
/// 2^53 - 1, the largest size the browser core can represent exactly.
const MAX_SAFE: u64 = (1 << 53) - 1;
/// Plaintext read per step while a part is built (§7 step 4: pieces of at most 1 MiB).
const PIECE: usize = 16 * CHUNK;
const INTRO: &[u8; 32] = b"age-encryption.org/v1\n-> X25519 ";
const STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BECH32: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

// ---------------------------------------------------------------------------------------------
// Errors

/// The client codes of §13 that the format produces (`network` and `mode_mismatch` belong to the transport).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    KeyInvalid,
    KeyWrong,
    Unsupported,
    Corrupt,
    Truncated,
    TrailingData,
}

impl Error {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn code(self) -> &'static str {
        match self {
            Error::KeyInvalid => "key_invalid",
            Error::KeyWrong => "key_wrong",
            Error::Unsupported => "unsupported",
            Error::Corrupt => "corrupt",
            Error::Truncated => "truncated",
            Error::TrailingData => "trailing_data",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(match self {
            Error::KeyInvalid => "This key is incomplete or damaged.",
            Error::KeyWrong => "This key doesn't open this file. Check that you copied the whole link.",
            Error::Unsupported => "This file needs a newer fyl.",
            Error::Corrupt | Error::TrailingData => "The file is damaged or was changed. It can't be decrypted safely.",
            Error::Truncated => "The file is incomplete.",
        })
    }
}

impl std::error::Error for Error {}

/// A streaming failure: the format (final), or the reader or writer (the Decryptor can continue, see there).
#[derive(Debug)]
pub enum StreamError {
    Crypto(Error),
    Read(io::Error),
    Write(io::Error),
}

impl From<Error> for StreamError {
    fn from(error: Error) -> Self {
        StreamError::Crypto(error)
    }
}

impl fmt::Display for StreamError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            StreamError::Crypto(error) => error.fmt(f),
            StreamError::Read(error) => write!(f, "read failed: {error}"),
            StreamError::Write(error) => write!(f, "write failed: {error}"),
        }
    }
}

impl std::error::Error for StreamError {}

// ---------------------------------------------------------------------------------------------
// Key material

/// Key bytes, overwritten on drop. Copies made on the way (moves, registers, library internals) are out of reach, so
/// this is the "where practical" of §15.7, not a promise.
struct Secret<T: AsMut<[u8]>>(T);

impl<T: AsMut<[u8]>> Drop for Secret<T> {
    fn drop(&mut self) {
        for byte in self.0.as_mut() {
            // SAFETY: a live, aligned &mut u8. Volatile, so the store to memory about to be freed isn't elided.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
        std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
    }
}

fn random(bytes: &mut [u8]) -> io::Result<()> {
    getrandom::fill(bytes).map_err(|_| io::Error::other("The system random number generator is unavailable."))
}

/// The X25519 identity behind KEY (§3.1), stored unclamped as in age. Debug never shows it.
pub struct Identity(Secret<[u8; 32]>);

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("Identity(<redacted>)")
    }
}

impl Identity {
    /// A fresh identity from the platform CSPRNG, one per transfer.
    pub fn generate() -> io::Result<Identity> {
        let mut secret = Secret([0; 32]);
        random(&mut secret.0)?;
        Ok(Identity(secret))
    }

    /// KEY: canonical b64url of 32 bytes, 43 characters.
    pub fn from_key(key: &str) -> Result<Identity, Error> {
        let mut secret = Secret([0; 32]);
        if decode_into(key.as_bytes(), URL, &mut secret.0) { Ok(Identity(secret)) } else { Err(Error::KeyInvalid) }
    }

    /// `AGE-SECRET-KEY-1…` in one case (§3.2). The decoder doesn't trim.
    pub fn from_age(text: &str) -> Result<Identity, Error> {
        let mut secret = Secret([0; 32]);
        if bech32_identity(text, &mut secret.0) { Ok(Identity(secret)) } else { Err(Error::KeyInvalid) }
    }

    /// KEY, for the link fragment. It must never reach a request, log or message (§2.2).
    pub fn key(&self) -> String {
        encode(&self.0 .0, URL, false)
    }

    /// The age identity string, uppercase, for `age -d -i`.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn age(&self) -> String {
        let mut text = bech32("age-secret-key-", &self.0 .0);
        text.make_ascii_uppercase();
        text
    }

    /// age's public form (`age1…`), never transmitted or stored (§3.1).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn recipient(&self) -> String {
        bech32("age", self.public().as_bytes())
    }

    fn secret(&self) -> StaticSecret {
        StaticSecret::from(self.0 .0)
    }

    fn public(&self) -> PublicKey {
        PublicKey::from(&self.secret())
    }
}

fn hkdf(ikm: &[u8], salt: &[u8], info: &[u8]) -> Secret<[u8; 32]> {
    let mut okm = Secret([0; 32]);
    Hkdf::<Sha256>::new(Some(salt), ikm).expand(info, &mut okm.0).expect("32 bytes is a valid HKDF output");
    okm
}

fn wrap_key(shared: &[u8; 32], share: &[u8; 32], recipient: &[u8; 32]) -> Secret<[u8; 32]> {
    let mut salt = [0; 64];
    salt[..32].copy_from_slice(share);
    salt[32..].copy_from_slice(recipient);
    hkdf(shared, &salt, b"age-encryption.org/v1/X25519")
}

fn header_mac(file_key: &[u8; 16]) -> Hmac<Sha256> {
    let key = hkdf(file_key, b"", b"header");
    <Hmac<Sha256> as KeyInit>::new_from_slice(&key.0).expect("HMAC takes any key length")
}

/// STREAM nonce: 88-bit big-endian chunk counter, then the final flag.
fn chunk_nonce(index: u64, last: bool) -> Nonce {
    let mut nonce = [0; 12];
    nonce[3..11].copy_from_slice(&index.to_be_bytes());
    nonce[11] = u8::from(last);
    nonce.into()
}

// ---------------------------------------------------------------------------------------------
// Encodings: base64 (§ Notation), Bech32 (§3.2)

fn encode(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let n = group.iter().enumerate().fold(0u32, |acc, (i, &b)| acc | u32::from(b) << (16 - 8 * i));
        for i in 0..=group.len() {
            out.push(alphabet[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
        if pad {
            out.extend(std::iter::repeat_n('=', 3 - group.len()));
        }
    }
    out
}

/// Canonical unpadded base64 of exactly `out.len()` bytes: right length, alphabet only, zero trailing bits.
fn decode_into(text: &[u8], alphabet: &[u8; 64], out: &mut [u8]) -> bool {
    if text.len() != (4 * out.len()).div_ceil(3) {
        return false;
    }
    let (mut acc, mut bits, mut at) = (0u32, 0u32, 0);
    for &c in text {
        let Some(value) = alphabet.iter().position(|&a| a == c) else { return false };
        acc = acc << 6 | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out[at] = (acc >> bits) as u8;
            at += 1;
            acc &= (1 << bits) - 1;
        }
    }
    acc == 0
}

/// b64url without padding, as head, meta and SUM travel (§5.1, §12.1).
pub fn b64url(bytes: &[u8]) -> String {
    encode(bytes, URL, false)
}

/// Canonical b64url without padding, any length.
pub fn b64url_decode(text: &str) -> Option<Vec<u8>> {
    if text.len() % 4 == 1 {
        return None;
    }
    let mut out = vec![0; text.len() * 3 / 4];
    decode_into(text.as_bytes(), URL, &mut out).then_some(out)
}

fn polymod(values: impl IntoIterator<Item = u8>) -> u32 {
    const GEN: [u32; 5] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    values.into_iter().fold(1, |chk, value| {
        let top = chk >> 25;
        GEN.iter().enumerate().fold((chk & 0x1ffffff) << 5 ^ u32::from(value), |chk, (i, g)| if top >> i & 1 == 1 { chk ^ g } else { chk })
    })
}

fn hrp_expand(hrp: &[u8]) -> impl Iterator<Item = u8> + '_ {
    hrp.iter().map(|c| c >> 5).chain([0]).chain(hrp.iter().map(|c| c & 31))
}

/// BIP 173 Bech32 (constant 1, not Bech32m) of `data` in 5-bit groups with zero padding, lowercase.
#[cfg_attr(not(test), allow(dead_code))]
fn bech32(hrp: &str, data: &[u8]) -> String {
    let mut words = Secret(Vec::with_capacity(data.len() * 8 / 5 + 1));
    let (mut acc, mut bits) = (0u32, 0u32);
    for &byte in data {
        acc = acc << 8 | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            words.0.push((acc >> bits & 31) as u8);
        }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 {
        words.0.push((acc << (5 - bits) & 31) as u8);
    }
    let check = polymod(hrp_expand(hrp.as_bytes()).chain(words.0.iter().copied()).chain([0; 6])) ^ 1;
    let mut out = String::with_capacity(hrp.len() + 1 + words.0.len() + 6);
    out.push_str(hrp);
    out.push('1');
    out.extend(words.0.iter().map(|&w| BECH32[w as usize] as char));
    out.extend((0..6).map(|i| BECH32[(check >> (5 * (5 - i)) & 31) as usize] as char));
    out
}

/// §3.2: HRP `age-secret-key-`, all one case, valid checksum, exactly 32 bytes with zero padding bits.
fn bech32_identity(text: &str, out: &mut [u8; 32]) -> bool {
    const HRP: &[u8] = b"age-secret-key-";
    let bytes = text.as_bytes();
    if bytes.iter().any(u8::is_ascii_uppercase) && bytes.iter().any(u8::is_ascii_lowercase) {
        return false;
    }
    let Some(pos) = text.rfind('1') else { return false };
    let (hrp, data) = (&bytes[..pos], &bytes[pos + 1..]);
    if !hrp.eq_ignore_ascii_case(HRP) || data.len() < 6 {
        return false;
    }
    let mut words = Secret(Vec::with_capacity(data.len()));
    for &c in data {
        let Some(word) = BECH32.iter().position(|&b| b == c.to_ascii_lowercase()) else { return false };
        words.0.push(word as u8);
    }
    if polymod(hrp_expand(HRP).chain(words.0.iter().copied())) != 1 {
        return false;
    }
    let (mut acc, mut bits, mut at) = (0u32, 0u32, 0);
    for &word in &words.0[..words.0.len() - 6] {
        acc = acc << 5 | u32::from(word);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            if at == out.len() {
                return false;
            }
            out[at] = (acc >> bits) as u8;
            at += 1;
            acc &= (1 << bits) - 1;
        }
    }
    at == out.len() && bits < 5 && acc == 0
}

// ---------------------------------------------------------------------------------------------
// Layout (§6)

pub fn chunks(plaintext: u64) -> u64 {
    plaintext.div_ceil(CHUNK as u64).max(1)
}

/// C(P), saturating far beyond any real size.
pub fn ciphertext_size(plaintext: u64) -> u64 {
    (H as u64).saturating_add(plaintext).saturating_add(16 * chunks(plaintext))
}

/// P(C): None where no file has this size (an empty or under-17-byte last chunk).
pub fn plaintext_size(ciphertext: u64) -> Option<u64> {
    let rest = ciphertext.checked_sub(H as u64).filter(|&rest| rest >= 16)?;
    let n = rest.div_ceil(S as u64).max(1);
    let p = rest - 16 * n;
    (n < 2 || p > CHUNK as u64 * (n - 1)).then_some(p)
}

/// P_max: the largest P with C(P) <= limit (`maxFileBytes` from /config.js or /api/health).
pub fn max_plaintext(limit: u64) -> Option<u64> {
    // Checked, not ciphertext_size: a saturated C(P) would pass for limit u64::MAX.
    let fits = |p: u64| (H as u64).checked_add(p).and_then(|c| c.checked_add(16 * chunks(p))).is_some_and(|c| c <= limit);
    if !fits(0) {
        return None;
    }
    let (mut lo, mut hi) = (0, limit);
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        if fits(mid) { lo = mid } else { hi = mid - 1 }
    }
    Some(lo)
}

pub fn parts(ciphertext: u64, part_size: u64) -> u64 {
    ciphertext.div_ceil(part_size)
}

/// Part `part` (1-based) as the ciphertext range [start, end).
pub fn part_range(ciphertext: u64, part_size: u64, part: u64) -> Option<(u64, u64)> {
    let start = part_size.checked_mul(part.checked_sub(1)?)?;
    (part_size > 0 && start < ciphertext).then(|| (start, start.saturating_add(part_size).min(ciphertext)))
}

/// The chunks a part touches, first and last, both possibly only in part. None for a part inside the head.
pub fn part_chunks(ciphertext: u64, part_size: u64, part: u64) -> Option<(u64, u64)> {
    let n = chunks(plaintext_size(ciphertext)?);
    let (start, end) = part_range(ciphertext, part_size, part)?;
    if end <= H as u64 {
        return None;
    }
    Some((start.saturating_sub(H as u64) / S as u64, ((end - 1 - H as u64) / S as u64).min(n - 1)))
}

// ---------------------------------------------------------------------------------------------
// Age files: creation (§4.1), parts (§6, §7), decryption (§4.2)

/// One profile age file: its head, payload cipher and plaintext size P. Fresh for an upload, or recovered from a stored
/// head by the key check, so a resuming sender rebuilds byte-identical parts and a recipient decrypts. P is bound here,
/// not passed per call: one payload key never seals two sizes, whose last chunks would share a nonce.
pub struct AgeFile {
    head: [u8; H],
    payload: ChaCha20Poly1305,
    size: u64,
}

impl fmt::Debug for AgeFile {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("AgeFile { .. }")
    }
}

impl AgeFile {
    /// A new file of `size` plaintext bytes to `identity`, with a fresh file key, ephemeral secret and payload nonce.
    /// For the content this runs once per transfer, at init, and never again (§4.1).
    pub fn create(identity: &Identity, size: u64) -> io::Result<AgeFile> {
        let (mut file_key, mut eph, mut nonce) = (Secret([0; 16]), Secret([0; 32]), [0; 16]);
        random(&mut file_key.0)?;
        random(&mut eph.0)?;
        random(&mut nonce)?;
        Ok(AgeFile::build(identity, &file_key, &eph, nonce, size))
    }

    /// The deterministic part of creation; tests inject the randomness here.
    fn build(identity: &Identity, file_key: &Secret<[u8; 16]>, eph: &Secret<[u8; 32]>, nonce: [u8; 16], size: u64) -> AgeFile {
        let recipient = identity.public();
        let eph = StaticSecret::from(eph.0);
        let share = PublicKey::from(&eph);
        let wrap = wrap_key(eph.diffie_hellman(&recipient).as_bytes(), share.as_bytes(), recipient.as_bytes());
        let mut body = [0; 32];
        body[..16].copy_from_slice(&file_key.0);
        let tag = ChaCha20Poly1305::new(<&Key>::from(&wrap.0))
            .encrypt_inout_detached(&Nonce::default(), b"", (&mut body[..16]).into())
            .expect("16 bytes is within the AEAD limit");
        body[16..].copy_from_slice(&tag);
        let mut head = Vec::with_capacity(H);
        head.extend_from_slice(INTRO);
        head.extend_from_slice(encode(share.as_bytes(), STD, false).as_bytes());
        head.push(b'\n');
        head.extend_from_slice(encode(&body, STD, false).as_bytes());
        head.extend_from_slice(b"\n---");
        let mut mac = header_mac(&file_key.0);
        mac.update(&head);
        head.push(b' ');
        head.extend_from_slice(encode(&mac.finalize().into_bytes(), STD, false).as_bytes());
        head.push(b'\n');
        head.extend_from_slice(&nonce);
        AgeFile::from_key(file_key, &head, size)
    }

    /// From a verified head.
    fn from_key(file_key: &Secret<[u8; 16]>, head: &[u8], size: u64) -> AgeFile {
        let head: [u8; H] = head[..H].try_into().expect("a head is at least H bytes");
        AgeFile { head, payload: payload_cipher(file_key, &head), size }
    }

    pub fn head(&self) -> &[u8; H] {
        &self.head
    }

    /// P, the plaintext size this file is bound to.
    pub fn size(&self) -> u64 {
        self.size
    }

    /// SUM of §5.1: b64url(SHA-256(head)).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn head_sha256(&self) -> String {
        b64url(&Sha256::digest(self.head))
    }

    fn seal(&self, index: u64, last: bool, chunk: &mut [u8]) -> Tag {
        self.payload.encrypt_inout_detached(&chunk_nonce(index, last), b"", chunk.into()).expect("a chunk is within the AEAD limit")
    }

    /// Part `part` of the file over its P plaintext bytes, computed on its own (any order, in parallel, identical on
    /// every retry and resume): reads the plaintext of the chunks it touches in pieces of at most 1 MiB through
    /// `read(offset, buf)`, which must fill `buf`, encrypts them and keeps the bytes inside the part (§6, §7 step 4).
    pub fn encrypt_part<F>(&self, part_size: u64, part: u64, mut read: F) -> io::Result<Vec<u8>>
    where
        F: FnMut(u64, &mut [u8]) -> io::Result<()>,
    {
        let (size, c) = (self.size, ciphertext_size(self.size));
        let Some((start, end)) = part_range(c, part_size, part) else {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "no such part"));
        };
        let mut out = Vec::with_capacity((end - start) as usize);
        let mut keep = |at: u64, bytes: &[u8]| {
            let (from, to) = (at.max(start), (at + bytes.len() as u64).min(end));
            if from < to {
                out.extend_from_slice(&bytes[(from - at) as usize..(to - at) as usize]);
            }
        };
        keep(0, &self.head);
        if let Some((first, last)) = part_chunks(c, part_size, part) {
            let n = chunks(size);
            let mut buf = vec![0; PIECE.min(((last - first + 1) as usize).saturating_mul(CHUNK))];
            let mut index = first;
            while index <= last {
                let count = (last - index + 1).min((buf.len() / CHUNK) as u64);
                let from = index * CHUNK as u64;
                let piece = &mut buf[..((index + count) * CHUNK as u64).min(size).saturating_sub(from) as usize];
                if !piece.is_empty() {
                    read(from, piece)?;
                }
                let len = piece.len();
                for k in 0..count as usize {
                    let i = index + k as u64;
                    let chunk = &mut piece[(k * CHUNK).min(len)..((k + 1) * CHUNK).min(len)];
                    let tag = self.seal(i, i == n - 1, chunk);
                    let at = H as u64 + S as u64 * i;
                    keep(at, chunk);
                    keep(at + chunk.len() as u64, &tag);
                }
                index += count;
            }
        }
        debug_assert_eq!(out.len() as u64, end - start);
        Ok(out)
    }

    /// The whole file in memory (the meta blob). Private: content is built only part by part, from its bound P.
    fn encrypt_all(&self, plaintext: &[u8]) -> Vec<u8> {
        assert_eq!(plaintext.len() as u64, self.size, "plaintext of the bound size");
        self.encrypt_part(ciphertext_size(self.size), 1, |at, buf| {
            buf.copy_from_slice(&plaintext[at as usize..at as usize + buf.len()]);
            Ok(())
        })
        .expect("reading from memory doesn't fail")
    }

    /// The download decryptor (§9.2, §10 step 7): it expects the served file from offset 0, whose first H bytes must
    /// equal this verified head, and which must decrypt to exactly P bytes.
    pub fn decryptor(&self) -> Decryptor {
        Decryptor::new(self.payload.clone(), Some((self.head, self.size)))
    }
}

/// The payload cipher of a verified head: HKDF(file key, nonce, "payload").
fn payload_cipher(file_key: &Secret<[u8; 16]>, head: &[u8]) -> ChaCha20Poly1305 {
    ChaCha20Poly1305::new(<&Key>::from(&hkdf(&file_key.0, &head[168..H], b"payload").0))
}

/// §4.2 step 8 over a payload in memory; the plaintext released before any failure comes back too.
fn open_all(payload: ChaCha20Poly1305, data: &[u8]) -> (Result<u64, Error>, Vec<u8>) {
    let mut out = Vec::with_capacity(data.len());
    let result = Decryptor::new(payload, None).run(&mut &data[..], &mut out).map_err(|error| match error {
        StreamError::Crypto(error) => error,
        StreamError::Read(_) | StreamError::Write(_) => unreachable!("memory I/O doesn't fail"),
    });
    (result, out)
}

/// How `stanza` stops: a code, or (`More`) a stanza type running past the first H bytes of a longer input.
enum Halt {
    Fail(Error),
    More,
}

impl From<Error> for Halt {
    fn from(error: Error) -> Self {
        Halt::Fail(error)
    }
}

/// What steps 1-5 of §4.2 take from a head.
struct Stanza {
    share: [u8; 32],
    body: [u8; 32],
    mac: [u8; 32],
    shared: SharedSecret,
}

/// Steps 1-5 of §4.2, in order, on `data`: the whole input, or (`complete` false) the first H bytes of a longer one.
fn stanza(identity: &Identity, data: &[u8], complete: bool) -> Result<Stanza, Halt> {
    let Some(lf) = data[..data.len().min(H)].iter().position(|&b| b == b'\n') else {
        return Err(if data.len() < H { Error::Truncated } else { Error::Corrupt }.into());
    };
    let version = &data[..lf];
    let Some(tail) = version.strip_prefix(b"age-encryption.org/").filter(|tail| !tail.is_empty()) else {
        return Err(Error::Corrupt.into());
    };
    if !tail.iter().all(|b| (0x21..=0x7e).contains(b)) {
        return Err(Error::Corrupt.into());
    }
    if version != b"age-encryption.org/v1" {
        return Err(Error::Unsupported.into());
    }
    let rest = &data[lf + 1..];
    let Some(args) = rest.strip_prefix(b"-> ") else {
        return Err(if b"-> ".starts_with(rest) { Error::Truncated } else { Error::Corrupt }.into());
    };
    match args.iter().position(|&b| b == b' ' || b == b'\n') {
        None if complete => return Err(Error::Truncated.into()),
        None => return Err(Halt::More),
        Some(end) if &args[..end] != b"X25519" => return Err(Error::Unsupported.into()),
        Some(_) => {}
    }
    if data.len() < H {
        return Err(Error::Truncated.into());
    }
    if &data[..32] != INTRO || data[75] != b'\n' || &data[119..124] != b"\n--- " || data[167] != b'\n' {
        return Err(Error::Corrupt.into());
    }
    let mut fields = [[0; 32]; 3];
    for (field, at) in fields.iter_mut().zip([32, 76, 124]) {
        if !decode_into(&data[at..at + 43], STD, field) {
            return Err(Error::Corrupt.into());
        }
    }
    let [share, body, mac] = fields;
    let shared = identity.secret().diffie_hellman(&PublicKey::from(share));
    if !shared.was_contributory() {
        return Err(Error::Corrupt.into());
    }
    Ok(Stanza { share, body, mac, shared })
}

/// Step 6: the file key, None when the stanza doesn't open with this identity.
fn unwrap(identity: &Identity, stanza: &Stanza) -> Option<Secret<[u8; 16]>> {
    let wrap = wrap_key(stanza.shared.as_bytes(), &stanza.share, identity.public().as_bytes());
    let mut file_key = Secret([0; 16]);
    file_key.0.copy_from_slice(&stanza.body[..16]);
    let tag = <&Tag>::try_from(&stanza.body[16..]).expect("the body ends in a 16-byte tag");
    ChaCha20Poly1305::new(<&Key>::from(&wrap.0))
        .decrypt_inout_detached(&Nonce::default(), b"", (&mut file_key.0[..]).into(), tag)
        .ok()?;
    Some(file_key)
}

/// Step 7: HMAC over the header up to "---", compared in constant time.
fn check_mac(data: &[u8], file_key: &Secret<[u8; 16]>, mac: &[u8; 32]) -> Result<(), Error> {
    let mut hmac = header_mac(&file_key.0);
    hmac.update(&data[..123]);
    hmac.verify_slice(mac).map_err(|_| Error::Corrupt)
}

/// Steps 6-7 after `stanza`: the verified file key.
fn file_key(identity: &Identity, data: &[u8], stanza: &Stanza) -> Result<Secret<[u8; 16]>, Error> {
    let file_key = unwrap(identity, stanza).ok_or(Error::KeyWrong)?;
    check_mac(data, &file_key, &stanza.mac)?;
    Ok(file_key)
}

fn complete(halt: Halt) -> Error {
    match halt {
        Halt::Fail(error) => error,
        Halt::More => Error::Truncated, // only for a partial input
    }
}

/// Steps 1-7 of §4.2 on one stored head for a file of `size` plaintext bytes (a worker given KEY, head and the P the
/// key check established); a failing unwrap is `key_wrong`. A stored head is exactly H bytes, else `corrupt`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn open_header(identity: &Identity, head: &[u8], size: u64) -> Result<AgeFile, Error> {
    let stanza = stanza(identity, head, true).map_err(complete)?;
    if head.len() != H {
        return Err(Error::Corrupt);
    }
    Ok(AgeFile::from_key(&file_key(identity, head, &stanza)?, head, size))
}

/// Reads until `buf` is full or the input ends; the count read.
fn fill<R: Read>(reader: &mut R, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}

#[derive(Clone, Copy)]
enum State {
    Head,
    Chunks,
    Done(u64),
    Failed(Error),
}

/// §4.2 step 8 as a stream with one chunk in memory: plaintext goes to the writer as each chunk verifies, and only Ok
/// says the file was complete (final chunk verified, nothing after it). A format error is final. After a Read or Write
/// error, cut the output back to `plaintext()` and call `run` again with a reader positioned at `offset()`: that is how
/// a download resumes with Range (§10 step 8); bytes already taken from the old reader are not reused.
pub struct Decryptor {
    payload: ChaCha20Poly1305,
    /// A content file's verified head, which the stream must start with, and its P; None for a payload alone.
    expect: Option<([u8; H], u64)>,
    state: State,
    chunk: u64,
    buf: Vec<u8>,
}

impl fmt::Debug for Decryptor {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "Decryptor {{ offset: {} }}", self.offset())
    }
}

impl Decryptor {
    fn new(payload: ChaCha20Poly1305, expect: Option<([u8; H], u64)>) -> Decryptor {
        let state = if expect.is_some() { State::Head } else { State::Chunks };
        Decryptor { payload, expect, state, chunk: 0, buf: vec![0; S] }
    }

    /// Ciphertext offset the next read starts at: 0 before the head, else 184 + 65552·i for the next chunk i.
    pub fn offset(&self) -> u64 {
        match self.state {
            State::Head => 0,
            _ => H as u64 + S as u64 * self.chunk,
        }
    }

    /// Verified plaintext before `offset()`, 65536·i.
    pub fn plaintext(&self) -> u64 {
        CHUNK as u64 * self.chunk
    }

    /// Decrypts from `reader` (at `offset()`) to `writer` until the end; Ok(P) once complete.
    pub fn run<R: Read, W: Write>(&mut self, reader: &mut R, writer: &mut W) -> Result<u64, StreamError> {
        loop {
            match self.state {
                State::Done(size) => return Ok(size),
                State::Failed(error) => return Err(error.into()),
                State::Head => {
                    let mut head = [0; H];
                    let n = fill(reader, &mut head).map_err(StreamError::Read)?;
                    if n < H || !matches!(self.expect, Some((expected, _)) if expected == head) {
                        return Err(self.fail(Error::Corrupt));
                    }
                    self.state = State::Chunks;
                }
                State::Chunks => {
                    let len = fill(reader, &mut self.buf).map_err(StreamError::Read)?;
                    let last = self.open_chunk(len).map_err(|error| self.fail(error))?;
                    // A content file's P is known: an authentic file of another size isn't the one its metadata describes.
                    if last && self.expect.is_some_and(|(_, size)| self.plaintext() + (len - 16) as u64 != size) {
                        return Err(self.fail(Error::Corrupt));
                    }
                    writer.write_all(&self.buf[..len - 16]).map_err(StreamError::Write)?;
                    if !last {
                        self.chunk += 1;
                        continue;
                    }
                    // The final chunk stays current until the end is confirmed, so a failing read here resumes
                    // with it rather than past the end.
                    if fill(reader, &mut [0]).map_err(StreamError::Read)? > 0 {
                        return Err(self.fail(Error::TrailingData));
                    }
                    self.state = State::Done(self.plaintext() + (len - 16) as u64);
                }
            }
        }
    }

    fn fail(&mut self, error: Error) -> StreamError {
        self.state = State::Failed(error);
        error.into()
    }

    /// Opens the `len` bytes in buf in place: a short chunk only as final, a full one as non-final first. Ok(final).
    fn open_chunk(&mut self, len: usize) -> Result<bool, Error> {
        match len {
            0 => return Err(Error::Truncated),
            1..=15 => return Err(Error::Corrupt),
            _ => {}
        }
        let (body, tag) = self.buf[..len].split_at_mut(len - 16);
        let tag = <&Tag>::try_from(&*tag).expect("the split leaves a 16-byte tag");
        let flags: &[bool] = if len < S { &[true] } else { &[false, true] };
        // A failed open leaves the buffer as it was: the tag is checked before anything is decrypted.
        let last = flags
            .iter()
            .copied()
            .find(|&last| self.payload.decrypt_inout_detached(&chunk_nonce(self.chunk, last), b"", (&mut *body).into(), tag).is_ok())
            .ok_or(Error::Corrupt)?;
        if last && body.is_empty() && self.chunk > 0 {
            return Err(Error::Corrupt);
        }
        Ok(last)
    }
}

/// §4.2 on one whole file from `reader` (`fyl decrypt`): the header, then the payload as `Decryptor::run`.
pub fn decrypt<R: Read, W: Write>(identity: &Identity, reader: &mut R, writer: &mut W) -> Result<u64, StreamError> {
    let mut head = [0; H];
    let n = fill(reader, &mut head).map_err(StreamError::Read)?;
    let stanza = match stanza(identity, &head[..n], n < H) {
        Ok(stanza) => stanza,
        Err(Halt::Fail(error)) => return Err(error.into()),
        Err(Halt::More) => return Err(type_end(reader)?.into()),
    };
    let file_key = file_key(identity, &head, &stanza)?;
    Decryptor::new(payload_cipher(&file_key, &head), None).run(reader, writer)
}

/// Step 2 when the stanza type runs past the first H bytes: it isn't X25519, so `unsupported` once something ends
/// it, `truncated` if the input ends first.
fn type_end<R: Read>(reader: &mut R) -> Result<Error, StreamError> {
    let mut buf = [0; 4096];
    loop {
        let n = fill(reader, &mut buf).map_err(StreamError::Read)?;
        if buf[..n].iter().any(|&b| b == b' ' || b == b'\n') {
            return Ok(Error::Unsupported);
        }
        if n < buf.len() {
            return Ok(Error::Truncated);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Metadata (§5) and names (§5.3, §7 step 1)

fn forbidden(c: char) -> bool {
    matches!(c, '\0'..='\x1f' | '\x7f'..='\u{9f}' | '/' | '\\' | '\u{61c}' | '\u{200e}' | '\u{200f}' | '\u{2028}' | '\u{2029}'
        | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// The server's raw-name rules (§5.3 step 5).
pub fn name_ok(name: &str) -> bool {
    (1..=1024).contains(&name.len()) && !name.bytes().all(|b| b == b'.') && !name.chars().any(forbidden)
}

/// Cuts `name` to at most `max` bytes at a code point boundary, keeping the extension (from the last dot, if it isn't
/// the first character and leaves room for at least one more byte).
pub fn shorten_name(name: &str, max: usize) -> String {
    if name.len() <= max {
        return name.to_string();
    }
    let ext = match name.rfind('.') {
        Some(dot) if dot > 0 && name.len() - dot < max => &name[dot..],
        _ => "",
    };
    let stem = &name[..name.len() - ext.len()];
    let mut cut = max - ext.len();
    while !stem.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{ext}", &stem[..cut])
}

/// §7 step 1: forbidden code points become `_`, a name of only dots (or none) becomes `_`, over 1024 bytes is
/// shortened. A file name that isn't UTF-8 goes through `String::from_utf8_lossy` first; its U+FFFD is allowed.
pub fn normalize_name(name: &str) -> String {
    let only_dots = |name: &str| name.bytes().all(|b| b == b'.');
    let name: String = name.chars().map(|c| if forbidden(c) { '_' } else { c }).collect();
    let name = shorten_name(&name, 1024);
    if only_dots(&name) { "_".to_string() } else { name }
}

/// §5.1 without padding; `"` is the only character escaped, which is exact for every valid name.
fn meta_json(name: &str, size: u64, head: &[u8]) -> Vec<u8> {
    format!(r#"{{"v":1,"name":"{}","size":{size},"headSha256":"{}"}}"#, name.replace('"', "\\\""), b64url(&Sha256::digest(head))).into_bytes()
}

/// The meta plaintext: §5.1 padded with spaces to a multiple of 512 bytes.
pub fn meta_text(name: &str, size: u64, head: &[u8]) -> Vec<u8> {
    let mut text = meta_json(name, size, head);
    text.resize(text.len().next_multiple_of(512), b' ');
    text
}

/// The meta blob for a content file (§5.2): its own age file to the same identity, with its own fresh randomness.
/// `name` must be normalised.
pub fn new_meta(identity: &Identity, name: &str, size: u64, head: &[u8; H]) -> io::Result<Vec<u8>> {
    let text = meta_text(name, size, head);
    Ok(AgeFile::create(identity, text.len() as u64)?.encrypt_all(&text))
}

/// §5.3 on decrypted meta, against the verified content head and the content object's size.
fn check_meta(text: &[u8], head: &[u8], ciphertext: u64) -> Result<(String, u64), Error> {
    if !text.len().is_multiple_of(512) || text.len() > 2560 {
        return Err(Error::Corrupt);
    }
    let trimmed = text.iter().rposition(|&b| b != b' ').map_or(&text[..0], |end| &text[..=end]);
    if text.len() - trimmed.len() >= 512 {
        return Err(Error::Corrupt);
    }
    if let Some(rest) = trimmed.strip_prefix(br#"{"v":"#) {
        let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        if digits > 0 && matches!(rest.get(digits), Some(b',' | b'}')) && &rest[..digits] != b"1" {
            return Err(Error::Unsupported);
        }
    }
    let json = std::str::from_utf8(trimmed).map_err(|_| Error::Corrupt)?;
    // `\"` is the only escape: keeps out `\ud800`, which JSON.parse takes and serde_json refuses.
    if trimmed.iter().enumerate().any(|(i, &b)| b == b'\\' && trimmed.get(i + 1) != Some(&b'"')) {
        return Err(Error::Corrupt);
    }
    let value: serde_json::Value = serde_json::from_str(json).map_err(|_| Error::Corrupt)?;
    let name = value.get("name").and_then(serde_json::Value::as_str).ok_or(Error::Corrupt)?;
    let size = value.get("size").and_then(serde_json::Value::as_u64).ok_or(Error::Corrupt)?;
    // Re-encoding to exactly the text rules out other members, order, whitespace, numbers like 1.0 and a SUM of another head.
    if !name_ok(name) || meta_json(name, size, head) != trimmed {
        return Err(Error::Corrupt);
    }
    // C (and so P) within 2^53 - 1, JavaScript's safe integers, where the browser can still compute P(C).
    if ciphertext > MAX_SAFE || plaintext_size(ciphertext) != Some(size) {
        return Err(Error::Corrupt);
    }
    Ok((name.to_string(), size))
}

/// A passed key check: the content file (to decrypt, or to rebuild parts on resume) and the authenticated metadata.
#[derive(Debug)]
pub struct Checked {
    pub content: AgeFile,
    pub name: String,
    pub size: u64,
}

/// §9.1 (also §8.4 step 2, §10 step 5): `head` and `meta` as stored, for a content object of `ciphertext` bytes,
/// nothing downloaded. Steps 1-5 on head (exactly H bytes) then meta, step 6 on both (both failing `key_wrong`, one
/// `corrupt`), step 7 on head then meta, no randomness shared between them, then meta's payload and §5.3. The first
/// failure wins. The content file comes back bound to the authenticated P.
pub fn key_check(identity: &Identity, head: &[u8], meta: &[u8], ciphertext: u64) -> Result<Checked, Error> {
    let head_stanza = stanza(identity, head, true).map_err(complete)?;
    if head.len() != H {
        return Err(Error::Corrupt);
    }
    let meta_stanza = stanza(identity, meta, true).map_err(complete)?;
    let (head_key, meta_key) = match (unwrap(identity, &head_stanza), unwrap(identity, &meta_stanza)) {
        (Some(head_key), Some(meta_key)) => (head_key, meta_key),
        (None, None) => return Err(Error::KeyWrong),
        _ => return Err(Error::Corrupt),
    };
    check_mac(head, &head_key, &head_stanza.mac)?;
    check_mac(meta, &meta_key, &meta_stanza.mac)?;
    // §12.1 step 6: meta's ephemeral share, stanza body and payload nonce each differ from head's. Equal shares mean one
    // wrap key for two file keys; an equal nonce with an equal file key means one payload key, so meta's chunk 0 would
    // reuse the keystream and Poly1305 key of a small file's only chunk. Honest files collide with probability 2^-128.
    if [(32, 75), (76, 119), (168, H)].iter().any(|&(from, to)| head[from..to] == meta[from..to]) {
        return Err(Error::Corrupt);
    }
    let (result, text) = open_all(payload_cipher(&meta_key, meta), &meta[H..]);
    result?;
    let (name, size) = check_meta(&text, head, ciphertext)?;
    Ok(Checked { content: AgeFile::from_key(&head_key, head, size), name, size })
}

/// A part's pin (§8.2, §8.3): its MD5 as 32 lowercase hex digits, and as the RFC 1864 `Content-MD5` value.
pub fn md5_pin(part: &[u8]) -> (String, String) {
    let md5 = md5::Md5::digest(part);
    (md5.iter().map(|b| format!("{b:02x}")).collect(), encode(&md5, STD, true))
}

// ---------------------------------------------------------------------------------------------
// Links and key entry (§2.4, §10 step 1)

#[derive(Debug, PartialEq, Eq)]
pub enum LinkError {
    /// Not `<base>/d/<ID>…`, a query other than `?dl=1`, or a key both after `%23` and after `#` (exit 2).
    Malformed,
    /// A fragment that isn't a KEY (exit 2, `key_invalid`).
    KeyInvalid,
    /// The server's `url` isn't `<origin>/d/<ID>`, or the origin isn't https (http only on loopback): show, print and
    /// store no link (exit 1, `url_mismatch`).
    UrlMismatch,
}

/// A parsed link: the transfer ID and its key, if any. `exposed`: the key came after `%23`, so it was in the request
/// path and reached the server; say so (§9.5).
#[derive(Debug)]
pub struct Link {
    pub id: String,
    pub key: Option<Identity>,
    pub exposed: bool,
}

fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `<base>/d/<ID>[/<segment>][?dl=1][#KEY]` with `base` the configured origin. `%23` right after the ID counts as `#`,
/// an empty fragment as no key, and the segment is never used, not even as a key: a raw link's NAME can look like one.
pub fn parse_link(link: &str, base: &str) -> Result<Link, LinkError> {
    let Some(rest) = link.strip_prefix(&format!("{}/d/", base.trim_end_matches('/'))) else {
        return Err(LinkError::Malformed);
    };
    let (rest, fragment) = rest.split_once('#').map_or((rest, None), |(rest, fragment)| (rest, Some(fragment)));
    let (path, query) = rest.split_once('?').map_or((rest, None), |(path, query)| (path, Some(query)));
    if query.is_some_and(|query| query != "dl=1") {
        return Err(LinkError::Malformed);
    }
    let (id, tail) = path.split_at(path.find(['/', '%']).unwrap_or(path.len()));
    let escaped = tail.strip_prefix("%23");
    if !id_ok(id) || !(escaped.is_some() || tail.is_empty() || tail.starts_with('/')) {
        return Err(LinkError::Malformed);
    }
    let escaped = escaped.filter(|key| !key.is_empty());
    let mut keys = [escaped, fragment].into_iter().flatten().filter(|key| !key.is_empty());
    let key = match (keys.next(), keys.next()) {
        (None, _) => None,
        (Some(key), None) => Some(Identity::from_key(key).map_err(|_| LinkError::KeyInvalid)?),
        (Some(_), Some(_)) => return Err(LinkError::Malformed),
    };
    Ok(Link { id: id.to_string(), key, exposed: escaped.is_some() })
}

/// §2.2: `https://HOST[:PORT]`, HOST a DNS name or a bracketed IPv6 address, or `http://` on loopback.
fn origin_ok(origin: &str) -> bool {
    let (rest, loopback) = match (origin.strip_prefix("https://"), origin.strip_prefix("http://")) {
        (Some(rest), _) => (rest, false),
        (None, Some(rest)) => (rest, true),
        (None, None) => return false,
    };
    let split = if rest.starts_with('[') { rest.find(']').map_or(rest.len(), |end| end + 1) } else { rest.find(':').unwrap_or(rest.len()) };
    let (host, port) = rest.split_at(split);
    let host_ok = match host.strip_prefix('[').and_then(|host| host.strip_suffix(']')) {
        _ if loopback => matches!(host, "localhost" | "127.0.0.1" | "[::1]"),
        Some(v6) => !v6.is_empty() && v6.bytes().all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.'),
        None => !host.is_empty() && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-'),
    };
    host_ok && (port.is_empty() || port.strip_prefix(':').is_some_and(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit())))
}

/// The keyed share link `<origin>/d/<ID>#KEY` (§2.2), built from the configured origin, never from the server's `url`,
/// which must be `<origin>/d/<ID>` byte for byte (`UrlMismatch` otherwise: show, print and store nothing).
pub fn share_link(origin: &str, id: &str, url: &str, key: &Identity) -> Result<String, LinkError> {
    if !origin_ok(origin) || !id_ok(id) || url.strip_prefix(origin).and_then(|rest| rest.strip_prefix("/d/")) != Some(id) {
        return Err(LinkError::UrlMismatch);
    }
    Ok(format!("{url}#{}", key.key()))
}

#[derive(Debug, PartialEq, Eq)]
pub enum EntryError {
    KeyInvalid,
    /// "This link is for another file"
    OtherTransfer,
}

/// The page's key field and the CLI key prompt for transfer `id` (§2.4): ASCII whitespace trimmed, then an age identity
/// string (by its prefix, in any case), a KEY (no `/`), or a link to this transfer on `base` with a KEY. The prefix
/// decides first: `AGE-SECRET-KEY-1` is 16 b64url characters, so a cut identity string could otherwise pass as a KEY.
pub fn parse_entry(input: &str, base: &str, id: &str) -> Result<Identity, EntryError> {
    let text = input.trim_ascii();
    if text.as_bytes().get(..16).is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"age-secret-key-1")) {
        return Identity::from_age(text).map_err(|_| EntryError::KeyInvalid);
    }
    if !text.contains('/') {
        return Identity::from_key(text).map_err(|_| EntryError::KeyInvalid);
    }
    match parse_link(text, base) {
        Ok(link) if link.id != id => Err(EntryError::OtherTransfer),
        Ok(Link { key: Some(identity), .. }) => Ok(identity),
        _ => Err(EntryError::KeyInvalid),
    }
}

// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::collections::HashMap;
    use std::time::Instant;

    const CONTENT: &str = include_str!("../../tests/vectors/e2ee/content.json");
    const DECRYPT: &str = include_str!("../../tests/vectors/e2ee/decrypt.json");
    const META: &str = include_str!("../../tests/vectors/e2ee/meta.json");
    const KEYCHECK: &str = include_str!("../../tests/vectors/e2ee/keycheck.json");
    const KEYS: &str = include_str!("../../tests/vectors/e2ee/keys.json");
    const LINKS: &str = include_str!("../../tests/vectors/e2ee/links.json");
    const NAMES: &str = include_str!("../../tests/vectors/e2ee/names.json");
    const LAYOUT: &str = include_str!("../../tests/vectors/e2ee/layout.json");
    const CCTV_MANIFEST: &str = include_str!("../../tests/vectors/e2ee/cctv/manifest.json");

    macro_rules! cctv {
        ($($name:literal),* $(,)?) => { &[$(($name, include_bytes!(concat!("../../tests/vectors/e2ee/cctv/", $name)) as &[u8])),*] };
    }

    const CCTV: &[(&str, &[u8])] = cctv![
        "header_crlf", "hmac_bad", "hmac_extra_space", "hmac_garbage", "hmac_missing", "hmac_no_space", "hmac_not_canonical",
        "hmac_trailing_space", "hmac_truncated", "hybrid_x25519_arg", "stanza_bad_start", "stanza_base64_padding",
        "stanza_empty_argument", "stanza_empty_body", "stanza_empty_last_line", "stanza_invalid_character", "stanza_long_line",
        "stanza_missing_body", "stanza_missing_final_line", "stanza_multiple_short_lines", "stanza_no_arguments",
        "stanza_not_canonical", "stanza_spurious_cr", "stanza_valid_characters", "stream_257_chunks", "stream_257_chunks_full",
        "stream_258_chunks", "stream_bad_tag", "stream_bad_tag_second_chunk", "stream_bad_tag_second_chunk_full",
        "stream_empty_payload", "stream_last_chunk_empty", "stream_last_chunk_full", "stream_last_chunk_full_second",
        "stream_missing_tag", "stream_no_chunks", "stream_no_final", "stream_no_final_full", "stream_no_final_two_chunks",
        "stream_no_final_two_chunks_full", "stream_no_nonce", "stream_short_chunk", "stream_short_nonce",
        "stream_short_second_chunk", "stream_three_chunks", "stream_trailing_garbage_long", "stream_trailing_garbage_short",
        "stream_two_chunks", "stream_two_final_chunks", "stream_two_final_chunks_full", "stream_two_final_chunks_second",
        "stream_two_final_chunks_short", "version_unsupported", "x25519", "x25519_bad_tag", "x25519_extra_argument",
        "x25519_grease", "x25519_identity", "x25519_long_file_key", "x25519_long_share", "x25519_low_order", "x25519_lowercase",
        "x25519_multiple_recipients", "x25519_no_match", "x25519_not_canonical_body", "x25519_not_canonical_share",
        "x25519_short_share",
    ];

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    fn s(value: &Value) -> &str {
        value.as_str().unwrap_or_else(|| panic!("not a string: {value}"))
    }

    fn n(value: &Value) -> u64 {
        value.as_u64().unwrap_or_else(|| panic!("not a number: {value}"))
    }

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn sha(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    fn array<const N: usize>(value: &Value) -> [u8; N] {
        unhex(s(value)).try_into().unwrap()
    }

    fn identity(value: &Value) -> Identity {
        Identity(Secret(array(value)))
    }

    fn fixed(identity: &Identity, file: &Value, size: u64) -> AgeFile {
        AgeFile::build(identity, &Secret(array(&file["fileKey"])), &Secret(array(&file["eph"])), array(&file["nonce"]), size)
    }

    /// The vectors' plaintext: byte i is i mod 251.
    fn pattern(at: u64, buf: &mut [u8]) -> io::Result<()> {
        for (k, byte) in buf.iter_mut().enumerate() {
            *byte = ((at + k as u64) % 251) as u8;
        }
        Ok(())
    }

    fn pattern_vec(size: u64) -> Vec<u8> {
        let mut out = vec![0; size as usize];
        pattern(0, &mut out).unwrap();
        out
    }

    /// A reader that hands out at most `step` bytes per call, and fails once at `fail_at` if set.
    struct Trickle<'a> {
        data: &'a [u8],
        at: usize,
        step: usize,
        fail_at: Option<usize>,
    }

    impl Read for Trickle<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let mut n = buf.len().min(self.step).min(self.data.len() - self.at);
            if let Some(limit) = self.fail_at {
                if self.at >= limit {
                    self.fail_at = None;
                    return Err(io::Error::new(io::ErrorKind::ConnectionReset, "test"));
                }
                n = n.min(limit - self.at);
            }
            buf[..n].copy_from_slice(&self.data[self.at..self.at + n]);
            self.at += n;
            Ok(n)
        }
    }

    fn trickle(data: &[u8], step: usize) -> Trickle<'_> {
        Trickle { data, at: 0, step, fail_at: None }
    }

    fn code(result: &Result<u64, StreamError>) -> &'static str {
        match result {
            Ok(_) => "success",
            Err(StreamError::Crypto(error)) => error.code(),
            Err(error) => panic!("unexpected {error}"),
        }
    }

    /// §4.2 on `data`: as `fyl decrypt` does, or as `fyl download` does with the content file of a verified head and P;
    /// (code, released plaintext).
    fn decrypt_with(identity: &Identity, verified: Option<(&[u8], u64)>, data: &[u8], step: usize) -> (&'static str, Vec<u8>) {
        let mut out = Vec::new();
        let result = match verified {
            Some((head, size)) => open_header(identity, head, size).unwrap().decryptor().run(&mut trickle(data, step), &mut out),
            None => decrypt(identity, &mut trickle(data, step), &mut out),
        };
        if let Ok(size) = result {
            assert_eq!(size, out.len() as u64);
        }
        (code(&result), out)
    }

    /// Parts computed on their own, in the given order, then put in place. Every read is at most 1 MiB (§7 step 4).
    fn parts_in_order(file: &AgeFile, part_size: u64, order: &[u64]) -> Vec<Vec<u8>> {
        let mut parts = vec![Vec::new(); order.len()];
        for &p in order {
            parts[p as usize - 1] = file
                .encrypt_part(part_size, p, |at, buf| {
                    assert!(buf.len() <= 1 << 20, "a read of {} bytes", buf.len());
                    pattern(at, buf)
                })
                .unwrap();
        }
        parts
    }

    fn check_parts(file: &AgeFile, part_size: u64, vector: &Value) {
        let c = ciphertext_size(file.size());
        let expected = vector["parts"].as_array().unwrap();
        assert_eq!(parts(c, part_size), expected.len() as u64);
        let order: Vec<u64> = (1..=expected.len() as u64).rev().collect();
        let built = parts_in_order(file, part_size, &order);
        let mut whole = Sha256::new();
        for (part, want) in built.iter().zip(expected) {
            let p = n(&want["part"]);
            assert_eq!(part_range(c, part_size, p), Some((n(&want["start"]), n(&want["end"]))), "{p}");
            assert_eq!(part_chunks(c, part_size, p), Some((n(&want["firstChunk"]), n(&want["lastChunk"]))), "{p}");
            assert_eq!(sha(part), s(&want["sha256"]), "part {p} of {} by {part_size}", file.size());
            let (md5, content_md5) = md5_pin(part);
            assert_eq!((md5.as_str(), content_md5.as_str()), (s(&want["md5"]), s(&want["contentMd5"])));
            whole.update(part);
        }
        assert_eq!(hex(&whole.finalize()), s(&vector["sha256"]));
    }

    #[test]
    fn content_vectors() {
        let doc = json(CONTENT);
        let id = identity(&doc["identity"]);
        assert_eq!(id.key(), s(&doc["key"]));
        assert_eq!(hex(id.public().as_bytes()), s(&doc["recipient"]));
        let f = &doc["file"];
        let eph = StaticSecret::from(array::<32>(&f["eph"]));
        let share = PublicKey::from(&eph);
        let shared = eph.diffie_hellman(&id.public());
        assert_eq!(hex(share.as_bytes()), s(&f["share"]));
        assert_eq!(hex(shared.as_bytes()), s(&f["sharedSecret"]));
        assert_eq!(hex(&wrap_key(shared.as_bytes(), share.as_bytes(), id.public().as_bytes()).0), s(&f["wrapKey"]));
        assert_eq!(hex(&hkdf(&array::<16>(&f["fileKey"]), b"", b"header").0), s(&f["headerKey"]));
        assert_eq!(hex(&hkdf(&array::<16>(&f["fileKey"]), &array::<16>(&f["nonce"]), b"payload").0), s(&f["payloadKey"]));
        let file = fixed(&id, f, 0);
        assert_eq!(hex(file.head()), s(&f["head"]));
        assert_eq!(&file.head()[..123], s(&f["hdr"]).as_bytes());
        assert_eq!(file.head_sha256(), s(&f["headSha256"]));
        let stanza = stanza(&id, file.head(), true).ok().unwrap();
        assert_eq!((hex(&stanza.body), hex(&stanza.mac)), (s(&f["body"]).to_string(), s(&f["mac"]).to_string()));

        for v in doc["vectors"].as_array().unwrap() {
            let size = n(&v["plaintextSize"]);
            let c = ciphertext_size(size);
            assert_eq!((c, chunks(size)), (n(&v["ciphertextSize"]), n(&v["chunks"])));
            assert_eq!(size - CHUNK as u64 * (chunks(size) - 1), n(&v["lastChunkPlaintext"]));
            assert_eq!(plaintext_size(c), Some(size));
            let file = fixed(&id, f, size);
            check_parts(&file, PART, v);
            if c > 1 << 20 {
                continue;
            }
            let stream = file.encrypt_all(&pattern_vec(size));
            assert_eq!(sha(&stream), s(&v["sha256"]));
            if let Some(ciphertext) = v.get("ciphertext") {
                assert_eq!(hex(&stream), s(ciphertext));
            }
            for (i, tag) in v["tags"].as_array().unwrap().iter().enumerate() {
                let end = (H + S * (i + 1)).min(stream.len());
                assert_eq!(hex(&stream[end - 16..end]), s(tag), "tag {i} of P={size}");
            }
            assert_eq!(decrypt_with(&id, None, &stream, usize::MAX), ("success", pattern_vec(size)));
        }
        for v in doc["slices"].as_array().unwrap() {
            check_parts(&fixed(&id, f, n(&v["plaintextSize"])), n(&v["partSize"]), v);
        }
    }

    #[test]
    fn decrypt_vectors() {
        let content = json(CONTENT);
        let id = identity(&content["identity"]);
        let mut streams: HashMap<u64, Vec<u8>> = HashMap::new();
        for v in json(DECRYPT)["vectors"].as_array().unwrap() {
            let why = s(&v["why"]);
            let mut data = Vec::new();
            for segment in v["input"].as_array().unwrap() {
                if let Some(text) = segment.get("hex") {
                    data.extend(unhex(s(text)));
                    continue;
                }
                if let Some(byte) = segment.get("repeat") {
                    data.extend(std::iter::repeat_n(unhex(s(byte))[0], n(&segment["count"]) as usize));
                    continue;
                }
                let size = n(&segment["content"]);
                let stream = streams.entry(size).or_insert_with(|| fixed(&id, &content["file"], size).encrypt_all(&pattern_vec(size)));
                let end = segment.get("end").map_or(stream.len(), |end| n(end) as usize);
                data.extend_from_slice(&stream[segment.get("start").map_or(0, n) as usize..end]);
            }
            assert_eq!((data.len() as u64, sha(&data)), (n(&v["inputSize"]), s(&v["inputSha256"]).to_string()), "{why}");
            let verified = v.get("verifiedHead").map(|head| (unhex(s(head)), n(&v["plaintextSize"])));
            for step in [usize::MAX, 1, 4093] {
                let verified = verified.as_ref().map(|(head, size)| (&head[..], *size));
                let (code, out) = decrypt_with(&identity(&v["identity"]), verified, &data, step);
                assert_eq!(code, s(&v["result"]), "{why} (reads of {step})");
                assert_eq!((out.len() as u64, sha(&out)), (n(&v["released"]), s(&v["releasedSha256"]).to_string()), "{why}");
            }
        }
    }

    #[test]
    fn meta_vectors() {
        let doc = json(META);
        let id = identity(&doc["identity"]);
        let head = unhex(s(&doc["head"]));
        assert_eq!(b64url(&Sha256::digest(&head)), s(&doc["headSha256"]));
        for v in doc["valid"].as_array().unwrap() {
            let (name, size, c) = (s(&v["name"]), n(&v["plaintextSize"]), n(&v["ciphertextSize"]));
            let text = meta_text(name, size, &head);
            assert_eq!(meta_json(name, size, &head), s(&v["text"]).as_bytes());
            assert_eq!(text.len() as u64, n(&v["paddedLength"]));
            let blob = fixed(&id, &doc["file"], text.len() as u64).encrypt_all(&text);
            assert_eq!(hex(&blob), s(&v["meta"]), "{name}");
            let checked = key_check(&id, &head, &blob, c).unwrap();
            assert_eq!((checked.name.as_str(), checked.size), (name, size));
            assert_eq!(checked.content.head()[..], head[..]);
        }
        for v in doc["invalid"].as_array().unwrap() {
            let blob = unhex(s(&v["meta"]));
            let mut text = Vec::new();
            assert_eq!(decrypt(&id, &mut &blob[..], &mut text).ok(), Some(n(&v["paddedLength"])));
            let shown = v.get("text").map_or_else(|| unhex(s(&v["textHex"])), |text| s(text).as_bytes().to_vec());
            assert_eq!(text[..shown.len()], shown[..]);
            assert!(text[shown.len()..].iter().all(|&b| b == b' '));
            let got = key_check(&id, &head, &blob, n(&v["ciphertextSize"])).map(|_| ()).unwrap_err();
            assert_eq!(got.code(), s(&v["result"]), "{}", s(&v["why"]));
        }
    }

    #[test]
    fn keycheck_vectors() {
        let doc = json(KEYCHECK);
        for v in doc["vectors"].as_array().unwrap() {
            let result = key_check(&identity(&v["identity"]), &unhex(s(&v["head"])), &unhex(s(&v["meta"])), n(&v["ciphertextSize"]));
            match result {
                Ok(checked) => {
                    assert_eq!(s(&v["result"]), "success", "{}", s(&v["why"]));
                    assert_eq!((checked.name.as_str(), checked.size), (s(&v["name"]), n(&v["plaintextSize"])));
                    assert_eq!(checked.content.size(), checked.size);
                }
                Err(error) => assert_eq!(error.code(), s(&v["result"]), "{}", s(&v["why"])),
            }
        }
        for v in doc["heads"].as_array().unwrap() {
            let got = open_header(&identity(&v["identity"]), &unhex(s(&v["head"])), 1).map(|_| "success");
            assert_eq!(got.unwrap_or_else(Error::code), s(&v["result"]), "{}", s(&v["why"]));
        }
    }

    #[test]
    fn key_vectors() {
        let doc = json(KEYS);
        for v in doc["valid"].as_array().unwrap() {
            let id = identity(&v["identity"]);
            assert_eq!((id.key(), id.age(), id.recipient()), (s(&v["key"]).into(), s(&v["ageIdentity"]).into(), s(&v["recipient"]).into()));
            assert_eq!(Identity::from_key(s(&v["key"])).unwrap().0 .0, id.0 .0);
            assert_eq!(Identity::from_age(s(&v["ageIdentity"])).unwrap().0 .0, id.0 .0);
            assert_eq!(Identity::from_age(&s(&v["ageIdentity"]).to_lowercase()).unwrap().0 .0, id.0 .0);
            assert!(!format!("{id:?}").contains(&id.key()));
        }
        for v in doc["invalidKeys"].as_array().unwrap() {
            assert_eq!(Identity::from_key(s(&v["key"])).map(|_| ()), Err(Error::KeyInvalid), "{}", s(&v["why"]));
        }
        for v in doc["invalidAgeIdentities"].as_array().unwrap() {
            assert_eq!(Identity::from_age(s(&v["ageIdentity"])).map(|_| ()), Err(Error::KeyInvalid), "{}", s(&v["why"]));
        }
        assert_eq!(b64url_decode(&b64url(&[1, 2, 3, 4])), Some(vec![1, 2, 3, 4]));
        assert_eq!(b64url_decode("AQ"), Some(vec![1]));
        assert_eq!(b64url_decode("AR"), None);
        assert_eq!(b64url_decode("AQ=="), None);
    }

    #[test]
    fn link_vectors() {
        let doc = json(LINKS);
        let base = "https://fyl.at";
        for v in doc["link"].as_array().unwrap() {
            let why = s(&v["why"]);
            match parse_link(s(&v["link"]), base) {
                Ok(link) => {
                    assert_eq!(link.id, s(&v["id"]), "{why}");
                    assert_eq!(link.key.map(|key| key.key()).as_deref(), v["key"].as_str(), "{why}");
                    assert_eq!(link.exposed, v["exposed"].as_bool().unwrap(), "{why}");
                }
                Err(error) => {
                    assert_eq!(n(&v["exit"]), 2, "{why}");
                    let want = if v.get("code").is_some() { LinkError::KeyInvalid } else { LinkError::Malformed };
                    assert_eq!(error, want, "{why}");
                }
            }
        }
        let id = s(&doc["id"]);
        for v in doc["entry"].as_array().unwrap() {
            let why = s(&v["why"]);
            let got = parse_entry(s(&v["input"]), base, id).map(|key| key.key());
            if let Some(key) = v.get("key") {
                assert_eq!(got.as_deref(), Ok(s(key)), "{why}");
            } else if v.get("otherTransfer").is_some() {
                assert_eq!(got, Err(EntryError::OtherTransfer), "{why}");
            } else {
                assert_eq!((got, s(&v["code"])), (Err(EntryError::KeyInvalid), "key_invalid"), "{why}");
            }
        }
        // The keyed share link; the KEY is parsed first here, so a key_invalid vector always has a matching url.
        for v in doc["share"].as_array().unwrap() {
            let why = s(&v["why"]);
            let got = Identity::from_key(s(&v["key"])).map_err(|_| "key_invalid").and_then(|key| {
                share_link(s(&v["origin"]), s(&v["id"]), s(&v["url"]), &key).map_err(|error| {
                    assert_eq!(error, LinkError::UrlMismatch, "{why}");
                    "url_mismatch"
                })
            });
            match v.get("link") {
                Some(link) => assert_eq!(got.as_deref(), Ok(s(link)), "{why}"),
                None => assert_eq!(got, Err(s(&v["code"])), "{why}"),
            }
        }
    }

    #[test]
    fn name_vectors() {
        for v in json(NAMES)["vectors"].as_array().unwrap() {
            let input: String = match v.get("utf16") {
                // Lone surrogates exist only in JavaScript strings; decoding maps each to the '_' it becomes there.
                Some(units) => char::decode_utf16(units.as_array().unwrap().iter().map(|u| n(u) as u16)).map(|c| c.unwrap_or('_')).collect(),
                None => s(&v["input"]).to_string(),
            };
            let name = normalize_name(&input);
            assert_eq!(name, s(&v["name"]), "{}", s(&v["why"]));
            assert!(name_ok(&name));
        }
        assert_eq!(normalize_name(""), "_");
        assert_eq!(normalize_name(&format!("{}x.", ".".repeat(1023))), "_", "only dots after shortening");
        assert_eq!(shorten_name("photo.jpeg", 8), "pho.jpeg");
    }

    #[test]
    fn layout_vectors() {
        let doc = json(LAYOUT);
        let k = &doc["constants"];
        assert_eq!((H, CHUNK, S, PART), (n(&k["H"]) as usize, n(&k["CHUNK"]) as usize, n(&k["S"]) as usize, n(&k["PART"])));
        let max = n(&k["MAX_FILE_BYTES"]);
        assert_eq!(max_plaintext(max), Some(n(&k["maxPlaintextSize"])));
        for v in doc["maxPlaintext"].as_array().unwrap() {
            assert_eq!(max_plaintext(n(&v["limit"])).map_or(-1, |p| p as i64), v["maxPlaintextSize"].as_i64().unwrap(), "{v}");
        }
        // Beyond JavaScript's range: C(P_max) itself must not overflow.
        let top = max_plaintext(u64::MAX).unwrap();
        assert_eq!(top, u64::MAX - 184 - 16 * chunks(top));
        assert!((top + 1).checked_add(184 + 16 * chunks(top + 1)).is_none());
        for v in doc["sizes"].as_array().unwrap() {
            let (p, c) = (n(&v["plaintextSize"]), n(&v["ciphertextSize"]));
            assert_eq!((ciphertext_size(p), plaintext_size(c), chunks(p)), (c, Some(p), n(&v["chunks"])));
            assert_eq!(p - CHUNK as u64 * (chunks(p) - 1), n(&v["lastChunkPlaintext"]));
            assert_eq!(parts(c, PART), n(&v["parts"]));
            assert_eq!(p >= 1 && c <= max, v["uploadable"].as_bool().unwrap());
        }
        for c in doc["invalidCiphertextSizes"].as_array().unwrap() {
            assert_eq!(plaintext_size(n(c)), None, "{c}");
        }
        for v in doc["partChunks"].as_array().unwrap() {
            let (c, p) = (n(&v["ciphertextSize"]), n(&v["part"]));
            assert_eq!(part_range(c, PART, p), Some((n(&v["start"]), n(&v["end"]))));
            assert_eq!(part_chunks(c, PART, p), Some((n(&v["firstChunk"]), n(&v["lastChunk"]))));
        }
        assert_eq!((part_range(201, PART, 0), part_range(201, PART, 2), part_chunks(201, 100, 1)), (None, None, None));
    }

    #[test]
    fn cctv_vectors() {
        let manifest = json(CCTV_MANIFEST);
        let entries = manifest["vectors"].as_array().unwrap();
        assert_eq!(entries.iter().map(|m| s(&m["file"])).collect::<Vec<_>>(), CCTV.iter().map(|(name, _)| *name).collect::<Vec<_>>());
        for ((name, raw), m) in CCTV.iter().zip(entries) {
            assert_eq!(sha(raw), s(&m["sha256"]), "{name}");
            let split = raw.windows(2).position(|w| w == b"\n\n").unwrap();
            let mut body = raw[split + 2..].to_vec();
            if m["compressed"].as_bool().unwrap() {
                body = miniz_oxide::inflate::decompress_to_vec_zlib(&body).unwrap();
            }
            let id = Identity::from_age(s(&m["identity"])).unwrap();
            for step in [usize::MAX, 1] {
                let (code, out) = decrypt_with(&id, None, &body, step);
                assert_eq!(code, s(&m["result"]), "{name} (CCTV: {})", s(&m["expect"]));
                assert_eq!((out.len() as u64, sha(&out)), (n(&m["released"]), s(&m["releasedSha256"]).to_string()), "{name}");
            }
        }
    }

    /// xorshift64*, seeded from the CSPRNG; the seed is in every failure message.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545f4914f6cdd1d)
        }

        fn below(&mut self, bound: u64) -> u64 {
            self.next() % bound
        }
    }

    #[test]
    fn random_round_trips() {
        let mut seed = [0; 8];
        random(&mut seed).unwrap();
        let seed = u64::from_le_bytes(seed) | 1;
        let mut rng = Rng(seed);
        for round in 0..40 {
            let size = match round {
                0..=4 => [0, 1, 65535, 65536, 65537][round],
                _ if round % 3 == 0 => CHUNK as u64 * (1 + rng.below(5)) + rng.below(3) - 1,
                _ => rng.below(5 * CHUNK as u64),
            };
            let context = format!("seed {seed:#x}, round {round}, P={size}");
            let mut plaintext = vec![0; size as usize];
            plaintext.iter_mut().for_each(|b| *b = rng.next() as u8);
            let id = Identity::generate().unwrap();
            let file = AgeFile::create(&id, size).unwrap();
            let stream = file.encrypt_all(&plaintext);
            assert_eq!(stream.len() as u64, ciphertext_size(size), "{context}");

            // Parts of a random size (at most 64, some inside the head), built in a random order, are slices of the stream.
            let c = stream.len() as u64;
            let part_size = (c / 64).max(1) + rng.below(c);
            let mut order: Vec<u64> = (1..=parts(c, part_size)).collect();
            for i in (1..order.len()).rev() {
                order.swap(i, rng.below(i as u64 + 1) as usize);
            }
            let mut built = vec![Vec::new(); order.len()];
            for &p in &order {
                built[p as usize - 1] = file.encrypt_part(part_size, p, reader(&plaintext)).unwrap();
            }
            assert_eq!(built.concat(), stream, "{context}, parts of {part_size}");

            let step = 1 + rng.below(3 * S as u64) as usize;
            let mut out = Vec::new();
            assert_eq!(decrypt(&id, &mut trickle(&stream, step), &mut out).ok(), Some(size), "{context}");
            assert_eq!(out, plaintext, "{context}");

            // A read failing anywhere resumes at offset() with the output cut back to plaintext().
            let mut decryptor = file.decryptor();
            let mut out = Vec::new();
            let mut reader = Trickle { data: &stream, at: 0, step, fail_at: Some(rng.below(c + 1) as usize) };
            match decryptor.run(&mut reader, &mut out) {
                Err(StreamError::Read(_)) => {
                    out.truncate(decryptor.plaintext() as usize);
                    let mut rest = trickle(&stream[decryptor.offset() as usize..], step);
                    assert_eq!(decryptor.run(&mut rest, &mut out).ok(), Some(size), "{context}");
                }
                other => assert_eq!(other.ok(), Some(size), "{context}"),
            }
            assert_eq!(out, plaintext, "{context}");

            let name = normalize_name(&format!("f/{round}\u{202e}.txt"));
            let meta = new_meta(&id, &name, size, file.head()).unwrap();
            let checked = key_check(&id, file.head(), &meta, c).unwrap();
            assert_eq!((checked.name, checked.size, checked.content.head()), (name, size, file.head()), "{context}");
            let other = Identity::generate().unwrap();
            assert_eq!(key_check(&other, file.head(), &meta, c).map(|_| ()), Err(Error::KeyWrong), "{context}");
        }
    }

    #[test]
    fn decryptor_never_succeeds_early() {
        let id = Identity::generate().unwrap();
        let file = AgeFile::create(&id, 3 * CHUNK as u64).unwrap();
        let stream = file.encrypt_all(&pattern_vec(3 * CHUNK as u64));
        for cut in [H, H + 1, H + S, H + 2 * S, stream.len() - 1] {
            let mut out = Vec::new();
            let mut decryptor = file.decryptor();
            let result = decryptor.run(&mut trickle(&stream[..cut], 1), &mut out);
            assert!(matches!(result, Err(StreamError::Crypto(Error::Truncated | Error::Corrupt))), "cut at {cut}");
            assert_eq!(out.len() as u64, decryptor.plaintext(), "only verified chunks are released");
            assert!(decryptor.run(&mut &stream[..], &mut out).is_err(), "a format error is final");
        }
        let mut long = stream.clone();
        long.push(0);
        let mut out = Vec::new();
        assert_eq!(code(&decrypt(&id, &mut &long[..], &mut out)), "trailing_data");
        // A stanza type running past the head: unsupported once something ends it, truncated if nothing does.
        let mut odd = b"age-encryption.org/v1\n-> ".to_vec();
        odd.resize(400, b'a');
        assert_eq!(code(&decrypt(&id, &mut trickle(&odd, 7), &mut out)), "truncated");
        odd.push(b'\n');
        assert_eq!(code(&decrypt(&id, &mut trickle(&odd, 7), &mut out)), "unsupported");
        assert_eq!(open_header(&id, &odd, 0).map(|_| ()).unwrap_err(), Error::Unsupported);
        let meta = new_meta(&id, "a", 1, file.head()).unwrap();
        assert_eq!(key_check(&id, &odd, &meta, 201).map(|_| ()).unwrap_err(), Error::Unsupported);
        assert_eq!(key_check(&id, file.head(), &odd, 201).map(|_| ()).unwrap_err(), Error::Unsupported);
    }

    /// A writer that refuses once after `left` bytes, like a full disk that frees up.
    struct Refuse {
        out: Vec<u8>,
        left: Option<usize>,
    }

    impl Write for Refuse {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if let Some(left) = self.left {
                if buf.len() > left {
                    self.left = None;
                    return Err(io::Error::new(io::ErrorKind::StorageFull, "test"));
                }
                self.left = Some(left - buf.len());
            }
            self.out.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn write_failure_resumes() {
        let id = Identity::generate().unwrap();
        let plaintext = pattern_vec(2 * CHUNK as u64 + 5);
        let file = AgeFile::create(&id, plaintext.len() as u64).unwrap();
        let stream = file.encrypt_all(&plaintext);
        let mut decryptor = file.decryptor();
        let mut writer = Refuse { out: Vec::new(), left: Some(CHUNK + 1) };
        assert!(matches!(decryptor.run(&mut &stream[..], &mut writer), Err(StreamError::Write(_))));
        assert_eq!((decryptor.offset(), decryptor.plaintext()), ((H + S) as u64, CHUNK as u64));
        writer.out.truncate(decryptor.plaintext() as usize);
        let rest = &stream[decryptor.offset() as usize..];
        assert_eq!(decryptor.run(&mut &rest[..], &mut writer).ok(), Some(plaintext.len() as u64));
        assert_eq!(writer.out, plaintext);
        let key = id.key();
        let link = format!("https://fyl.at/d/{}%23{key}#{key}", "a".repeat(43));
        assert_eq!(parse_link(&link, "https://fyl.at").map(|_| ()).unwrap_err(), LinkError::Malformed, "two keys");
    }

    /// A read failing right after the final chunk (while checking that nothing follows) resumes with the final chunk.
    #[test]
    fn read_failure_after_the_final_chunk_resumes() {
        let id = Identity::generate().unwrap();
        for size in [2 * CHUNK as u64, 2 * CHUNK as u64 + 1] {
            let plaintext = pattern_vec(size);
            let file = AgeFile::create(&id, size).unwrap();
            let stream = file.encrypt_all(&plaintext);
            let n = chunks(size);
            let (mut decryptor, mut out) = (file.decryptor(), Vec::new());
            let mut reader = Trickle { data: &stream, at: 0, step: usize::MAX, fail_at: Some(stream.len()) };
            assert!(matches!(decryptor.run(&mut reader, &mut out), Err(StreamError::Read(_))), "P={size}");
            assert_eq!((decryptor.offset(), decryptor.plaintext()), (H as u64 + S as u64 * (n - 1), CHUNK as u64 * (n - 1)), "P={size}");
            out.truncate(decryptor.plaintext() as usize);
            assert_eq!(decryptor.run(&mut &stream[decryptor.offset() as usize..], &mut out).ok(), Some(size), "P={size}");
            assert_eq!(out, plaintext, "P={size}");
        }
    }

    /// `fyl download`: the served head must be the verified one, and the file exactly the authenticated P.
    #[test]
    fn download_checks_head_and_size() {
        let id = Identity::generate().unwrap();
        let plaintext = pattern_vec(1000);
        let file = AgeFile::create(&id, 1000).unwrap();
        let mut stream = file.encrypt_all(&plaintext);
        let open = |size| open_header(&id, file.head(), size).unwrap().decryptor();
        let mut out = Vec::new();
        assert_eq!(open(1000).run(&mut &stream[..], &mut out).ok(), Some(1000));
        for size in [999, 1001] {
            let mut out = Vec::new();
            assert_eq!(code(&open(size).run(&mut &stream[..], &mut out)), "corrupt", "P bound to {size}");
            assert!(out.is_empty());
        }
        stream[130] ^= 1;
        let mut out = Vec::new();
        assert_eq!(code(&open(1000).run(&mut &stream[..], &mut out)), "corrupt", "served head differs");
        assert!(out.is_empty());
    }

    /// Single-threaded throughput on this machine: cargo test --release -- --ignored throughput --nocapture
    #[test]
    #[ignore]
    fn throughput() {
        let size = 4 * PART;
        let id = Identity::generate().unwrap();
        let file = AgeFile::create(&id, size).unwrap();
        let (mut stream, mut encrypt) = (Vec::new(), 0.0);
        for p in 1..=parts(ciphertext_size(size), PART) {
            let started = Instant::now();
            let part = file.encrypt_part(PART, p, |_, buf| {
                buf.fill(7);
                Ok(())
            });
            encrypt += started.elapsed().as_secs_f64();
            stream.extend(part.unwrap());
        }
        let started = Instant::now();
        assert_eq!(file.decryptor().run(&mut &stream[..], &mut io::sink()).ok(), Some(size));
        let decrypt = started.elapsed().as_secs_f64();
        let mib = size as f64 / (1 << 20) as f64;
        println!("encrypt (parts): {:.0} MiB/s, decrypt (stream): {:.0} MiB/s", mib / encrypt, mib / decrypt);
    }

    // Interoperability (docs/E2EE.md, "Interoperability evidence"): vectors written by the browser core, this core and
    // the reference age CLI through scripts/e2ee_interop.mjs.

    const CROSS: [(&str, &str); 3] = [
        ("browser", include_str!("../../tests/vectors/e2ee/cross/browser.json")),
        ("rust", include_str!("../../tests/vectors/e2ee/cross/rust.json")),
        ("age", include_str!("../../tests/vectors/e2ee/cross/age.json")),
    ];

    /// The cross vectors' plaintext: ChaCha20-Poly1305 with key `seed` and the zero nonce over `size` zero bytes, tag dropped.
    fn keystream(seed: &[u8; 32], size: u64) -> Vec<u8> {
        let mut out = vec![0; size as usize];
        ChaCha20Poly1305::new(seed.into()).encrypt_inout_detached(&Nonce::default(), b"", (&mut out[..]).into()).unwrap();
        out
    }

    fn reader(plaintext: &[u8]) -> impl FnMut(u64, &mut [u8]) -> io::Result<()> + '_ {
        move |at, buf| {
            buf.copy_from_slice(&plaintext[at as usize..at as usize + buf.len()]);
            Ok(())
        }
    }

    #[test]
    fn cross_vectors() {
        for (producer, text) in CROSS {
            for v in json(text)["vectors"].as_array().unwrap() {
                let why = format!("{producer}: {}", s(&v["why"]));
                let id = Identity::from_key(s(&v["key"])).unwrap();
                assert_eq!((id.age(), id.recipient()), (s(&v["ageIdentity"]).into(), s(&v["recipient"]).into()), "{why}");
                assert_eq!(Identity::from_age(s(&v["ageIdentity"])).unwrap().key(), s(&v["key"]), "{why}");
                assert_eq!(normalize_name(s(&v["input"])), s(&v["name"]), "{why}");
                // The keyed link: the browser's shareLink() form, parsed here, and every key-field form of it.
                let (base, transfer, key, link) = ("https://fyl.at", s(&v["id"]), s(&v["key"]), s(&v["link"]));
                assert_eq!(link, format!("{base}/d/{transfer}#{key}"), "{why}");
                let built = share_link(base, transfer, &format!("{base}/d/{transfer}"), &id);
                assert_eq!(built.as_deref(), Ok(link), "{why}");
                let parsed = parse_link(link, base).map(|link| (link.id, link.key.map(|key| key.key()), link.exposed));
                assert_eq!(parsed, Ok((transfer.to_string(), Some(key.to_string()), false)), "{why}");
                let keyless = parse_link(&format!("{base}/d/{transfer}"), base).map(|link| (link.id, link.key.is_none()));
                assert_eq!(keyless, Ok((transfer.to_string(), true)), "{why}");
                let (escaped, lower) = (format!("{base}/d/{transfer}%23{key}"), s(&v["ageIdentity"]).to_lowercase());
                for entry in [key, link, escaped.as_str(), s(&v["ageIdentity"]), lower.as_str()] {
                    let got = parse_entry(&format!(" \t\x0c{entry}\r\n"), base, transfer).map(|key| key.key());
                    assert_eq!(got, Ok(key.to_string()), "{why}: {entry}");
                }
                assert_eq!(parse_entry(link, base, "other").map(|_| ()), Err(EntryError::OtherTransfer), "{why}");
                let (size, c, part_size) = (n(&v["plaintextSize"]), n(&v["ciphertextSize"]), n(&v["partSize"]));
                assert_eq!(ciphertext_size(size), c, "{why}");
                let plaintext = keystream(&array(&v["seed"]), size);
                assert_eq!(sha(&plaintext), s(&v["plaintextSha256"]), "{why}");
                let head = unhex(s(&v["head"]));
                let checked = key_check(&id, &head, &unhex(s(&v["meta"])), c).unwrap_or_else(|error| panic!("{why}: {error:?}"));
                assert_eq!((checked.name.as_str(), checked.size), (s(&v["name"]), size), "{why}");
                // The producer's file rebuilt from its head, part by part, last first: equal hashes mean equal bytes.
                let expected = v["parts"].as_array().unwrap();
                assert_eq!(parts(c, part_size), expected.len() as u64, "{why}");
                let mut file = vec![0; c as usize];
                for want in expected.iter().rev() {
                    let p = n(&want["part"]);
                    let part = checked.content.encrypt_part(part_size, p, reader(&plaintext)).unwrap();
                    let (start, end) = part_range(c, part_size, p).unwrap();
                    assert_eq!((start, end), (n(&want["start"]), n(&want["end"])), "{why}, part {p}");
                    let (md5, content_md5) = md5_pin(&part);
                    let want: [&str; 3] = [s(&want["sha256"]), s(&want["md5"]), s(&want["contentMd5"])];
                    assert_eq!([sha(&part).as_str(), md5.as_str(), content_md5.as_str()], want, "{why}, part {p}");
                    file[start as usize..end as usize].copy_from_slice(&part);
                }
                assert_eq!(sha(&file), s(&v["sha256"]), "{why}");
                if let Some(ciphertext) = v.get("ciphertext") {
                    assert_eq!(hex(&file), s(ciphertext), "{why}");
                }
                // Decrypted as `fyl decrypt` does (identity, whole file) and as `fyl download` does (verified head).
                for step in [usize::MAX, 4093] {
                    assert_eq!(decrypt_with(&id, None, &file, step), ("success", plaintext.clone()), "{why}");
                }
                assert_eq!(decrypt_with(&id, Some((&head, size)), &file, S), ("success", plaintext), "{why}");
            }
        }
    }

    /// Writes this core's cross vectors for scripts/e2ee_interop.mjs: the cases from $FYL_CROSS_CASES, every key, head,
    /// meta and link from the production paths, compact JSON to $FYL_CROSS_WRITE. Without them it does nothing.
    #[test]
    #[ignore]
    fn cross_write() {
        let (Ok(cases), Ok(target)) = (std::env::var("FYL_CROSS_CASES"), std::env::var("FYL_CROSS_WRITE")) else { return };
        let mut vectors = Vec::new();
        for case in json(&std::fs::read_to_string(cases).unwrap()).as_array().unwrap() {
            let (size, id, mut seed, mut transfer) = (n(&case["plaintextSize"]), Identity::generate().unwrap(), [0; 32], [0; 32]);
            random(&mut seed).unwrap();
            random(&mut transfer).unwrap();
            let transfer = b64url(&transfer);
            let (plaintext, name, file) = (keystream(&seed, size), normalize_name(s(&case["input"])), AgeFile::create(&id, size).unwrap());
            let (meta, c) = (new_meta(&id, &name, size, file.head()).unwrap(), ciphertext_size(size));
            let checked = key_check(&id, file.head(), &meta, c).unwrap();
            assert_eq!((checked.name.as_str(), checked.size), (name.as_str(), size));
            let part_size = case["partSize"].as_u64().unwrap_or(c);
            let mut built: Vec<(u64, Vec<u8>)> =
                (1..=parts(c, part_size)).rev().map(|p| (p, file.encrypt_part(part_size, p, reader(&plaintext)).unwrap())).collect();
            built.reverse();
            let whole = built.iter().flat_map(|(_, part)| part.iter().copied()).collect::<Vec<u8>>();
            assert_eq!(whole, file.encrypt_all(&plaintext));
            let entries: Vec<Value> = built
                .iter()
                .map(|(p, part)| {
                    let ((start, end), (md5, content_md5)) = (part_range(c, part_size, *p).unwrap(), md5_pin(part));
                    serde_json::json!({"part": p, "start": start, "end": end, "sha256": sha(part), "md5": md5, "contentMd5": content_md5})
                })
                .collect();
            let mut v = serde_json::json!({
                "why": s(&case["why"]), "input": s(&case["input"]), "name": name, "plaintextSize": size, "seed": hex(&seed),
                "plaintextSha256": sha(&plaintext), "key": id.key(), "ageIdentity": id.age(), "recipient": id.recipient(),
                "id": transfer, "link": share_link("https://fyl.at", &transfer, &format!("https://fyl.at/d/{transfer}"), &id).unwrap(),
                "ciphertextSize": c, "head": hex(file.head()), "meta": hex(&meta), "sha256": sha(&whole), "partSize": part_size,
                "parts": entries,
            });
            if c <= 4096 {
                v["ciphertext"] = hex(&whole).into();
            }
            vectors.push(v);
        }
        std::fs::write(target, serde_json::json!({ "vectors": vectors }).to_string()).unwrap();
    }

    /// The local 1 GiB round trips of scripts/e2ee_interop.mjs. $FYL_INTEROP is `encrypt` ($FYL_INTEROP_IN to
    /// $FYL_INTEROP_OUT in 50 MiB parts as an upload builds them, the new KEY to $FYL_INTEROP_KEY) or `decrypt` (streaming
    /// with one chunk in memory, as `fyl decrypt`). Without it it does nothing.
    #[test]
    #[ignore]
    fn interop_file() {
        use std::fs::File;
        use std::os::unix::fs::FileExt;
        let Ok(mode) = std::env::var("FYL_INTEROP") else { return };
        let var = |name| std::env::var(name).unwrap();
        let (input, output, key) = (var("FYL_INTEROP_IN"), var("FYL_INTEROP_OUT"), var("FYL_INTEROP_KEY"));
        match mode.as_str() {
            "encrypt" => {
                let source = File::open(input).unwrap();
                let size = source.metadata().unwrap().len();
                let (id, mut target) = (Identity::generate().unwrap(), File::create(output).unwrap());
                let file = AgeFile::create(&id, size).unwrap();
                for p in 1..=parts(ciphertext_size(size), PART) {
                    target.write_all(&file.encrypt_part(PART, p, |at, buf| source.read_exact_at(buf, at)).unwrap()).unwrap();
                }
                target.sync_all().unwrap();
                std::fs::write(key, id.key()).unwrap();
            }
            "decrypt" => {
                let id = Identity::from_key(std::fs::read_to_string(key).unwrap().trim()).unwrap();
                let mut target = File::create(output).unwrap();
                decrypt(&id, &mut File::open(input).unwrap(), &mut target).unwrap();
                target.sync_all().unwrap();
            }
            other => panic!("FYL_INTEROP={other}"),
        }
    }
}

#!/usr/bin/env node
// Local interoperability harness for the E2EE cores (docs/E2EE.md, "Interoperability evidence"). CI never runs it; the
// browser and Rust test suites verify the vectors it writes to tests/vectors/e2ee/cross/.
//
//   node scripts/e2ee_interop.mjs write --age AGE [--age AGE ...] [--keygen AGE_KEYGEN ...]
//       rewrites browser.json, rust.json and age.json with fresh random values (needs cargo in PATH)
//   node scripts/e2ee_interop.mjs oracle --age AGE [--age AGE ...] [--keygen AGE_KEYGEN ...]
//       each reference age decrypts the content and meta of every committed browser and Rust vector
//   node scripts/e2ee_interop.mjs big --age AGE [--size BYTES] [--work DIR] [--keep]
//       1 GiB round trips browser -> Rust, Rust -> browser and age <-> both, elapsed time and peak RSS per step
//
// Every key here belongs to throwaway random test data and stays in the work directory, removed at the end.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, getRandomValues, randomFillSync } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as age from '../dist/e2ee/age.js';
import { metaPlaintext } from '../dist/e2ee/meta.js';
import { chacha20poly1305 } from '../dist/vendor/noble-ciphers-2.4.0/chacha.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CROSS = join(ROOT, 'tests/vectors/e2ee/cross'), CLI = join(ROOT, 'cli-rs'), SELF = fileURLToPath(import.meta.url);
const GiB = 1024 ** 3, ORIGIN = 'https://fyl.at';

// The same cases for every producer. partSize is the test-only part size of §6 (absent: one part, the whole file).
const CASES = [
  { why: 'one byte, one part', size: 1, input: 'a' },
  { why: 'parts of 100 bytes, boundaries inside the head', size: 1000, partSize: 100, input: 'Bericht "Q3" – Übersicht 📊.pdf' },
  { why: 'one short chunk; the longest meta (1024 quotes, 2760 bytes)', size: 65535, partSize: 30000, input: '"'.repeat(1024) },
  { why: 'one full chunk, flagged final; forbidden code points normalised', size: 65536, partSize: 65536, input: 'a/b\\c\u202egpj.exe' },
  { why: 'a 1-byte final chunk after a full one; a boundary inside chunk 1', size: 65537, partSize: 65552, input: 'notes.txt' },
  { why: 'two full chunks, the last flagged final; 1024-byte meta bucket', size: 131072, partSize: 50000, input: 'x'.repeat(600) + '.bin' },
  { why: "four chunks; part 2 starts inside chunk 1's tag", size: 200003, partSize: 131280, input: '日本語のファイル名.txt' },
  { why: 'seventeen chunks in five parts', size: 1048576 + 12345, partSize: 262144, input: 'archive.tar.gz' },
];

const ABOUT = 'docs/E2EE.md, "Interoperability evidence": vectors one implementation wrote for the others to verify '
  + '(scripts/e2ee_interop.mjs write). Values are random, drawn once by the production code paths, and fixed by this '
  + 'file. Plaintext of P bytes: ChaCha20-Poly1305(key = seed, nonce = 12 zero bytes) over P zero bytes, tag dropped. '
  + 'Verifiers: KEY gives ageIdentity and recipient; input normalises to name; the key check on head and meta gives name '
  + 'and P; every part of partSize, rebuilt from head and plaintext, has sha256, md5 and contentMd5 (equal hashes, equal '
  + 'bytes) and the parts make the whole file (sha256; ciphertext hex where C <= 4096); the file decrypts to the plaintext. '
  + 'link is the keyed share link for the random transfer id on https://fyl.at; it parses to id and key, and the key '
  + 'field takes KEY, the link, its %23 form and ageIdentity in either case, each padded with ASCII whitespace.';

const hex = data => Buffer.from(data).toString('hex');
const unhex = text => new Uint8Array(Buffer.from(text, 'hex'));
const sha256 = data => createHash('sha256').update(data).digest('hex');
const random = n => getRandomValues(new Uint8Array(n));
const keystream = (seed, size) => chacha20poly1305(seed, new Uint8Array(12)).encrypt(new Uint8Array(size)).subarray(0, size);
const run = (bin, args, input) => new Uint8Array(execFileSync(bin, args, { input, maxBuffer: 2 * GiB, stdio: ['pipe', 'pipe', 'inherit'] }));
const text = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function check(ok, message) {
  if (!ok) throw new Error(message);
}

function options(argv) {
  const out = { age: [], keygen: [], size: GiB, work: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = () => argv[++i];
    if (flag === '--age') out.age.push(resolve(value()));
    else if (flag === '--keygen') out.keygen.push(resolve(value()));
    else if (flag === '--size') out.size = Number(value());
    else if (flag === '--work') out.work = resolve(value());
    else if (flag === '--keep') out.keep = true;
    else throw new Error('Unknown option ' + flag);
  }
  return out;
}

// The vector files' layout: one line per vector, raw UTF-8 except controls, bidi and other invisible characters.
const VECTOR = ['why', 'tool', 'input', 'name', 'plaintextSize', 'seed', 'plaintextSha256', 'key', 'ageIdentity', 'recipient',
  'id', 'link', 'ciphertextSize', 'head', 'meta', 'sha256', 'partSize', 'parts', 'ciphertext'];
const PART = ['part', 'start', 'end', 'sha256', 'md5', 'contentMd5'];
const ordered = (value, keys) => Object.fromEntries(keys.filter(key => key in value).map(key => [key, value[key]]));
const compact = value => JSON.stringify(value).replace(/[^\x20-\x7e\p{L}\p{N}\p{P}\p{S}]/gu,
  ch => Array.from({ length: ch.length }, (_, i) => '\\u' + ch.charCodeAt(i).toString(16).padStart(4, '0')).join(''));

function dump(name, producer, vectors) {
  const lines = vectors.map(v => '  ' + compact({ ...ordered(v, VECTOR), parts: v.parts.map(p => ordered(p, PART)) }));
  writeFileSync(join(CROSS, name + '.json'), '{\n "about": ' + compact(ABOUT) + ',\n "producer": ' + compact(producer)
    + ',\n "vectors": [\n' + lines.join(',\n') + '\n ]\n}\n');
}

function partEntry(part, start, end) {
  return { part: part.number, start, end, sha256: sha256(part.bytes), md5: age.md5Hex(part.bytes), contentMd5: age.contentMd5(part.bytes) };
}

/** The fields every producer records about one finished age file; the link is the browser's shareLink(). */
async function vector(c, identity, seed, plaintext, file, head, meta, parts) {
  const key = age.encodeKey(identity), id = age.encodeKey(random(32));
  return {
    why: c.why, input: c.input, name: age.normalizeName(c.input), plaintextSize: c.size, seed: hex(seed), plaintextSha256: sha256(plaintext),
    key, ageIdentity: age.encodeAgeIdentity(identity), recipient: await age.ageRecipient(identity),
    id, link: age.shareLink(ORIGIN, id, `${ORIGIN}/d/${id}`, key),
    ciphertextSize: file.length, head: hex(head), meta: hex(meta), sha256: sha256(file), partSize: c.partSize ?? file.length, parts,
    ...(file.length <= 4096 ? { ciphertext: hex(file) } : {}),
  };
}

// The browser core's production path: prepareUpload (name, KEY, head, meta, key check) and encryptPart per part, built
// last part first, each on its own.
async function browserVectors() {
  const out = [];
  for (const c of CASES) {
    const seed = random(32), plaintext = keystream(seed, c.size);
    const upload = await age.prepareUpload(c.input, c.size), C = upload.ciphertextSize, partSize = c.partSize ?? C;
    const file = new Uint8Array(C), parts = [];
    for (let p = age.partCount(C, partSize); p >= 1; p--) {
      const bytes = await age.encryptPart(upload.content, plaintext, p, { partSize }), { start, end } = age.partRange(C, p, partSize);
      file.set(bytes, start);
      parts.unshift(partEntry({ number: p, bytes }, start, end));
    }
    check(sha256(file) === sha256(await age.encryptPart(upload.content, plaintext, 1, { partSize: C })), c.why);
    out.push(await vector(c, upload.identity, seed, plaintext, file, upload.head, upload.meta, parts));
  }
  return out;
}

// The Rust core's production path, in its ignored test cross_write; it writes compact JSON, laid out here.
function rustVectors(work) {
  const cases = join(work, 'cases.json'), written = join(work, 'rust.json');
  writeFileSync(cases, JSON.stringify(CASES.map(c => ({ why: c.why, input: c.input, plaintextSize: c.size, partSize: c.partSize }))));
  execFileSync('cargo', ['test', '--locked', 'e2ee::tests::cross_write', '--', '--ignored', '--exact'], {
    cwd: CLI, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, FYL_CROSS_CASES: cases, FYL_CROSS_WRITE: written },
  });
  return JSON.parse(readFileSync(written, 'utf8')).vectors;
}

// The reference age CLI encrypts plaintext and the §5.1 metadata text (`age -r`) to the recipient of an identity the
// browser core drew, or (every other case, with --keygen) one the reference age-keygen made, whose string and public key
// the browser core must reproduce. The browser key check must accept the pair before it is recorded.
async function ageVectors(tools, keygens, work) {
  const out = [];
  for (const [i, c] of CASES.entries()) {
    const tool = tools[i % tools.length], keygen = i % 2 && keygens.length ? keygens[(i >> 1) % keygens.length] : null;
    let identity = age.generateIdentity(), from = 'browser core';
    if (keygen) {
      const lines = text(keygen.bin, []).split('\n'), secret = lines.at(-1);
      identity = age.decodeAgeIdentity(secret);
      check(age.encodeAgeIdentity(identity) === secret && lines.includes('# public key: ' + await age.ageRecipient(identity)), 'age-keygen identity');
      from = keygen.version;
    }
    const recipient = await age.ageRecipient(identity);
    for (const other of keygens) {
      writeFileSync(join(work, 'identity.txt'), age.encodeAgeIdentity(identity) + '\n', { mode: 0o600 });
      check(text(other.bin, ['-y', join(work, 'identity.txt')]) === recipient, `${other.version} -y disagrees with ageRecipient`);
    }
    const seed = random(32), plaintext = keystream(seed, c.size), file = run(tool.bin, ['-r', recipient], plaintext);
    const head = file.subarray(0, age.H), meta = run(tool.bin, ['-r', recipient], await metaPlaintext(age.normalizeName(c.input), c.size, head));
    const checked = await age.checkKey(identity, head, meta, file.length);
    check(checked.size === c.size && checked.name === age.normalizeName(c.input), c.why);
    const partSize = c.partSize ?? file.length, parts = [];
    for (let p = 1; p <= age.partCount(file.length, partSize); p++) {
      const { start, end } = age.partRange(file.length, p, partSize);
      parts.push(partEntry({ number: p, bytes: file.subarray(start, end) }, start, end));
    }
    out.push({ tool: `${tool.version}; identity from ${from}`, ...await vector(c, identity, seed, plaintext, file, head, meta, parts) });
  }
  return out;
}

function lockVersions(names) {
  const lock = readFileSync(join(CLI, 'Cargo.lock'), 'utf8');
  return names.map(name => `${name} ${lock.match(new RegExp(`name = "${name}"\\nversion = "([^"]+)"`))[1]}`).join(', ');
}

const ageTools = (bins, name = 'age') => bins.map(bin => ({ bin, version: `${name} ${text(bin, ['--version'])}` }));

async function write(opts) {
  check(opts.age.length, 'write needs --age');
  const work = mkdtempSync(join(tmpdir(), 'fyl-interop-'));
  try {
    mkdirSync(CROSS, { recursive: true });
    // cargo compiles every cross file into the tests, so each must exist before rust.json is written.
    for (const name of ['browser', 'rust', 'age']) if (!existsSync(join(CROSS, name + '.json'))) writeFileSync(join(CROSS, name + '.json'), '{"vectors": []}\n');
    const tools = ageTools(opts.age);
    dump('browser', `browser core (dist/e2ee: WebCrypto, vendored @noble/ciphers 2.4.0) on Node ${process.version}`, await browserVectors());
    const rustc = text('rustc', ['--version']).split(' ').slice(0, 2).join(' ');
    dump('rust', `Rust core (cli-rs/src/e2ee.rs: ${lockVersions(['chacha20poly1305', 'x25519-dalek', 'hkdf', 'hmac', 'sha2', 'md-5'])}), ${rustc}`,
      rustVectors(work));
    const keygens = ageTools(opts.keygen, 'age-keygen');
    dump('age', `reference age CLI (${[...tools, ...keygens].map(t => t.version).join(', ')}; tool names the ones per vector)`,
      await ageVectors(tools, keygens, work));
    console.log('wrote', ['browser', 'rust', 'age'].map(name => `cross/${name}.json`).join(', '));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The producer's exact file, rebuilt from its head by the browser core; the recorded SHA-256 proves the bytes. */
async function rebuild(v) {
  const checked = await age.checkKey(age.decodeKey(v.key), unhex(v.head), unhex(v.meta), v.ciphertextSize);
  const plaintext = keystream(unhex(v.seed), v.plaintextSize);
  const file = await age.encryptPart(checked.content, plaintext, 1, { partSize: v.ciphertextSize });
  check(sha256(file) === v.sha256, `${v.why}: rebuilt file differs`);
  return file;
}

async function oracle(opts) {
  check(opts.age.length, 'oracle needs --age');
  const work = mkdtempSync(join(tmpdir(), 'fyl-interop-'));
  try {
    for (const tool of ageTools(opts.age)) {
      for (const producer of ['browser', 'rust']) {
        const { vectors } = JSON.parse(readFileSync(join(CROSS, producer + '.json'), 'utf8'));
        for (const v of vectors) {
          const identityFile = join(work, 'identity.txt'), contentFile = join(work, 'content.age'), metaFile = join(work, 'meta.age');
          writeFileSync(identityFile, v.ageIdentity + '\n', { mode: 0o600 });
          writeFileSync(contentFile, await rebuild(v));
          writeFileSync(metaFile, unhex(v.meta));
          for (const keygen of opts.keygen) check(text(keygen, ['-y', identityFile]) === v.recipient, `${v.why}: recipient`);
          check(sha256(run(tool.bin, ['-d', '-i', identityFile, contentFile])) === v.plaintextSha256, `${v.why}: content`);
          const meta = run(tool.bin, ['-d', '-i', identityFile, metaFile]), want = await metaPlaintext(v.name, v.plaintextSize, unhex(v.head));
          check(sha256(meta) === sha256(want), `${v.why}: meta`);
        }
        console.log(`${tool.version}: decrypted all ${vectors.length} ${producer} vectors (content and meta) to the exact plaintext`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- 1 GiB round trips -------------------------------------------------------------------------------------------

/** Encrypts like an upload: prepareUpload, then each 50 MiB part on its own, read in pieces from the file. */
async function encryptFile(input, output, keyFile) {
  const source = await open(input), size = (await source.stat()).size, target = await open(output, 'w');
  const upload = await age.prepareUpload(basename(input), size);
  const read = async (from, to) => {
    const buffer = new Uint8Array(to - from), { bytesRead } = await source.read(buffer, 0, buffer.length, from);
    return buffer.subarray(0, bytesRead);
  };
  for (let p = 1; p <= age.partCount(upload.ciphertextSize); p++) await target.write(await age.encryptPart(upload.content, read, p));
  await Promise.all([source.close(), target.close()]);
  writeFileSync(keyFile, upload.key, { mode: 0o600 });
}

/** Decrypts like a download: decryptReadable over a pull stream of 1 MiB reads, writing as chunks verify. */
async function decryptFile(input, output, keyFile) {
  const source = await open(input), target = await open(output, 'w');
  const stream = new ReadableStream({
    async pull(controller) {
      const buffer = new Uint8Array(1 << 20), { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead) controller.enqueue(buffer.subarray(0, bytesRead));
      else controller.close();
    },
  }, { highWaterMark: 0 });
  for await (const plaintext of age.decryptReadable(stream, readFileSync(keyFile, 'utf8').trim())) await target.write(plaintext);
  await Promise.all([source.close(), target.close()]);
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const piece of createReadStream(path, { highWaterMark: 1 << 20 })) hash.update(piece);
  return hash.digest('hex');
}

function rustTestBinary() {
  const lines = execFileSync('cargo', ['test', '--locked', '--no-run', '--message-format=json'], { cwd: CLI, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const artifact = lines.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .find(m => m.reason === 'compiler-artifact' && m.profile?.test && m.executable && m.target.kind.includes('bin'));
  check(artifact, 'no Rust test binary');
  return artifact.executable;
}

async function big(opts) {
  check(opts.age.length && Number.isSafeInteger(opts.size) && opts.size > 0, 'big needs --age and a size');
  const work = opts.work ?? mkdtempSync(join(tmpdir(), 'fyl-interop-'));
  mkdirSync(work, { recursive: true });
  const at = name => join(work, name), rust = rustTestBinary(), node = process.execPath, steps = [];
  let plainSha;
  const rustRun = (mode, input, output, key) => [rust, ['e2ee::tests::interop_file', '--ignored', '--exact', '--test-threads=1'],
    { FYL_INTEROP: mode, FYL_INTEROP_IN: input, FYL_INTEROP_OUT: output, FYL_INTEROP_KEY: key }];
  const measure = (label, [bin, args, env = {}]) => {
    const result = spawnSync('/usr/bin/time', ['-f', 'TIME %e %M', bin, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
    const line = result.stderr.trim().split('\n').at(-1).split(' ');
    check(result.status === 0 && line[0] === 'TIME', `${label} failed:\n${result.stderr}`);
    steps.push({ label, seconds: Number(line[1]), rss: Number(line[2]) / 1024 });
  };
  const verify = async (label, output) => {
    check(await fileSha256(output) === plainSha, `${label}: plaintext differs`);
    steps.at(-1).ok = true;
    rmSync(output);
  };
  try {
    const plain = at('plain'), handle = await open(plain, 'w'), hash = createHash('sha256');
    for (let done = 0; done < opts.size;) {
      const piece = randomFillSync(new Uint8Array(Math.min(16 << 20, opts.size - done)));
      hash.update(piece);
      await handle.write(piece);
      done += piece.length;
    }
    await handle.close();
    plainSha = hash.digest('hex');
    const tools = ageTools(opts.age), tool = tools.at(-1);

    measure('browser encrypt (prepareUpload, encryptPart per 50 MiB part)', [node, [SELF, 'encrypt', plain, at('b.age'), at('b.key')]]);
    measure('Rust decrypt (decrypt, streaming)', rustRun('decrypt', at('b.age'), at('out'), at('b.key')));
    await verify('browser -> Rust', at('out'));
    measure('Rust encrypt (encrypt_part per 50 MiB part)', rustRun('encrypt', plain, at('r.age'), at('r.key')));
    measure('browser decrypt (decryptReadable, streaming)', [node, [SELF, 'decrypt', at('r.age'), at('out'), at('r.key')]]);
    await verify('Rust -> browser', at('out'));

    for (const [from, file] of [['browser', 'b'], ['Rust', 'r']]) {
      writeFileSync(at('identity.txt'), age.encodeAgeIdentity(age.decodeKey(readFileSync(at(file + '.key'), 'utf8').trim())) + '\n', { mode: 0o600 });
      for (const t of tools) {
        measure(`${t.version} -d (${from} file)`, [t.bin, ['-d', '-i', at('identity.txt'), '-o', at('out'), at(file + '.age')]]);
        await verify(`${from} -> ${t.version}`, at('out'));
      }
    }
    const identity = age.generateIdentity();
    writeFileSync(at('a.key'), age.encodeKey(identity), { mode: 0o600 });
    measure(`${tool.version} -r`, [tool.bin, ['-r', await age.ageRecipient(identity), '-o', at('a.age'), plain]]);
    measure('browser decrypt (age file)', [node, [SELF, 'decrypt', at('a.age'), at('out'), at('a.key')]]);
    await verify('age -> browser', at('out'));
    measure('Rust decrypt (age file)', rustRun('decrypt', at('a.age'), at('out'), at('a.key')));
    await verify('age -> Rust', at('out'));

    console.log(`${opts.size} bytes, plaintext SHA-256 ${plainSha}; elapsed and peak RSS from /usr/bin/time`);
    for (const s of steps) {
      console.log(`${s.label.padEnd(62)} ${s.seconds.toFixed(1).padStart(6)} s ${s.rss.toFixed(0).padStart(6)} MiB${s.ok ? '  plaintext identical' : ''}`);
    }
  } finally {
    if (!opts.keep) rmSync(work, { recursive: true, force: true });
  }
}

const [command, ...rest] = process.argv.slice(2);
const commands = {
  write: () => write(options(rest)),
  oracle: () => oracle(options(rest)),
  big: () => big(options(rest)),
  encrypt: () => encryptFile(...rest),
  decrypt: () => decryptFile(...rest),
};
check(commands[command], 'usage: node scripts/e2ee_interop.mjs write|oracle|big --age AGE ... (see the header)');
await commands[command]();

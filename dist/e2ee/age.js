// fyl.at end-to-end encryption, profile fyl-e2ee-1 (docs/E2EE.md): the API the upload page, the download page and
// their workers import. All randomness comes from the platform CSPRNG; no export takes injected values.
import { MAX_FILE_BYTES, checkKey, ciphertextSize, maxPlaintextSize, sealContent, sealMeta, toIdentity } from './core.js';
import { bech32, encodeKey, fromBase64, toBase64 } from './encoding.js';
import { E2EEError } from './errors.js';
import { normalizeName } from './meta.js';
import { publicKey, random } from './primitives.js';

export {
  CHUNK, Decryptor, H, MAX_FILE_BYTES, PART, S, TAG, checkKey, chunkCount, chunkOffset, ciphertextSize, decryptBytes,
  decryptReadable, decryptStream, encryptPart, maxPlaintextSize, openContent, partCount, partRange, plaintextSize,
} from './core.js';
export { decodeAgeIdentity, decodeKey, encodeAgeIdentity, encodeKey } from './encoding.js';
export { E2EEError } from './errors.js';
export { parseKeyEntry, parseLink, shareLink } from './links.js';
export { contentMd5, md5, md5Hex } from './md5.js';
export { normalizeName, validName } from './meta.js';
export { supported } from './primitives.js';

/** 32 bytes from the CSPRNG: the X25519 identity whose b64url form is KEY (§3.1). */
export const generateIdentity = () => random(32);

/** The content key for a file of P bytes, with a fresh head (§4.1), generated once per transfer. */
export const createContent = (identity, size) => sealContent(identity, size);

/** The metadata blob for a normalised name, P and the content head (§5). */
export const createMeta = (identity, name, size, head) => sealMeta(identity, name, size, head);

/** age's public recipient string (`age1…`) for the standard-tool path; never sent anywhere. */
export const ageRecipient = async identity => bech32('age', await publicKey(toIdentity(identity)));

/** head and meta as the API carries them (b64url); a value that isn't canonical b64url is corrupt. */
export const encodeBlob = data => toBase64(data, true);
export function decodeBlob(text) {
  const data = fromBase64(text, true);
  if (!data) throw new E2EEError('corrupt');
  return data;
}

/**
 * §7 step 1 for a file of `size` (P) bytes: normalises the name, generates KEY, the content head and the metadata,
 * and runs the recipient's key check on them, so a drift between implementations costs no upload. `maxFileBytes` is
 * the server's limit on the stored size (/config.js). Returns what init needs (`ciphertextSize`, `head`, `meta`) and
 * `content` for encryptPart(), bound to `size` by the key check.
 */
export async function prepareUpload(name, size, { maxFileBytes = MAX_FILE_BYTES } = {}) {
  if (!Number.isSafeInteger(size) || size < 1 || size > maxPlaintextSize(maxFileBytes)) throw new RangeError('The file is empty or too large.');
  const identity = generateIdentity(), normalized = normalizeName(name);
  const { head } = await createContent(identity, size);
  const meta = await createMeta(identity, normalized, size, head), stored = ciphertextSize(size);
  const checked = await checkKey(identity, head, meta, stored);
  if (checked.name !== normalized || checked.size !== size) throw new E2EEError('corrupt');
  return { identity, key: encodeKey(identity), name: normalized, size, ciphertextSize: stored, head, meta, content: checked.content };
}

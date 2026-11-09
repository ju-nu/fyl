// E2EE links (docs/E2EE.md §2.2, §2.4, §10 step 1). KEY only ever goes into the fragment of a link built here.
import { decodeAgeIdentity, decodeKey, encodeKey } from './encoding.js';
import { E2EEError } from './errors.js';

const ID = /^[A-Za-z0-9_-]+$/;
// https://HOST[:PORT], HOST a DNS name or a bracketed IPv6 address; http:// only on loopback (§2.2).
const ORIGIN = /^(?:https:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))(?::[0-9]+)?$/;

/**
 * `<origin>/d/<ID>[/<segment>][?dl=1][#KEY]` → {id, key, exposed}, key null for none (or an empty fragment). `%23`
 * right after the ID counts as `#`, and `exposed` says the key came that way, so it was in the request path (§9.5);
 * elsewhere `%23` is part of the segment, which is never a key. A fragment that isn't a KEY is key_invalid, anything
 * else malformed link_invalid.
 */
export function parseLink(link, origin) {
  if (typeof link !== 'string') throw new E2EEError('link_invalid');
  const hash = link.indexOf('#');
  let rest = hash < 0 ? link : link.slice(0, hash), fragment = hash < 0 ? '' : link.slice(hash + 1);
  const query = rest.indexOf('?');
  if (query >= 0) {
    if (rest.slice(query) !== '?dl=1') throw new E2EEError('link_invalid');
    rest = rest.slice(0, query);
  }
  const prefix = origin + '/d/';
  if (!rest.startsWith(prefix)) throw new E2EEError('link_invalid');
  const match = /^([A-Za-z0-9_-]+)(?:%23(.*)|\/.*)?$/s.exec(rest.slice(prefix.length));
  if (!match) throw new E2EEError('link_invalid');
  if (match[2]) {
    if (fragment) throw new E2EEError('link_invalid');
    fragment = match[2];
  }
  if (fragment) decodeKey(fragment);
  return { id: match[1], key: fragment || null, exposed: Boolean(match[2]) };
}

/**
 * The page's key field and the key prompt (§2.4): ASCII whitespace trimmed, then a KEY, an age identity string or a
 * full link to this transfer with a KEY; returns the KEY. Another transfer's link is other_transfer, the rest
 * key_invalid.
 */
export function parseKeyEntry(input, id, origin) {
  const text = String(input).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  if (/^age-secret-key-1/i.test(text)) return encodeKey(decodeAgeIdentity(text));
  if (!text.includes('/')) {
    decodeKey(text);
    return text;
  }
  let link;
  try {
    link = parseLink(text, origin);
  } catch {
    throw new E2EEError('key_invalid');
  }
  if (link.id !== id) throw new E2EEError('other_transfer');
  if (!link.key) throw new E2EEError('key_invalid');
  return link.key;
}

/**
 * The keyed share link `<origin>/d/<ID>#KEY` (§2.2), built from the client's own origin, never from the server's
 * `url`, which must be `<origin>/d/<ID>` byte for byte (url_mismatch otherwise: show, copy and store nothing).
 */
export function shareLink(origin, id, url, key) {
  if (typeof origin !== 'string' || !ORIGIN.test(origin) || typeof id !== 'string' || !ID.test(id) || url !== origin + '/d/' + id) {
    throw new E2EEError('url_mismatch');
  }
  decodeKey(key);
  return url + '#' + key;
}

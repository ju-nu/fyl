import { ApiError, isObject, metric } from './shared';

/**
 * Cloudflare Access in front of the admin host (ADMIN_HOST, admin.fyl.at). Access signs every request it lets through
 * with a JWT in Cf-Access-Jwt-Assertion; the Worker checks it again, so a missing or loosened Access policy still
 * serves nothing: RS256 against the team's published keys (https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs), `aud`
 * containing ACCESS_AUD, `iss` the team's address, `exp`, `nbf` and `iat` with a minute of leeway. An identity token
 * names the person (`email`), a service token's names its client id (`common_name`); either passes. Only an identity
 * on ADMIN_EMAILS is the `owner`, whom the read-only operator views trust without ADMIN_TOKEN. The token and the
 * e-mail are never logged or counted; `access_denied` counts the reason only.
 */
export interface Access { kind: 'identity' | 'service'; owner: boolean }

/** Clocks of Cloudflare's machines and ours may differ a little. */
const LEEWAY_S = 60;
/** The published keys are used this long before they are fetched again; an unknown kid fetches them sooner, at most every REFETCH_MS. */
const KEYS_TTL_MS = 60 * 60 * 1000;
const REFETCH_MS = 30 * 1000;
/** While the certs endpoint fails, keys fetched within this long still verify (Access rotates its keys every few weeks, with overlap). */
const STALE_MS = 24 * 60 * 60 * 1000;
const CERTS_TIMEOUT_MS = 5000;
const TEAM = /^[a-z0-9-]{1,63}\.cloudflareaccess\.com$/;

let cached: { team: string; at: number; keys: Map<string, CryptoKey> } | null = null;
/** Drops the cached keys (tests start each case from a fetch). */
export const forgetAccessKeys = () => { cached = null; };

/** The admin host in lower case, or '' when ADMIN_HOST is unset: then no host is the admin host. */
export const adminHostOf = (env: Pick<Env, 'ADMIN_HOST'>) => String(env.ADMIN_HOST ?? '').trim().toLowerCase();
/** The report host (REPORT_HOST, report.fyl.at), or '' when the report form stays on the public host (development). */
export const reportHostOf = (env: Pick<Env, 'REPORT_HOST'>) => String(env.REPORT_HOST ?? '').trim().toLowerCase();

/**
 * Local development only (scripts/dev.mjs): the admin host answers without Access when ACCESS_TEAM_DOMAIN is empty,
 * DEV_ACCESS_BYPASS is "1" and the admin host is a *.localhost name, all three. Production's wrangler.jsonc sets the
 * team and admin.fyl.at, and `npm run deploy` refuses a DEV_ACCESS_BYPASS secret, so this can never apply there.
 */
export const devBypass = (env: Pick<Env, 'ADMIN_HOST' | 'ACCESS_TEAM_DOMAIN' | 'DEV_ACCESS_BYPASS'>) =>
  !String(env.ACCESS_TEAM_DOMAIN ?? '').trim() && env.DEV_ACCESS_BYPASS === '1' && /(?:^|\.)localhost$/.test(adminHostOf(env));

const base64url = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
const decoded = (text: string): unknown => { try { return JSON.parse(new TextDecoder().decode(base64url(text))); } catch { return null; } };

/** The team's signing keys by kid, from the cache while fresh (or while a refetch for an unknown kid is too soon). */
async function keysOf(team: string, kid: string) {
  const now = Date.now(), fresh = cached?.team === team && now - cached.at < KEYS_TTL_MS;
  if (fresh && cached && (cached.keys.has(kid) || now - cached.at < REFETCH_MS)) return cached.keys;
  let body: unknown = null;
  try {
    const response = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(CERTS_TIMEOUT_MS) });
    body = response.ok ? await response.json() : null;
  } catch { /* unreachable or unreadable: below */ }
  if (!isObject(body) || !Array.isArray(body.keys)) {
    if (cached?.team === team && now - cached.at < STALE_MS) return cached.keys;
    throw new Error('Access certs unavailable');
  }
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    if (!isObject(jwk) || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
    keys.set(jwk.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  cached = { team, at: now, keys };
  return keys;
}

/** Why a token fails (the access_denied code), or the access it grants. */
async function verify(env: Env, token: string): Promise<Access | string> {
  const team = String(env.ACCESS_TEAM_DOMAIN ?? '').trim().toLowerCase(), audience = String(env.ACCESS_AUD ?? '').trim();
  if (!TEAM.test(team) || !audience) {
    console.error(JSON.stringify({ event: 'misconfigured', missing: TEAM.test(team) ? 'ACCESS_AUD' : 'ACCESS_TEAM_DOMAIN' }));
    metric(env, 'misconfigured');
    return 'unconfigured';
  }
  if (!token) return 'missing';
  const parts = token.length <= 16384 ? /^([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(token) : null;
  const header = parts ? decoded(parts[1]) : null, claims = parts ? decoded(parts[2]) : null;
  // A segment of 4n + 1 characters is no base64url at all (atob throws): malformed, like an unreadable header.
  let signature: ReturnType<typeof base64url> | null = null;
  try { if (parts) signature = base64url(parts[3]); } catch { /* below */ }
  if (!parts || !signature || !isObject(header) || !isObject(claims)) return 'malformed';
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return 'algorithm';
  let keys: Map<string, CryptoKey>;
  try { keys = await keysOf(team, header.kid); }
  catch { console.error(JSON.stringify({ event: 'access_certs_unavailable' })); return 'certs'; }
  const key = keys.get(header.kid);
  if (!key) return 'kid';
  const signed = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(`${parts[1]}.${parts[2]}`));
  if (!signed) return 'signature';
  if (claims.iss !== `https://${team}`) return 'issuer';
  if (!(Array.isArray(claims.aud) ? claims.aud.includes(audience) : claims.aud === audience)) return 'audience';
  const now = Date.now() / 1000;
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S < now) return 'expired';
  if ((claims.nbf !== undefined && !(typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S <= now))
    || (claims.iat !== undefined && !(typeof claims.iat === 'number' && claims.iat - LEEWAY_S <= now))) return 'not_yet_valid';
  if (typeof claims.email === 'string' && claims.email) {
    const owners = String(env.ADMIN_EMAILS ?? '').toLowerCase().split(',').map(entry => entry.trim()).filter(Boolean);
    return { kind: 'identity', owner: owners.includes(claims.email.toLowerCase()) };
  }
  if (typeof claims.common_name === 'string' && claims.common_name) return { kind: 'service', owner: false };
  return 'subject';
}

/** The access a request to the admin host carries, or 403 `access_denied`: nothing on that host is served without it. */
export async function accessOf(request: Request, env: Env): Promise<Access> {
  if (devBypass(env)) return { kind: 'identity', owner: true };
  const result = await verify(env, request.headers.get('Cf-Access-Jwt-Assertion')?.trim() || '');
  if (typeof result !== 'string') return result;
  if (result !== 'unconfigured') metric(env, 'access_denied', result);
  throw new ApiError(403, 'Cloudflare Access sign-in required.', 'access_denied');
}

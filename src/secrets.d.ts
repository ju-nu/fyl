// Secrets set with `wrangler secret put`. They are absent unless configured. CF_ANALYTICS_TOKEN (optional) is a read-only
// API token (Account Analytics Read) for the admin host's statistics. ADMIN_EMAILS lists the Cloudflare Access identities
// (comma-separated) that read the dashboard as its owner (src/access.ts); it is a secret so the public config names no one.
interface Env { ADMIN_TOKEN?: string; MONITOR_TOKEN?: string; NETWORK_HASH_KEY?: string; TURNSTILE_SECRET?: string; CF_ANALYTICS_TOKEN?: string; ADMIN_EMAILS?: string; DEV_ACCESS_BYPASS?: string; DEV_FAKE_STATS?: string }
declare namespace Cloudflare { interface Env { ADMIN_TOKEN?: string; MONITOR_TOKEN?: string; NETWORK_HASH_KEY?: string; TURNSTILE_SECRET?: string; CF_ANALYTICS_TOKEN?: string; ADMIN_EMAILS?: string; DEV_ACCESS_BYPASS?: string; DEV_FAKE_STATS?: string } }
// Local development only (scripts/dev.mjs passes them with --var): DEV_ACCESS_BYPASS="1" opens the admin host without
// Access (see devBypass() in src/access.ts), DEV_FAKE_STATS="1" answers /api/stats with sample data. Never in production:
// `npm run deploy` refuses either as a secret, and wrangler.jsonc must not name them.

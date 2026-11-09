// Deploy gate (`npm run deploy` runs it before `wrangler deploy`): the Worker refuses downloads, unlocks and operator
// calls without its secrets, so they must exist before new code goes live. Only names are listed and printed, never
// values. If the listing itself fails (a token without that permission, the API down), it warns and lets the deploy go on.
import { spawnSync } from 'node:child_process';
const REQUIRED = ['NETWORK_HASH_KEY', 'GRANT_SIGNING_KEY', 'ADMIN_TOKEN'];
const listed = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'list', '--format', 'json'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let names = null;
if (listed.status === 0) {
  try {
    const parsed = JSON.parse(listed.stdout.slice(listed.stdout.indexOf('['), listed.stdout.lastIndexOf(']') + 1));
    if (Array.isArray(parsed)) names = parsed.map(entry => entry?.name);
  } catch { /* not the listing */ }
}
if (!names) {
  console.warn('Warning: could not list the Worker secrets; deploying without checking them.');
  process.exit(0);
}
const missing = REQUIRED.filter(name => !names.includes(name));
if (missing.length) {
  console.error(`Missing Worker secrets: ${missing.join(', ')}. Set each with: openssl rand -base64 48 | npx wrangler secret put <NAME>`);
  process.exit(1);
}
// Development-only switches (scripts/dev.mjs passes them with --var): as secrets they would have no business in production.
const local = ['DEV_ACCESS_BYPASS', 'DEV_FAKE_STATS'].filter(name => names.includes(name));
if (local.length) {
  console.error(`Development-only Worker secrets are set: ${local.join(', ')}. Remove each with: npx wrangler secret delete <NAME>`);
  process.exit(1);
}
console.log(`Worker secrets present: ${REQUIRED.join(', ')}.`);
// The hourly monitor reads /api/admin/ready and /api/billing with MONITOR_TOKEN; the site works without it, the alerts don't.
if (!names.includes('MONITOR_TOKEN'))
  console.warn('Warning: MONITOR_TOKEN is not set, so the hourly monitor (readiness and the billing alert) cannot sign in. Set it with: openssl rand -base64 48 | npx wrangler secret put MONITOR_TOKEN');
// A previous grant key passes grants only for an hour after GRANT_SIGNING_KEY_ROTATED_AT (none without it), and
// /api/admin/ready fails while it is left in place: remind, but don't block a deploy over it.
if (names.includes('GRANT_SIGNING_KEY_PREVIOUS'))
  console.warn(`Warning: GRANT_SIGNING_KEY_PREVIOUS is still set${names.includes('GRANT_SIGNING_KEY_ROTATED_AT') ? '' : ' without GRANT_SIGNING_KEY_ROTATED_AT, so it passes no grant'}. `
    + 'Remove it an hour after the rotation: npx wrangler secret delete GRANT_SIGNING_KEY_PREVIOUS');
// Only the Access identities on ADMIN_EMAILS read the dashboard without the operator token; without it every read
// there answers 401. It is not required, so the deploy that drops the old plain var can go out before the secret
// exists (wrangler refuses a secret while a var of that name is deployed).
if (!names.includes('ADMIN_EMAILS'))
  console.warn('Warning: ADMIN_EMAILS is not set, so no Access identity reads the admin dashboard as its owner. '
    + "Set the owner's address (comma-separated for several) with: npx wrangler secret put ADMIN_EMAILS");
// The admin host's statistics and billing estimate read Cloudflare's analytics with a read-only API token; the
// dashboard says so until it is set, and the hourly monitor fails on the estimate's 503.
if (!names.includes('CF_ANALYTICS_TOKEN'))
  console.warn('Warning: CF_ANALYTICS_TOKEN is not set, so the admin dashboard shows no statistics and no billing estimate (/api/stats and /api/billing answer 503), '
    + 'and the hourly monitor fails on the missing estimate. '
    + 'Create an API token with Account > Account Analytics > Read, then: npx wrangler secret put CF_ANALYTICS_TOKEN');

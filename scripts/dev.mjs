import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generate } from './build_i18n.mjs';
// The pages in every language come from i18n/ (scripts/build_i18n.mjs); a template or catalog edited since the last
// build shows on the next start.
const generated = generate();
if (generated.length) console.log(`Generated ${generated.join(', ')} in dist/.`);
const forwarded = process.argv.slice(2);
const portFlag = forwarded.indexOf('--port');
const port = portFlag >= 0 ? forwarded[portFlag + 1] : forwarded.find(value => value.startsWith('--port='))?.split('=')[1] || process.env.PORT || '4173';
const host = process.env.HOST || '127.0.0.1';
// Links point at this server, not at fyl.at: an encrypting client puts the key only on a link to its own origin, and
// refuses an upload whose server names another one (docs/E2EE.md §2.2). PUBLIC_BASE_URL overrides it (another name for
// this machine); an address that listens everywhere is reached at 127.0.0.1.
const reached = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
const origin = process.env.PUBLIC_BASE_URL || `http://${reached.includes(':') ? `[${reached}]` : reached}:${port}`;
// Encrypted uploads are on locally whatever the emergency switch in wrangler.jsonc says (docs/E2EE.md §17), unless
// E2EE_ENABLED in the environment says otherwise.
// REPORT_HOST is emptied, so the report form is served locally at /<lang>/report instead of sending to report.fyl.at
// (a --var overrides wrangler.jsonc's vars, which env files can't).
const args = ['--ip', host, '--port', port, '--var', `PUBLIC_BASE_URL:${origin}`, '--var', `E2EE_ENABLED:${process.env.E2EE_ENABLED || 'true'}`, '--var', 'REPORT_HOST:'];
// Every other argument goes to wrangler dev as given, e.g. --persist-to DIR for a throwaway state (tests/test_local_worker.py).
args.push(...forwarded.filter((value, index) => !(value === '--port' || value.startsWith('--port=') || forwarded[index - 1] === '--port')));
// The Worker has no development fallback for its secrets: local ones are generated once (random, never printed) into
// .wrangler/, which git ignores. Not into .dev.vars, whose secret names would change `wrangler types`; a .dev.vars of
// your own still applies on top. wrangler dev loads no .env file this way, so the account tokens in it stay out.
const file = '.wrangler/dev-secrets.env', secrets = {};
if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) {
  const match = /^([A-Z_]+)=(.+)$/.exec(line);
  if (match) secrets[match[1]] = match[2];
}
const missing = ['NETWORK_HASH_KEY', 'GRANT_SIGNING_KEY', 'ADMIN_TOKEN', 'MONITOR_TOKEN'].filter(name => (secrets[name] || '').length < 32);
if (missing.length) {
  for (const name of missing) secrets[name] = randomBytes(48).toString('base64url');
  mkdirSync('.wrangler', { recursive: true });
  writeFileSync(file, Object.entries(secrets).map(([name, value]) => `${name}=${value}\n`).join(''), { mode: 0o600 });
  console.log(`Generated local ${missing.join(', ')} in ${file}.`);
}
const envFiles = ['--env-file', file, ...(existsSync('.dev.vars') ? ['--env-file', '.dev.vars'] : [])];
// The admin host, locally: http://admin.localhost:<port>/ (browsers and curl resolve *.localhost to this machine). The
// Worker sees the real local host (not fyl.at, the first route) so it can tell the two hosts apart. Development only,
// and only through these --var flags (env files can't override wrangler.jsonc vars): ACCESS_TEAM_DOMAIN and ACCESS_AUD
// emptied plus DEV_ACCESS_BYPASS=1 on a *.localhost admin host open it without Cloudflare Access (devBypass() in
// src/access.ts); DEV_FAKE_STATS=1 shows sample statistics. FYL_DEV_STATS=live reads Analytics Engine instead, with a
// CF_ANALYTICS_TOKEN of your own in .dev.vars.
const admin = ['--infer-origin-from-routes=false', '--var', 'ADMIN_HOST:admin.localhost', '--var', 'ACCESS_TEAM_DOMAIN:', '--var', 'ACCESS_AUD:',
  '--var', 'DEV_ACCESS_BYPASS:1', '--var', `DEV_FAKE_STATS:${process.env.FYL_DEV_STATS === 'live' ? '0' : '1'}`];
console.log(`Admin host: http://admin.localhost:${port}/ (no Cloudflare Access; ${process.env.FYL_DEV_STATS === 'live' ? 'live' : 'sample'} statistics).`);
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', ...envFiles, ...admin, ...args], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));

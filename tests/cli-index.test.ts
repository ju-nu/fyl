import { describe, expect, it } from 'vitest';
import { direct, useNetworkPrefix } from './helpers';

useNetworkPrefix('198.18.19.');

// /cli/version.json by client (cliIndex() in src/index.ts): the CLIs of the old numbering before 2.5.1 read every later
// release as older, so they get the bridge 2.5.1, which carries them on; everyone else gets the current release.
describe('/cli/version.json', () => {
  const index = async (agent: string | null, method = 'GET') => {
    const { response } = await direct('/cli/version.json', {}, { method, headers: agent === null ? {} : { 'User-Agent': agent } });
    const text = await response.text();
    return { status: response.status, text, cache: response.headers.get('Cache-Control'), vary: response.headers.get('Vary') };
  };

  it('names the bridge to the old CLIs that cannot see later releases, the current release to everyone else', async () => {
    const current = await (await direct('/cli/latest', {})).response.text();
    const bridge = JSON.parse(await (await direct('/cli/bridge.json', {})).response.text());
    expect([bridge.name, bridge.version, bridge.path]).toEqual(['fyl', '2.5.1', '/cli/2.5.1/']);
    expect(current.trim()).not.toBe(bridge.version);
    for (const agent of ['fyl-cli/2.5.0', 'fyl-cli/2.4.0', 'fyl-cli/2.0.0', 'fyl-cli/2.4.12', 'fyl-cli/2.5.0 fyl-smoke']) {
      const answer = await index(agent);
      expect([agent, answer.status, JSON.parse(answer.text)]).toEqual([agent, 200, bridge]);
    }
    for (const agent of ['fyl-cli/2.5.1', 'fyl-cli/2.5.1 fyl-smoke', 'fyl-cli/1.0.0', 'fyl-cli/1.4.2', 'fyl-cli/2.5.10', 'fyl-cli/2.6.0', 'fyl-cli/3.0.0',
      'fyl-cli/2.5', 'fyl-cli/2.4.0x', 'Mozilla/5.0 fyl-cli/2.4.0', 'curl/8.5.0', 'Mozilla/5.0 (Macintosh)', 'fyl-smoke/1.0.0', '', null]) {
      const answer = await index(agent);
      const named = JSON.parse(answer.text);
      expect([agent, answer.status, named.version, named.path]).toEqual([agent, 200, current.trim(), `/cli/${current.trim()}/`]);
    }
  });

  it('is kept by no shared cache, since the answer depends on the User-Agent', async () => {
    for (const agent of ['fyl-cli/2.5.0', 'fyl-cli/1.0.0', null]) {
      const answer = await index(agent);
      expect([agent, answer.cache, answer.vary]).toEqual([agent, 'private, max-age=60', 'User-Agent']);
    }
    const head = await index('fyl-cli/2.5.0', 'HEAD');
    expect([head.status, head.text, head.vary]).toEqual([200, '', 'User-Agent']);
  });
});

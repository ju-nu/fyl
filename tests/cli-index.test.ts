import { describe, expect, it } from 'vitest';
import { direct, useNetworkPrefix } from './helpers';

useNetworkPrefix('198.18.19.');

// /cli/version.json is a static file: every client, whatever its User-Agent, gets the current release.
describe('/cli/version.json', () => {
  it('names the current release to every client', async () => {
    const current = (await (await direct('/cli/latest', {})).response.text()).trim();
    for (const agent of ['fyl-cli/2.5.0', 'fyl-cli/1.0.0', 'curl/8.5.0', null]) {
      const { response } = await direct('/cli/version.json', {}, { headers: agent === null ? {} : { 'User-Agent': agent } });
      const named = JSON.parse(await response.text());
      expect([agent, response.status, named.version, named.path]).toEqual([agent, 200, current, `/cli/${current}/`]);
    }
  });
});

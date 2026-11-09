import { describe, expect, it } from 'vitest';
import { call, useNetworkPrefix } from './helpers';

useNetworkPrefix('198.18.31.');

// The tagline is "Fyl for now." and the brand is Fyl; the domain fyl.at and the command fyl stay lowercase.
describe('brand copy', () => {
  it('says "Fyl for now." in the home title, preview title and headline and in every footer, and "Fyls" nowhere', async () => {
    const home = await (await call('/en/')).text();
    expect(home).toContain('<title>fyl.at — Share files up to 50 GB · Fyl for now.</title>');
    expect(home).toContain('<meta property="og:title" content="fyl.at — Share files up to 50 GB · Fyl for now.">');
    expect(home).toContain('<h1 id="page-heading">Fyl for <span class="now">now.</span></h1>');
    for (const path of ['/', '/report', '/privacy', '/download']) {
      const page = path === '/' ? home : await (await call(path)).text();
      expect(page, path).toContain('<span class="footer-brand"><b>fyl.at</b> · Fyl for now.</span>');
      expect(page, path).not.toMatch(/Fyls/);
    }
  });
});

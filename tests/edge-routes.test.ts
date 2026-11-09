import { describe, expect, it } from 'vitest';
import { direct, useNetworkPrefix } from './helpers';

useNetworkPrefix('198.18.42.');

const html = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
const REPORT = { REPORT_HOST: 'report.fyl.at' } as unknown as Partial<Env>;

// Answers at the edges of the routes: files that don't exist, other methods, the report host's own files.
describe('a CLI file that does not exist', () => {
  it('is a plain-text 404 that no cache keeps, without the published files\' headers', async () => {
    for (const path of ['/cli/9.9.9/SHA256SUMS', '/cli/9.9.9/fyl-linux-x86_64', '/cli/nothing']) for (const method of ['GET', 'HEAD']) {
      const { response } = await direct(path, {}, { method });
      const body = await response.text();
      expect([path, method, response.status, response.headers.get('Cache-Control'), response.headers.get('Content-Type'), response.headers.get('Content-Disposition')])
        .toEqual([path, method, 404, 'no-store', 'text/plain; charset=utf-8', null]);
      expect([path, method, body]).toEqual([path, method, method === 'HEAD' ? '' : 'Not found.\n']);
    }
  });

  it('leaves the published files as they are', async () => {
    const latest = await (await direct('/cli/latest', {})).response.text();
    const { response } = await direct(`/cli/${latest.trim()}/SHA256SUMS`, {});
    await response.arrayBuffer();
    expect([response.status, response.headers.get('Cache-Control')]).toEqual([200, 'public, max-age=31536000, immutable']);
  });
});

describe('HEAD on /api/health', () => {
  it('answers like GET, without a body', async () => {
    const get = (await direct('/api/health', {})).response, head = (await direct('/api/health', {}, { method: 'HEAD' })).response;
    await get.arrayBuffer();
    expect([head.status, head.headers.get('Content-Type'), await head.text()]).toEqual([200, get.headers.get('Content-Type'), '']);
    expect((await direct('/api/health', {}, { method: 'POST' })).response.status).toBe(405);
  });
});

describe('a browser opening a page address that does not exist', () => {
  it('goes to the home page of its language (302), or of the language / would choose', async () => {
    for (const [path, language, location] of [['/faq', 'de-AT,de;q=0.9', '/de/'], ['/en/nonexistent', 'fr', '/en/'], ['/nl/old/page.html', 'en', '/nl/'],
      ['/something', 'ja', '/en/']] as const) {
      const { response } = await direct(path, {}, { headers: { ...html, 'Accept-Language': language }, redirect: 'manual' });
      expect([path, response.status, response.headers.get('Location'), response.headers.get('Cache-Control')]).toEqual([path, 302, location, 'no-store']);
    }
  });

  it('never for files, the API, the CLI, download links or /.well-known, nor for a request that is no navigation', async () => {
    for (const path of ['/missing.css', '/fonts/none.woff2', '/api/nothing', '/cli/9.9.9/SHA256SUMS', '/.well-known/nothing', '/vendor/x', '/e2ee/x', '/og/x']) {
      const { response } = await direct(path, {}, { headers: html, redirect: 'manual' });
      await response.arrayBuffer();
      expect([path, response.status]).toEqual([path, 404]);
    }
    const { response } = await direct('/faq', {}, { headers: { Accept: '*/*' }, redirect: 'manual' });
    expect(response.status).toBe(404);
    // A download link that doesn't work keeps its own page.
    const link = (await direct('/d/' + 'Q'.repeat(43), {}, { headers: html, redirect: 'manual' })).response;
    expect([link.status, (link.headers.get('Content-Type') || '').startsWith('text/html')]).toEqual([404, true]);
  });
});

describe('security.txt on the report host', () => {
  it('is the same file as on fyl.at, which names both addresses as canonical', async () => {
    const site = await (await direct('/.well-known/security.txt', {})).response.text();
    const { response } = await direct('https://report.fyl.at/.well-known/security.txt', REPORT);
    expect([response.status, response.headers.get('Content-Type'), await response.text()]).toEqual([200, 'text/plain; charset=utf-8', site]);
    expect([...site.matchAll(/^Canonical: (.+)$/gm)].map(match => match[1]))
      .toEqual(['https://fyl.at/.well-known/security.txt', 'https://report.fyl.at/.well-known/security.txt']);
  });
});

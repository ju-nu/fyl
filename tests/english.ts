import { vi } from 'vitest';
import en from '../i18n/en.json';

// The browser scripts take their messages from the page's JSON block #fyl-i18n, which scripts/build_i18n.mjs writes into
// every generated page (i18n/README.md); dist/i18n.js reads it into window.FylText. Tests run them in English, with
// every message of the catalog, as the English pages carry them.
export const ENGLISH = JSON.stringify({ lang: 'en', intl: 'en-GB', strings: en });

/**
 * Loads dist/i18n.js without a page, for the DOM-free parts of the scripts: FylText lands on `window` (stub it first),
 * and `document` is gone again afterwards, so download.js and report.js still stop before touching a page.
 */
export async function englishText() {
  vi.stubGlobal('document', { getElementById: (id: string) => id === 'fyl-i18n' ? { textContent: ENGLISH } : null });
  // @ts-expect-error: a browser script without type declarations; it defines window.FylText.
  await import('../dist/i18n.js');
  vi.stubGlobal('document', undefined);
}

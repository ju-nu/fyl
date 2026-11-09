import LOCALE_LIST from '../i18n/locales.json';

/**
 * The site's languages (i18n/locales.json, which scripts/build_i18n.mjs reads too): every page exists once per locale
 * under /<code>/, built from i18n/templates/ and i18n/<code>.json. English is the fallback and the binding version.
 */
export const LOCALES: readonly string[] = LOCALE_LIST.map(locale => locale.code);
const FALLBACK = 'en';
/** og:locale of each code (en_GB, de_DE, …). */
export const OG_LOCALES: Readonly<Record<string, string>> = Object.fromEntries(LOCALE_LIST.map(locale => [locale.code, locale.og]));

/** The code of a path's first segment (`/de/privacy` → de), or null where it is no locale. */
export function localeOf(path: string) {
  const code = /^\/([a-z]{2})(?:\/|$)/.exec(path)?.[1];
  return code && LOCALES.includes(code) ? code : null;
}

/**
 * The locale a browser asks for in Accept-Language (RFC 9110 §12.5.4): the supported language with the highest q-value
 * (ties keep the header's order), by primary subtag, so de-AT picks de; q=0 and `*` pick nothing. English otherwise.
 * Only `/`, the report host's `/` and the noindex download pages use it: a locale's own path never redirects. Only
 * when a request sends no Accept-Language at all does Cloudflare's CF-IPCountry pick (countryLocale()).
 */
export function negotiate(header: string | null, country?: string | null) {
  if (!header?.trim()) return countryLocale(country);
  const asked = (header || '').slice(0, 1024).split(',').slice(0, 32).map((part, order) => {
    const [range, ...params] = part.trim().split(';');
    const q = params.map(param => /^\s*q\s*=\s*([01](?:\.\d{0,3})?)\s*$/i.exec(param)?.[1]).find(Boolean);
    return { code: range.trim().toLowerCase().split(/[-_]/)[0], q: q === undefined ? 1 : Number(q), order };
  }).filter(entry => entry.q > 0 && LOCALES.includes(entry.code)).sort((a, b) => b.q - a.q || a.order - b.order);
  return asked[0]?.code ?? FALLBACK;
}

/** Countries whose main language fyl.at speaks; any other country, and none, get English. */
const COUNTRY_LOCALES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(['AT', 'DE', 'CH', 'LI', 'LU'].map(country => [country, 'de'])),
  ...Object.fromEntries(['ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'VE', 'EC', 'GT', 'CU', 'BO', 'DO', 'HN', 'PY', 'SV', 'NI', 'CR', 'PA', 'UY', 'PR'].map(country => [country, 'es'])),
  ...Object.fromEntries(['FR', 'MC'].map(country => [country, 'fr'])),
  NL: 'nl',
};

/** The locale for a CF-IPCountry code (two letters, as Cloudflare sends it), English where none fits. */
function countryLocale(country?: string | null) {
  const code = COUNTRY_LOCALES[(country || '').trim().toUpperCase()];
  return code && LOCALES.includes(code) ? code : FALLBACK;
}

/**
 * A message with its arguments, as dist/i18n.js and scripts/build_i18n.mjs format it (i18n/README.md): {name}, and
 * {count, plural, one {…} other {…}} with # for the number and =N for an exact one. A name without a value stays.
 */
export function format(message: string, vars: Record<string, string | number>, intl: string): string {
  const number = (value: number) => new Intl.NumberFormat(intl).format(value);
  let out = '', index = 0;
  while (index < message.length) {
    const open = message.indexOf('{', index);
    if (open < 0) { out += message.slice(index); break; }
    out += message.slice(index, open);
    let depth = 0, end = open;
    for (; end < message.length; end++) { if (message[end] === '{') depth++; else if (message[end] === '}' && --depth === 0) break; }
    const body = message.slice(open + 1, end), [name, kind] = body.split(',').map(part => part.trim());
    if (kind === 'plural' && name in vars) {
      const count = Number(vars[name]), options: Record<string, string> = {};
      for (const [, choice, text] of body.slice(body.indexOf(',', body.indexOf(',') + 1) + 1).matchAll(/\s*(=\d+|\w+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) options[choice] = text;
      out += format((options['=' + count] ?? options[new Intl.PluralRules(intl).select(count)] ?? options.other ?? '').replaceAll('#', number(count)), vars, intl);
    } else out += /^\w+$/.test(body) && body in vars ? String(vars[body]) : message.slice(open, end + 1);
    index = end + 1;
  }
  return out;
}

/**
 * The messages of a generated page, from its JSON block #fyl-i18n (the download page's carries what previewTags()
 * needs): the Worker writes a download page's preview tags in the language of the page it serves, from the same file.
 */
export function messagesOf(page: string) {
  let block: { lang?: unknown; intl?: unknown; strings?: unknown } = {};
  try { block = JSON.parse(/<script type="application\/json" id="fyl-i18n">(.*?)<\/script>/s.exec(page)?.[1] || '{}'); } catch { /* English keys below */ }
  const lang = typeof block.lang === 'string' ? block.lang : FALLBACK, intl = typeof block.intl === 'string' ? block.intl : lang;
  const strings = (block.strings && typeof block.strings === 'object' ? block.strings : {}) as Record<string, unknown>;
  const t = (key: string, vars: Record<string, string | number> = {}) => typeof strings[key] === 'string' ? format(strings[key] as string, vars, intl) : key;
  const number = (value: number, digits: number) => new Intl.NumberFormat(intl, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  return {
    lang, t,
    /** Sizes as the download page writes them: binary units with the familiar labels (1 GB = 1024³ bytes). */
    size: (bytes: number) => bytes >= 1073741824 ? t('common.size.gb', { n: number(bytes / 1073741824, 2) }) : bytes >= 1048576 ? t('common.size.mb', { n: number(bytes / 1048576, 1) })
      : bytes >= 1024 ? t('common.size.kb', { n: number(bytes / 1024, 1) }) : t('common.size.bytes', { count: bytes }),
    /** A time span, rounded to its largest unit: 45 minutes, 23 hours, 7 days. */
    span(ms: number) {
      const minutes = Math.max(1, Math.ceil(ms / 60000)), hours = Math.round(minutes / 60);
      return minutes < 60 ? t('common.duration.minutes', { count: minutes }) : hours < 48 ? t('common.duration.hours', { count: hours }) : t('common.duration.days', { count: Math.round(hours / 24) });
    },
    /** A type label of kind() ("PDF document", "EXE file", "file") in the page's language. */
    type: (label: string) => typeof strings['common.type.' + label] === 'string' ? t('common.type.' + label)
      : /^\S+ file$/.test(label) ? t('common.typeExt', { ext: label.slice(0, -5) }) : label === 'file' ? t('common.typeNone') : label,
  };
}

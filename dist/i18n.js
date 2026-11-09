// The page's language for its scripts (i18n/README.md). Every page that has scripts carries its messages in the JSON
// block #fyl-i18n (scripts/build_i18n.mjs writes it, already filled with English where a translation lacks a key), so
// nothing is fetched and no inline script runs. This reads it once and gives the scripts window.FylText: messages with
// their arguments, and the numbers, sizes, times and dates of the upload and download pages in the page's language.
// Loaded before the page's other scripts (defer, in order). Kept as written, like download.js, which uses it.
(() => {
  'use strict';
  let block = {};
  try { block = JSON.parse(document.getElementById('fyl-i18n')?.textContent || '{}') || {}; } catch {}
  const lang = typeof block.lang === 'string' ? block.lang : 'en', intl = typeof block.intl === 'string' ? block.intl : lang;
  const strings = block.strings && typeof block.strings === 'object' ? block.strings : {};
  const numbers = new Map(), rules = new Intl.PluralRules(intl);
  /** A number in the page's language, with exactly `digits` decimals (1,024.0 in English, 1.024,0 in German). */
  const number = (value, digits = 0) => {
    if (!numbers.has(digits)) numbers.set(digits, new Intl.NumberFormat(intl, {minimumFractionDigits: digits, maximumFractionDigits: digits}));
    return numbers.get(digits).format(value);
  };
  const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  // {name}, and {count, plural, one {…} other {…}} with # for the number and =N for an exact one (the same format as
  // scripts/build_i18n.mjs and src/i18n.ts). A name without a value stays as written.
  function format(message, vars) {
    let out = '', index = 0;
    while (index < message.length) {
      const open = message.indexOf('{', index);
      if (open < 0) { out += message.slice(index); break; }
      out += message.slice(index, open);
      let depth = 0, end = open;
      for (; end < message.length; end++) { if (message[end] === '{') depth++; else if (message[end] === '}' && --depth === 0) break; }
      const body = message.slice(open + 1, end), [name, kind] = body.split(',').map(part => part.trim());
      if (kind === 'plural' && name in vars) {
        const count = Number(vars[name]), options = {};
        for (const [, choice, text] of body.slice(body.indexOf(',', body.indexOf(',') + 1) + 1).matchAll(/\s*(=\d+|\w+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) options[choice] = text;
        out += format((options['=' + count] ?? options[rules.select(count)] ?? options.other ?? '').replaceAll('#', number(count)), vars);
      } else out += /^\w+$/.test(body) && body in vars ? vars[body] : message.slice(open, end + 1);
      index = end + 1;
    }
    return out;
  }
  const has = key => typeof strings[key] === 'string';
  /** A message as plain text (for textContent and attributes); a key the page doesn't carry shows as itself. */
  const t = (key, vars = {}) => has(key) ? format(strings[key], vars) : key;
  /** A message whose key ends in Html, for innerHTML: its own markup stays, every argument is escaped. */
  const tHtml = (key, vars = {}) => has(key) ? format(strings[key], Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, escapeHTML(value)]))) : escapeHTML(key);
  // Sizes use binary units with the familiar labels: 1 GB = 1024 MB = 1024³ bytes.
  const GB = 1073741824, MB = 1048576, KB = 1024;
  const size = bytes => bytes >= GB ? t('common.size.gb', {n: number(bytes / GB, 2)}) : bytes >= MB ? t('common.size.mb', {n: number(bytes / MB, 1)})
    : bytes >= KB ? t('common.size.kb', {n: number(bytes / KB, 1)}) : t('common.size.bytes', {count: bytes});
  // "0.70 of 1.84 GB": the part done in the unit of the whole.
  const part = (done, whole) => {
    const [key, divisor, digits] = whole >= GB ? ['common.size.partGb', GB, 2] : whole >= MB ? ['common.size.partMb', MB, 1] : whole >= KB ? ['common.size.partKb', KB, 1] : ['common.size.partBytes', 1, 0];
    return t(key, {done: number(done / divisor, digits), total: number(whole / divisor, digits)});
  };
  // Time left, always rounded down so the label never runs ahead: 47 min, 6 h 12 min, 2 days 23 h.
  const span = minutes => {
    if (minutes < 60) return t('common.time.minutes', {n: number(minutes)});
    const hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
    if (hours < 24) return minutes % 60 ? t('common.time.hoursMinutes', {h: number(hours), m: number(minutes % 60)}) : t('common.time.hours', {n: number(hours)});
    return hours % 24 ? t('common.time.daysHours', {count: days, h: number(hours % 24)}) : t('common.time.days', {count: days});
  };
  const left = ms => ms < 60000 ? t(ms > 0 ? 'common.time.underMinute' : 'common.time.expiringNow') : t('common.time.left', {time: span(Math.floor(ms / 60000))});
  // A lifetime in its largest whole unit: 3 days, 2 hours, 90 minutes.
  const duration = minutes => minutes % 1440 === 0 ? t('common.duration.days', {count: minutes / 1440}) : minutes % 60 === 0 ? t('common.duration.hours', {count: minutes / 60}) : t('common.duration.minutes', {count: minutes});
  // "Mon 2 Nov, 10:10" in English (this device's time zone); the language's own short form elsewhere. French leaves
  // the weekday out: "Jusqu'au jeu. 5 nov." reads wrong, "Jusqu'au 5 nov." is how it is said.
  const weekday = lang === 'fr' ? undefined : 'short';
  const dateFormat = new Intl.DateTimeFormat(intl, {weekday, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
  const dayFormat = new Intl.DateTimeFormat(intl, {weekday, day: 'numeric', month: 'short'});
  const date = ms => lang === 'en' ? dateFormat.format(new Date(ms)).replace(/^(\w+),? /, '$1 ').replace(/,? (\d\d:\d\d)$/, ', $1') : dateFormat.format(new Date(ms));
  const day = ms => lang === 'en' ? dayFormat.format(new Date(ms)).replace(/^(\w+),? /, '$1 ') : dayFormat.format(new Date(ms));
  const percent = value => t('common.percent', {n: number(value)});
  // A file type the server or the page names in English ("PDF document", "EXE file", "file"), in the page's language.
  const type = label => has('common.type.' + label) ? t('common.type.' + label) : /^\S+ file$/.test(label) ? t('common.typeExt', {ext: label.slice(0, -5)})
    : label === 'file' ? t('common.typeNone') : label;
  window.FylText = {lang, base: '/' + lang, has, t, tHtml, number, size, part, span, left, duration, date, day, percent, type, escapeHTML};
})();

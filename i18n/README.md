# The site in several languages

fyl.at's public pages exist once per locale: `en` (English, the fallback and the binding version), `de`, `es`, `fr`,
`nl`. The list is `locales.json` (code, native name, `og:locale`, Intl locale), read by `scripts/build_i18n.mjs` and by
the Worker (`src/i18n.ts`). The admin dashboard, the CLI, the API (its JSON errors too), `llms.txt` and `robots.txt`
stay English.

## Layout

- `templates/{index,privacy,report,download}.html`: the pages, with `{{key}}` where a message goes.
- `en.json`: every message, in English. The source of truth for keys.
- `<lang>.json`: the same keys, translated. May be missing or incomplete for a while: the build falls back to English
  per key, and `tests/i18n.test.ts` fails as soon as a present catalog misses a key (or has one too many).
- `npm run build:i18n` (also run by `npm run build:assets` and `npm run dev`) writes `dist/<lang>/*.html` and
  `dist/sitemap.xml`. They are committed; a test fails while one is stale. Never edit them by hand: they carry no
  marker (served pages have no HTML comments; the build drops the templates' comments). `node scripts/build_i18n.mjs --check` lists
  every problem without writing.

Routing (`src/index.ts`): `/` answers a browser 302 to `/<lang>/` by `Accept-Language` (`Vary: Accept,
Accept-Language`, `Cache-Control: no-store`, query kept); it is hreflang's `x-default`. A request to `/` that doesn't
ask for HTML (curl, agents) gets `llms.txt` instead. Only `/` (and the report host's `/`) redirects by language; a
browser opening a page address that doesn't exist goes to the home page of its language. Old addresses (`/privacy`,
`/index.html`, `/download`, `*.html`) answer 301 to English; `/report` and `/<lang>/report` answer 302 to the report
host, `report.fyl.at/` and `report.fyl.at/<lang>/`. Download links
`/d/<id>` and their closed pages keep their address and pick the language from `?lang=` (their language menu) or
`Accept-Language`. No cookie is set.

## Catalog format (rules for translators)

A catalog is one flat JSON object: `"key": "message"`, UTF-8, two-space indent, keys in the order of `en.json`.

1. Translate every key of `en.json`, and only those. Never rename, add or drop a key.
2. Keep every placeholder exactly: `{name}`, `{count}`, `{duration}`, `{base}` … stay as written, untranslated, and each
   one that the English uses must appear (order may change).
3. Plurals use `{count, plural, one {…} other {…}}`; `#` is the number. Keep `count, plural,` and the `other` case;
   add the cases your language needs (`one`, `few`, `many`, `=0` …, as `Intl.PluralRules` names them).
4. Keys ending in `Html` contain markup. Keep every tag exactly as in English (same tags, same attributes, same order;
   only the text between them changes). `&nbsp;` may stay or go. Write `&amp;` for a literal `&`.
5. Every other key is plain text: no tags and no entities; write `&`, `<`, quotes as they are (the build escapes them).
6. Keep leading and trailing spaces where the English has them (`home.pendingLead`, `home.elsewhereTail`): those
   messages are joined to a file name.
7. `common.type.<label>` keys are file types named by their English label (the key itself never changes).
8. Keep the tone of the English: short, plain sentences, "you", no exclamation marks. Use the typographic apostrophe
   and quotes of your language.
9. `home.title` (the home page's `<title>` and `og:title`) keeps brand and tagline untranslated and adds a translated
   descriptor: `fyl.at — Share files up to 50 GB · Fyl for now.`
10. `privacy.bindingHtml` says that the English privacy page is binding; translate it, keep its link.
11. A number and its unit, or a count and its noun (`{n} MB`, `# files`), are joined by a no-break space (U+00A0, or
    `&nbsp;` in an `Html` key), so a narrow line never breaks between them. Titles and descriptions keep plain spaces.

### Glossary: never translate

fyl, fyl.at, report.fyl.at, Fyl for now. (the tagline), CLI, curl, wget, E2EE, Cloudflare, Cloudflare R2, Turnstile,
Workers Analytics Engine, PBKDF2, HMAC, IPv4, IPv6, MD5, SHA-256, HTTPS, Accept-Language, product and platform names
(macOS, Linux, Windows, iPhone, iPad, Android, Word, Excel, PowerPoint, Photoshop, QuickTime, JSON, ZIP …), units
(GB, MB, KB, min, h, s, %: keep the symbol, use your language's spacing; French writes octets as Go, Mo, Ko, its
standard symbols), commands, flags, file names, paths, URLs and
anything in `<code>` (`fyl download`, `--password`, `/usr/local/bin`, `archive.zip`, `utm_source`).

## Adding a language

1. Add it to `locales.json` (code, native name, `og:locale`, Intl locale).
2. Add `<code>.json` with every key of `en.json`.
3. `npm run build:i18n`, then `npm test` (hreflang, sitemap, menu and routing tests read `locales.json`).

Corrections to a translation are welcome as pull requests that change only the catalog; the workflow for new strings
is in [CONTRIBUTING.md](../CONTRIBUTING.md#languages).

## In code

- Pages: `{{key}}`, `{{key name:other.key count=3}}` (arguments: another message, a number formatted for the locale),
  and the page parts `{{@lang}}`, `{{@base}}` (`/<lang>`), `{{@seo}}`, `{{@strings}}`, `{{@languageButton}}`,
  `{{@languageMenu}}`, `{{@binding}}`.
- Scripts: `dist/i18n.js` reads the page's JSON block `#fyl-i18n` (CSP-safe, nothing inline runs) into
  `window.FylText`: `t(key, vars)`, `tHtml(key, vars)` (arguments escaped), `size`, `part`, `span`, `left`,
  `duration`, `date`, `day`, `percent`, `number`, `type`. The block carries only the keys the page's scripts name;
  the build finds them as string literals (`'home.gone.'` with a trailing dot takes every key with that prefix), so
  write every other key out whole: `'home.delete' + …` is refused by `npm run build:i18n --check` and the tests.
- Worker: `src/i18n.ts` (`negotiate()`, `localeOf()`, `messagesOf()` for the download page's preview tags).

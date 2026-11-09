// The report form (/report). It checks a report the way the server does (POST /api/reports) and sends only the
// transfer id of the link, never a grant or anything else the link may carry.
(() => {
  'use strict';
  const ID = /^[A-Za-z0-9_-]{43,64}$/;
  // Messages and numbers in the page's language (dist/i18n.js, loaded first). The server's errors stay English; the
  // form translates those it knows by code.
  const words = () => typeof window === 'undefined' ? undefined : window.FylText;
  const text = (key, vars) => words() ? words().t(key, vars) : key;
  const number = value => words() ? words().number(value) : String(value);
  const MAX = 4000;
  const CATEGORIES = ['malware', 'phishing', 'csam', 'illegal', 'copyright', 'privacy', 'other'];
  // The transfer id of a fyl.at download link (/d/<id>, with or without the name, ?dl=1 or a grant) or of a bare id;
  // null for anything else. `host` is this site's own host, so the links of a local copy count too.
  function linkId(text, host = 'fyl.at') {
    const value = String(text).trim();
    if (ID.test(value)) return value;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!['https:', 'http:'].includes(url.protocol) || !['fyl.at', host].includes(url.host) || url.username || url.password) return null;
    // An encrypted link's ID ends at %23 too (docs/E2EE.md §12.2); whatever follows is never sent.
    return /^\/d\/([A-Za-z0-9_-]{43,64})(?:%23.*|\/[^/]*)?$/s.exec(url.pathname)?.[1] || null;
  }
  // Key material (docs/E2EE.md §15.4): 43 key characters after # (or %23), or an age identity string. A report never
  // carries a key: the link loses its fragment, and details, a name or an email with one are refused.
  const KEY_MATERIAL = /(?:#|%23)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])|AGE-SECRET-KEY-1/i;
  const withoutKey = text => String(text).trim().replace(/#.*$/s, '').replace(/(\/d\/[A-Za-z0-9_-]+)%23.*$/s, '$1');
  // The server's rules, as a message per field that breaks one. Name and email may be left out only for reports of
  // child sexual abuse material (DSA Art. 16(2)(c)); the good-faith statement is always needed (Art. 16(2)(d)).
  function problems({link, category, details, name, email, goodFaith}, host) {
    const found = {}, length = [...details].length, contact = category !== 'csam';
    if (!linkId(link, host)) found.link = text(String(link).trim() ? 'report.error.link' : 'report.error.linkEmpty');
    if (!CATEGORIES.includes(category)) found.category = text('report.error.category');
    if (!length) found.details = text('report.error.detailsEmpty');
    else if (length < 20) found.details = text('report.error.detailsShort', {count: number(length)});
    else if (length > MAX) found.details = text('report.error.detailsLong', {max: number(MAX), count: number(length)});
    else if (/(?![\n\t])\p{Cc}/u.test(details)) found.details = text('report.error.detailsControl');
    else if (KEY_MATERIAL.test(details)) found.details = text('report.error.detailsKey');
    if (contact && !name) found.name = text('report.error.nameEmpty');
    else if ([...name].length > 200) found.name = text('report.error.nameLong');
    else if (KEY_MATERIAL.test(name)) found.name = text('report.error.key');
    if (contact && !email) found.email = text('report.error.emailEmpty');
    else if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) found.email = text('report.error.emailInvalid');
    else if (KEY_MATERIAL.test(email)) found.email = text('report.error.key');
    if (goodFaith !== true) found.goodFaith = text('report.error.goodFaith');
    return found;
  }
  const payload = (fields, host) => ({link: linkId(fields.link, host), category: fields.category, details: fields.details,
    ...(fields.name ? {name: fields.name} : {}), ...(fields.email ? {email: fields.email} : {}), goodFaith: true});
  // Why the server refused a report. The per-minute rate limit and a network's daily report limit (report_limit) are
  // both 429 but need different advice. A 400 says what is wrong as the server wrote it, in English (the form checks the
  // same first); another code the page knows (turnstile_failed, temporarily_unavailable) reads in its language.
  const known = body => typeof body?.code === 'string' && words()?.has('common.error.' + body.code);
  const refusal = (status, body) => status === 400 && body?.error ? body.error
    : status !== 429 && known(body) ? text('common.error.' + body.code)
    : status === 429 && body?.code === 'report_limit' ? text('report.refused.limit')
    : [404, 410, 429].includes(status) ? text('report.refused.' + status) : body?.error || text('report.refused.other');
  // The case of an accepted report. A file that was closed already (expired, used up, deleted or removed) is still
  // taken while the server remembers it, with fileAvailable: false; a server without the field had the file.
  const received = body => ({id: typeof body?.case === 'string' ? body.case : '', fileAvailable: body?.fileAvailable !== false});
  // Cloudflare Turnstile, only when the Worker's /config.js names a site key: it does once the server checks the token
  // (TURNSTILE_SITE_KEY and TURNSTILE_SECRET set). Without one nothing is loaded from Cloudflare.
  const TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  const siteKey = config => typeof config?.turnstileSiteKey === 'string' && /^[\w-]{1,128}$/.test(config.turnstileSiteKey) ? config.turnstileSiteKey : null;
  // Loads Turnstile (explicit rendering, no inline script) into `box` and keeps its token. Expiry, a timeout or an
  // error render it afresh (an error up to 3 times, then `failed(true)`); reset() after every answer of the server,
  // which spends a token on each check. As wide as the form, or compact where that is under 300 px.
  function humanCheck(key, box, {win = globalThis, doc = globalThis.document, theme = 'auto', failed = () => {}} = {}) {
    if (!key || !box) return null;
    let id = null, token = '', errors = 0, timer = 0;
    const reset = () => {
      token = ''; clearTimeout(timer);
      if (id !== null) try { win.turnstile.reset(id); } catch { /* gone: nothing to reset */ }
    };
    const render = () => {
      try {
        id = win.turnstile.render(box, {sitekey: key, action: 'report', theme, language: words()?.lang || 'en', size: box.clientWidth >= 300 ? 'flexible' : 'compact',
          'refresh-expired': 'manual', retry: 'never',
          callback: value => { token = value; errors = 0; failed(false); },
          'expired-callback': reset, 'timeout-callback': reset,
          'error-callback': () => {
            token = '';
            if (++errors > 3) failed(true); else timer = setTimeout(reset, 2000 * errors);
            return true;
          }}) ?? null;
      } catch { /* told below */ }
      if (id === null) failed(true);
    };
    const script = doc.createElement('script');
    script.src = TURNSTILE; script.async = true;
    script.addEventListener('load', render);
    script.addEventListener('error', () => failed(true));
    doc.head.append(script);
    return {token: () => token, reset};
  }
  globalThis.FylReport = {linkId, problems, payload, refusal, received, siteKey, humanCheck, TURNSTILE, withoutKey};
  if (typeof document === 'undefined') return; // tests load the helpers above without a page

  const $ = id => document.getElementById(id);
  const form = $('report-form'), host = location.host;
  const FIELDS = {link: 'report-link', category: 'report-category', details: 'report-details', name: 'report-name', email: 'report-email', goodFaith: 'report-good-faith'};
  let sending = false;
  // "Report this file" on a download page passes its link; only fyl.at download links are taken.
  const given = new URLSearchParams(location.search).get('link');
  if (given && linkId(given, host)) $('report-link').value = withoutKey(given);
  // A pasted encrypted link loses its key as soon as the field is left.
  $('report-link').addEventListener('change', () => { if (linkId($('report-link').value, host)) $('report-link').value = withoutKey($('report-link').value); });
  // Above the submit button, only with a site key. Its own failure shows under it; the button always stays usable.
  const key = siteKey(window.FYL_CONFIG);
  $('report-human').hidden = !key;
  const human = humanCheck(key, $('report-human-widget'), {theme: document.documentElement.dataset.theme || 'auto', failed: failed => { $('report-human-note').hidden = !failed; }});
  const fields = () => ({link: $('report-link').value, category: form.elements.category.value, details: $('report-details').value.trim(),
    name: $('report-name').value.trim(), email: $('report-email').value.trim(), goodFaith: $('report-good-faith').checked});
  const control = field => field === 'category' ? form.querySelector('input[name="category"]:checked') || form.querySelector('input[name="category"]') : $(FIELDS[field]);
  function fieldError(field, message) {
    const error = $(FIELDS[field] + '-error');
    error.querySelector('span').textContent = message; error.hidden = !message;
    (field === 'category' ? [...form.elements.category] : [$(FIELDS[field])]).forEach(input => input.setAttribute('aria-invalid', String(!!message)));
  }
  // One line counts the marked fields and follows quietly as they are fixed. It is an alert only for the moment of
  // sending (`submitted`), so typing in a field doesn't interrupt with an announcement on every key.
  function countErrors(count = Object.keys(FIELDS).filter(field => !$(FIELDS[field] + '-error').hidden).length, submitted = false) {
    const line = text('report.checkFields', {count});
    if (submitted) $('report-alert').setAttribute('role', 'alert'); else $('report-alert').removeAttribute('role');
    if ($('report-alert-text').textContent !== line) $('report-alert-text').textContent = line;
    $('report-alert').hidden = !count;
  }
  // Details count code points, like the server: one counter against the maximum ("12 / 4,000", red past it), and the
  // minimum as its own line under it, which turns into a tick once there are 20.
  const countDetails = () => {
    const length = [...$('report-details').value.trim()].length;
    $('report-count').textContent = text('report.count', {count: number(length), max: number(MAX)});
    $('report-count').classList.toggle('over', length > MAX);
    $('report-details-min').classList.toggle('met', length >= 20);
  };
  function formError(message) {
    $('report-error').textContent = message; $('report-error').hidden = !message;
    if (message) $('report-error').focus();
  }
  // Errors show next to their field; correcting the field clears its error at once. Choosing child sexual abuse marks
  // name and email optional.
  const recheck = event => {
    const field = event.target.name;
    if (field === 'category') {
      document.querySelectorAll('.contact-optional').forEach(element => { element.hidden = event.target.value !== 'csam'; });
      for (const contact of ['name', 'email']) if (!$(FIELDS[contact] + '-error').hidden) fieldError(contact, problems(fields(), host)[contact] || '');
    }
    if (FIELDS[field] && !$(FIELDS[field] + '-error').hidden) fieldError(field, problems(fields(), host)[field] || '');
    if (field === 'details') countDetails();
    if (!$('report-alert').hidden) countErrors();
  };
  countDetails(); // a browser may have restored the field
  form.addEventListener('input', recheck);
  form.addEventListener('change', recheck);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending) return;
    const values = fields(), found = problems(values, host), wrong = Object.keys(FIELDS).find(field => found[field]);
    for (const field of Object.keys(FIELDS)) fieldError(field, found[field] || '');
    formError(''); countErrors(Object.keys(found).length, true);
    if (wrong) { control(wrong).focus(); return; }
    sending = true; $('report-submit').disabled = true; $('report-submit').querySelector('span').textContent = text('report.sending');
    try {
      const response = await fetch('/api/reports', {method: 'POST', cache: 'no-store', credentials: 'omit',
        headers: {Accept: 'application/json', 'Content-Type': 'application/json'},
        body: JSON.stringify({...payload(values, host), ...(human ? {turnstile: human.token()} : {})})});
      const body = await response.json().catch(() => null);
      if (response.ok) { done(received(body)); return; }
      human?.reset();
      formError(refusal(response.status, body));
    } catch { human?.reset(); formError(text('report.offline')); }
    finally { sending = false; $('report-submit').disabled = false; $('report-submit').querySelector('span').textContent = text('report.send'); }
  });
  $('copy-case').addEventListener('click', async () => {
    const text = $('case-id').textContent;
    try { await navigator.clipboard.writeText(text); } catch { getSelection().selectAllChildren($('case-id')); return; }
    $('live-status').textContent = text('report.caseCopied');
    const swaps = [...$('copy-case').querySelectorAll('.swap')], show = second => swaps.forEach(swap => { swap.children[0].toggleAttribute('data-off', second); swap.children[1].toggleAttribute('data-off', !second); });
    show(true); setTimeout(() => show(false), 2000);
  });
  function done({id, fileAvailable}) {
    $('case-id').textContent = id || text('report.noNumber');
    $('done-next').hidden = !fileAvailable; $('done-gone').hidden = fileAvailable;
    $('report-view').hidden = true; $('done-view').hidden = false;
    $('done-heading').focus({preventScroll: true}); scrollTo({top: 0});
    $('live-status').textContent = [text('report.receivedLive'), id ? text('report.caseLive', {id}) : '', fileAvailable ? '' : text('report.goneLive')].filter(Boolean).join(' ');
  }
})();

// Download page for links opened in a browser (/d/<id>). The Worker renders the transfer into html[data-state] and the
// JSON block #fyl-state; this fills in the texts and keeps them current: the expiry and pause countdowns, the upload's
// progress while it still runs, and the download, which starts by itself once the upload is done or a password
// unlocked the file. An encrypted link (mode "e2ee", docs/E2EE.md §9) is decrypted here instead: the key comes from the
// address after # (or the key field), is checked against the transfer's head and meta before anything is downloaded,
// and the download starts only on a click.
(() => {
  'use strict';
  // Status polls: every 5 s, then 1.5 times longer up to 60 s while nothing changes, back to 5 s on progress, and at
  // least 60 s (longer if Retry-After says so) after a 429. Callers add ±20 % jitter.
  const nextDelay = (delay, {changed = false, status = 200, retryAfter = null} = {}) => status === 429
    ? Math.max(60000, Math.min(600000, (Number(retryAfter) || 0) * 1000)) : changed ? 5000 : Math.min(60000, Math.round(delay * 1.5));
  // The server's clock minus this device's, from a server time read at `local`; 0 without one.
  const clockOffset = (server, local) => Number.isFinite(server) ? server - local : 0;
  // The server's password rule (validPassword in src/shared.ts): 6 to 200 code points after NFC, no control characters
  // or lone surrogates. A password that breaks it would only cost a try.
  const validPassword = text => {
    const normal = String(text).normalize('NFC'), length = [...normal].length;
    return length >= 6 && length <= 200 && !/[\p{Cc}\p{Cs}]/u.test(normal);
  };
  // KEY (docs/E2EE.md §3.1): canonical unpadded b64url of 32 bytes.
  const KEY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
  // The key in this page's address (§2.4, §9.5): the fragment, or what follows %23 right after the ID, which was in the
  // request path (`exposed`). An empty one is no key; a path segment never is one, not even a KEY-shaped one (a raw
  // link's name sits there). `invalid`: something that should be a key but isn't one.
  function addressKey(pathname, hash) {
    const match = /^\/d\/([A-Za-z0-9_-]+)(?:%23(.*)|\/.*)?$/s.exec(pathname), fragment = String(hash).replace(/^#/, '');
    if (!match) return {id: null, key: null, exposed: false, invalid: false};
    const exposed = !!match[2], key = exposed ? match[2] : fragment;
    if (exposed && fragment) return {id: match[1], key: null, exposed, invalid: true};
    return {id: match[1], key: key && KEY.test(key) ? key : null, exposed: exposed && KEY.test(key), invalid: !!key && !KEY.test(key)};
  }
  // P(C) (§6): the plaintext size of an encrypted file of C stored bytes, null where no plaintext gives C.
  function plainSize(C) {
    if (!Number.isSafeInteger(C) || C - 184 < 16) return null;
    const rest = C - 184, n = Math.max(1, Math.ceil(rest / 65552)), P = rest - 16 * n;
    return n >= 2 && P <= 65536 * (n - 1) ? null : P;
  }
  // The file badge, type label and program warning that the Worker gives raw names (kind() in src/index.ts), here for a
  // decrypted name, with the extensions §15.4 adds for encrypted files (pages, shortcuts, scripts).
  const TYPES = new Map(Object.entries({
    'ZIP archive': 'zip', '7-Zip archive': '7z', 'RAR archive': 'rar', 'TAR archive': 'tar', 'gzip archive': 'gz tgz', 'bzip2 archive': 'bz2',
    'XZ archive': 'xz', 'Zstandard archive': 'zst', 'PDF document': 'pdf', 'Word document': 'doc docx docm', 'text document': 'odt rtf pages',
    'Excel spreadsheet': 'xls xlsx xlsm', 'spreadsheet': 'ods numbers csv', 'PowerPoint presentation': 'ppt pptx pptm', 'presentation': 'odp key',
    'text file': 'txt md log', 'e-book': 'epub mobi', 'JPEG image': 'jpg jpeg', 'PNG image': 'png',
    'GIF image': 'gif', 'WebP image': 'webp', 'HEIC image': 'heic heif', 'SVG image': 'svg', 'TIFF image': 'tif tiff', 'RAW photo': 'dng cr2 cr3 nef arw raf',
    'Photoshop file': 'psd', 'MP4 video': 'mp4 m4v', 'QuickTime video': 'mov', 'Matroska video': 'mkv', 'WebM video': 'webm', 'AVI video': 'avi',
    'MP3 audio': 'mp3', 'WAV audio': 'wav', 'FLAC audio': 'flac', 'AAC audio': 'm4a aac', 'Ogg audio': 'ogg opus', 'Windows program': 'exe com scr',
    'Windows installer': 'msi msix', 'disk image': 'dmg iso img vhd vhdx', 'macOS installer': 'pkg', 'Android app': 'apk', 'iOS app': 'ipa',
    'Linux package': 'deb rpm', 'Linux program': 'appimage run', 'shell script': 'sh bash zsh command', 'batch script': 'bat cmd', 'PowerShell script': 'ps1',
    'Java archive': 'jar', 'JavaScript file': 'js', 'Python script': 'py', 'JSON file': 'json', 'HTML page': 'html htm', 'font': 'ttf otf woff woff2',
  }).flatMap(([label, extensions]) => extensions.split(' ').map(extension => [extension, label])));
  const RISKY = new Set(('exe com scr pif msi msix msixbundle appx appxbundle msp msc bat cmd ps1 psm1 vb vbs vbe js jse ws wsc wsf wsh hta chm cpl '
    + 'scf url xll jar jnlp lnk reg dll app dmg pkg mpkg command sh bash zsh run bin appimage deb rpm apk ipa iso img vhd vhdx '
    + 'docm dotm xlsm xltm xlam pptm potm ppam ppsm sldm '
    + 'html htm xhtml shtml svg mht mhtml one library-ms search-ms settingcontent-ms desktop scpt').split(' '));
  function kind(name) {
    const extension = /\.([a-z0-9]{1,10}|[a-z0-9]{1,20}-ms)$/i.exec(name)?.[1].toLowerCase() || '';
    return {ext: extension ? extension.slice(0, 4).toUpperCase() : 'FILE', type: TYPES.get(extension) || (extension ? extension.toUpperCase() + ' file' : 'file'), risky: RISKY.has(extension)};
  }
  // HTTP Basic for the password (§11): the user name is ignored, the password is UTF-8.
  const basic = password => 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode('fyl:' + password)));
  // §9.3: without the service worker the file is decrypted into memory, up to 256 MiB, decided before downloading.
  const MEMORY_LIMIT = 256 * 1048576;
  // iPhone and iPad (iPadOS says Macintosh, with touch) stay on that path until their device tests pass.
  const appleTouch = nav => /iPad|iPhone|iPod/.test(nav?.userAgent || '') || (/Macintosh/.test(nav?.userAgent || '') && nav?.maxTouchPoints > 1);
  // The streaming path runs only where it was measured (§9.3, §9.4): Chromium, which navigator.userAgentData names, but
  // not an Android WebView (it hands downloads to its app, outside the service worker) and never on iPhone or iPad.
  // Every other browser saves through the in-memory fallback.
  const streams = nav => {
    const brands = Array.isArray(nav?.userAgentData?.brands) ? nav.userAgentData.brands.map(item => String(item?.brand || '')) : [];
    return !!nav?.serviceWorker && !appleTouch(nav) && brands.includes('Chromium') && !brands.some(brand => /WebView/i.test(brand));
  };
  globalThis.FylDownload = {nextDelay, clockOffset, validPassword, addressKey, plainSize, kind, basic, MEMORY_LIMIT, appleTouch, streams};
  if (typeof document === 'undefined') return; // tests load the helpers above without a page

  const $ = id => document.getElementById(id);
  // The page's language (dist/i18n.js, loaded first): the Worker served the page in it (?lang= or Accept-Language).
  const L = window.FylText, t = L.t;
  const icon = name => '<svg class="i" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  const root = document.documentElement;
  const STATES = ['ready', 'protected', 'unlocked', 'uploading', 'gone'];
  // Why a link doesn't work: title, the status over the empty time line and its note, the next step (the messages
  // download.gone.<reason>.title, .tag, .line and .text), and the icon here. The card keeps the ready page's shape: a
  // meta line under the title, the time line drained, then one wide action. Encrypted links add damaged, newer,
  // unsupported_mode and mismatch (§13: found by the key check, or by the server for a record it can't serve), and
  // platform, which is not the link's fault: this browser lacks what decryption needs (WebCrypto X25519), and the
  // terminal stays, with the key.
  const ICONS = {consumed: 'one', deleted: 'trash', expired: 'clock', missing: 'file', removed: 'flag', quarantined: 'pause', busy: 'clock',
    damaged: 'alert', newer: 'info', unsupported_mode: 'info', mismatch: 'key', platform: 'info'};
  const GONE = Object.fromEntries(Object.entries(ICONS).map(([reason, glyph]) => [reason, [...['title', 'tag', 'line', 'text'].map(part => t('download.gone.' + reason + '.' + part)), glyph]]));
  // Links that are closed for good, and the one paused while a report is reviewed; any other may still work.
  const CLOSED = ['consumed', 'deleted', 'expired', 'removed'];
  let data = {};
  try { data = JSON.parse($('fyl-state')?.textContent || '{}') || {}; } catch {}
  if (!STATES.includes(data.state)) data = {state: 'gone', reason: data?.reason === 'unsupported_mode' ? 'unsupported_mode' : 'missing'};
  const address = addressKey(location.pathname, location.hash);
  const E2EE = data.mode === 'e2ee' && data.state !== 'gone';
  const transferId = data.id || address.id || '';
  // An encrypted page names only /d/<ID>, built here, never from the address, which may carry a key or a crafted name.
  const link = (E2EE ? null : data.url) || location.origin + '/d/' + transferId;
  const first = {received: data.received || 0, at: data.updatedAt || 0};
  let longest = 0, stalled = false, started = false, submitting = false, toastTimer = null, begun = false;
  let delay = 5000, pollTimer = null, polling = false, lastPoll = 0;
  // A raw file asked for with a key: a link with a key never yields an unencrypted file (§13 mode_mismatch).
  if (!E2EE && data.state !== 'gone' && address.key) data = {state: 'gone', reason: 'mismatch'};
  // No Referer from an encrypted page (§2.2, §15.3), whose address may still hold a key sent after %23. The page's meta
  // says same-origin only so that the raw unlock form posts its real Origin; this page never posts it, so its policy
  // becomes no-referrer before it asks anything of fyl.at. What <head> loads before any script runs carries
  // referrerpolicy="no-referrer" itself. Its POST to /done keeps its Origin, which fetch sends whatever the policy.
  if (E2EE || address.key) document.querySelector('meta[name="referrer"]')?.setAttribute('content', 'no-referrer');

  // Sizes in binary units (1 GB = 1024³ bytes), "0.70 of 1.84 GB", the time left rounded down so it never runs ahead
  // (47 min, 6 h 12 min, 2 days 23 h), dates: the upload page's formatters, in the page's language (dist/i18n.js).
  const sizeLabel = L.size, partLabel = L.part, leftLabel = L.left, dateLabel = L.date;
  // While uploading, the time left only needs to be about right; rounded to the nearest minute.
  const aboutLabel = ms => t('download.about', {time: ms < 90000 ? t('common.time.minutes', {n: L.number(1)}) : L.span(Math.round(ms / 60000))});
  const clockLabel = ms => { const seconds = Math.ceil(ms / 1000); return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0'); };
  // The page doesn't know the link's whole lifetime, so its line is scaled to the shortest choice that holds the time
  // left (1 hour, 1 day, 3 or 7 days).
  const lifeShare = ms => ms / ([3600000, 86400000, 259200000].find(span => ms <= span) || 604800000);
  const setLine = (element, value) => element.style.setProperty?.('--v', String(Math.max(0, Math.min(1, value)).toFixed(4)));
  const shellQuote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";
  const set = (id, text) => { if ($(id).textContent !== text) $(id).textContent = text; };
  // A file name, and the link in a command, may break after / _ - . (then anywhere, by CSS), but never just before the
  // extension. In a command the flags stay whole, and so do the link's last characters with its closing quote.
  const escapeHTML = text => String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const breakable = text => {
    const value = String(text), extension = /\.[a-z0-9]{1,10}$/i.exec(value)?.[0] || '';
    return escapeHTML(value.slice(0, value.length - extension.length)).replace(/([/_\-.])/g, '$1<wbr>') + escapeHTML(extension);
  };
  let command = '';
  const announce = text => { $('live-status').textContent = text; };
  const finePointer = () => matchMedia('(pointer: fine)').matches;
  // Times in the data are the Worker's, and this device's clock may be off: the page carries the server's time when it
  // was rendered (`now`), status answers their `serverTime` (or at least a Date header).
  let offset = clockOffset(data.now, Date.now());
  const now = () => Date.now() + offset;
  const syncClock = (response, info) => {
    const server = Number.isFinite(info?.serverTime) ? info.serverTime : Date.parse(response.headers.get('Date') || '') + 500;
    if (Number.isFinite(server)) offset = clockOffset(server, Date.now());
  };

  // An encrypted link's state on this page. `key`: the KEY in use (from the address, typed, or kept for this tab once it
  // verified); `error`: why the key field shows (key_invalid, key_wrong, other_transfer, key_missing, or load: the
  // decryption code didn't load, which a retry fixes); `blobs`: head and meta (from the page, or for a protected link
  // from the info route with the password); `verified`: the decrypted name and P once the key check passed; `broken`: a
  // file the key check found damaged or too new, or a browser that can't decrypt (platform); `password`: kept in page
  // memory for the download's requests only.
  const e = {key: null, source: null, error: null, exposed: false, blobs: null, verified: null, broken: null, password: null, checking: false};
  const OPEN_KEYS = 'fyl-open-keys';
  const openKeys = () => { try { const map = JSON.parse(sessionStorage.getItem(OPEN_KEYS) || '{}'); return map && typeof map === 'object' ? map : {}; } catch { return {}; } };
  const keepOpenKey = (id, key) => { try { sessionStorage.setItem(OPEN_KEYS, JSON.stringify({...openKeys(), [id]: key})); } catch {} };
  root.toggleAttribute('data-e2ee', E2EE);
  if (E2EE) {
    e.exposed = address.exposed || (address.invalid && /%23./.test(location.pathname));
    if (address.invalid) e.error = 'key_invalid';
    else if (address.key) { e.key = address.key; e.source = address.exposed ? 'exposed' : 'address'; }
    else if (KEY.test(openKeys()[transferId] || '')) { e.key = openKeys()[transferId]; e.source = 'stored'; }
    if (typeof data.head === 'string' && typeof data.meta === 'string') e.blobs = {head: data.head, meta: data.meta};
    // §9.5: the address keeps only /d/<ID> and the fragment, so a crafted name or a key sent in the path doesn't stay.
    history.replaceState(null, '', '/d/' + transferId + (address.exposed ? '' : location.hash));
    // The decrypted name is never machine-translated, also where the page announces it.
    $('live-status').translate = false; $('toast-text').translate = false;
    $('download').remove();
  }
  const plaintext = () => E2EE ? plainSize(data.size) ?? 0 : data.size || 0;

  const popover = (element, open) => { try { if (open) element.showPopover?.(); else element.hidePopover?.(); } catch {} };
  // Its message is announced through the live region: a region that appears together with its text is often not read.
  function toast(message) {
    const element = $('toast');
    clearTimeout(toastTimer); $('toast-text').textContent = message; announce(message);
    popover(element, false); popover(element, true);
    toastTimer = setTimeout(() => popover(element, false), 4300);
  }

  // What the card shows. An encrypted link adds "key" (no key, or one that doesn't open the file) and shows the name
  // only once the key check passed.
  function view() {
    if (!E2EE || data.state === 'gone') return data.state;
    if (e.broken) return 'gone';
    if (!e.verified) return data.state === 'protected' && !e.blobs ? 'protected' : data.state === 'uploading' && !e.blobs ? 'uploading' : 'key';
    return data.state === 'uploading' ? 'uploading' : 'ready';
  }
  function render() {
    const state = view(), reason = E2EE && e.broken ? e.broken : data.reason, gone = GONE[reason] || GONE.missing;
    const name = E2EE ? e.verified?.name : data.name, named = state !== 'gone' && !!name, file = named ? (E2EE ? kind(name) : data) : {};
    root.dataset.state = state;
    root.toggleAttribute('data-once', state !== 'gone' && !!data.once); root.toggleAttribute('data-protected', state !== 'gone' && !!data.protected);
    root.toggleAttribute('data-risky', state !== 'gone' && !!file.risky);
    root.toggleAttribute('data-stalled', state === 'uploading' && stalled);
    // A browser that can't decrypt keeps the terminal command, with the key it has.
    const platform = E2EE && e.broken === 'platform';
    root.toggleAttribute('data-platform', platform);
    if (state === 'protected' && ['wrong','paused','format'].includes(data.error)) root.dataset.error = data.error; else delete root.dataset.error;
    const title = state === 'gone' ? gone[0] : named ? name : t(state === 'key' ? (e.key && (!e.error || e.error === 'load') ? 'download.encryptedFile' : 'download.keyRequired') : 'download.passwordRequired');
    // A name breaks at its separators before it breaks inside a word.
    if ($('file-title').textContent !== title) { if (named) $('file-title').innerHTML = breakable(title); else $('file-title').textContent = title; }
    $('file-title').translate = !named;
    // An encrypted file's name stays out of the title, which lands in history and tab lists.
    document.title = E2EE ? t('download.encryptedTitle') : t('download.pageTitle', {name: title});
    $('key-exposed').hidden = !(E2EE && e.exposed && (state !== 'gone' || platform));
    renderKey(state);
    if (state === 'gone') {
      set('file-meta', t(CLOSED.includes(reason) ? 'download.metaClosed' : reason === 'quarantined' ? 'download.metaPaused' : 'download.metaLink'));
      set('gone-tag', gone[1]); set('gone-line', gone[2]); set('gone-text', gone[3]);
      $('tile-icon').setAttribute('href', '#i-' + gone[4]);
      if (platform) renderCommand(state);
      return;
    }
    $('tile-icon').setAttribute('href', state === 'key' ? '#i-key' : '#i-lock');
    // The page names the form's address (report.fyl.at/<lang>/); only the link to report is added.
    const form = new URL($('report-link').href || L.base + '/report', location.href);
    form.search = new URLSearchParams({link}).toString();
    $('report-link').href = form.href;
    set('file-ext', file.ext || 'FILE');
    const size = sizeLabel(plaintext());
    const once = data.once ? ' · ' + t('download.oneDownload') : '';
    set('file-meta', size + (named ? (file.type ? ' · ' + L.type(file.type) : '') + once
      : ' · ' + (state !== 'key' ? t('download.nameHidden') : e.checking ? t('download.checkingKey') : t('download.encrypted') + once)));
    // While an encrypted upload still runs, the key view has no expiry to show yet.
    $('life').hidden = E2EE && data.state === 'uploading';
    if (E2EE) {
      $('save-box').hidden = false;
      if (saveState === 'idle') set('save-label', t('download.downloadSize', {size}));
      set('after-text', t('download.afterE2ee'));
      set('auto-text', t('download.autoE2ee'));
    } else {
      $('download').href = data.downloadUrl || location.pathname + '?dl=1';
      set('download-label', begun ? t('download.onceAgain') : t('download.downloadSize', {size}));
    }
    renderCommand(state);
    if (state === 'protected') renderPassword();
    tick();
  }
  // "Download in a terminal": curl for a raw link; fyl download for an encrypted one (curl would get only ciphertext),
  // with the key once it verified (or where this browser can't check it), otherwise without it, so the tool asks for it.
  // The command is never machine-translated (#curl-command has translate="no"): a translation service would get the key.
  function renderCommand(state) {
    const keyed = E2EE && !!e.key && (!!e.verified || e.broken === 'platform'), text = E2EE ? 'fyl download ' + shellQuote(link + (keyed ? '#' + e.key : ''))
      : 'curl -fOJ' + (data.protected ? ' -u fyl' : '') + (state === 'uploading' ? ' --retry 120' : '') + ' ' + shellQuote(link);
    if (command !== text) {
      command = text;
      const [program, quoted] = [text.slice(0, text.indexOf(" '")), text.slice(text.indexOf(" '") + 1)];
      $('curl-command').innerHTML = escapeHTML(program) + ' ' + breakable(quoted.slice(0, -8)) + '<span class="nowrap">' + escapeHTML(quoted.slice(-8)) + '</span>';
    }
    // What curl prints before it saves the file: its password prompt, or its first wait while the upload runs.
    set('curl-output', E2EE ? '' : [...(data.protected ? ['Enter host password for user \'fyl\':'] : []), ...(state === 'uploading' ? ['Warning: Problem : HTTP error. Will retry in 10 seconds. 117 retries left.'] : [])].join('\n'));
    $('curl-output').hidden = !$('curl-output').textContent;
    // What curl prints stays English, like curl; the hint is the page's (each key written out whole: the page carries
    // only the keys its scripts name, scripts/build_i18n.mjs).
    set('curl-hint', t(E2EE ? (data.protected ? (keyed ? 'download.hintE2eePassword' : 'download.hintE2eePasswordKey') : keyed ? 'download.hintE2ee' : 'download.hintE2eeKey')
      : state === 'uploading' ? 'download.hintUploading' : data.protected ? 'download.hintPassword' : 'download.hintPlain'));
  }
  // The key field (§2.4, §9.5): outside any form, without a name, never autofilled. It shows while the link has no key
  // or one that failed; the key is checked here and never submitted. Its errors (key_invalid, key_wrong,
  // other_transfer, key_missing, load) are the messages download.keyError.<error>.
  function renderKey(state) {
    const show = E2EE && (state === 'key' || state === 'protected') && (!e.key || !!e.error) && !e.checking;
    // The code that checks the key didn't load: no field, only a retry, which reloads the page (see check()).
    const retry = e.error === 'load';
    $('key-box').hidden = !show;
    $('key-field').hidden = retry;
    if (show && e.error) root.dataset.keyError = e.error; else delete root.dataset.keyError;
    $('key').setAttribute('aria-invalid', String(show && !!e.error && !retry));
    $('key-message').innerHTML = show && e.error ? icon('alert') + '<span>' + escapeHTML(t('download.keyError.' + e.error)) + '</span>' : '';
    set('key-lead', t(retry ? (e.key ? 'download.keyLeadRetryKeyed' : 'download.keyLeadRetry') : e.error && e.error !== 'key_missing' ? 'download.keyLeadWhole'
      : state === 'protected' ? 'download.keyLeadProtected' : 'download.keyLead'));
    set('open-file-label', t(retry ? 'download.tryAgain' : 'download.openFile'));
  }

  // Wrong passwords show the tries left; after the last one the field is locked until the pause ends. The pause's
  // message stays put and the countdown runs on the button, which no screen reader reads out every second.
  function renderPassword() {
    const paused = root.dataset.error === 'paused', input = $('password'), left = Number(data.triesLeft);
    input.disabled = paused; $('unlock').disabled = paused; input.placeholder = paused ? t('download.pausedPlaceholder') : '';
    input.type = paused || $('reveal').getAttribute('aria-pressed') === 'true' ? 'text' : 'password';
    if (paused) input.value = ''; else set('unlock-label', t('download.unlock'));
    input.setAttribute('aria-invalid', String(['wrong', 'format'].includes(root.dataset.error)));
    const message = paused ? t('download.pausedMessage') : root.dataset.error === 'wrong' ? (left > 0 ? t('download.wrongPasswordTries', {count: left}) : t('download.wrongPassword'))
      : root.dataset.error === 'format' ? t('download.passwordFormat') : '';
    $('password-message').innerHTML = message ? icon(paused ? 'clock' : 'alert') + '<span>' + escapeHTML(message) + '</span>' : '';
  }

  // Runs every second: expiry, the pause countdown, and the upload's look between polls. Only the server closes a link:
  // a countdown at zero asks it, and the page shows "gone" only when it answers 404 or 410.
  function tick() {
    if (data.state === 'gone') return;
    if (data.state === 'uploading') { renderProgress(); return; }
    if (data.expiresAt) {
      const left = data.expiresAt - now();
      if (left <= 0 && !pollTimer && !polling) poll();
      set('expires-in', leftLabel(left)); set('expires-at', t('download.until', {date: dateLabel(data.expiresAt)}));
      setLine($('life-fill'), lifeShare(left));
    }
    if (root.dataset.error !== 'paused') return;
    const wait = (data.pausedUntil || 0) - now();
    if (wait > 0) { set('unlock-label', t('download.tryAgainIn', {time: clockLabel(wait)})); return; }
    pauseOver();
  }
  function pauseOver() {
    const reading = [document.body, $('password-message')].includes(document.activeElement);
    data.error = null; render(); announce(t('download.passwordAgain'));
    if (reading && finePointer()) $('password').focus();
  }
  // The sender can lift a pause early (the upload page offers it). A request without a password shows when: the
  // download address answers 429 while this network is paused and 401 once it may try again, and it spends no try. It
  // runs when the page comes back into view and every minute while it shows the pause.
  let probing = false;
  async function probePause() {
    if (root.dataset.error !== 'paused' || document.hidden || probing) return;
    probing = true;
    try {
      const response = await fetch(location.pathname + '?dl=1', {method: 'HEAD', cache: 'no-store', credentials: 'omit'});
      if (response.status === 401 && root.dataset.error === 'paused') { data.pausedUntil = 0; pauseOver(); }
    } catch {} finally { probing = false; }
  }

  // Received bytes grow by whole parts, so the rate comes from the server's part times, over at least 15 s. The
  // upload counts as stalled when no part finished for 1.5 times the longest gap seen between parts (at least
  // 1 minute, at most 10); before any gap was seen, after 3 minutes: four parallel 50 MiB parts on a slower uplink
  // take that long to finish the first time.
  function renderProgress() {
    const size = data.size || 1, received = Math.min(data.received || 0, size), percent = Math.min(99, Math.floor(received / size * 100));
    const idle = data.updatedAt ? now() - data.updatedAt : 0, was = stalled;
    stalled = idle > (longest ? Math.min(600000, Math.max(60000, longest * 1.5)) : 180000);
    if (stalled !== was) {
      root.toggleAttribute('data-stalled', stalled);
      if (stalled) announce(t('download.stalledAnnounce'));
      else Object.assign(first, {received, at: data.updatedAt});
    }
    const span = data.updatedAt - first.at, rate = span >= 15000 && received > first.received ? (received - first.received) / span : 0;
    // An encrypted upload counts stored bytes; shown on the plaintext's scale.
    const scale = E2EE ? plaintext() / size : 1;
    set('progress-text', t(stalled ? 'download.waitingSender' : 'download.uploadingPart', {part: partLabel(Math.round(received * scale), Math.round(size * scale))}));
    set('progress-number', stalled ? t('download.paused') : rate ? aboutLabel((size - received) / rate - idle) : L.percent(percent));
    setLine($('progress-fill'), percent / 100);
    $('progress').setAttribute('aria-valuenow', String(percent));
  }

  const expired = () => !!data.expiresAt && data.expiresAt - now() <= 0;
  const schedule = ms => { clearTimeout(pollTimer); pollTimer = setTimeout(poll, Math.round(ms * (0.8 + Math.random() * 0.4))); };
  // Polls the transfer while it uploads, and confirms an expiry the countdown reached. A hidden page doesn't poll; it
  // asks once when it becomes visible again.
  async function poll() {
    clearTimeout(pollTimer); pollTimer = null;
    if (document.hidden || polling || data.state === 'gone') return;
    polling = true; lastPoll = Date.now();
    let changed = false, status = 0, retryAfter = null;
    try {
      const response = await fetch('/api/transfers/' + encodeURIComponent(transferId), {cache:'no-store', credentials:'omit', headers:{Accept:'application/json'}});
      const info = await response.json().catch(() => ({}));
      status = response.status; retryAfter = response.headers.get('Retry-After');
      syncClock(response, info);
      if (status === 404 || status === 410) { close(status === 410 ? info.code : 'missing'); return; }
      if (status === 403 && info.code === 'quarantined') { close('quarantined'); return; }
      if (status === 503 && info.code === 'unsupported_mode') { close('unsupported_mode'); return; }
      if (response.ok && data.state === 'uploading') {
        if (info.state === 'ready') { finished(info); return; }
        changed = info.received !== data.received || info.updatedAt !== data.updatedAt;
        if (info.updatedAt > data.updatedAt && !stalled) longest = Math.max(longest, info.updatedAt - data.updatedAt);
        if (!first.at) Object.assign(first, {received: info.received, at: info.updatedAt});
        Object.assign(data, {received: info.received, updatedAt: info.updatedAt, size: info.size || data.size});
        renderProgress();
      } else if (response.ok && Number.isFinite(info.expiresAt)) { data.expiresAt = info.expiresAt; tick(); }
    } catch {} finally { polling = false; }
    if (data.state === 'gone') return;
    delay = nextDelay(delay, {changed, status, retryAfter});
    if (data.state === 'uploading' || expired()) schedule(delay);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !(data.state === 'uploading' || expired())) return;
    if (Date.now() - lastPoll < 2000) schedule(2000); else poll();
  });
  // A protected file is loaded again (as GET), which then asks for the password; any other starts downloading: the
  // line fills and turns green, then Download takes the status row's place. An encrypted page changes in place, so the
  // key in its address never crosses a navigation, and waits for a click (§9.5).
  function finished(info) {
    if (E2EE) {
      Object.assign(data, {state: data.protected || info.protected ? 'protected' : 'ready', expiresAt: info.expiresAt, once: info.once ?? data.once, size: info.size || data.size});
      if (data.state === 'ready' && !e.blobs && info.e2ee?.head && info.e2ee?.meta) { e.blobs = {head: info.e2ee.head, meta: info.e2ee.meta}; check(); }
      setLine($('progress-fill'), 1); $('progress').classList.add('done');
      setTimeout(() => { delay = 5000; render(); announce(t('download.readyDownload')); }, 450);
      return;
    }
    if (data.protected || info.protected) { location.replace(location.pathname + location.search); return; }
    Object.assign(data, {name:info.name || data.name, size:info.size || data.size, expiresAt:info.expiresAt, once:info.once ?? data.once});
    setLine($('progress-fill'), 1); $('progress').classList.add('done');
    setTimeout(() => { data.state = 'ready'; delay = 5000; render(); announce(t('download.readyFile')); start(); }, 450);
  }
  function close(reason) {
    clearTimeout(pollTimer); pollTimer = null;
    data = {state:'gone', reason:GONE[reason] ? reason : 'missing'}; e.broken = null;
    render(); announce(GONE[data.reason][3]);
  }
  // The file comes as an attachment, so the page stays. A one-time download only starts while the page is visible,
  // so a tab left in the background doesn't use up the only download unseen.
  function start() {
    if (started || E2EE) return;
    if (data.once && document.hidden) { document.addEventListener('visibilitychange', start, {once:true}); return; }
    started = true; location.assign($('download').href); onceBegun();
  }
  // A raw one-time link's one download has begun (the automatic start or a click): Download stays, for a download that
  // broke off (the same network may fetch it again for 15 minutes), but becomes the secondary button that says so,
  // and the note under it says what happens now. A second click doesn't start a second copy of the file by mistake.
  function onceBegun() {
    if (begun || E2EE || !data.once) return;
    begun = true;
    $('download').classList.remove('btn-primary'); $('download').classList.add('btn-secondary');
    set('download-label', t('download.onceAgain')); set('once-note', t('download.onceStarted'));
    announce(t('download.onceStarted'));
  }

  // The key check (§9.1) on head and meta, before any request that could use up the link. A wrong or malformed key
  // brings back the key field; a damaged or newer file, or a browser that can't decrypt, says so instead. Only the
  // core's own errors (E2EEError, with a string code) say anything about the key or the file: any other failure means
  // its code didn't load, a network blip, never a damaged file. Browsers keep a failed module import for the page's
  // whole life, so the retry reloads the page, which keeps the key in its address (§9.5).
  let core = null;
  const loadCore = () => { core ??= import('./e2ee/age.js'); return core; };
  const coreError = error => error?.name === 'E2EEError' && typeof error.code === 'string';
  async function check() {
    if (!E2EE || !e.key || !e.blobs) { render(); return; }
    const key = e.key, blobs = e.blobs;
    e.checking = true; e.verified = null; e.error = null; e.broken = null; render();
    let result = null, failure = null;
    try {
      const age = await loadCore();
      result = await age.checkKey(key, age.decodeBlob(blobs.head), age.decodeBlob(blobs.meta), data.size);
    } catch (error) { failure = coreError(error) ? error.code : 'load'; }
    if (key !== e.key || blobs !== e.blobs) return; // another key or answer came meanwhile
    e.checking = false;
    if (result) {
      e.verified = {name: result.name, size: result.size};
      // A typed key, or one rescued from the path, is kept for this tab so a reload keeps working (§2.4).
      if (e.source === 'typed' || e.source === 'exposed') keepOpenKey(transferId, key);
      announce(t('download.keyOpens', {name: result.name, size: sizeLabel(result.size)}));
    } else if (failure === 'load') e.error = 'load'; // the key stays in the address for the reload
    else if (failure === 'platform') e.broken = 'platform'; // no key can work here; the key stays for the command
    else if (['key_wrong', 'key_invalid'].includes(failure)) {
      // The key goes; the field asks for another (a kept key that no longer fits goes without a message).
      e.key = null; e.error = e.source === 'stored' ? null : failure;
    } else e.broken = failure === 'unsupported' ? 'newer' : 'damaged';
    render();
    if (e.error && finePointer()) $(e.error === 'load' ? 'open-file' : 'key').focus();
  }
  // The key field takes a KEY, a whole fyl link to this file or an age identity (§2.4).
  async function parseEntry() {
    try { return (await loadCore()).parseKeyEntry($('key').value, transferId, location.origin); }
    catch (error) {
      e.error = !coreError(error) ? 'load' : error.code === 'other_transfer' ? 'other_transfer' : 'key_invalid';
      e.verified = null; render(); $(e.error === 'load' ? 'open-file' : 'key').focus(); return null;
    }
  }
  async function enterKey() {
    if (!$('key').value.trim()) { e.error = view() === 'protected' ? 'key_missing' : 'key_invalid'; render(); $('key').focus(); return; }
    const key = await parseEntry();
    if (!key) return;
    e.key = key; e.source = 'typed'; e.error = null;
    if (e.blobs) await check(); else render();
  }
  // A protected encrypted link (§11): the password goes as HTTP Basic to the info route, which answers head and meta;
  // the page never navigates and keeps the password in memory for the download's requests. The key is checked first
  // for its form, so a missing or malformed one costs no password try.
  async function unlockEncrypted() {
    if (submitting) return;
    if (e.error === 'load') { location.reload(); return; } // see check()
    if (!validPassword($('password').value)) { data.error = 'format'; render(); $('password').focus(); return; }
    if ($('key').value.trim() && (!e.key || e.error)) {
      const key = await parseEntry();
      if (!key) return;
      e.key = key; e.source = 'typed'; e.error = null;
    }
    if (!e.key) { e.error = 'key_missing'; render(); $('key').focus(); return; }
    const password = $('password').value;
    submitting = true; $('unlock').disabled = true;
    let response = null, info = {};
    try {
      response = await fetch('/api/transfers/' + encodeURIComponent(transferId), {cache: 'no-store', credentials: 'omit',
        headers: {Accept: 'application/json', Authorization: basic(password)}});
      info = await response.json().catch(() => ({}));
    } catch { toast(t('download.unreachable')); }
    finally { submitting = false; $('unlock').disabled = false; }
    if (!response) return;
    syncClock(response, info);
    $('password').value = ''; // the page never keeps a typed password in the field
    if (response.ok && info.mode !== 'e2ee') { close('mismatch'); return; }
    if (response.ok && typeof info.e2ee?.head === 'string' && typeof info.e2ee?.meta === 'string') {
      e.password = password; data.error = null;
      if (Number.isFinite(info.expiresAt)) data.expiresAt = info.expiresAt;
      e.blobs = {head: info.e2ee.head, meta: info.e2ee.meta};
      await check();
      return;
    }
    if (response.status === 401) {
      Object.assign(data, {error: 'wrong', triesLeft: info.triesLeft}); render();
      $('password-field').classList.remove('shake'); void $('password-field').offsetWidth; $('password-field').classList.add('shake');
      if (finePointer()) $('password').focus();
    } else if (response.status === 429 && info.code === 'password_paused') { Object.assign(data, {error: 'paused', pausedUntil: info.pausedUntil}); render(); }
    else if (response.status === 404 || response.status === 410) close(response.status === 410 ? info.code : 'missing');
    else if (response.status === 403 && info.code === 'quarantined') close('quarantined');
    else if (response.status === 503 && info.code === 'unsupported_mode') close('unsupported_mode');
    else toast(info.code && L.has('common.error.' + info.code) ? t('common.error.' + info.code) : info.error || t('download.passwordCheckFailed'));
  }

  // Saving (§9.2, §9.3). With an active service worker the browser saves a stream: the page posts the file's name and
  // size with a port to it, opens /_dl/<token> in a hidden frame and sends the download request only once the worker
  // reports the browser's first pull. Otherwise the file is decrypted into memory, up to 256 MiB, and saved from a Blob
  // through <a download> after it verified completely. Decryption runs in a dedicated worker, or on the page.
  let saveState = 'idle', registration = null, registering = null, blobURL = null, savedName = '';
  const streaming = E2EE && streams(navigator);
  // Registered on load; a registration that failed is tried again at the next click.
  const register = () => {
    if (!streaming) return Promise.resolve(null);
    registering ??= navigator.serviceWorker.register('/_dl/sw.js', {scope: '/_dl/'})
      .then(found => { registration = found; return found; }, () => { registering = null; return null; });
    return registering;
  };
  register();
  const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });
  // The service worker for this click: the active one, or one that activates within 5 s (a first visit registers it on
  // load, so it may still be installing at the click). null: the fallback saves.
  async function activeWorker() {
    if (!streaming) return null;
    const deadline = Date.now() + 5000, found = registration || await Promise.race([register(), sleep(5000).then(() => null)]);
    if (!found || found.active?.state === 'activated') return found?.active || null;
    const worker = found.installing || found.waiting || found.active;
    if (worker && worker.state !== 'redundant') await new Promise(resolve => {
      const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      worker.addEventListener('statechange', () => { if (['activated', 'redundant'].includes(worker.state)) { clearTimeout(timer); resolve(); } });
    });
    return found.active?.state === 'activated' ? found.active : null;
  }
  // Why a save failed, as download.saveError.<code>; trailing data reads as a damaged file.
  const SAVE_ERRORS = ['corrupt', 'truncated', 'network', 'cancelled', 'unsupported', 'refused', 'load'];
  const saveError = code => t('download.saveError.' + (code === 'trailing_data' ? 'corrupt' : SAVE_ERRORS.includes(code) ? code : 'network'));
  // The button stays focusable while it runs (aria-disabled; save() ignores clicks then), so keyboard focus never falls
  // back to the page; where it hides, focus moves to what replaces it.
  function setSave(state, message = '') {
    saveState = state;
    const size = sizeLabel(plaintext()), focused = document.activeElement === $('save');
    // Too big for memory: a browser that can stream tries again on the next click (its worker may activate meanwhile).
    $('save').hidden = state === 'memory' || (state === 'big' && !streaming) || (state === 'saved' && data.once);
    $('save').setAttribute('aria-disabled', String(state === 'running'));
    set('save-label', state === 'running' ? t('download.decryptingRunning') : state === 'failed' || state === 'big' ? t('download.tryAgain') : state === 'saved' ? t('download.downloadAgain') : t('download.downloadSize', {size}));
    $('save-progress').hidden = state !== 'running';
    $('saved-line').hidden = state !== 'saved' && state !== 'memory';
    if (state === 'saved') set('saved-text', t('download.savedAs', {name: savedName}));
    if (state === 'memory') set('saved-text', t('download.savedMemory', {name: savedName}));
    $('save-again').hidden = state !== 'memory';
    $('save-error').innerHTML = state === 'failed' ? icon('alert') + '<span>' + escapeHTML(message) + '</span>' : '';
    set('e2ee-note-text', t(state !== 'big' ? 'download.e2eeNote' : streaming ? 'download.noStart' : appleTouch(navigator) ? 'download.appleBig' : 'download.memoryBig'));
    if (focused && $('save').hidden) $(state === 'memory' ? 'save-again' : state === 'big' ? 'e2ee-note' : 'saved-line').focus();
  }
  function saveProgress(verified) {
    const size = plaintext() || 1, percent = Math.min(100, Math.floor(verified / size * 100));
    set('save-text', t('download.decryptingPart', {part: partLabel(verified, size)})); set('save-number', L.percent(percent));
    setLine($('save-fill'), percent / 100); $('save-bar').setAttribute('aria-valuenow', String(percent));
  }
  function saveFailed(event, saved) {
    if (event.code === 'refused' && [404, 410].includes(event.status)) { close(event.status === 410 ? event.serverCode : 'missing'); return; }
    if (event.code === 'refused' && event.serverCode === 'quarantined') { close('quarantined'); return; }
    if (event.code === 'refused' && event.serverCode === 'unsupported_mode') { close('unsupported_mode'); return; }
    // A browser may keep the part it saved: the page says the file is incomplete (§9.2). #save-error is an alert, which
    // screen readers announce; the live region doesn't repeat it.
    const message = [saved ? t('download.saveIncomplete') : '', saveError(event.code), data.once ? t('download.onceRetry') : ''].filter(Boolean).join(' ');
    setSave('failed', message);
  }
  // One-time links stay open for retries after delivery; once the file verified and is saved, the page closes it at
  // once (§11). Not earlier: a save that fails after the last chunk verified can still be tried again.
  const closeOnce = () => { if (data.once) fetch('/api/transfers/' + encodeURIComponent(transferId) + '/done', {method: 'POST', cache: 'no-store', credentials: 'omit'}).catch(() => {}); };
  const startWorker = () => new Promise(resolve => {
    let worker;
    try { worker = new Worker('/e2ee/worker.js', {type: 'module'}); } catch { resolve(null); return; }
    const timer = setTimeout(() => { worker.terminate(); resolve(null); }, 5000);
    worker.onmessage = ({data: message}) => { if (message?.type === 'ready') { clearTimeout(timer); resolve(worker); } };
    worker.onerror = () => { clearTimeout(timer); worker.terminate(); resolve(null); };
  });
  // Starts the download's decryption writing to `port`; resolves to a function that stops it, or rejects when its code
  // didn't load (the caller says so; nothing was asked of fyl.at then).
  async function decrypt(port, onEvent) {
    const job = {url: location.origin + '/d/' + transferId + '?dl=1', auth: e.password ? basic(e.password) : null, key: e.key, head: e.blobs.head,
      size: e.verified.size, ciphertextSize: data.size};
    const worker = await startWorker();
    if (worker) {
      worker.onmessage = ({data: event}) => onEvent(event);
      worker.postMessage({job: 'decrypt', download: job}, [port]);
      return () => worker.terminate();
    }
    (await import('./e2ee/jobs.js')).produce(job, port, onEvent);
    return () => {};
  }
  const token = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  // Resolves to 'fallback' when the worker didn't start the download within 10 s (nothing was requested), else 'done'.
  function viaServiceWorker(active) {
    return new Promise(resolve => {
      const channel = new MessageChannel(), port = channel.port1, id = token(), frame = document.createElement('iframe');
      let stop = () => {}, verified = false, closed = false, over = false, begun = false;
      const end = result => { if (over) return; over = true; clearTimeout(timer); clearInterval(ping); stop(); setTimeout(() => frame.remove(), 1000); resolve(result); };
      const timer = setTimeout(() => {
        // The browser never pulled: the token is cancelled and nothing was asked of fyl.at.
        port.postMessage({type: 'error'}); port.close(); active.postMessage({type: 'cancel', token: id}); end('fallback');
      }, 10000);
      const ping = setInterval(() => active.postMessage({type: 'ping'}), 10000);
      // The final chunk verified and the browser has the whole stream: only now is a one-time link closed, so a cancel
      // that comes after the last chunk verified but before the stream closed still leaves the retry it is offered.
      const success = () => { closeOnce(); setSave('saved'); announce($('saved-text').textContent); end('done'); };
      port.onmessage = async ({data: message}) => {
        if (message?.type === 'cancel') { saveFailed({code: 'cancelled'}, false); end('done'); return; }
        if (message?.type !== 'pulled' || begun || over) return;
        begun = true; clearTimeout(timer);
        try {
          stop = await decrypt(port, event => {
            if (over) return;
            if (event.type === 'progress') saveProgress(event.verified);
            else if (event.type === 'done') { verified = true; if (closed) success(); }
            else if (event.type === 'closed') { closed = true; if (verified) success(); }
            else if (event.type === 'error') { saveFailed(event, true); end('done'); }
            else if (event.type === 'cancelled') { saveFailed({code: 'cancelled'}, true); end('done'); }
          });
        } catch {
          // The decryption code didn't load: the browser's download fails at once instead of waiting for data.
          port.postMessage({type: 'error'}); saveFailed({code: 'load'}, true); end('done'); return;
        }
        if (over) stop();
      };
      active.postMessage({type: 'download', token: id, name: e.verified.name, size: e.verified.size}, [channel.port2]);
      frame.hidden = true; frame.src = '/_dl/' + id;
      document.body.append(frame);
    });
  }
  function inMemory() {
    return new Promise(resolve => {
      const channel = new MessageChannel(), chunks = [];
      let stop = () => {}, over = false;
      const end = () => { if (over) return; over = true; stop(); channel.port2.close(); resolve(); };
      channel.port2.onmessage = ({data: message}) => {
        if (over) return;
        if (message?.type === 'chunk') { chunks.push(message.data); channel.port2.postMessage({type: 'ack'}); }
        else if (message?.type === 'end') {
          // The end comes only after the final chunk verified, and the one-time link is closed on it rather than on
          // the worker's done: stopping the worker here can drop that message, which it sends after the end.
          closeOnce();
          // Only a file that verified completely becomes a Blob; it is saved through <a download>, never opened.
          if (blobURL) URL.revokeObjectURL(blobURL);
          blobURL = URL.createObjectURL(new Blob(chunks, {type: 'application/octet-stream'}));
          chunks.length = 0; saveBlob(); setSave('memory'); announce($('saved-text').textContent); end();
        }
      };
      decrypt(channel.port1, event => {
        if (over) return;
        if (event.type === 'progress') saveProgress(event.verified);
        else if (event.type === 'error') { chunks.length = 0; saveFailed(event, false); end(); }
      }).then(stopper => { stop = stopper; if (over) stopper(); }, () => { if (!over) { saveFailed({code: 'load'}, false); end(); } });
    });
  }
  function saveBlob() {
    const anchor = document.createElement('a');
    anchor.href = blobURL; anchor.download = savedName; anchor.rel = 'noopener'; anchor.hidden = true;
    document.body.append(anchor); anchor.click(); anchor.remove();
  }
  async function save() {
    if (!e.verified || saveState === 'running') return;
    savedName = e.verified.name;
    setSave('running'); saveProgress(0);
    const active = await activeWorker();
    if (active && await viaServiceWorker(active) === 'done') return;
    if (e.verified.size > MEMORY_LIMIT) { setSave('big'); return; }
    await inMemory();
  }
  window.addEventListener('pagehide', () => { if (blobURL) URL.revokeObjectURL(blobURL); blobURL = null; });
  // The page decrypts, so closing it stops the download (§9.2): the browser asks first while one runs.
  window.addEventListener('beforeunload', event => { if (saveState === 'running') { event.preventDefault(); event.returnValue = ''; } });

  $('reveal').addEventListener('click', () => {
    const shown = $('reveal').getAttribute('aria-pressed') !== 'true';
    $('reveal').setAttribute('aria-pressed', String(shown)); $('password').type = shown ? 'text' : 'password';
    $('reveal').querySelector('use').setAttribute('href', shown ? '#i-eye-off' : '#i-eye');
  });
  // A grant (?grant=<expiry>.<signature>) lasts an hour. After that the button loads the page again, which asks for
  // the password, instead of a refused download that would open the browser's own password dialog.
  if (!E2EE) $('download').addEventListener('click', event => {
    const expiry = Number(new URL($('download').href).searchParams.get('grant')?.split('.')[0]);
    if (data.state === 'unlocked' && expiry && now() >= expiry) { event.preventDefault(); location.replace(location.pathname); return; }
    started = true; onceBegun();
  });
  $('password').addEventListener('input', () => {
    $('password').setAttribute('aria-invalid', 'false');
    if (data.error === 'format') { data.error = null; render(); }
  });
  // A double click must not send the password twice: each wrong one counts. Nor is one sent the server would refuse.
  $('unlock-form').addEventListener('submit', event => {
    if (E2EE) { event.preventDefault(); unlockEncrypted(); return; }
    if (submitting) { event.preventDefault(); return; }
    if (!validPassword($('password').value)) {
      event.preventDefault(); data.error = 'format'; render(); $('password').focus(); return;
    }
    submitting = true;
  });
  // Open file reads the field; after the decryption code failed to load, Try again reloads the page (see check()).
  $('open-file').addEventListener('click', () => { if (e.error === 'load') location.reload(); else enterKey(); });
  $('key').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault?.();
    if (view() === 'protected') $('password').focus(); else enterKey();
  });
  $('key').addEventListener('input', () => { if (e.error) { e.error = null; renderKey(view()); } });
  $('save').addEventListener('click', save);
  $('save-again').addEventListener('click', () => { if (blobURL) saveBlob(); });
  // A key changed in the address bar is read and checked again (§9.5).
  window.addEventListener('hashchange', () => {
    if (!E2EE) return;
    const found = addressKey(location.pathname, location.hash);
    if (found.invalid) { Object.assign(e, {key: null, error: 'key_invalid', verified: null, broken: null}); render(); return; }
    if (!found.key || found.key === e.key) return;
    Object.assign(e, {key: found.key, source: 'address', error: null});
    check();
  });
  // The skip link moves focus without touching the fragment, which may hold the key (§9.5).
  document.querySelector('.skip')?.addEventListener('click', event => {
    event.preventDefault(); $('card').setAttribute('tabindex', '-1'); $('card').focus();
  });
  window.addEventListener('pageshow', () => { submitting = false; });
  // Copied: the icon swaps to a tick for 2 s and the live region says so; no toast on top.
  let copiedTimer = null;
  $('copy-command').addEventListener('click', async () => {
    const text = command;
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch {
      const field = document.createElement('textarea');
      field.value = text; field.setAttribute('readonly',''); field.style.position = 'fixed'; field.style.top = '-1000px';
      // Selecting the field moves focus into it, and removing it would drop focus to the page: it goes back to the
      // button that copied.
      const back = document.activeElement;
      document.body.append(field); field.select();
      try { copied = document.execCommand('copy'); } catch {}
      field.remove(); back?.focus?.({preventScroll: true});
    }
    if (!copied) { getSelection().selectAllChildren($('curl-command')); toast(t('common.clipboardFailed')); return; }
    announce(t('common.commandCopied'));
    const [first, second] = $('copy-command').querySelector('.swap')?.children || [];
    if (!second) return;
    first.toggleAttribute('data-off', true); second.toggleAttribute('data-off', false);
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { first.toggleAttribute('data-off', false); second.toggleAttribute('data-off', true); }, 2000);
  });

  // "Download in a terminal" eases open and shut like the upload page's reveals. Only Chromium can ease a <details> to
  // its auto height in CSS, so the script runs it everywhere: the element eases from the height it has to the summary's
  // or its full one (.sizing in styles.css), the window fades and slides in or out (download.css), and a click on the
  // way turns it around from where it is. It stays open until a closing ease has ended, so nothing jumps.
  const term = document.querySelector('details.term'), summary = term.querySelector('summary');
  const stillMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let shutting = false;
  const settle = () => {
    clearTimeout(term.sizeTimer); term.classList.remove('sizing', 'closing'); term.style.height = '';
    if (shutting) { shutting = false; term.open = false; term.removeAttribute('data-shut'); }
  };
  term.addEventListener('transitionend', event => { if (event.target === term && event.propertyName === 'height') settle(); });
  summary.addEventListener('click', event => {
    if (stillMotion.matches || document.visibilityState !== 'visible') return;
    event.preventDefault();
    const from = term.getBoundingClientRect().height, opening = !term.open || shutting;
    clearTimeout(term.sizeTimer); term.classList.remove('sizing', 'closing'); term.style.height = '';
    shutting = !opening; term.toggleAttribute('data-shut', !opening);
    // Opening, the window starts hidden (data-opening) and is measured at its full height before it eases in.
    if (opening && !term.open) { term.setAttribute('data-opening', ''); term.open = true; }
    const top = term.getBoundingClientRect().top;
    const to = opening ? term.getBoundingClientRect().height : summary.getBoundingClientRect().bottom - top;
    term.style.height = from + 'px';
    void term.offsetHeight;
    term.removeAttribute('data-opening');
    term.classList.add('sizing'); term.classList.toggle('closing', !opening);
    term.style.height = to + 'px';
    if (Math.abs(to - from) < 1) { settle(); return; }
    term.sizeTimer = setTimeout(settle, 600 * (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--slow')) || 1));
  });

  // The page opts into cross-document view transitions for the unlock reload (the form posts to this page). A link to
  // another page (report, privacy, home) skips it: those pages don't opt in, and the browser would abort it with an error.
  window.addEventListener('pageswap', event => {
    const transition = event.viewTransition, to = event.activation?.entry?.url;
    if (!transition) return;
    [transition.ready, transition.finished, transition.updateCallbackDone].forEach(promise => promise?.catch(() => {}));
    if (!to || new URL(to).pathname !== location.pathname) transition.skipTransition();
  });
  // The language menu (?lang=, see downloadPage() in src/index.ts) keeps the fragment, which may hold the key: a link
  // alone would drop it. The key stays in the fragment, which browsers never send.
  document.getElementById('lang-menu')?.addEventListener('click', event => {
    const item = event.target.closest?.('a[data-lang]');
    if (!item || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); location.assign(item.getAttribute('href') + location.hash);
  });
  // The unlock form posts to this page; reloading the answer must not send the password again.
  if (!E2EE) history.replaceState(history.state, '', location.href);
  render();
  if (E2EE) check();
  if (data.state === 'gone') return;
  setInterval(tick, 1000);
  // The field is focused only with a fine pointer, so a phone keyboard doesn't cover the card. A wrong password shakes
  // the field once; #password-message, a live region the field is described by, says it once.
  if (data.state === 'protected' && root.dataset.error !== 'paused' && finePointer()) $(E2EE && !e.key ? 'key' : 'password').focus();
  // An encrypted link without a usable key focuses the key field the same way (not while a key from the address is
  // checked: the field is hidden then).
  else if (E2EE && view() === 'key' && !$('key-box').hidden && finePointer()) $('key').focus();
  // A paused link disables every control, so focus goes to the reason instead of the page; it opens no keyboard.
  if (data.state === 'protected' && root.dataset.error === 'paused') { $('password-message').setAttribute('tabindex', '-1'); $('password-message').focus({preventScroll: true}); }
  if (data.state === 'protected') {
    setInterval(probePause, 60000);
    window.addEventListener('focus', probePause);
    document.addEventListener('visibilitychange', probePause);
  }
  if (data.state === 'protected' && root.dataset.error === 'wrong') $('password-field').classList.add('shake');
  // Started once the page has loaded: a navigation begun earlier would cut its remaining loads short.
  if (data.state === 'unlocked' && !E2EE) window.addEventListener('load', start, {once:true});
  if (data.state === 'uploading' && transferId) schedule(delay);
})();

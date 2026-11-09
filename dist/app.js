(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  // The page's language (dist/i18n.js, loaded first): its messages, and numbers, sizes, times and dates as it writes them.
  const L = window.FylText, t = L.t, tHtml = L.tHtml;
  const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon = name => '<svg class="i" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  // Two stacked labels in one grid cell (see .swap in styles.css): Copy and Copied, the icon and its tick.
  const COPY_ICONS = '<span class="swap swap-ico"><svg class="i" aria-hidden="true"><use href="#i-copy"/></svg><svg class="i" aria-hidden="true" data-off><use href="#i-check"/></svg></span>';
  const copyLabel = label => COPY_ICONS + '<span class="swap"><span>' + escapeHTML(label) + '</span><span data-off>' + escapeHTML(t('common.copied')) + '</span></span>';
  const CLI_INSTALL_COMMAND = 'curl -fsSL https://fyl.at/cli/install | sh';
  const LIMIT = window.FYL_CONFIG?.maxFileBytes || 53687091200;
  // End-to-end encryption (docs/E2EE.md): its option shows while the Worker's config says the server takes encrypted
  // uploads (E2EE_ENABLED, an emergency switch); encrypted transfers keep working whatever it says.
  const E2EE = window.FYL_CONFIG?.e2ee === true;
  const loadCore = () => import('./e2ee/age.js');
  const GB = 1073741824;
  const transfers = new Map(), main = $('main');
  let selectedFile = null, activeId = null, currentView = 'setup', busy = false;
  // A folder becomes one zip (docs/FOLDER-ZIP.md, dist/zip.js), dropped or chosen from the drop zone's menu where the
  // browser can pick folders (iOS and iPadOS can't). While its files are listed and read once for their CRCs, `folder`
  // holds it and the file card shows <folder>.zip with the progress; then its zip, a File made of header bytes and the
  // folder's own files, is the chosen file, which every upload path reads like any other.
  const ZIP = window.FylZip;
  const IOS = /iP(hone|ad|od)/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const FOLDERS = !!ZIP && !IOS && (!!window.showDirectoryPicker || 'webkitdirectory' in document.createElement('input'));
  // Several files at once: where folders can be sent, putting them in one is the simpler way.
  const MULTIPLE = t(FOLDERS ? 'home.multipleFolder' : 'home.multiple');
  let folder = null;
  const folderOf = file => folder && file && folder.zip === file ? folder : null;
  // What a resume compares besides the name and size: a file's date, a folder's fingerprint F (FOLDER-ZIP §9).
  const dateOf = file => folderOf(file)?.print ?? file.lastModified;
  let toastTimer = null, pendingDelete = null, pendingExpiry = null, uploadController = null, ownUpload = null, reviewed = null;
  // The link shown in the link object (`shown`), the early one while uploading, and whether an encrypted link's key left
  // this tab (copied or shared) yet.
  let early = null, shown = null, keyCopied = false;

  // Keyboard changes never animate (the expiry pill jumps), pointer presses do.
  let viaKeyboard = false;
  window.addEventListener('keydown', event => { if (!['Shift','Control','Alt','Meta'].includes(event.key)) viaKeyboard = true; }, true);
  window.addEventListener('pointerdown', () => { viaKeyboard = false; }, true);
  // Sizes in binary units (1 GB = 1024³ bytes), "0.70 of 1.84 GB", the time left rounded down (47 min, 6 h 12 min,
  // 2 days 23 h), "Mon 2 Nov, 10:10" in this device's time zone: all in the page's language (dist/i18n.js).
  const sizeLabel = L.size, partLabel = L.part, leftLabel = L.left, when = L.date, dayLabel = L.day;
  const lifetime = () => {
    const value = document.querySelector('input[name="lifetime"]:checked').value;
    return value === 'custom' ? Number($('custom-minutes').value) * Number($('custom-unit').value) : Number(value);
  };
  const durationLabel = L.duration;
  const splitMinutes = minutes => minutes % 1440 === 0 ? [minutes / 1440, '1440'] : minutes % 60 === 0 ? [minutes / 60, '60'] : [minutes, '1'];
  const validLifetime = minutes => Number.isInteger(minutes) && minutes >= 5 && minutes <= 10080;
  // What is wrong with a lifetime, by name.
  const lifetimeProblem = minutes => !(minutes > 0) ? t('home.lifetimeNumber') : !Number.isInteger(minutes) ? t('home.lifetimeWhole')
    : t(minutes > 10080 ? 'home.lifetimeLong' : 'home.lifetimeShort', {duration: durationLabel(minutes)});
  // The server's rule exactly (api.js); the server keeps only a hash.
  const validPassword = text => window.FylAPI.validPassword(text);
  const chosenPassword = () => $('password-toggle').checked ? $('password-input').value : '';
  const e2ee = () => E2EE && $('e2ee-toggle').checked;
  // An encrypted transfer's name is known only to this browser: the server stores it encrypted.
  const encrypted = record => record?.mode === 'e2ee';
  const unnamed = record => t(encrypted(record) ? 'home.encryptedFile' : 'home.protectedFile');
  // The same inside a sentence: "Manage protected file", "Forgot the protected file on this device."
  const unnamedInline = record => t(encrypted(record) ? 'home.anEncryptedFile' : 'home.aProtectedFile');
  const unnamedThe = record => t(encrypted(record) ? 'home.theEncryptedFile' : 'home.theProtectedFile');
  const shellQuote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";
  const expiryArgument = minutes => minutes % 1440 === 0 ? minutes / 1440 + 'd' : minutes % 60 === 0 ? minutes / 60 + 'h' : minutes + 'm';
  // While the custom lifetime is invalid, the command keeps the default instead of an --expires the CLI refuses.
  const uploadFlags = () => {
    const minutes = lifetime(), flags = [];
    if (validLifetime(minutes) && minutes !== 1440) flags.push('--expires ' + expiryArgument(minutes));
    if ($('once-toggle').checked) flags.push('--once');
    if ($('password-toggle').checked) flags.push('--password');
    if (e2ee()) flags.push('--encrypt');
    return flags;
  };
  const fileArgument = () => folder ? shellQuote('./' + folder.root) : selectedFile ? shellQuote('./' + selectedFile.name) : './archive.zip';
  const uploadCommand = () => ['fyl ' + fileArgument(), ...uploadFlags()].join(' ');
  // The private link is fyl.at/#manage/…, which every version of the site and the CLI read; / picks the language. In the
  // address bar the page keeps its own address (/<lang>/), so a reload stays in its language.
  const siteURL = () => location.origin + '/';
  const managementURL = record => siteURL() + '#manage/' + record.id + '/' + record.ownerKey;
  const pageURL = () => location.origin + location.pathname;
  const managedPage = record => pageURL() + '#manage/' + record.id + '/' + record.ownerKey;
  // A server refusal in the page's language, by its code (the API's JSON stays English); otherwise its message.
  const reason = (failure, fallback) => (failure?.code && L.has('common.error.' + failure.code) ? t('common.error.' + failure.code) : failure?.message) || t(fallback);
  const announce = text => { $('live-status').textContent = text; };
  // File names and links break after / _ - . first (then anywhere, by CSS), but never just before the extension.
  const breakable = text => {
    const value = String(text), extension = /\.[a-z0-9]{1,10}$/i.exec(value)?.[0] || '';
    return escapeHTML(value.slice(0, value.length - extension.length)).replace(/([/_\-.%])/g, '$1<wbr>') + escapeHTML(extension);
  };
  // A command breaks like that too, but its last characters (the end of a 64-character id, the closing quote) stay
  // together, so no line holds just one or two of them.
  const commandHTML = text => breakable(text.slice(0, -8)) + '<span class="nowrap">' + escapeHTML(text.slice(-8)) + '</span>';
  // Middle truncation: the end of a value (version, extension, the last characters of a key) stays visible.
  const middle = (text, keep, tag = 'span', extra = '') => {
    const cut = Math.max(0, text.length - keep);
    return '<' + tag + extra + ' title="' + escapeHTML(text) + '"><span class="a">' + escapeHTML(text.slice(0, cut)) + '</span><span class="b">' + escapeHTML(text.slice(cut)) + '</span></' + tag + '>';
  };
  const swapTo = (element, second) => {
    const [first, other] = element?.children || [];
    if (!other) return;
    first.toggleAttribute('data-off', second); other.toggleAttribute('data-off', !second);
  };
  // The few changes that happen once per task (a file chosen, Upload becoming the link, back to the start) morph with a
  // view transition; without one they are instant. The update reads the current state when it runs, so a change made
  // meanwhile is never undone by a late callback.
  function morph(update) {
    if (!document.startViewTransition || document.visibilityState !== 'visible') { update(); return Promise.resolve(); }
    const transition = document.startViewTransition(update);
    transition.ready.catch(() => {});
    return transition.finished.catch(() => {});
  }

  // A change that makes a block taller or shorter (the terminal's command wrapping onto a second line when a flag is
  // added, the password lines in its output) eases to the new height like the reveals do (.sizing in styles.css)
  // instead of pushing the page at once. Interrupted, it starts from the height it has reached.
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  function resize(element, change) {
    if (!element?.getBoundingClientRect) { change(); return; }
    const from = element.getBoundingClientRect().height;
    clearTimeout(element.sizeTimer); element.classList.remove('sizing', 'closing'); element.style.height = '';
    change();
    const to = element.getBoundingClientRect().height;
    if (!from || !to || Math.abs(to - from) < 1 || reduceMotion?.matches || document.visibilityState !== 'visible') return;
    const done = () => { clearTimeout(element.sizeTimer); element.classList.remove('sizing', 'closing'); element.style.height = ''; };
    element.style.height = from + 'px';
    void element.offsetHeight;
    element.classList.add('sizing'); element.classList.toggle('closing', to < from);
    element.style.height = to + 'px';
    element.sizeTimer = setTimeout(done, 600 * (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--slow')) || 1));
    element.addEventListener('transitionend', event => { if (event.target === element && event.propertyName === 'height') done(); }, {once: true});
  }

  // The toast is a popover, so it shows in the top layer, above an open dialog and its backdrop; showing it afresh
  // also lifts it above a dialog opened since. Its message is announced through the page's live region (a region that
  // appears together with its text is often not read). Its timer waits while the tab is hidden and while the pointer
  // or focus is on it, so Undo never vanishes under the hand that reaches for it.
  let toastRun = null, toastShown = false, toastHovered = false, toastFocused = false;
  const popover = (element, open) => { try { if (open) element.showPopover?.(); else element.hidePopover?.(); } catch {} };
  function toast(message, {action = null, done = false} = {}) {
    const element = $('toast');
    clearTimeout(toastTimer);
    $('toast-text').textContent = message; $('toast-icon').toggleAttribute('hidden', !done); // an SVG has no .hidden
    $('toast-action').hidden = !action; toastRun = action?.run || null;
    if (action) $('toast-action').textContent = action.label;
    popover(element, false); popover(element, true); toastShown = true; toastHovered = false; toastFocused = false;
    announce(message);
    toastTimer = setTimeout(hideToast, action ? 6000 : 4300);
  }
  function hideToast() { clearTimeout(toastTimer); popover($('toast'), false); toastShown = false; toastRun = null; }
  // Restarts the timer once the toast is left alone again (2.5 s, as after the tab comes back).
  function holdToast() {
    if (!toastShown) return;
    clearTimeout(toastTimer);
    if (!toastHovered && !toastFocused && !document.hidden) toastTimer = setTimeout(hideToast, 2500);
  }
  $('toast').addEventListener('mouseenter', () => { toastHovered = true; holdToast(); });
  $('toast').addEventListener('mouseleave', () => { toastHovered = false; holdToast(); });
  $('toast').addEventListener('focusin', () => { toastFocused = true; holdToast(); });
  $('toast').addEventListener('focusout', () => { toastFocused = false; holdToast(); });
  // The action may name where focus goes next, since the button it was on disappears with the toast.
  $('toast-action').addEventListener('click', () => { const run = toastRun; hideToast(); run?.()?.focus?.({preventScroll: true}); });
  document.addEventListener('visibilitychange', holdToast);
  const dialogError = (name, message) => { $(name + '-error').textContent = message; $(name + '-error').hidden = !message; };
  function error(message, source = 'file') {
    const target = source === 'expiry' ? 'form-error' : 'file-error';
    ['file-error','form-error'].forEach(id => {
      $(id).textContent = id === target ? message : '';
      $(id).hidden = !$(id).textContent;
    });
  }
  // Copied: the button's icon and label swap in place for 2 s and the live region says so; no toast on top.
  function confirmCopy(button) {
    if (!button?.querySelectorAll) return;
    const swaps = [...button.querySelectorAll('.swap')];
    swaps.forEach(element => swapTo(element, true));
    clearTimeout(button.copiedTimer);
    button.copiedTimer = setTimeout(() => swaps.forEach(element => swapTo(element, false)), 2000);
  }
  async function copy(text, message, fieldId = '', button = null) {
    let copied = false;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text); copied = true;
    } catch {
      const field = document.createElement('textarea');
      field.value = text; field.setAttribute('readonly',''); field.style.position = 'fixed'; field.style.top = '-1000px';
      // Selecting the field moves focus into it, and removing it would drop focus to the page: it goes back to the
      // button that copied.
      const back = document.activeElement;
      document.body.append(field); field.select();
      try { copied = document.execCommand('copy'); } catch {}
      field.remove(); back?.focus?.({preventScroll: true});
    }
    if (copied) { announce(message); confirmCopy(button); return true; }
    // Shows the value for copying by hand: a field is selected, any other element's text is.
    const existing = fieldId && $(fieldId);
    if (existing?.id === 'link-url' && urlParts && existing.dataset?.copy === text) { urlFull = true; fitUrl(); }
    if (existing && (existing.value === text || existing.textContent === text || existing.dataset?.copy === text)) {
      const hidden = existing.closest('[hidden]');
      if (hidden) hidden.hidden = false;
      if ('select' in existing && existing.value === text) { existing.focus(); existing.select(); } else getSelection().selectAllChildren(existing);
    }
    toast(t('common.clipboardFailed'));
    return false;
  }

  // One panel, five views: setup (the form), loading (a management link being fetched), progress (the link while the
  // file uploads), receipt and gone. paintView() shows the parts of the current one; showView() also moves focus and,
  // for the big changes, morphs.
  let phase = 'uploading'; // of the link object: uploading, stalled, failed, ready
  function paintView() {
    const view = currentView, setup = view === 'setup', linked = view === 'progress' || view === 'receipt';
    const chosen = !!(selectedFile || folder);
    main.dataset.view = view; main.toggleAttribute('data-file', chosen);
    $('setup-heading').hidden = !setup; $('setup-top').hidden = !setup; $('setup-view').hidden = !setup; $('dropzone').hidden = chosen;
    $('chosen-file').hidden = setup ? !chosen : !linked;
    $('tool-head').hidden = !linked && view !== 'loading'; $('lo').hidden = !linked;
    $('transfer').setAttribute('aria-labelledby', setup ? 'setup-heading' : view === 'gone' ? 'gone-heading' : 'tool-heading');
    if (view === 'loading') $('transfer').setAttribute('aria-busy', 'true'); else $('transfer').removeAttribute('aria-busy');
    // After the ready beat it stays (faded, .leaving) until the receipt replaces it.
    $('cancel-row').hidden = view !== 'progress' || (phase === 'ready' && !$('cancel-row').classList.contains('leaving'));
    $('receipt-view').hidden = view !== 'receipt'; $('gone-view').hidden = view !== 'gone';
    // The file card reads as the form's once the form is back (a cancel, a failure, Change options): its size and
    // kind, a folder's files and what it left out, and buttons that name a folder. paintFile() tells the formats apart
    // by the current view, so it repaints here, after showView() set it, not before.
    if (setup) paintFile();
    paintSideFile();
  }
  // "This file in a terminal" shows once the link exists: while the file uploads and on the receipt, not after a failure.
  function paintSideFile() {
    $('side-file').hidden = !(currentView === 'progress' || currentView === 'receipt') || !shown || phase === 'failed';
  }
  // Brings the panel into view when it is off screen; near the top of the page that means the top, header included.
  function reveal() {
    // Smooth or instant is the CSS scroll-behavior's call, which follows prefers-reduced-motion.
    const top = $('transfer').getBoundingClientRect().top;
    if (top >= 0 && top <= innerHeight * .65) return;
    if (top + (window.scrollY || 0) < innerHeight / 2) window.scrollTo?.({top: 0}); else $('transfer').scrollIntoView({block: 'start'});
  }
  function showView(name, {focus = null, animate = false} = {}) {
    currentView = name;
    if (name !== 'progress') endWait();
    const done = () => {
      if (currentView !== name || !focus) return;
      // After Upload became the link, Copy link has focus once the link is there (it may have arrived during the morph).
      const target = name === 'progress' && early ? $('copy-link') : $(focus);
      target?.focus({preventScroll:true});
      reveal();
    };
    // The panel eases to the new view's height while the file card and the link object morph (the page around it
    // switches at once, see the view transitions in styles.css).
    if (animate) morph(() => resize($('transfer'), paintView)).then(() => requestAnimationFrame(done));
    else { paintView(); requestAnimationFrame(done); }
  }

  // The expiry control: radios underneath; on top a pill that glides to the chosen cell on a pointer press and jumps
  // with the arrow keys, like every keyboard change. The pill holds a copy of the row in the selected colours that
  // moves the opposite way, so its labels stay where the row's are and recolour exactly as far as the pill has come.
  // Both move by transform with one timing (styles.css), so a change mid-way retargets; the pill takes the chosen
  // cell's size, so the 3 + 2 layout works too. A resize or restored options place it without moving.
  const seg = $('seg'), segRow = seg.querySelector('.seg-row'), segLabels = [...segRow.querySelectorAll('label')];
  const segPill = document.createElement('div'), segOn = document.createElement('div');
  segPill.className = 'seg-pill'; segPill.setAttribute('aria-hidden', 'true');
  segOn.className = 'seg-row seg-on';
  segOn.innerHTML = segLabels.map(label => '<span>' + escapeHTML(label.textContent.trim()) + '</span>').join('');
  segPill.append(segOn); seg.append(segPill);
  function paintSeg(instant) {
    const label = segLabels.find(element => element.querySelector('input').checked);
    if (!label || !segRow.offsetWidth) return;
    const row = segRow.getBoundingClientRect(), cell = label.getBoundingClientRect(), x = cell.left - row.left, y = cell.top - row.top;
    if (instant) { seg.classList.add('instant'); requestAnimationFrame(() => requestAnimationFrame(() => seg.classList.remove('instant'))); }
    Object.assign(segPill.style, {width: cell.width + 'px', height: cell.height + 'px', transform: 'translate(' + x + 'px,' + y + 'px)'});
    Object.assign(segOn.style, {width: row.width + 'px', transform: 'translate(' + -x + 'px,' + -y + 'px)'});
  }
  if (window.ResizeObserver) new ResizeObserver(() => paintSeg(true)).observe(segRow);

  // The live command follows the options token by token: a flag that appears is added, one that goes is removed, and a
  // changed value (--expires 3d to 7d) is rewritten in place, so nothing else is redrawn and nothing blinks. A flag
  // fades in only the first time it appears: coming back (passing through the default 1 day, or a custom value that
  // was briefly invalid) it is simply there again. Its output is what the CLI prints for them.
  const FLAG_ORDER = ['--expires', '--once', '--password', '--encrypt'], commandTokens = {}, flagsSeen = new Set();
  let commandShown = false;
  function paintCommand() {
    // An option eases the terminal to its new height. The first paint is the page's own layout, and a new file comes
    // with the morph of the file card (a view transition already crossfades the page; easing inside it dims the page).
    const fileChanged = commandTokens.file?.textContent !== 'fyl ' + fileArgument();
    if (commandShown && !fileChanged) { resize($('teaser-command').closest?.('.tw-sec'), drawCommand); return; }
    drawCommand(); commandShown = true;
  }
  function drawCommand() {
    const flags = uploadFlags(), line = $('teaser-command');
    if (!commandTokens.file) { commandTokens.file = document.createElement('span'); line.replaceChildren(commandTokens.file); }
    const file = 'fyl ' + fileArgument();
    if (commandTokens.file.textContent !== file) commandTokens.file.textContent = file;
    FLAG_ORDER.forEach((name, index) => {
      const flag = flags.find(value => value.split(' ')[0] === name);
      let token = commandTokens[name];
      if (!flag) { token?.wrap.remove(); delete commandTokens[name]; return; }
      if (!token) {
        // The space stays outside the flag, so the line may break between flags but never inside one.
        token = commandTokens[name] = {wrap: document.createElement('span'), flag: document.createElement('span')};
        token.flag.className = flagsSeen.has(name) ? 'flag' : 'flag new'; flagsSeen.add(name); token.wrap.append(' ', token.flag);
        const next = FLAG_ORDER.slice(index + 1).map(other => commandTokens[other]).find(Boolean);
        if (next) next.wrap.before?.(token.wrap); else line.append(token.wrap);
      }
      if (token.flag.textContent !== flag) token.flag.textContent = flag;
    });
    // What the CLI prints, which stays English like the CLI itself.
    $('teaser-output').textContent = [...($('password-toggle').checked ? ['Password (press Enter to generate one):', 'Password: ' + ($('password-input').value || '…')] : []), 'https://fyl.at/d/…'].join('\n');
    $('cli-upload-command').textContent = uploadCommand();
  }
  // The Upload button: while it can't be pressed its label, and accessible name, is the reason.
  let goState = {running: false, resume: false, replaces: false};
  function syncGo() {
    const valid = validLifetime(lifetime()), {running, resume, replaces} = goState, ready = !!selectedFile && valid && !running;
    // While a folder is listed, its reading; then, while it is read once for its checksums, how far.
    const reason = !selectedFile && folder ? folder.size === null ? t('home.readingFolder') : t('home.preparingFirst', {percent: L.percent(Math.floor(folder.read / Math.max(1, folder.total) * 100))})
      : t(!selectedFile ? FOLDERS ? 'home.chooseFirstAny' : 'home.chooseFirst' : !valid ? 'home.setExpiry' : 'home.continuingElsewhere');
    const action = t(running || resume ? 'home.resumeUpload' : replaces ? 'home.uploadDiscard' : 'home.uploadGetLink');
    $('create-button').disabled = !ready;
    // The reason changes only while it shows: on its way out (a file was just chosen) it keeps its words, instead of
    // reading "Continuing in another tab" while it fades.
    if (!ready) $('go-a').textContent = reason;
    $('go-b').textContent = action;
    $('create-button').setAttribute('aria-label', ready ? action : reason);
    swapTo($('go-swap'), ready);
    main.toggleAttribute('data-file', !!(selectedFile || folder));
  }
  function updateOptions() {
    const custom = document.querySelector('input[name="lifetime"]:checked').value === 'custom', minutes = lifetime(), valid = validLifetime(minutes);
    $('custom-expiry-wrap').classList.toggle('open', custom);
    $('custom-minutes').setAttribute('aria-invalid', String(custom && !valid));
    $('expiry-summary').innerHTML = valid ? tHtml('home.expirySummaryHtml', {duration: durationLabel(minutes)}) : '<span class="err-text">' + escapeHTML(lifetimeProblem(minutes)) + '</span>';
    // Each option that is on opens its section in the block under the toggles; with none on, one line shows instead.
    const once = $('once-toggle').checked, password = $('password-toggle').checked;
    $('once-wrap').classList.toggle('open', once);
    $('password-wrap').classList.toggle('open', password);
    $('e2ee-wrap').classList.toggle('open', e2ee());
    $('option-details').classList.toggle('any', once || password || e2ee());
    $('password-input').setAttribute('aria-invalid', 'false');
    paintCommand(); error(''); syncGo(); paintFile();
    showPending();
  }
  function setOptions({minutes, once, password, protected: secret, e2ee: encrypt}) {
    const preset = [...document.querySelectorAll('input[name="lifetime"]')].find(input => input.value === String(minutes));
    (preset || document.querySelector('input[name="lifetime"][value="custom"]')).checked = true;
    if (!preset) [$('custom-minutes').value, $('custom-unit').value] = splitMinutes(minutes);
    $('once-toggle').checked = once; $('password-toggle').checked = !!(password || secret); $('e2ee-toggle').checked = !!encrypt;
    if (password) $('password-input').value = password;
    updateOptions(); paintSeg(true);
  }

  // The file row: size and type while choosing; once uploading, its size and the options it was sent with. The labels
  // are the server's (kind() in src/shared.ts), in English; the page shows them in its language (L.type).
  const TYPES = {zip:'ZIP archive', '7z':'7-Zip archive', rar:'RAR archive', tar:'TAR archive', gz:'gzip archive', tgz:'gzip archive', pdf:'PDF document',
    doc:'Word document', docx:'Word document', xls:'Excel spreadsheet', xlsx:'Excel spreadsheet', ppt:'PowerPoint presentation', pptx:'PowerPoint presentation',
    csv:'spreadsheet', txt:'text file', md:'text file', jpg:'JPEG image', jpeg:'JPEG image', png:'PNG image', gif:'GIF image', webp:'WebP image', heic:'HEIC image',
    svg:'SVG image', mp4:'MP4 video', mov:'QuickTime video', mkv:'Matroska video', webm:'WebM video', mp3:'MP3 audio', wav:'WAV audio', flac:'FLAC audio',
    m4a:'AAC audio', exe:'Windows program', msi:'Windows installer', dmg:'disk image', iso:'disk image', apk:'Android app', deb:'Linux package', sh:'shell script', json:'JSON file'};
  const extensionOf = name => /\.([a-z0-9]{1,10})$/i.exec(name)?.[1].toLowerCase() || '';
  function paintFile(record = null) {
    const chosen = !record && folder, file = record || (chosen ? {name: chosen.name, size: chosen.size} : selectedFile && {name: selectedFile.name, size: selectedFile.size});
    const note = !!(chosen?.skipped && currentView === 'setup');
    $('selected-note').hidden = !note;
    if (chosen?.skipped) $('selected-note').textContent = t('home.folderSkipped', {count: chosen.skipped});
    // The row's buttons name what it holds, and the button that picks again also reads what was left out.
    $('repick').setAttribute('aria-label', t(chosen ? 'home.repickFolder' : 'home.repick'));
    $('repick').setAttribute('aria-describedby', 'selected-name selected-size' + (note ? ' selected-note' : ''));
    $('remove-file').setAttribute('aria-label', t(chosen ? 'home.removeFolder' : 'home.removeFile'));
    if (!file) return;
    const extension = extensionOf(file.name || '');
    $('selected-name').innerHTML = breakable(file.name || unnamed(file)); $('selected-name').title = file.name || '';
    $('file-extension').textContent = extension ? extension.slice(0, 4).toUpperCase() : 'FILE';
    const tag = (name, key) => '<span class="tag">' + icon(name) + escapeHTML(t(key)) + '</span>';
    const options = record ? record : {protected: $('password-toggle').checked, once: $('once-toggle').checked, mode: e2ee() ? 'e2ee' : 'raw'};
    // A folder: "Reading the folder…" until it is listed, then its files (how far its reading got is on the button).
    const kind = escapeHTML(chosen ? t('home.folderFiles', {count: chosen.count}) : extension ? L.type(TYPES[extension] || extension.toUpperCase() + ' file') : t('home.typeNone'));
    $('selected-size').innerHTML = chosen && chosen.size === null ? escapeHTML(t('home.readingFolder')) : currentView === 'setup' && !record
      ? escapeHTML(sizeLabel(file.size)) + ' · ' + kind
      : [escapeHTML(sizeLabel(file.size)), encrypted(options) ? tag('shield', 'home.encrypted') : '', options.protected || options.password ? tag('lock', 'home.password') : '', options.once ? tag('one', 'home.once') : ''].filter(Boolean).join(' · ');
  }
  function setFile(file, animate = false) {
    if (!file) return;
    if (!file.size) { error(t('home.empty')); return; }
    if (file.size > LIMIT) { error(t('home.tooLarge', {limit: L.number(Math.round(LIMIT / GB))})); return; }
    dropFolder(); selectedFile = file; error('');
    updateOptions(); announce(t('home.selected', {name: file.name}));
    if (animate && currentView === 'setup') morph(paintView).then(() => { if (document.activeElement === document.body || document.activeElement === $('pick-file')) $('repick').focus({preventScroll:true}); });
    else paintView();
  }
  // Where focus goes when the control it was on disappears with a list: the picker (or the chosen file's row) on the
  // form, otherwise the heading of what the panel shows.
  const formFocus = () => currentView === 'setup' ? $(selectedFile ? 'repick' : 'pick-file') : $(currentView === 'gone' ? 'gone-heading' : 'tool-heading');
  // With `focus`, the picker takes focus as soon as it is shown again (inside the morph's update), so focus never
  // falls to the page while the remove button disappears.
  function clearFile(animate = false, focus = false) {
    dropFolder(); selectedFile = null; $('file-input').value = ''; $('folder-input').value = ''; error(''); updateOptions();
    const update = () => { paintView(); if (focus) $('pick-file').focus({preventScroll: true}); };
    if (animate && currentView === 'setup') morph(update); else update();
  }
  // Choosing a folder (docs/FOLDER-ZIP.md §2): the walk lists its files and the refusals of §2.6 are checked, then the
  // pre-pass reads every file once for its CRC (FylAPI.crcPass, off the page's thread) while the card shows it.
  // Another choice meanwhile, or removing it, stops it; a refusal or a file that can't be read goes back to the zone.
  const REFUSED = {empty: 'home.folderEmpty', too_many: 'home.folderTooMany', collision: 'home.folderCollision', too_large: 'home.folderTooLarge', too_large_encrypt: 'home.folderTooLargeEncrypt'};
  function dropFolder() { folder?.controller.abort(); folder = null; }
  async function chooseFolder(name, list) {
    if (currentView !== 'setup' || busy) return;
    dropFolder(); selectedFile = null; error('');
    const root = ZIP.clean(name) || 'folder', mine = {root, name: root + '.zip', controller: new AbortController(), size: null, count: 0, skipped: 0, read: 0, total: 0};
    folder = mine;
    const listing = (async () => {
      const items = await list(mine.controller.signal);
      if (!items) return null;
      const {entries, skipped} = ZIP.gather(name, items), out = ZIP.check(entries, LIMIT);
      Object.assign(mine, {size: out.size, count: entries.length, skipped: skipped.length, total: entries.reduce((sum, entry) => sum + entry.size, 0), print: await ZIP.fingerprint(entries)});
      return {entries, out};
    })();
    const refuse = refusal => {
      if (folder !== mine) return;
      folder = null; updateOptions();
      error(REFUSED[refusal?.code] ? t(REFUSED[refusal.code], {count: L.number(ZIP.MAX_ENTRIES), path: refusal.detail, limit: L.number(Math.round(LIMIT / GB))})
        : refusal?.code === 'file_changed' ? t('home.folderReadFailed', {path: refusal.path}) : t('home.folderUnreadable'));
      morph(paintView).then(() => { if (document.activeElement === document.body || document.activeElement === $('repick')) $('pick-file').focus({preventScroll: true}); });
    };
    // The card comes once the folder is listed, so it has its final lines (what was left out); one that takes longer
    // than a moment to list shows "Reading the folder…" until then, and the panel eases when that line joins.
    let failed = null;
    const listed = await Promise.race([listing.then(() => true, refusal => { failed = refusal || {}; return true; }), new Promise(resolve => { setTimeout(resolve, 150, false); })]);
    if (folder !== mine) return;
    if (failed) { refuse(failed); return; }
    updateOptions(); announce(t(listed ? 'home.preparingFolder' : 'home.readingFolder'));
    morph(paintView).then(() => { if ([document.body, $('pick-file')].includes(document.activeElement)) $('repick').focus({preventScroll: true}); });
    let found;
    try { found = await listing; } catch (refusal) { refuse(refusal); return; }
    if (folder !== mine || !found) return;
    if (!listed) { resize($('transfer'), () => paintFile()); syncGo(); announce(t('home.preparingFolder')); }
    // With encryption on, a zip that fits the limit only unencrypted is refused now, before every file is read once
    // (encryption adds 16 bytes per 64 KiB, docs/E2EE.md §6). Encryption can still be turned on after the pre-pass, so
    // createTransfer() checks again.
    if (e2ee()) {
      const core = await loadCore().catch(() => null);
      if (folder !== mine) return;
      if (core && found.out.size > core.maxPlaintextSize(LIMIT)) { refuse({code: 'too_large_encrypt'}); return; }
    }
    let crcs, shown = -1;
    try {
      crcs = await window.FylAPI.crcPass(found.entries.map(entry => entry.file), mine.controller.signal, read => {
        mine.read = read;
        const now = Math.floor(read / Math.max(1, mine.total) * 100);
        if (folder === mine && now !== shown) { shown = now; syncGo(); }
      });
    } catch (failure) {
      if (failure?.name !== 'AbortError') refuse({code: 'file_changed', path: found.entries[failure?.index]?.path || mine.name});
      return;
    }
    if (folder !== mine) return;
    Object.assign(mine, {zip: ZIP.file(root, found.out, crcs), ranges: ZIP.dataRanges(found.out), crcs});
    selectedFile = mine.zip; updateOptions();
    announce([t('home.selected', {name: mine.name}), t('home.folderFiles', {count: mine.count}) + '.', ...(mine.skipped ? [t('home.folderSkipped', {count: mine.skipped})] : [])].join(' '));
  }
  // A dropped folder (FileSystemDirectoryEntry) or a picked one (FileSystemDirectoryHandle), walked into the items of
  // FylZip.gather(); readers are read until they return nothing (Chromium gives 100 entries at a time). A folder whose
  // name is skipped is listed once and not entered, nor one whose path is too long for any file in it (which also ends
  // a loop through a linked folder). Past 100,000 files the walk stops, and no file is opened: the folder is refused.
  const ENTRIES = {
    list: entry => new Promise((resolve, reject) => {
      const reader = entry.createReader(), found = [];
      const next = () => reader.readEntries(batch => { if (!batch.length) resolve(found); else { found.push(...batch); next(); } }, reject);
      next();
    }).then(found => found.map(child => ({name: child.name, dir: child.isDirectory, file: child.isFile, handle: child}))),
    file: entry => new Promise((resolve, reject) => entry.file(resolve, reject)),
  };
  const HANDLES = {
    list: async handle => {
      const found = [];
      for await (const child of handle.values()) found.push({name: child.name, dir: child.kind === 'directory', file: child.kind === 'file', handle: child});
      return found;
    },
    file: handle => handle.getFile(),
  };
  async function walk(top, source, signal) {
    const items = [], files = [], encoder = new TextEncoder(), todo = [[top, [], ZIP.clean(top.name) || 'folder']];
    while (todo.length && files.length <= ZIP.MAX_ENTRIES) {
      const [dir, parts, path] = todo.pop();
      for (const child of await source.list(dir)) {
        const name = ZIP.clean(child.name), below = [...parts, child.name], at = path + '/' + name;
        if (child.dir && name !== null && encoder.encode(at).length + 2 <= ZIP.MAX_PATH) todo.push([child.handle, below, at]);
        else if (child.dir) items.push({parts: below, kind: 'dir'});
        else if (child.file) { const item = {parts: below, kind: 'file', handle: child.handle}; items.push(item); if (name !== null) files.push(item); }
      }
      if (signal.aborted) return null;
    }
    if (files.length > ZIP.MAX_ENTRIES) return files;
    for (let at = 0; at < files.length; at += 32) {
      await Promise.all(files.slice(at, at + 32).map(async item => { item.file = await source.file(item.handle); item.size = item.file.size; item.mtimeMs = item.file.lastModified; }));
      if (signal.aborted) return null;
    }
    return items;
  }
  // The folder picker: showDirectoryPicker where there is one (no "upload N files" prompt, files are opened as they are
  // read), else the folder input, whose files carry their path in webkitRelativePath (root/sub/a.txt).
  async function pickFolder() {
    if (window.showDirectoryPicker) {
      let handle = null;
      try { handle = await window.showDirectoryPicker({id: 'fyl-folder'}); }
      catch (failure) { if (failure?.name === 'AbortError') return; }
      if (handle) { chooseFolder(handle.name, signal => walk(handle, HANDLES, signal)); return; }
    }
    $('folder-input').value = ''; $('folder-input').click();
  }
  // The file's own name ends its path: Chromium writes a "\" in a name as "/" in webkitRelativePath, which would make
  // back\slash.txt a file in a folder "back" instead of a name that is skipped (§2.3).
  const relative = file => {
    const path = file.webkitRelativePath, cut = path.length - file.name.length - 1;
    return cut > 0 && path[cut] === '/' ? [...path.slice(0, cut).split('/'), file.name] : path.split('/');
  };
  // A browser that ignores webkitdirectory gives files without a folder: it can't send folders, which it says.
  function chooseFolderInput(files) {
    const inside = files.filter(file => file.webkitRelativePath.includes('/'));
    if (files.length && !inside.length) { error(t('home.folderUnsupported')); return; }
    chooseFolder(inside[0] ? relative(inside[0])[0] : '', async () => inside.map(file => ({parts: relative(file).slice(1), kind: 'file', size: file.size, mtimeMs: file.lastModified, file})));
  }
  function cancelProgress() {
    const failed = phase === 'failed', idle = waiting, stored = idle && pendingUpload();
    uploadController?.abort(); uploadController = null; busy = false; forgetPending(ownUpload); ownUpload = null; showPending();
    // An upload waiting for the network runs nowhere: cancelling it discards it, as cancelling a running one does.
    if (idle && stored?.uploadId === idle.uploadId) discardIdle(stored).then(showPending);
    showView('setup', {focus: 'create-button', animate: true});
    if (!failed) announce(t('home.cancelledAnnounce'));
  }
  function resetDraft(focus = true) {
    activeId = null; reviewed = null; clearFile();
    history.replaceState(null,'',pageURL());
    showView('setup', {focus: focus ? 'pick-file' : null, animate: focus});
  }
  // Transfer rate over the last few seconds, for the speed and time-left hint and the link's ready estimate.
  let samples = [];
  const rateLabel = bytesPerSecond => bytesPerSecond >= 1048576 ? t('common.rate.mb', {n: L.number(bytesPerSecond / 1048576, 1)}) : t('common.rate.kb', {n: L.number(Math.max(1, Math.round(bytesPerSecond / 1024)))});
  const readyIn = seconds => seconds < 60 ? t('common.time.seconds', {n: L.number(Math.max(5, Math.round(seconds / 5) * 5))}) : seconds < 3600 ? t('common.time.minutes', {n: L.number(Math.round(seconds / 60))})
    : t('common.time.hours', {n: L.number(seconds / 3600, (seconds / 3600).toFixed(1).endsWith('.0') ? 0 : 1)});
  const tookLabel = seconds => seconds < 60 ? t('common.time.seconds', {n: L.number(seconds)}) : seconds < 3600 ? t('common.time.minutesSeconds', {m: L.number(Math.floor(seconds / 60)), s: L.number(seconds % 60)})
    : t('common.time.hoursMinutes', {h: L.number(Math.floor(seconds / 3600)), m: L.number(Math.floor(seconds % 3600 / 60))});
  function estimate(sent, size) {
    const now = performance.now();
    samples.push([now, sent]);
    samples = samples.filter(([time]) => now - time <= 5000);
    const [firstTime, firstSent] = samples[0];
    if (now - firstTime < 1000 || sent <= firstSent) return null;
    const rate = (sent - firstSent) / ((now - firstTime) / 1000);
    return {rate, seconds: (size - sent) / rate};
  }
  // Lines take their value from --v, set through the CSSOM (CSP allows no style attributes).
  const setLine = (element, value) => element?.style?.setProperty?.('--v', String(Math.max(0, Math.min(1, value)).toFixed(4)));
  const lifeLeft = record => (record.expiresAt - Date.now()) / Math.max(1, record.expiresAt - (record.createdAt || record.expiresAt - (record.minutes || 1440) * 60000));
  function setProgress(value) {
    setLine($('life-bar'), value / 100);
    $('mt-main').textContent = L.percent(value);
    $('progressbar').setAttribute('aria-valuenow', String(value));
  }
  // The link object while uploading: the meter names progress, and its right side what follows, the lifetime from the
  // end of the upload (the server starts it then). A dropped connection greys it; the upload retries by itself. `step`
  // is what api.js is doing (checking, uploading, retrying, creating); `stage` says it in the page's language.
  let lastSent = 0;
  function paintUpload(file, minutes, stage, step, speed) {
    const stalled = phase === 'stalled';
    $('mt-sub').textContent = step === 'checking' ? stage : step === 'creating' ? t('home.finishing')
      : lastSent || stalled ? partLabel(lastSent, file.size) + (speed && !stalled ? ' · ' + rateLabel(speed.rate) : '') : t('home.starting');
    $('chip-a').textContent = stalled ? t('home.paused') : speed ? t('home.readyIn', {time: readyIn(speed.seconds)}) : t('home.uploading');
    $('mt-then').textContent = stalled ? t('home.waitingNetwork') : t('home.thenOpen', {duration: durationLabel(minutes)});
  }
  function stall(on) {
    phase = on ? 'stalled' : 'uploading';
    $('lo').classList.toggle('stalled', on);
    $('head-a').textContent = t(on ? 'home.headPaused' : 'home.headLive');
    $('lo-hint').innerHTML = tHtml(on ? 'home.stalledHintHtml' : 'home.loHintHtml');
    if (on) announce(t('home.pausedAnnounce'));
  }
  // An error that retrying can't fix, after the link was shown: the link can't work, so the copy actions go and the
  // next step leads. The file and options stay for "Upload again" or "Change options".
  const FAILED = t('home.failedText');
  function fail() {
    phase = 'failed';
    $('lo').classList.remove('stalled'); $('lo').classList.add('failed');
    $('lo-actions').hidden = true; $('lo-actions').classList.remove('awaiting'); $('lo-actions').inert = false; $('keysplit').hidden = true; $('keywarn').hidden = true; $('keyremember').hidden = true; $('qr-panel').classList.remove('open');
    $('link-url').removeAttribute('href'); $('copy-inline').hidden = true; // struck through, no longer a link
    $('head-a').textContent = t('home.headFailed'); $('chip-a').textContent = t('home.failed');
    $('mt-then').textContent = t('home.linkWontWork'); $('mt-sub').textContent = lastSent && selectedFile ? t('home.stoppedAt', {part: partLabel(lastSent, selectedFile.size)}) : '';
    // The server's reason is about one part ("This part has reached its retry limit…"); what matters here is that the
    // link won't open and nothing chosen is lost.
    $('lo-hint').textContent = FAILED;
    $('upload-again').hidden = false; $('cancel-button').textContent = t('home.changeOptions'); $('cancel-button').classList.toggle('btn-cancel', false); paintSideFile();
    announce(t('home.failedAnnounce', {reason: FAILED}));
    $('upload-again').focus({preventScroll:true});
  }
  // Retries used up while the browser is offline: the link object stays, paused, until the network is back ('online')
  // or Retry now; then the upload resumes from its saved parts like a resume after a reload.
  let waiting = null; // the interrupted upload this tab waits to resume
  function waitForNetwork(entry) {
    waiting = {uploadId: entry.uploadId};
    if (phase !== 'stalled') stall(true);
    $('retry-now').hidden = false; $('mt-then').textContent = t('home.waitingNetwork');
    if (selectedFile) $('mt-sub').textContent = partLabel(lastSent, selectedFile.size);
  }
  function endWait() { waiting = null; $('retry-now').hidden = true; }
  function resumeWaiting() {
    if (!waiting || busy || currentView !== 'progress') return;
    const same = pendingUpload()?.uploadId === waiting.uploadId;
    endWait();
    // Another tab may have resumed, discarded or replaced it meanwhile; then the form says so instead of a new upload.
    if (same) createTransfer();
    else { showView('setup', {focus: 'create-button', animate: true}); showPending(); error(t('home.changedElsewhere'), 'expiry'); }
  }
  // The init response carries the final link, so it can be shared while the file uploads: opened early, it shows a
  // page that waits for the upload. Protected links leave out the name, so sharing them does too.
  const menuValues = {};
  // The link in its field: one line, the host without its scheme, the id and the name each cut in the middle to what
  // fits (the font is monospaced, so a width is a count of characters); the name keeps its end, so the extension
  // shows. The key never shows in full: screens get shared. When copying fails, the field shows the whole link to be
  // selected by hand. The clipboard, the QR code and the link's target are always the whole link.
  let urlParts = null, urlFull = false;
  const cut = (text, room, end = .5) => {
    const chars = [...text];
    if (chars.length <= room) return text;
    if (room < 2) return '…';
    const tail = Math.round((room - 1) * end);
    return chars.slice(0, room - 1 - tail).join('') + '…' + chars.slice(chars.length - tail).join('');
  };
  // The key rows' values are cut in the middle to the characters that fit, like the link field (their copy buttons copy
  // them whole). No title tooltip: hovering must not put a whole key on the screen.
  function fitValue(element) {
    const text = element.dataset?.full || '';
    if (!element.clientWidth) { element.textContent = text; return; }
    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(50); element.replaceChildren(probe);
    const width = probe.offsetWidth / 50;
    element.textContent = width ? cut(text, Math.floor(element.clientWidth / width), .45) : text;
  }
  function fitUrl() {
    const element = $('link-url');
    if (!urlParts) return;
    const {host, id, sep, name, key} = urlParts, size = text => [...text].length;
    const shownHost = urlFull ? host : host.replace(/^https?:\/\//, ''), shownKey = urlFull ? key : cut(key, 9);
    let idRoom = Infinity, nameRoom = Infinity;
    if (!urlFull && element.clientWidth) {
      const probe = document.createElement('span');
      // offsetWidth, not getBoundingClientRect(): the panel may be mid-morph, scaled by a transform.
      probe.textContent = '0'.repeat(50); element.append(probe);
      const width = probe.offsetWidth / 50; probe.remove();
      const room = Math.floor(element.clientWidth / width) - size(shownHost) - size(sep) - size(shownKey);
      if (width && size(id) + size(name) > room) {
        nameRoom = Math.min(size(name), Math.max(14, Math.floor(room / 2))); idRoom = room - nameRoom;
        if (idRoom < 9) { idRoom = Math.min(size(id), 9); nameRoom = Math.max(name ? 6 : 0, room - idRoom); }
      }
    }
    element.classList.toggle('full', urlFull);
    element.innerHTML = (shownHost ? '<span class="host">' + escapeHTML(shownHost) + '</span>' : '') + '<span class="id">' + escapeHTML(cut(id, idRoom)) + '</span>'
      + (sep ? '<span class="sep">' + sep + '</span>' : '') + (name ? '<bdi class="name" dir="auto">' + escapeHTML(cut(name, nameRoom, .62)) + '</bdi>' : '')
      + (shownKey ? '<span class="key">' + escapeHTML(shownKey) + '</span>' : '');
  }
  function showLink(share) {
    const arriving = !!share?.url && !early && currentView === 'progress';
    early = share?.url ? share : null;
    // The link arriving while "Creating your link…" shows: the panel eases to its new height, the link and its actions
    // fade in.
    resize($('transfer'), () => {
      if (early) paintLink(early.url, {secret: !share.title, uploading: true});
      $('lo-actions').hidden = !early; $('lo-actions').classList.remove('awaiting'); $('lo-actions').inert = false; paintSideFile();
    });
    if (arriving) for (const element of [$('url-row'), $('lo-actions')]) { element.classList.remove('arrive'); void element.offsetWidth; element.classList.add('arrive'); }
    if (early && [document.body, $('tool-heading'), $('create-button')].includes(document.activeElement)) $('copy-link').focus({preventScroll:true});
  }
  // Paints a link everywhere it shows: the link object (dimmed host, the key on its wash), the copy menu, the key rows
  // of an encrypted link and the terminal companion. The private link is never shown in full: screens get shared.
  function paintLink(url, {secret = false, uploading = false, keyless = false} = {}) {
    if (shown !== url) { $('qr-image').replaceChildren(); $('qr-panel').classList.remove('open'); $('qr-button').setAttribute('aria-expanded', 'false'); keyCopied = false; }
    shown = url;
    const [, host, id, rest = '', key = ''] = /^(https?:\/\/[^/]+\/d\/)([^/#]+)([^#]*)(#.*)?$/.exec(url) || [null, '', url];
    // The name in the path is shown as people wrote it, not percent-encoded, and isolated so a right-to-left name keeps
    // the link's order. The clipboard, the QR code and the commands keep the encoded link.
    let name = rest.replace(/^\//, '');
    try { name = decodeURIComponent(name); } catch {}
    $('link-url').classList.remove('waiting'); $('link-url').dataset.copy = url; $('link-url').setAttribute('href', url);
    $('copy-inline').hidden = false; // first, so the field is measured without it
    urlParts = {host, id, sep: name ? '/' : '', name: name || rest, key}; urlFull = false; fitUrl();
    // An encrypted link gets fyl download in two forms: with the key (it lands in shell history), and without it, which
    // asks for the key (docs/E2EE.md §2.5). The password never rides in a link or command.
    const plain = url.split('#')[0], nokeyCli = 'fyl download ' + shellQuote(plain);
    const curl = key ? 'fyl download ' + shellQuote(url) : keyless ? nokeyCli : 'curl -fOJ ' + (uploading ? '--retry 120 ' : '') + (secret ? '-u fyl ' : '') + shellQuote(plain);
    // The terminal companion shows an encrypted file's command without the key (fyl download asks for it), the way the
    // key rows say to send them; the command with the key stays in the copy menu.
    $('file-curl').innerHTML = commandHTML(key ? nokeyCli : curl);
    $('side-file-lead').textContent = t(key || keyless ? 'home.sideFileLeadE2ee' : 'home.sideFileLead');
    $('lo').classList.toggle('e2ee', !!key); $('keysplit').hidden = !key; $('keyremember').hidden = !key;
    $('keywarn').hidden = !key && !keyless;
    $('keywarn-text').textContent = t(key ? 'home.keyWarn' : 'home.keylessWarn');
    if (key) for (const [id, text] of [['key-nokey', plain], ['key-key', key.slice(1)]]) { $(id).dataset.full = text.replace(/^https?:\/\//, ''); fitValue($(id)); }
    $('remember-keys').checked = rememberingKeys();
    Object.assign(menuValues, {link: url, curl, nokey: plain, key: key.slice(1), nokeycli: nokeyCli});
    const item = (name, glyph, label, sub, mono) => '<button class="menu-item" type="button" role="menuitem" data-menu-copy="' + name + '">' + icon(glyph) + '<span>' + escapeHTML(t(label)) + '<small' + (mono ? ' class="v"' : '') + '>' + escapeHTML(mono ? sub : t(sub)) + '</small></span><span></span></button>';
    const preview = text => text.length <= 32 ? text : text.slice(0, 17) + '…' + text.slice(-14);
    // Readable values get a preview; random ones (the key, an encrypted link) their consequence.
    $('copy-menu').innerHTML = key
      ? item('link', 'link', 'home.menuLinkKey', 'home.menuLinkKeySub') + item('nokey', 'link', 'home.linkNoKey', 'home.menuNoKeySub')
        + item('key', 'key', 'home.menuKey', 'home.menuKeySub') + item('curl', 'terminal', 'home.menuCommand', 'home.menuCommandSub')
        + item('nokeycli', 'terminal', 'home.menuCommandNoKey', 'home.menuCommandNoKeySub')
      : keyless ? item('nokey', 'link', 'home.linkNoKey', 'home.menuNoKeyKeylessSub') + item('nokeycli', 'terminal', 'home.menuCommand', 'home.menuCommandNoKeySub')
      : item('link', 'link', 'home.menuLink', preview((host + id).replace(/^https?:\/\//, '') + (name ? '/' + name : rest)), true) + item('curl', 'terminal', 'home.menuDownloadCommand', preview(curl), true);
    $('share-link').hidden = !navigator.share;
  }
  // The password shows as soon as the upload starts: the link already works then, and recipients need both.
  function showSecret(password = '') { $('lo-secret').hidden = !password; $('lo-password').textContent = password; }
  function resetProgress(file, minutes) {
    showSecret();
    phase = 'uploading'; lastSent = 0; shown = null; early = null; samples = [];
    $('lo').classList.remove('ready', 'lifetime', 'stalled', 'failed', 'e2ee');
    $('head-a').textContent = t('home.headLive'); swapTo($('tool-heading').querySelector('.swap'), false);
    $('chip-a').textContent = t('home.uploading'); swapTo($('chip').querySelector('.swap'), false);
    urlParts = null; $('link-url').classList.remove('full'); $('link-url').classList.add('waiting'); $('link-url').textContent = t('home.creatingLink'); delete $('link-url').dataset.copy; $('link-url').removeAttribute('href'); $('copy-inline').hidden = true;
    // While "Creating your link…" shows, the actions keep their place unseen (.awaiting), so the link arriving changes
    // nothing's height: it and its actions just fade in.
    $('lo-actions').hidden = false; $('lo-actions').classList.add('awaiting'); $('lo-actions').inert = true;
    $('keysplit').hidden = true; $('key-split').setAttribute('aria-expanded', 'false'); $('keyrows-wrap').classList.remove('open'); $('keywarn').hidden = true; $('keyremember').hidden = true; $('upload-again').hidden = true; endWait();
    $('qr-image').replaceChildren(); $('qr-panel').classList.remove('open'); $('qr-button').setAttribute('aria-expanded', 'false');
    stall(false); $('lo-hint').hidden = false;
    $('mt-sub').textContent = t('home.starting'); $('mt-then').textContent = t('home.thenOpen', {duration: durationLabel(minutes)}); $('mt-then').hidden = false; $('mt-change').hidden = true;
    $('lo-meter').setAttribute('aria-label', t('home.progress')); $('progressbar').hidden = false;
    $('cancel-button').textContent = t('home.cancelUpload'); $('cancel-button').classList.toggle('btn-cancel', true); $('cancel-button').disabled = false; $('cancel-row').classList.remove('leaving');
    $('file-rm-row').hidden = true;
    const bar = $('life-bar');
    if (bar?.style) { bar.style.transition = 'none'; setProgress(0); void bar.offsetWidth; bar.style.transition = ''; } else setProgress(0);
    paintFile({name: file.name, size: file.size, protected: $('password-toggle').checked, once: $('once-toggle').checked});
  }
  // The ready beat: the line completes and turns green, the chip draws its tick and the heading swaps. Nothing moves:
  // Cancel upload fades but keeps its place, so the panel doesn't shrink here only to grow again when the receipt
  // eases in below a moment later.
  function finishProgress(size, started) {
    phase = 'ready';
    $('lo').classList.remove('stalled'); $('lo').classList.add('ready');
    swapTo($('chip').querySelector('.swap'), true); swapTo($('tool-heading').querySelector('.swap'), true);
    setProgress(100); $('mt-sub').textContent = t('home.uploadedIn', {size: sizeLabel(size), time: tookLabel(Math.round((Date.now() - started) / 1000))});
    $('mt-then').textContent = ''; $('cancel-button').disabled = true; $('cancel-row').classList.add('leaving');
  }
  // Download passwords stay in this tab (sessionStorage) unless the sender ticks "Remember the password on this device",
  // which keeps them in localStorage too. Neither the recent uploads nor the interrupted upload's record hold them.
  const PASSWORDS = 'fyl-passwords';
  const passwordsIn = name => {
    try { const map = JSON.parse(window[name].getItem(PASSWORDS) || '{}'); return map && typeof map === 'object' && !Array.isArray(map) ? map : {}; }
    catch { return {}; }
  };
  const savePasswords = (name, map) => { try { if (Object.keys(map).length) window[name].setItem(PASSWORDS, JSON.stringify(map)); else window[name].removeItem(PASSWORDS); } catch {} };
  const passwordOf = id => [passwordsIn('sessionStorage')[id], passwordsIn('localStorage')[id]].find(value => typeof value === 'string' && value) || '';
  const remembered = id => typeof passwordsIn('localStorage')[id] === 'string';
  function keepPassword(id, password, remember = null) {
    const session = passwordsIn('sessionStorage'); session[id] = password; savePasswords('sessionStorage', session);
    if (remember === null) return;
    const local = passwordsIn('localStorage');
    if (remember) local[id] = password; else delete local[id];
    savePasswords('localStorage', local);
  }
  // Keeps only the passwords whose id passes `keep`, in both storages.
  function dropPasswords(keep) {
    for (const name of ['sessionStorage', 'localStorage']) {
      const map = passwordsIn(name);
      for (const id of Object.keys(map)) if (!keep(id)) delete map[id];
      savePasswords(name, map);
    }
    dropKeys(keep);
  }
  // Encrypted uploads' keys (KEY, the part of the link after #) follow the same rule (docs/E2EE.md §2.5): this tab's
  // session storage, and local storage only while "Remember keys on this device" is ticked, which applies to every key
  // and is undone by unticking it or by Forget this device. The recent uploads and the pending upload's record never
  // hold a key, and the server never sees one.
  const KEYS = 'fyl-keys', REMEMBER_KEYS = 'fyl-remember-keys', KEY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
  const keysIn = name => {
    try { const map = JSON.parse(window[name].getItem(KEYS) || '{}'); return map && typeof map === 'object' && !Array.isArray(map) ? map : {}; }
    catch { return {}; }
  };
  const saveKeys = (name, map) => { try { if (Object.keys(map).length) window[name].setItem(KEYS, JSON.stringify(map)); else window[name].removeItem(KEYS); } catch {} };
  const rememberingKeys = () => { try { return localStorage.getItem(REMEMBER_KEYS) === '1'; } catch { return false; } };
  const keyOf = id => [keysIn('sessionStorage')[id], keysIn('localStorage')[id]].find(value => typeof value === 'string' && KEY.test(value)) || '';
  function keepKey(id, key) {
    for (const name of rememberingKeys() ? ['sessionStorage', 'localStorage'] : ['sessionStorage']) { const map = keysIn(name); map[id] = key; saveKeys(name, map); }
  }
  function rememberKeys(on) {
    try { if (on) localStorage.setItem(REMEMBER_KEYS, '1'); else localStorage.removeItem(REMEMBER_KEYS); } catch {}
    const session = keysIn('sessionStorage');
    if (on) saveKeys('localStorage', {...keysIn('localStorage'), ...session});
    else { saveKeys('sessionStorage', {...keysIn('localStorage'), ...session}); saveKeys('localStorage', {}); }
  }
  function dropKeys(keep) {
    for (const name of ['sessionStorage', 'localStorage']) {
      const map = keysIn(name);
      for (const id of Object.keys(map)) if (!keep(id)) delete map[id];
      saveKeys(name, map);
    }
  }
  // The keyed link of an encrypted record, built from this page's origin like the upload built it (§2.2); the plain
  // link where this tab doesn't have the key.
  const shareURL = record => encrypted(record) && keyOf(record.id) && record.url === location.origin + '/d/' + record.id ? record.url + '#' + keyOf(record.id) : record.url;
  // An interrupted upload is remembered in this browser until the server's 24-hour upload window closes, so choosing
  // the same file again continues it, also after the tab was closed. Tabs share the record, and the newest upload
  // replaces it. The tab that runs an upload holds the Web Lock fyl-upload:<uploadId> until it stops (the browser frees
  // it when the tab closes), so no other tab resumes or discards it. Creating a session and saving its record happen
  // under fyl-new-upload, so two tabs never replace each other's record halfway.
  const PENDING = 'fyl-upload', UPLOAD_WINDOW = 86400000, MB = 1048576, prints = new WeakMap();
  const RESUME_HINT = t('home.resumeHint');
  const ELSEWHERE = t('home.elsewhere');
  const PASSWORD_HINT = $('password-hint').textContent;
  const lockName = pending => 'fyl-upload:' + pending.uploadId;
  const setPending = value => { try { if (value) localStorage.setItem(PENDING, JSON.stringify(value)); else localStorage.removeItem(PENDING); } catch {} };
  const pendingUpload = () => {
    let pending = null;
    try { pending = JSON.parse(localStorage.getItem(PENDING) || 'null'); } catch {}
    if (!pending?.uploadId) return null;
    if (!(Date.now() < pending.created + UPLOAD_WINDOW)) { setPending(null); return null; }
    return pending;
  };
  const forgetPending = uploadId => { if (uploadId && pendingUpload()?.uploadId === uploadId) setPending(null); };
  // Takes a Web Lock and keeps it until the returned release() is called. Resolves to null when `ifAvailable` finds it
  // taken or `signal` aborts the wait; without Web Locks, to a release that does nothing.
  const hold = (name, options = {}) => !navigator.locks ? Promise.resolve(() => {}) : new Promise(resolve => {
    let release;
    const held = new Promise(done => { release = done; });
    navigator.locks.request(name, options, lock => { resolve(lock ? release : null); return lock ? held : undefined; }).catch(() => resolve(null));
  });
  const lockedElsewhere = async pending => {
    if (!pending || pending.uploadId === ownUpload || !navigator.locks) return false;
    const {held = []} = await navigator.locks.query().catch(() => ({}));
    return held.some(lock => lock.mode === 'exclusive' && lock.name === lockName(pending));
  };
  // The interrupted upload that no tab is running, which this tab may resume or discard.
  const idlePending = async () => {
    const pending = pendingUpload();
    return pending && pending.uploadId !== ownUpload && !(await lockedElsewhere(pending)) ? pending : null;
  };
  // Discards it under its lock, so no tab can start resuming it meanwhile; true if it was discarded.
  async function discardIdle(pending) {
    if (await lockedElsewhere(pending)) return false;
    const release = await hold(lockName(pending), {ifAvailable: true});
    if (!release) return false;
    try {
      if (pendingUpload()?.uploadId !== pending.uploadId) return false;
      window.FylAPI.discard({uploadId: pending.uploadId, key: pending.key}); setPending(null);
      dropPasswords(id => id !== pending.uploadId);
      return true;
    } finally { release(); }
  }
  // Name, size and date alone can't tell an edited file from the original, so a resume also needs the same content
  // fingerprint: SHA-256 over the first and last MB and the size. Null when the file can't be read or WebCrypto is
  // missing (insecure context); such an upload is not kept for a resume. Cached per chosen file. The resume itself then
  // checks every uploaded part against the file (verify() in api.js).
  const fingerprint = file => {
    if (!prints.has(file)) prints.set(file, new Blob([file.slice(0, MB), file.slice(Math.max(MB, file.size - MB)), String(file.size)]).arrayBuffer()
      .then(bytes => crypto.subtle.digest('SHA-256', bytes)).then(hash => btoa(String.fromCharCode(...new Uint8Array(hash)))).catch(() => null));
    return prints.get(file);
  };
  const sameFile = (pending, file, print) => !!(pending && file && print) && pending.name === file.name && pending.size === file.size && pending.lastModified === dateOf(file) && pending.print === print;
  // A resume keeps the expiry, download mode and password the upload started with, so it is offered only with those. A
  // password this tab doesn't know (another tab or session set it) can't be compared; the resumed upload keeps it.
  const sameOptions = pending => {
    const known = passwordOf(pending.uploadId);
    return pending.minutes === lifetime() && pending.once === $('once-toggle').checked && !!pending.protected === $('password-toggle').checked && (!known || known === chosenPassword())
      // With the option hidden (encryption off for new uploads), an encrypted upload still resumes as it began.
      && (!E2EE || !!pending.e2ee === e2ee());
  };
  // An encrypted upload resumes only with its key (docs/E2EE.md §8.4): this tab's, or one pasted into the field.
  const resumeNeedsKey = pending => !!pending?.e2ee && !keyOf(pending.uploadId);
  let pendingTurn = 0, watched = null, restored = null, resumedWithoutLocks = false;
  async function showPending() {
    const file = selectedFile, turn = ++pendingTurn;
    let pending = pendingUpload();
    const elsewhere = await lockedElsewhere(pending);
    if (elsewhere) {
      // Shown as running elsewhere until that tab stops: it releases the lock when it finishes, fails or closes.
      // Watching takes the lock shared, so no tab mistakes a watcher for a running upload.
      const lock = lockName(pending);
      if (watched !== lock) {
        watched = lock;
        navigator.locks.request(lock, {mode: 'shared'}, () => {}).then(() => { if (watched === lock) watched = null; showPending(); }, () => {});
      }
    }
    if (turn !== pendingTurn) return;
    const notice = !!pending;
    if (pending) {
      $('pending-name').textContent = pending.name; $('discard-pending').hidden = elsewhere;
      $('pending-lead').textContent = t(elsewhere ? 'home.elsewhereLead' : 'home.pendingLead');
      // A folder's record keeps its fingerprint where a file's keeps its date.
      $('pending-tail').textContent = t(elsewhere ? 'home.elsewhereTail' : typeof pending.lastModified === 'string' ? 'home.pendingTailFolder' : 'home.pendingTail');
    }
    else if ($('form-error').textContent === RESUME_HINT) error('');
    if (!elsewhere && $('form-error').textContent === ELSEWHERE) error('');
    const print = file && await fingerprint(file), same = sameFile(pending, file, print);
    if (turn !== pendingTurn) return;
    // The folder of an unfinished folder upload, chosen again but changed since (another file, a rename, a touch): it
    // can't be resumed, so instead of asking for the same folder the notice says why Upload now starts anew.
    const changed = !elsewhere && !!pending && !same && typeof pending.lastModified === 'string' && !!folder && file === folder.zip && pending.name === folder.name;
    if (pending && !elsewhere && typeof pending.lastModified === 'string') $('pending-tail').textContent = t(changed ? 'home.pendingChangedFolder' : 'home.pendingTailFolder');
    // The same upload running in another tab can't be resumed here as well; another file starts a new upload.
    const running = elsewhere && same && sameOptions(pending);
    if (elsewhere) pending = null;
    // Choosing the file again brings back the upload's options once; changing them afterwards starts a new upload.
    if (same && pending && !sameOptions(pending) && restored !== file) { restored = file; setOptions({...pending, password: passwordOf(pending.uploadId)}); return; }
    const resume = same && !!pending && sameOptions(pending);
    // Once the same file is chosen, Upload reads "Resume upload" and the notice has done its job.
    $('pending-upload').hidden = !notice || resume;
    goState = {running, resume, replaces: !!pending && !!file && !resume};
    syncGo();
    $('password-hint').textContent = resume && pending.protected && !passwordOf(pending.uploadId) ? t('home.passwordResumeHint') : PASSWORD_HINT;
    $('resume-key-wrap').hidden = !(resume && resumeNeedsKey(pending));
  }
  async function createTransfer() {
    if (busy || !selectedFile) return;
    const minutes = lifetime();
    if (!validLifetime(minutes)) {
      error(lifetimeProblem(minutes),'expiry');
      $('custom-minutes').focus(); return;
    }
    const file = selectedFile, once = $('once-toggle').checked, started = Date.now(), zipped = folderOf(file);
    busy = true;
    const print = await fingerprint(file), candidate = pendingUpload();
    const resuming = sameFile(candidate, file, print) && sameOptions(candidate);
    // A resumed upload keeps its password: shown on the receipt if this tab knows it.
    const password = resuming ? candidate.protected ? passwordOf(candidate.uploadId) : '' : chosenPassword();
    const refuse = (message, field) => { busy = false; error(message, 'expiry'); if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); } };
    const encrypt = resuming ? !!candidate.e2ee : e2ee();
    if (!resuming && $('password-toggle').checked && !validPassword(password)) { refuse(t('home.passwordRule'), $('password-input')); return; }
    // An encrypted upload resumes with its key: this tab's, or the link or key pasted into the field (docs/E2EE.md §8.4).
    let resumeKey = resuming && encrypt ? keyOf(candidate.uploadId) : '';
    if (resuming && encrypt && !resumeKey) {
      try { resumeKey = (await loadCore()).parseKeyEntry($('resume-key').value, candidate.uploadId, location.origin); }
      catch (failure) {
        refuse(t(failure?.code === 'other_transfer' ? 'home.otherTransfer' : 'home.pasteResumeKey'), $('resume-key'));
        return;
      }
    }
    if (encrypt && !(await loadCore().then(core => core.supported(), () => false))) { refuse(t('home.noEncrypt')); return; }
    // The limit counts stored bytes, and encryption adds 16 bytes per 64 KiB (docs/E2EE.md §6).
    if (encrypt && file.size > (await loadCore()).maxPlaintextSize(LIMIT)) { refuse(t(zipped ? 'home.folderTooLargeEncrypt' : 'home.tooLargeEncrypt', {limit: L.number(Math.round(LIMIT / GB))})); return; }
    // Without Web Locks no tab can tell whether another one runs the upload, so a page resumes at most once.
    if (resuming && !navigator.locks && resumedWithoutLocks) { refuse(t('home.reloadResume')); return; }
    error('');
    const again = currentView === 'progress'; // Upload again, Retry now, or the network came back
    resetProgress(file, minutes); showSecret(password); showView('progress', {focus: again ? null : 'tool-heading', animate: !again});
    // A resumed upload's link is known already; an encrypted one's once its key checked out (FylAPI.upload).
    if (resuming && !encrypt) showLink(candidate.protected ? {url: candidate.url} : {title: file.name, url: candidate.url});
    announce(t(resuming ? 'home.resumedAnnounce' : 'home.startedAnnounce'));
    const controller = new AbortController(); uploadController = controller;
    const back = message => { showView('setup', {focus: 'create-button'}); showPending(); error(message, 'expiry'); };
    let entry = null, releaseUpload = null, releaseNew = null;
    try {
      if (resuming) {
        // Only one tab gets the upload's lock. Inside it the record is read again: another tab may have finished,
        // discarded or replaced it in the meantime.
        releaseUpload = await hold(lockName(candidate), {ifAvailable: true});
        if (!releaseUpload) { back(ELSEWHERE); return; }
        if (pendingUpload()?.uploadId !== candidate.uploadId) { back(t('home.changedElsewhere')); return; }
        resumedWithoutLocks = !navigator.locks; entry = candidate; ownUpload = candidate.uploadId;
      } else {
        releaseNew = await hold('fyl-new-upload', {signal: controller.signal});
        if (controller.signal.aborted) return;
        // An interrupted upload no tab is running is replaced by this one; one running elsewhere stays with its tab.
        const current = pendingUpload();
        if (current) await discardIdle(current);
      }
      // Taken before the session is created, so the record never outlasts the server's upload window.
      const created = resuming ? candidate.created : Date.now();
      const remember = async session => {
        releaseUpload ??= await hold(lockName(session)); // a new session's lock is free
        ownUpload = session.uploadId;
        if (password) keepPassword(session.uploadId, password);
        // An encrypted upload's record keeps the MD5 of every part it sends (`md5`), never its key (docs/E2EE.md §2.5).
        entry = {uploadId: session.uploadId, key: session.key, url: session.url, name: file.name, size: file.size, lastModified: dateOf(file), print, created,
          lock: lockName(session), minutes, once, protected: resuming ? !!candidate.protected : !!password,
          ...(encrypt ? {e2ee: true, md5: resuming && candidate.md5 && typeof candidate.md5 === 'object' ? {...candidate.md5} : {}} : {})};
        if (encrypt) keepKey(session.uploadId, session.e2eeKey);
        if (print) setPending(entry);
        releaseNew?.();
        if (currentView === 'progress') showLink(encrypt ? {url: session.share} : entry.protected ? {url: session.url} : {title: file.name, url: session.url});
      };
      // §8.2: the part's MD5 goes into this browser's record before the part is pinned or sent, re-read first (this
      // tab holds the upload's lock); false when the record is gone or can't be written, and nothing is sent then.
      // 'replaced' when an upload started in another tab has taken the record's place: without it this upload can't
      // be resumed, so it stops and is discarded like an interrupted one that was replaced.
      const records = {
        get: uploadId => (entry?.uploadId === uploadId && entry.md5) || {},
        put: (uploadId, part, md5) => {
          const stored = pendingUpload();
          if (entry?.uploadId === uploadId && stored?.uploadId && stored.uploadId !== uploadId) return 'replaced';
          if (!entry || entry.uploadId !== uploadId || stored?.uploadId !== uploadId) return false;
          if (stored.md5?.[part] && stored.md5[part] !== md5) return false;
          entry.md5 = {...stored.md5, ...entry.md5, [part]: md5};
          try { localStorage.setItem(PENDING, JSON.stringify(entry)); return pendingUpload()?.md5?.[part] === md5; } catch { return false; }
        },
      };
      const record = await window.FylAPI.upload(file, {minutes, once, password, e2ee: encrypt, records, ...(zipped ? {folder: {ranges: zipped.ranges, crcs: zipped.crcs}} : {})}, controller, (value, stage, sent, step) => {
        // A part that failed is retried by api.js; until one makes progress again, the link object shows it paused.
        if (value !== null) { setProgress(value); if (phase === 'stalled') stall(false); }
        else if (step === 'retrying' && phase === 'uploading') stall(true);
        if (sent) lastSent = sent;
        paintUpload(file, minutes, stage, step, sent ? estimate(sent, file.size) : null);
        $('cancel-button').disabled = step === 'creating';
      }, resuming ? {uploadId: candidate.uploadId, key: candidate.key, url: candidate.url, ...(encrypt ? {e2eeKey: resumeKey} : {})} : null, remember);
      // The interrupted upload's record goes only once the validated receipt is stored with the recent uploads. An
      // encrypted one's key stays with the keys (keepKey), and its record keeps the link without it.
      if (password) record.password = password;
      if (record.e2eeKey) { keepKey(record.id, record.e2eeKey); delete record.e2eeKey; }
      transfers.set(record.id, record); activeId = record.id;
      if (saveRecent({add: [record]})) forgetPending(record.id);
      showPending(); history.replaceState(null, '', managedPage(record)); renderHistory();
      finishProgress(file.size, started); announce(t('home.uploadedAnnounce'));
      // Nothing is lost any more, so closing the tab or opening another link meanwhile needs no warning.
      busy = false;
      await new Promise(resolve => setTimeout(resolve, 700));
      if (currentView === 'progress' && activeId === record.id) renderReceipt(record, false, true);
    } catch (failure) {
      if (failure.resumable) {
        // The newest upload wins: if another tab replaced the record meanwhile, this session is given up. So is one
        // without a fingerprint, whose file could never be recognised again.
        const stored = pendingUpload(), kept = !!print && !!entry && (!stored || stored.uploadId === entry.uploadId);
        if (kept) setPending(entry); else if (entry) window.FylAPI.discard({uploadId: entry.uploadId, key: entry.key});
        // Offline with its link shown, the upload waits here and goes on once the browser is back online, or on Retry now.
        if (kept && currentView === 'progress' && navigator.onLine === false) waitForNetwork(entry);
        else back(kept ? RESUME_HINT : t(print ? 'home.replaced' : 'home.insecureResume'));
      }
      // A refusal of an encrypted upload (the file changed, a key that doesn't open it, a resume that can't be checked)
      // stops without ending it: the record stays for a resume or Discard, and the form says why (docs/E2EE.md §8.4).
      else if (failure.kind === 'refused') back(failure.message);
      else if (failure.name !== 'AbortError') {
        forgetPending(entry?.uploadId); showPending();
        // Once its link was shown, the link object says it won't work; a refusal before that goes back to the form.
        if (entry && currentView === 'progress') fail();
        else { showView('setup', {focus: 'create-button'}); error(reason(failure, 'home.uploadFailedRetry'), 'expiry'); }
      }
    } finally {
      releaseNew?.(); releaseUpload?.();
      if (uploadController === controller) { uploadController = null; busy = false; ownUpload = null; }
      $('cancel-button').disabled = false;
    }
  }
  // The QR generator (MIT, vendored) is only downloaded when someone asks for a code.
  let qrLibrary = null;
  function loadQR() {
    qrLibrary ??= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/qrcode-generator-2.0.4.js';
      script.onload = () => window.qrcode ? resolve(window.qrcode) : reject(new Error('QR generator unavailable'));
      script.onerror = () => { qrLibrary = null; reject(new Error('QR generator unavailable')); };
      document.head.append(script);
    });
    return qrLibrary;
  }
  // Drawn with the 4-module white margin the QR standard asks for, inside the SVG, so the code scans in dark mode too.
  function qrSVG(qrcode, text) {
    const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
    const count = qr.getModuleCount(), quiet = 4, size = count + 2 * quiet;
    let path = '';
    for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (qr.isDark(row, col)) path += 'M' + col + ' ' + row + 'h1v1h-1z';
    return '<svg viewBox="' + -quiet + ' ' + -quiet + ' ' + size + ' ' + size + '" role="img" aria-label="' + escapeHTML(t('home.qrLabel')) + '" shape-rendering="crispEdges"><rect x="' + -quiet + '" y="' + -quiet + '" width="' + size + '" height="' + size + '" fill="#ffffff"/><path d="' + path + '" fill="#141416"/></svg>';
  }
  async function toggleQR() {
    const open = $('qr-button').getAttribute('aria-expanded') !== 'true';
    if (open && shown && !$('qr-image').firstChild) {
      try { $('qr-image').innerHTML = qrSVG(await loadQR(), shown); }
      catch { toast(t('home.qrFailed')); return; }
    }
    $('qr-button').setAttribute('aria-expanded', String(open));
    $('qr-panel').classList.toggle('open', open);
  }
  // A protected link: the server's flag, or a password known for the record where the flag is missing.
  const secret = record => !!(record.protected || record.password);
  // An encrypted link is shared as the link alone (docs/E2EE.md §9.5: navigator.share gets only {url}).
  const shareData = record => encrypted(record) ? {url: shareURL(record)} : secret(record) ? {url: record.url} : {title: record.name, url: record.url};
  // Too many wrong passwords pause a protected link, for one network or for everyone, and its owner may lift that at
  // once. The owner info's `passwordPause` says when the pause of everyone ends (`until`, on the server's clock) and how
  // many networks were paused as it answered (`networks`); a network's pause ends PASSWORD_PAUSE after it began, so
  // those end within that time of the answer (`pauseSeen`). A server that doesn't report pauses shows no button.
  const PASSWORD_PAUSE = 15 * 60000; // the server's PASSWORD_PAUSE_MS
  let clockOffset = 0; // the server's clock minus this device's, from the latest answer that gave its time
  const serverNow = () => Date.now() + clockOffset;
  const paused = record => {
    const pause = record.protected ? record.passwordPause : null, now = serverNow();
    return !!pause && ((Number.isFinite(pause.until) && pause.until > now) || (pause.networks > 0 && now < record.pauseSeen + PASSWORD_PAUSE));
  };
  // Takes over an owner answer: the server's time, when it gives it, and when it counted the password pauses.
  // P(C) (docs/E2EE.md §6): the file's own size, from the stored size the server reports for an encrypted transfer.
  const plainSize = C => {
    if (!Number.isSafeInteger(C) || C - 184 < 16) return null;
    const rest = C - 184, n = Math.max(1, Math.ceil(rest / 65552)), P = rest - 16 * n;
    return n >= 2 && P <= 65536 * (n - 1) ? null : P;
  };
  // An encrypted transfer's answer has no name (the server never had it): the one this browser knows stays. Its size is
  // the stored one, shown as the file's own.
  function ownerAnswer(answer) {
    if (answer && typeof answer === 'object' && answer.name == null) delete answer.name;
    if (answer?.mode === 'e2ee' && plainSize(answer.size) !== null) answer.size = plainSize(answer.size);
    if (Number.isFinite(answer?.serverTime)) clockOffset = answer.serverTime - Date.now();
    if (answer?.passwordPause) answer.pauseSeen = serverNow();
    return answer;
  }
  function isAvailable(record) {
    if (record && record.state === 'ready' && Date.now() >= record.expiresAt) record.state = 'expired';
    return !!record && record.state === 'ready';
  }
  // The receipt's meter: the time left, rounded down, with its date and Change; the line shows the share left.
  function paintLife() {
    const record = shownRecord(activeId);
    if (!record || currentView !== 'receipt') return;
    $('mt-main').textContent = leftLabel(record.expiresAt - Date.now());
    $('mt-sub').textContent = t(record.once ? 'home.untilOnce' : 'home.until', {date: when(record.expiresAt)});
    setLine($('life-bar'), lifeLeft(record));
  }
  // The sections under the link object enter only right after the ready beat (`enter`): the panel eases to its new
  // height while they fade in. Drawn again (a reload, a new expiry, a lifted pause) they just appear.
  function renderReceipt(record, focus = true, enter = false) {
    if (!isAvailable(record)) { renderGone(record); return; }
    if (enter) resize($('transfer'), () => drawReceipt(record, focus, enter)); else drawReceipt(record, focus, enter);
  }
  function drawReceipt(record, focus, enter) {
    const entering = name => enter ? ' enter' + (name ? ' ' + name : '') : '';
    activeId = record.id; phase = 'ready'; showSecret(); // the receipt has its own password section
    const lo = $('lo');
    lo.classList.remove('stalled', 'failed'); lo.classList.add('ready', 'lifetime');
    swapTo($('chip').querySelector('.swap'), true); swapTo($('tool-heading').querySelector('.swap'), true);
    paintFile(record);
    paintLink(shareURL(record), {secret: secret(record), keyless: encrypted(record) && !keyOf(record.id)});
    $('lo-actions').hidden = false; $('lo-actions').classList.remove('awaiting'); $('lo-actions').inert = false; $('lo-hint').hidden = true; $('upload-again').hidden = true; $('cancel-row').hidden = true; $('cancel-row').classList.remove('leaving');
    $('mt-then').hidden = true; $('mt-change').hidden = false; $('lo-meter').setAttribute('aria-label', t('home.timeLeft')); $('progressbar').hidden = true;
    // The hint names this page's origin, like the command its copy button copies (managementURL()).
    $('file-rm-row').querySelector('code').innerHTML = "fyl rm '" + escapeHTML(siteURL()) + "<wbr>#manage/…'";
    $('file-rm-row').hidden = false;
    const pausedNow = paused(record);
    $('receipt-view').innerHTML =
      (record.password ? '<section class="secret' + entering() + '" aria-labelledby="secret-heading"><h3 id="secret-heading">' + escapeHTML(t('home.password')) + '</h3><div class="joined"><span class="value" id="receipt-password" dir="ltr" translate="no">' + escapeHTML(record.password) + '</span><button class="btn btn-secondary" type="button" data-action="copy-password" aria-label="' + escapeHTML(t('home.copyPassword')) + '">' + copyLabel(t('common.copy')) + '</button></div><p class="hint">' + escapeHTML(t('home.sendSeparately')) + '</p>' +
        '<label class="check"><input type="checkbox" id="remember-password"' + (remembered(record.id) ? ' checked' : '') + '><span>' + tHtml('home.rememberPasswordHtml') + '</span></label></section>' : '') +
      '<section class="private' + entering('d1') + '" aria-labelledby="private-heading"><h3 id="private-heading">' + icon('key') + escapeHTML(t('home.privateLink')) + '</h3><p class="meta">' + escapeHTML(t('home.privateMeta')) + '</p>' +
        (pausedNow ? '<p class="meta pause-note" id="pause-note">' + escapeHTML(t('home.pauseNote')) + '</p>' : '') +
        '<div class="private-actions"><button class="btn btn-secondary" type="button" data-action="copy-private">' + copyLabel(t('home.copyPrivate')) + '</button>' +
        (pausedNow ? '<button class="btn btn-secondary" type="button" data-action="lift-pause" aria-describedby="pause-note">' + icon('refresh') + escapeHTML(t('home.liftPause')) + '</button>' : '') +
        '<button class="btn btn-danger-quiet" type="button" data-action="delete">' + icon('trash') + escapeHTML(t('home.deleteFile')) + '</button></div>' +
        '<div class="manual-copy" id="manual-private" hidden><label for="private-link">' + escapeHTML(t('home.privateLink')) + '</label><input id="private-link" dir="ltr" readonly value="' + escapeHTML(managementURL(record)) + '"></div></section>' +
      '<button class="btn btn-secondary btn-block again' + entering('d2') + '" type="button" data-action="new">' + escapeHTML(t('home.sendAnother')) + '</button>';
    showView('receipt', {focus: focus ? 'tool-heading' : null});
    paintLife();
  }
  // A link that doesn't work (any more): a plain title, the reason as an outlined tag over the dead line, the next step.
  // The icon of each; its title, tag and text are home.gone.<state>.*, with no tag where the link may still work.
  const GONE = {consumed: 'one', deleted: 'trash', expired: 'clock', removed: 'flag', quarantined: 'pause', busy: 'clock', missing: 'file', denied: 'key', offline: 'alert'};
  function renderGone(record, why) {
    showSecret();
    activeId = record?.id || null;
    const found = why || record?.state || 'missing', state = GONE[found] ? found : 'missing', glyph = GONE[state];
    const title = escapeHTML(t('home.gone.' + state + '.title')), text = escapeHTML(t('home.gone.' + state + '.text'));
    const tag = L.has('home.gone.' + state + '.tag') ? escapeHTML(t('home.gone.' + state + '.tag')) : '';
    // Under review, the owner may still delete the file (see handleRoute).
    const owner = state === 'quarantined' && reviewed && record === reviewed ? '<section class="private" aria-labelledby="review-heading"><h3 id="review-heading">' + icon('key') + escapeHTML(t('home.privateLink')) + '</h3><p class="meta">' + escapeHTML(t('home.reviewMeta')) + '</p><div class="private-actions"><button class="btn btn-danger-quiet" type="button" data-action="delete">' + icon('trash') + escapeHTML(t('home.deleteFile')) + '</button></div></section>' : '';
    $('gone-view').innerHTML = '<div class="gone-head"><span class="tile" aria-hidden="true">' + icon(glyph) + '</span><div class="minw0"><h2 id="gone-heading" tabindex="-1">' + title + '</h2>' + (record?.name ? '<p class="gone-file" dir="auto">' + escapeHTML(record.name) + '</p>' : '') + '</div></div>' +
      (tag ? '<div class="life-dead" role="group" aria-label="' + escapeHTML(t('home.linkStatus')) + '"><span class="tag-out">' + tag + '</span><span class="bar dead" aria-hidden="true"></span></div>' : '') +
      '<p class="gone-text">' + text + '</p>' + owner + '<button class="btn btn-primary btn-lg" type="button" data-action="new">' + escapeHTML(t('home.sendAnother')) + '</button>';
    showView('gone', {focus: 'gone-heading'}); renderHistory();
  }
  // The transfer shown here: the one under review whose management link is open, or a stored one.
  const shownRecord = id => reviewed && reviewed.id === id ? reviewed : transfers.get(id);
  // Recent uploads and their private links are kept in this browser so they can be managed after a reload; their
  // passwords are not (see keepPassword). Tabs share the list, so a change is merged into what is stored at that
  // moment: a record joins when it is uploaded or its management link is opened, other changes only update records
  // still stored, and what one tab forgets stays gone.
  // `review` is true while the server answers 403 quarantined: the file is paused while a report about it is reviewed.
  const STORE = 'fyl-recent', KEEP = ['id','ownerKey','name','size','url','expiresAt','createdAt','minutes','once','protected','mode','state','review'], RECENT = 20;
  const storable = record => Object.fromEntries(KEEP.map(key => [key, record[key]]));
  const live = record => record.state === 'ready' && Date.now() < record.expiresAt;
  const closedState = failure => ['deleted', 'consumed', 'removed'].includes(failure.code) ? failure.code : 'expired';
  // The stored records, without those expired for more than a day; null when storage can't be read.
  const storedRecent = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || '[]'), cutoff = Date.now() - 86400000;
      return (Array.isArray(saved) ? saved : []).filter(record => record?.id && record.ownerKey && record.url && record.expiresAt > cutoff);
    } catch { return null; }
  };
  // True when every added record is stored afterwards.
  function saveRecent({add = [], update = [], drop = []}) {
    let stored;
    try {
      // Every record is written back with only the KEEP fields, so the first save after loading (loadRecent) also drops
      // any other field a record carries, a password above all: this device never stores one (keepPassword).
      const list = new Map((storedRecent() || []).map(record => [record.id, storable(record)]));
      const keep = record => list.set(record.id, storable(record));
      add.forEach(keep); update.filter(record => list.has(record.id)).forEach(keep); drop.forEach(id => list.delete(id));
      // Over the limit, the oldest closed records go first, and only then the oldest live ones.
      const records = [...list.values()];
      while (records.length > RECENT) {
        const closed = records.findIndex(record => !live(record)), [gone] = records.splice(Math.max(0, closed), 1);
        if (live(gone)) toast(t('home.recentLimit', {count: RECENT, name: gone.name || unnamedThe(gone)}));
      }
      if (records.length) localStorage.setItem(STORE, JSON.stringify(records)); else localStorage.removeItem(STORE);
      const listed = new Set(records.map(record => record.id)), pending = pendingUpload()?.uploadId;
      stored = add.every(record => listed.has(record.id));
      // Passwords go with their records; the interrupted upload's and the one running here stay.
      dropPasswords(id => listed.has(id) || id === pending || id === ownUpload);
    } catch { return false; }
    syncRecent(); return stored;
  }
  // Takes over the stored list, with what other tabs added, changed or forgot. The transfer shown here stays loaded.
  function syncRecent() {
    const saved = storedRecent(), before = new Map(transfers);
    if (!saved) return;
    transfers.clear();
    for (const record of saved) transfers.set(record.id, Object.assign(before.get(record.id) || {}, record));
    if (before.has(activeId) && !transfers.has(activeId)) transfers.set(activeId, before.get(activeId));
  }
  function loadRecent() {
    saveRecent({}); renderHistory(); // also drops long-expired records from storage
    if (window.requestIdleCallback) requestIdleCallback(refreshRecent, {timeout: 3000}); else setTimeout(refreshRecent, 1000);
  }
  // Refreshes states that may have changed elsewhere (downloaded, deleted, expired) once the page is idle, four at a
  // time. Records past their expiry are marked locally by isAvailable() and cost no request; the open transfer was
  // just fetched. The requests share the download rate limit, so a 429 ends the round.
  async function refreshRecent() {
    const queue = [...transfers.values()].filter(record => isAvailable(record) && record.id !== activeId), refreshed = [...queue];
    if (!queue.length) return;
    const worker = async () => {
      for (let record = queue.shift(); record; record = queue.shift()) {
        try { Object.assign(record, ownerAnswer(await window.FylAPI.info(record.id, record.ownerKey)), {review: false}); }
        catch (failure) {
          if (failure.status === 410 || failure.status === 404) record.state = closedState(failure);
          else if (underReview(failure)) record.review = true;
          else if (failure.status === 429) queue.length = 0;
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(4, queue.length)}, worker));
    saveRecent({update: refreshed}); renderHistory();
  }
  // Recent uploads read like a departures board: the time left leads, live links come first (newest first), closed
  // ones stay below, muted, with the reason. Rows never animate.
  const CLOSED = ['consumed', 'deleted', 'removed', 'expired'];
  function renderHistory() {
    $('recent-section').hidden = transfers.size === 0;
    const records = [...transfers.values()].reverse();
    records.forEach(isAvailable);
    records.sort((a, b) => (b.state === 'ready') - (a.state === 'ready'));
    $('recent-list').innerHTML = records.map(record => {
      const ready = record.state === 'ready', review = ready && record.review === true, closed = CLOSED.includes(record.state) ? record.state : 'expired';
      const tag = escapeHTML(t('home.closed.' + closed + '.tag')), why = escapeHTML(t('home.closed.' + closed + '.why', {date: dayLabel(record.expiresAt)}));
      const left = ready ? '<span data-countdown="' + record.id + '">' + escapeHTML(leftLabel(record.expiresAt - Date.now())) + '</span>' : '';
      const line = ready ? '<span class="bar" aria-hidden="true"><i data-life="' + record.id + '"></i></span>' : '<span class="bar dead" aria-hidden="true"></span>';
      // Password and One download describe how a live link opens; a closed row says only why it closed.
      const meta = [ready ? '<span class="life-inline" data-countdown="' + record.id + '">' + escapeHTML(leftLabel(record.expiresAt - Date.now())) + '</span>' : '<span class="life-inline">' + tag + '</span>',
        review ? '<span class="tag-out">' + escapeHTML(t('home.underReview')) + '</span>' : '', ready && encrypted(record) ? '<span class="on">' + icon('shield') + escapeHTML(t('home.encrypted')) + '</span>' : '',
        ready && secret(record) ? '<span class="on">' + icon('lock') + escapeHTML(t('home.password')) + '</span>' : '', ready && record.once ? '<span class="on">' + icon('one') + escapeHTML(t('home.once')) + '</span>' : '',
        '<span>' + escapeHTML(sizeLabel(record.size)) + '</span>', ready ? '' : '<span>' + why + '</span>'].filter(Boolean);
      // Each item after the first carries its separator, which CSS hides at the start of a line, so no line starts or
      // ends with a lone dot (the time left leads this line only on phones).
      const items = meta.slice(1).map(item => '<span class="sep"><span class="dot" aria-hidden="true">·</span>' + item + '</span>');
      return '<li class="row' + (ready ? '' : ' closed') + '" data-status="' + (review ? 'review' : record.state) + '">' +
        '<div class="row-life">' + (ready ? left + line : '<span class="tag-out">' + tag + '</span>' + line) + '</div>' +
        '<div class="row-main">' + middle(record.name || unnamed(record), 12, 'p', ' class="mid" dir="auto"') + '<p class="row-meta">' + meta[0] + items.join('') + '</p>' + line + '</div>' +
        '<button class="btn btn-quiet manage" type="button" data-record="' + record.id + '" aria-label="' + escapeHTML(t('home.manageLabel', {name: record.name || unnamedInline(record)})) + '"><span class="manage-l">' + escapeHTML(t('home.manage')) + '</span>' + icon('chev') + '</button>' +
        '<button class="btn btn-icon" type="button" data-forget="' + record.id + '" aria-label="' + escapeHTML(t('home.forgetLabel', {name: record.name || unnamedInline(record)})) + '">' + icon('x') + '</button></li>';
    }).join('');
    paintLines();
  }
  function paintLines() { document.querySelectorAll('[data-life]').forEach(element => { const record = transfers.get(element.dataset.life); if (record) setLine(element, lifeLeft(record)); }); }
  function openDialog(name, tab = 'upload') {
    if (name === 'cli') updateCLI(tab);
    if ($(name + '-error')) dialogError(name, '');
    $(name + '-dialog').showModal();
    // Focus starts at the title, so screen readers read it and no button looks chosen (Chrome rings a button focused
    // by script); Tab then reaches the safe action first (Keep it, Cancel), Escape closes.
    $(name + '-heading')?.focus({preventScroll:true});
  }
  function updateCLI(tab) {
    document.querySelectorAll('[data-cli-tab]').forEach(button => {
      const chosen = button.dataset.cliTab === tab;
      button.setAttribute('aria-selected',String(chosen)); button.tabIndex = chosen ? 0 : -1;
      $('cli-' + button.dataset.cliTab).classList.toggle('active', chosen);
    });
  }
  // A transfer under review answers its owner 403 quarantined, after checking the key, but deleting it still works.
  // Its details are not given out, so the view uses what this browser stored, if anything, and stores nothing new but
  // that a stored one is under review.
  const underReview = failure => failure.status === 403 && failure.code === 'quarantined';
  function showReview(id, key) {
    const stored = transfers.get(id);
    if (stored) { stored.review = true; saveRecent({update: [stored]}); }
    reviewed = {...stored, id, ownerKey: key, state: 'ready'};
    renderGone(reviewed, 'quarantined');
  }
  async function handleRoute(focus = true) {
    const pieces = location.hash.slice(1).split('/');
    if (pieces[0] === 'manage' && pieces[1]) {
      const route = location.hash, key = pieces[2] || '';
      reviewed = null;
      if (!/^[a-zA-Z0-9_-]{43,64}$/.test(pieces[1])) { renderGone(null); return; }
      if (!/^[a-zA-Z0-9_-]{43}$/.test(key)) { renderGone(null, 'denied'); return; }
      // While the owner info loads, the panel says so (and is aria-busy) instead of showing the empty form.
      $('head-a').textContent = t('home.loading'); swapTo($('tool-heading').querySelector('.swap'), false);
      showView('loading');
      try {
        const record = ownerAnswer(await window.FylAPI.info(pieces[1], key));
        if (location.hash !== route) return;
        record.ownerKey = key; record.password = passwordOf(record.id) || undefined; record.review = false;
        if (record.name == null && transfers.get(record.id)?.name) record.name = transfers.get(record.id).name;
        transfers.set(record.id, record); saveRecent({add: [record]});
        renderReceipt(record, focus); renderHistory();
      } catch (failure) {
        if (location.hash !== route) return;
        if (underReview(failure)) { showReview(pieces[1], key); return; }
        renderGone(null, failure.status === 403 ? 'denied' : failure.status === 404 ? 'missing' : failure.status === 410 ? failure.code : failure.status === 429 ? 'busy' : 'offline');
      }
    } else if (location.hash === '#cli') {
      // "Use the CLI" on an older download page links here: open the guide and drop the hash.
      history.replaceState(null, '', location.pathname + location.search);
      resetDraft(false); openDialog('cli', 'setup');
    // The wordmark (href="#") starts a new draft. Its picker takes focus only after a key press: a pointer click would
    // otherwise light the picker's focus ring, which stays keyboard-only.
    } else if (!location.hash || location.hash === '#') resetDraft(focus && viaKeyboard);
  }

  document.querySelectorAll('input[name="lifetime"]').forEach(input => input.addEventListener('change', () => { updateOptions(); paintSeg(viaKeyboard); }));
  $('custom-minutes').addEventListener('input',updateOptions);
  $('custom-unit').addEventListener('change',updateOptions);
  $('once-toggle').addEventListener('change',updateOptions);
  $('e2ee-option').hidden = !E2EE; $('e2ee-wrap').hidden = !E2EE;
  // Turning encryption on checks that this browser can (WebCrypto X25519 in a secure context); if not, it says so.
  $('e2ee-toggle').addEventListener('change',async () => {
    updateOptions();
    if (!$('e2ee-toggle').checked || await loadCore().then(core => core.supported(), () => false)) return;
    $('e2ee-toggle').checked = false; updateOptions();
    error(t('home.noEncryptCli'), 'expiry');
  });
  // Turning the password on offers a generated one; the sender may type their own instead.
  $('password-toggle').addEventListener('change',() => {
    if ($('password-toggle').checked && !$('password-input').value) $('password-input').value = window.FylAPI.passphrase();
    updateOptions();
  });
  $('password-input').addEventListener('input',updateOptions);
  $('generate-password').addEventListener('click',() => {
    $('password-input').value = window.FylAPI.passphrase(); updateOptions(); announce(t('home.newPasswordAnnounce', {password: $('password-input').value}));
  });
  const pickFile = () => { $('file-input').value = ''; $('file-input').click(); };
  $('repick').addEventListener('click',() => { if (currentView !== 'setup') return; if (folder) pickFolder(); else pickFile(); });
  $('file-input').addEventListener('change',() => setFile($('file-input').files[0], true));
  // The drop zone says "file or folder" where the browser can pick folders, and its picker opens a menu (Choose a file,
  // Choose a folder) that theme.js places under the zone's "choose" words; elsewhere it says "file" and opens the file
  // picker. theme.js sets html.no-folders before the first paint; this decides for good.
  document.documentElement.classList.toggle('no-folders', !FOLDERS);
  document.querySelectorAll('#dropzone .if-folders, #dropzone .if-files, #setup-heading .if-folders, #setup-heading .if-files').forEach(element => { element.hidden = element.classList.contains('if-folders') !== FOLDERS; });
  if (FOLDERS) {
    const pick = $('pick-file');
    pick.setAttribute('popovertarget', 'pick-menu'); pick.setAttribute('aria-haspopup', 'menu'); pick.setAttribute('aria-expanded', 'false');
    pick.dataset.anchor = '#dropzone .choose, #dropzone .touch-only'; pick.dataset.align = 'center';
  } else $('pick-file').addEventListener('click', pickFile);
  // A menu item opens its picker first, while the click still counts as the user's, then closes the menu.
  const fromMenu = open => () => { open(); $('pick-menu').hidePopover?.(); };
  $('pick-menu-file').addEventListener('click', fromMenu(pickFile));
  $('pick-menu-folder').addEventListener('click', fromMenu(pickFolder));
  $('folder-input').addEventListener('change', () => chooseFolderInput([...$('folder-input').files]));
  $('remove-file').addEventListener('click',() => {
    const was = folder;
    clearFile(true, true);
    announce(t(was ? 'home.folderRemoved' : 'home.fileRemoved'));
  });
  $('create-button').addEventListener('click',createTransfer);
  $('upload-again').addEventListener('click',createTransfer);
  $('retry-now').addEventListener('click',resumeWaiting);
  window.addEventListener('online',resumeWaiting);
  $('cancel-button').addEventListener('click',cancelProgress);
  // Files can be dropped anywhere on the page while the upload form is shown; the drop zone shows the target.
  const dragHasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  const dragging = on => { main.toggleAttribute('data-drag', on); $('dropzone').classList.toggle('drag-over', on); };
  // A modal dialog (the CLI's, a delete or expiry question) covers the form: nothing dropped or pasted meanwhile is
  // chosen behind it, where nobody sees it happen.
  const modalOpen = () => ['cli', 'delete', 'expiry', 'forget'].some(name => $(name + '-dialog').open);
  window.addEventListener('dragenter',event => { if (dragHasFiles(event) && currentView === 'setup' && !busy && !modalOpen() && ++dragDepth === 1) dragging(true); });
  window.addEventListener('dragleave',() => { if (dragDepth && --dragDepth === 0) dragging(false); });
  window.addEventListener('dragover',event => event.preventDefault());
  window.addEventListener('drop',event => {
    event.preventDefault(); dragDepth = 0; dragging(false);
    if (currentView !== 'setup' || busy || modalOpen() || !dragHasFiles(event)) return;
    // Exactly one dropped folder becomes a zip; several items, folders among them, stay one file at a time. The entry
    // has to be taken during the event.
    const items = [...(event.dataTransfer.items || [])].filter(item => item.kind === 'file');
    const entry = ZIP && items.length === 1 ? items[0].webkitGetAsEntry?.() : null;
    if (entry?.isDirectory) { chooseFolder(entry.name, signal => walk(entry, ENTRIES, signal)); return; }
    if (event.dataTransfer.files.length !== 1) { error(MULTIPLE); return; }
    setFile(event.dataTransfer.files[0], true);
  });
  // A file pasted anywhere on the page (not into a field) is chosen like a dropped one. Pasted images usually come
  // without a useful name (image.png), so they get one from the time and their type. Pasted text does nothing.
  const typing = target => !!target?.isContentEditable || !!target?.matches?.('textarea, select, input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="file"], [type="range"], [type="color"])');
  const IMAGE_EXTENSIONS = {'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/tiff': 'tif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico'};
  function pastedFile(file) {
    if (!/^image\//.test(file.type) || (file.name && !/^(image|blob|unknown|untitled|clipboard)(\.[a-z0-9]+)?$/i.test(file.name))) return file;
    const now = new Date(), two = value => String(value).padStart(2, '0');
    const stamp = now.getFullYear() + two(now.getMonth() + 1) + two(now.getDate()) + '-' + two(now.getHours()) + two(now.getMinutes()) + two(now.getSeconds());
    const extension = IMAGE_EXTENSIONS[file.type] || file.type.slice(6).replace(/[^a-z0-9]/gi, '').slice(0, 5).toLowerCase() || 'img';
    return new File([file], 'pasted-image-' + stamp + '.' + extension, {type: file.type, lastModified: file.lastModified});
  }
  document.addEventListener('paste', event => {
    if (typing(event.target)) return;
    const data = event.clipboardData;
    let files = [...(data?.files || [])];
    if (!files.length) files = [...(data?.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    // While an upload runs or a dialog is open, a pasted file is refused like a dropped one.
    if (currentView !== 'setup' || busy || modalOpen()) return;
    if (files.length !== 1) { error(MULTIPLE); return; }
    setFile(pastedFile(files[0]), true);
  });
  document.addEventListener('click',async event => {
    if (event.target.id === 'private-link') event.target.select();
    const close = event.target.closest('[data-close]');
    if (close) { close.closest('dialog').close(); return; }
    const dialog = event.target.closest('[data-dialog]');
    if (dialog) { openDialog(dialog.dataset.dialog, dialog.dataset.cliStart || 'upload'); return; }
    const tab = event.target.closest('[data-cli-tab]');
    if (tab) { updateCLI(tab.dataset.cliTab); return; }
    const forgetButton = event.target.closest('[data-forget]');
    if (forgetButton) {
      const id = forgetButton.dataset.forget, record = transfers.get(id), password = passwordOf(id), kept = remembered(id), key = keyOf(id);
      const order = [...$('recent-list').querySelectorAll('[data-forget]')].map(button => button.dataset.forget), at = order.indexOf(id);
      transfers.delete(id); saveRecent({drop: [id]});
      if (id === activeId) resetDraft(false); // its private link leaves the address bar too
      renderHistory();
      // Focus goes to the row that took its place (or the one above), and to the form once the list is empty.
      const rows = $('recent-list').querySelectorAll('[data-forget]');
      (rows[Math.min(Math.max(at, 0), rows.length - 1)] || formFocus())?.focus({preventScroll: true});
      // Undo brings the record back as it was, its password and an encrypted upload's key too (fyl.at can't give the key
      // again); the file itself was never touched.
      if (record) toast(t('home.forgot', {name: record.name || unnamedThe(record)}), {done: true, action: {label: t('home.undo'), run: () => {
        if (password) keepPassword(id, password, kept ? true : null);
        if (key) keepKey(id, key);
        saveRecent({add: [record]}); renderHistory();
        return [...$('recent-list').querySelectorAll('[data-forget]')].find(button => button.dataset.forget === id);
      }}});
      return;
    }
    if (event.target.closest('#forget-all')) {
      const pending = await idlePending(), count = transfers.size;
      $('forget-text').innerHTML = tHtml(pending ? 'home.forgetTextPendingHtml' : 'home.forgetTextHtml', {uploads: t('home.recentCount', {count}), name: pending?.name || ''});
      openDialog('forget'); return;
    }
    const recent = event.target.closest('[data-record]');
    if (recent) {
      const record = transfers.get(recent.dataset.record);
      // A running upload keeps this tab, so the transfer opens in a new one.
      if (busy) { window.open(managedPage(record), '_blank', 'noopener'); return; }
      history.replaceState(null,'',managedPage(record));
      await handleRoute();
      reveal();
      return;
    }
    const button = event.target.closest('[data-action]'), action = button?.dataset.action;
    if (!action) return;
    if (action === 'new') { resetDraft(); return; }
    const record = shownRecord(activeId);
    if (!record) { renderGone(null); return; }
    if (action === 'copy-password') copy(record.password,t('home.passwordCopied'),'receipt-password', button);
    if (action === 'copy-private') copy(managementURL(record),t('home.privateCopied'),'private-link', button);
    if (action === 'delete') {
      if (!isAvailable(record)) { renderGone(record); return; }
      pendingDelete = record.id;
      // Each key written out whole: the page carries only the keys its scripts name (scripts/build_i18n.mjs).
      $('delete-text').innerHTML = tHtml(record === reviewed ? (record.name ? 'home.deleteReviewNamedHtml' : 'home.deleteReviewUnnamedHtml') : record.name ? 'home.deleteNamedHtml' : 'home.deleteUnnamedHtml', {name: record.name || ''});
      openDialog('delete');
    }
    if (action === 'lift-pause') {
      if (!isAvailable(record)) { renderGone(record); return; }
      button.disabled = true;
      // The answer is the owner info with its pauses lifted; one that leaves them out ends them here as well.
      try { Object.assign(record, {passwordPause: null}, ownerAnswer(await window.FylAPI.unpause(record.id, record.ownerKey))); }
      catch (failure) {
        button.disabled = false;
        if (failure.status === 410 || failure.status === 404) closedElsewhere(record, failure);
        else if (underReview(failure)) showReview(record.id, record.ownerKey);
        else toast(reason(failure, 'home.liftFailed'));
        return;
      }
      if (activeId === record.id && currentView === 'receipt') {
        renderReceipt(record, false);
        document.querySelector('#receipt-view [data-action="copy-private"]')?.focus(); // the button is gone
      }
      toast(t('home.pauseLifted'), {done: true});
    }
    if (action === 'edit-expiry') {
      $('expiry-menu').hidePopover?.();
      if (!isAvailable(record)) { renderGone(record); return; }
      pendingExpiry = record.id;
      const [amount, unit] = splitMinutes(record.minutes);
      $('edit-custom-minutes').value = String(amount); $('edit-custom-unit').value = unit;
      updateEditExpiry(); openDialog('expiry');
    }
  });
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click',event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
  }));
  document.querySelector('.cli-tabs').addEventListener('keydown',event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-cli-tab]')], current = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    updateCLI(tabs[next].dataset.cliTab); tabs[next].focus();
  });
  document.querySelectorAll('[data-copy-command]').forEach(button => button.addEventListener('click',() => copy(button.previousElementSibling.textContent,t('common.commandCopied'),'',button)));
  $('copy-install').addEventListener('click',event => copy(CLI_INSTALL_COMMAND,t('home.installCopied'),'',event.currentTarget));
  $('copy-upload-command').addEventListener('click',event => copy(uploadCommand(),t('home.uploadCopied'),'',event.currentTarget));
  $('copy-file-curl').addEventListener('click',event => copy((menuValues.key ? menuValues.nokeycli : menuValues.curl) || '',t('home.downloadCopied'),'file-curl',event.currentTarget));
  $('copy-file-rm').addEventListener('click',event => { const record = shownRecord(activeId); if (record?.ownerKey) copy('fyl rm ' + shellQuote(managementURL(record)),t('home.deleteCopied'),'',event.currentTarget); });
  const linkCopied = () => { keyCopied = true; };
  $('copy-link').addEventListener('click',async () => { if (shown && await copy(shown,t('home.linkCopied'),'link-url',$('copy-link'))) linkCopied(); });
  $('copy-lo-password').addEventListener('click', () => { const value = $('lo-password').textContent; if (value) copy(value, t('home.passwordCopied'), 'lo-password', $('copy-lo-password')); });
  $('copy-inline').addEventListener('click',async () => { if (shown && await copy(shown,t('home.linkCopied'),'link-url',$('copy-inline'))) linkCopied(); });
  if (window.ResizeObserver) new ResizeObserver(() => fitUrl()).observe($('link-url'));
  if (window.ResizeObserver) new ResizeObserver(() => ['key-nokey', 'key-key'].forEach(id => fitValue($(id)))).observe($('keyrows'));
  // Like MEGA's "export link and key separately": the one link with the key is the default; one quiet line with a
  // disclosure arrow opens the two parts.
  $('key-split').addEventListener('click', () => {
    const open = $('key-split').getAttribute('aria-expanded') !== 'true';
    $('key-split').setAttribute('aria-expanded', String(open)); $('keyrows-wrap').classList.toggle('open', open);
    ['key-nokey', 'key-key'].forEach(id => fitValue($(id)));
  });
  document.fonts?.addEventListener?.('loadingdone', () => fitUrl());
  $('copy-menu').addEventListener('click',async event => {
    const item = event.target.closest('[data-menu-copy]');
    if (!item) return;
    $('copy-menu').hidePopover?.();
    const name = item.dataset.menuCopy;
    const copied = t({link: 'home.linkCopied', curl: shown?.includes('#') ? 'home.terminalCopied' : 'home.downloadCopied', nokey: 'home.noKeyCopied',
      key: 'home.keyCopied', nokeycli: 'home.terminalCopied'}[name]);
    // Only what carries the key counts as the key having left this tab (the warning before closing it).
    if (await copy(menuValues[name] || '', copied, '', $('copy-link')) && ['link', 'key', 'curl'].includes(name)) linkCopied();
  });
  document.querySelectorAll('[data-copy-key]').forEach(button => button.addEventListener('click',async () => {
    const name = button.dataset.copyKey, text = menuValues[name];
    if (await copy(text || '', t(name === 'key' ? 'home.keyCopied' : 'home.noKeyCopied'), '', button) && name === 'key') linkCopied();
  }));
  $('share-link').addEventListener('click',() => {
    const record = currentView === 'receipt' ? shownRecord(activeId) : null, data = record ? shareData(record) : early;
    if (data) navigator.share(data).then(linkCopied, () => {});
  });
  $('qr-button').addEventListener('click',toggleQR);
  // The expiry menu on the receipt: the presets save at once (counted from the upload); Custom opens the dialog. A
  // preset whose time has already passed can't be chosen.
  $('expiry-menu').addEventListener('beforetoggle',event => {
    const record = shownRecord(activeId);
    if (event.newState !== 'open' || !record) return;
    document.querySelectorAll('#expiry-menu [data-minutes]').forEach(item => {
      const minutes = Number(item.dataset.minutes);
      item.setAttribute('aria-checked', String(minutes === record.minutes)); item.disabled = record.createdAt + minutes * 60000 <= Date.now();
    });
  });
  $('expiry-menu').addEventListener('click',event => {
    const item = event.target.closest('[data-minutes]');
    if (!item) return;
    $('expiry-menu').hidePopover?.();
    const record = shownRecord(activeId);
    if (record && Number(item.dataset.minutes) !== record.minutes) saveExpiry(record, Number(item.dataset.minutes), item, false);
  });
  $('confirm-delete').addEventListener('click',async () => {
    const record = shownRecord(pendingDelete);
    if (!record) return;
    $('confirm-delete').disabled = true;
    try { await window.FylAPI.remove(record.id, record.ownerKey); }
    catch (failure) {
      if (failure.status === 410 || failure.status === 404) { pendingDelete = null; $('delete-dialog').close(); closedElsewhere(record, failure); }
      else dialogError('delete', reason(failure, 'home.deleteFailed'));
      return;
    }
    finally { $('confirm-delete').disabled = false; }
    pendingDelete = null; $('delete-dialog').close();
    if (record.state === 'ready') record.state = 'deleted';
    saveRecent({update: [record]}); renderGone(record); announce(t('home.deletedAnnounce'));
  });
  // A transfer that closed meanwhile (deleted, used up or expired, perhaps in another tab) shows why.
  function closedElsewhere(record, failure) {
    record.state = closedState(failure); saveRecent({update: [record]}); renderGone(record);
  }
  // Forget this device: the recent uploads, the interrupted upload and every password kept here. An upload running in
  // this or another tab goes on; it is forgotten once it finishes or is cancelled.
  $('confirm-forget').addEventListener('click', async () => {
    const pending = await idlePending(), discarded = !!pending && await discardIdle(pending);
    transfers.clear();
    try { localStorage.removeItem(STORE); } catch {}
    dropPasswords(id => id === ownUpload); rememberKeys(false); dropKeys(id => id === ownUpload);
    $('forget-dialog').close(); showPending();
    if (activeId) resetDraft(false); // the shown transfer's private link leaves the address bar too
    renderHistory(); formFocus()?.focus({preventScroll: true}); // the dialog's opener is gone with the list
    toast(t(discarded ? 'home.forgotAllPending' : 'home.forgotAll'), {done: true});
  });
  const editedLifetime = () => Number($('edit-custom-minutes').value * $('edit-custom-unit').value);
  function updateEditExpiry() {
    const minutes = editedLifetime(), record = transfers.get(pendingExpiry);
    const expiresAt = record ? record.createdAt + minutes * 60000 : 0, valid = validLifetime(minutes);
    $('edit-custom-minutes').setAttribute('aria-invalid',String(!valid));
    $('save-expiry').disabled = !valid || expiresAt <= Date.now();
    $('edit-expiry-summary').innerHTML = !valid ? '<span class="err-text">' + escapeHTML(lifetimeProblem(minutes)) + '</span>' : expiresAt <= Date.now() ? '<span class="err-text">' + escapeHTML(t('home.timePassed')) + '</span>' : escapeHTML(t('home.openUntil', {date: when(expiresAt)}));
  }
  $('edit-custom-minutes').addEventListener('input',updateEditExpiry);
  $('edit-custom-unit').addEventListener('change',updateEditExpiry);
  // Changes the expiry, from the menu (`dialog` false) or the dialog; a link that closed or went under review meanwhile
  // shows that instead.
  async function saveExpiry(record, minutes, button, dialog) {
    const closeDialog = () => { pendingExpiry = null; if (dialog) $('expiry-dialog').close(); };
    if (!isAvailable(record)) { closeDialog(); renderGone(record); return; }
    if (!validLifetime(minutes) || record.createdAt + minutes * 60000 <= Date.now()) { if (dialog) updateEditExpiry(); return; }
    button.disabled = true;
    try { Object.assign(record, ownerAnswer(await window.FylAPI.expiry(record.id, record.ownerKey, minutes))); }
    catch (failure) {
      if (failure.status === 410 || failure.status === 404) { closeDialog(); closedElsewhere(record, failure); }
      else if (underReview(failure)) { closeDialog(); showReview(record.id, record.ownerKey); }
      else if (dialog) dialogError('expiry', reason(failure, 'home.expiryFailed'));
      else toast(reason(failure, 'home.expiryFailed'));
      return;
    }
    finally { button.disabled = false; }
    closeDialog();
    saveRecent({update: [record]}); renderReceipt(record, false); renderHistory();
    $('mt-change').focus({preventScroll:true});
    toast(t('home.expirySaved', {duration: durationLabel(record.minutes || minutes)}), {done: true});
  }
  $('save-expiry').addEventListener('click',() => {
    const record = transfers.get(pendingExpiry);
    if (!isAvailable(record)) { $('expiry-dialog').close(); pendingExpiry = null; renderGone(record); return; }
    saveExpiry(record, editedLifetime(), $('save-expiry'), true);
  });
  // Only the Cancel button stops a running upload: opening a management link or the wordmark meanwhile would throw it
  // away, so such a navigation is undone. Other fragments (#transfer) only scroll.
  window.addEventListener('hashchange', event => {
    if (!busy) handleRoute();
    else if (!location.hash || location.hash.startsWith('#manage/')) {
      history.replaceState(null, '', event.oldURL);
      toast(t('home.uploadRunning'));
    }
  });
  setInterval(() => {
    let changed = false;
    transfers.forEach(record => { const before = record.state; isAvailable(record); if (before !== record.state) changed = true; });
    document.querySelectorAll('[data-countdown]').forEach(element => { const record = transfers.get(element.dataset.countdown); if (record) element.textContent = leftLabel(record.expiresAt - Date.now()); });
    paintLines(); paintLife();
    if ((!$('pending-upload').hidden || goState.resume) && !pendingUpload()) showPending(); // the upload window has closed
    if (changed) {
      const record = transfers.get(activeId);
      if (record && record.state !== 'ready' && currentView === 'receipt') renderGone(record);
      renderHistory();
    }
  }, 5000);
  // Warn before closing the tab while an upload is running, and before an encrypted link's key was copied or shared:
  // this tab holds its only copy.
  window.addEventListener('beforeunload', event => { if (busy || (currentView === 'receipt' && shown?.includes('#') && !keyCopied)) { event.preventDefault(); event.returnValue = ''; } });
  // One thumb on phones: the docked Upload button steps aside while the on-screen keyboard is open.
  if (window.visualViewport) { const keyboard = () => document.documentElement.classList.toggle('kb-open', visualViewport.height < innerHeight * .75); visualViewport.addEventListener('resize', keyboard); keyboard(); }
  updateOptions(); paintSeg(true);
  $('discard-pending').addEventListener('click', async () => {
    const pending = await idlePending();
    if (pending) await discardIdle(pending);
    showPending(); error('');
  });
  // "Remember keys on this device", under an encrypted link: every key, in local storage, until it is unticked.
  $('remember-keys').addEventListener('change', () => {
    rememberKeys($('remember-keys').checked);
    toast(t($('remember-keys').checked ? 'home.keysSaved' : 'home.keysTab'), {done: true});
  });
  // The receipt's "Remember the password on this device".
  document.addEventListener('change', event => {
    const record = transfers.get(activeId);
    if (event.target.id !== 'remember-password' || !record?.password) return;
    keepPassword(record.id, record.password, event.target.checked);
    toast(t(event.target.checked ? 'home.passwordSaved' : 'home.passwordTab'), {done: true});
  });
  // Another tab started, finished or discarded an upload, or changed the recent uploads.
  window.addEventListener('storage', event => {
    if (event.key === PENDING || event.key === null) showPending();
    if (event.key !== STORE && event.key !== null) return;
    syncRecent(); renderHistory();
    const record = transfers.get(activeId);
    if (currentView === 'receipt' && !isAvailable(record)) renderGone(record);
  });
  loadRecent();
  handleRoute(false);
})();

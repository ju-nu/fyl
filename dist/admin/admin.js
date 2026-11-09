// The private dashboard on the admin host (admin.fyl.at, behind Cloudflare Access). It reads /api/stats (aggregates the
// Worker queries from Analytics Engine), /api/billing (its estimate of the open Cloudflare bill), /api/admin/ready and
// /api/admin/reports with the owner's Access sign-in, each on its own so one failing leaves the others: it holds no
// token and changes nothing. Charts are SVG drawn here, each with a table; every value from the server goes
// into the page as text, never as markup (referrers and campaign tags come from visitors).
(() => {
  'use strict';
  const KB = 1024, NS = 'http://www.w3.org/2000/svg';
  const number = new Intl.NumberFormat('en');
  const count = value => number.format(Math.round(Number(value) || 0));
  // Sizes as the site writes them: binary units with the familiar labels (1 GB = 1024³ bytes).
  const size = bytes => {
    const value = Number(bytes) || 0;
    for (const [unit, factor] of [['TB', KB ** 4], ['GB', KB ** 3], ['MB', KB ** 2], ['KB', KB]])
      if (value >= factor) return (value / factor).toFixed(value / factor >= 100 ? 0 : 1).replace(/\.0$/, '') + ' ' + unit;
    const whole = Math.round(value);
    return count(whole) + (whole === 1 ? ' byte' : ' bytes');
  };
  // The axis of a chart: 0 up to a round maximum at or above `max` in about four steps of 1, 2 or 5 times a power of
  // ten (of a binary unit for bytes). Counts step by whole numbers; an empty chart still gets an axis.
  const ticks = (max, bytes = false) => {
    if (bytes && !(max > 0)) return [0, KB];
    const unit = bytes ? [KB ** 4, KB ** 3, KB ** 2, KB, 1].find(factor => max >= factor) || 1 : 1;
    const rough = Math.max(max, bytes ? unit : 1) / unit / 4, power = 10 ** Math.floor(Math.log10(rough)), fraction = rough / power;
    const step = Math.max(bytes ? 1 / unit : 1, (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power) * unit;
    const top = Math.max(step, Math.ceil(max / step) * step), list = [];
    for (let value = 0; value <= top + step / 2; value += step) list.push(Math.round(value * 1000) / 1000);
    return list;
  };
  // A bucket's name in Vienna time (src/stats.ts TIME_ZONE): a day ("Fri 30 Oct", already a Vienna date) or an hour,
  // which the server keys in UTC ("Sat 22:00", short "22:00"; around the autumn DST change 02:00 comes twice).
  const ZONE = 'Europe/Vienna';
  const label = (bucket, hourly = false, short = false) => {
    const date = new Date(hourly ? bucket + ':00:00Z' : bucket + 'T00:00:00Z');
    if (Number.isNaN(date.getTime())) return String(bucket);
    if (hourly) return date.toLocaleString('en-GB', {...(short ? {} : {weekday: 'short'}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: ZONE}).replace(',', '');
    return date.toLocaleDateString('en-GB', short ? {day: 'numeric', month: 'short', timeZone: 'UTC'} : {weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'});
  };
  // An age in seconds as the operator scripts write it.
  const age = seconds => {
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    const minutes = Math.floor(seconds / 60), hours = Math.floor(seconds / 3600);
    return hours < 1 ? minutes + ' min' : hours < 48 ? hours + ' h ' + (minutes % 60) + ' min' : Math.floor(hours / 24) + ' d ' + (hours % 24) + ' h';
  };
  const ACTIONS = ['quarantine', 'restore', 'remove', 'reject', 'note'];
  // The decision a case's command starts with: quarantine while the file can still be downloaded, else reject.
  const defaultAction = item => item && item.fileAvailable === false ? 'reject' : 'quarantine';
  // The operator command for a case; only a real case id gets one. The reason after --note is the operator's to write.
  const command = (id, action) => /^R-[0-9A-HJKMNP-TV-Z]{10}$/.test(String(id)) && ACTIONS.includes(action)
    ? 'npm run admin -- decide ' + id + ' ' + action + ' --note "…"' : '';
  // "Storage in use" from readiness: the bytes the Budget holds and their share of MAX_STORED_BYTES, or null. The local
  // dashboard's readiness marks its made-up figure `sample` (src/index.ts readiness()), and the note says so.
  const storage = capacity => {
    const bytes = capacity?.storedBytes, max = capacity?.maxStoredBytes;
    if (!Number.isFinite(bytes) || !Number.isFinite(max) || bytes < 0 || max <= 0) return null;
    return [size(bytes), (bytes > 0 && bytes * 100 < max ? '<1' : Math.floor(bytes * 100 / max)) + ' % of ' + size(max) + (capacity.sample === true ? ' · sample' : ' · now')];
  };
  // Dollars as the bill writes them; a meter's cost may need a third decimal (R2 storage costs $0.015 a GB-month).
  const dollars = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 3});
  const cents = new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2});
  const money = (value, exact = false) => (exact ? dollars : cents).format(exact ? Number(value) || 0 : Math.round((Number(value) || 0) * 100 + 1e-6) / 100);
  // The line under the total: the base and what the meters above their allowances add, in cents like the total above it
  // and the invoice (only a single meter's own row keeps the third decimal). Half a cent or less would read "$0.00".
  const charges = (base, above) => money(base) + ' Workers Paid base' + (above > 0
    ? ' + ' + (above < 0.005 ? 'less than $0.01' : money(above)) + ' above the allowances.' : ', everything else within the allowances so far.');
  // A meter's amount: whole counts with separators, large ones short for the eye (10M, 25B), fractions to two digits
  // (0.98 GB-month). `full` never shortens: a screen reader reads "10M" as letters (or as metres).
  const compact = new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1});
  const full = value => {
    const number = Math.max(0, Number(value) || 0);
    return number >= 100 || Number.isInteger(number) ? count(number) : String(Number(number.toFixed(number >= 10 ? 1 : 2)));
  };
  const amount = value => Math.max(0, Number(value) || 0) >= 100000 ? compact.format(Number(value)) : full(value);
  // "used / included unit", and what it costs where the usage went above the allowance; `spoken` is the same for a
  // screen reader, in full figures and words ("8,232 requests used of 10,000,000 included").
  const SUFFIX = {ms: ' ms', 'GB-month': ' GB-month', 'GB-s': ' GB-s'};
  const WORDS = {ms: 'milliseconds', 'GB-month': 'gigabyte-months', 'GB-s': 'gigabyte-seconds'};
  const usage = meter => amount(meter.used) + ' / ' + amount(meter.included) + (SUFFIX[meter.unit] || '') + (meter.cost > 0 ? ' · ' + money(meter.cost, true) : '');
  const spoken = meter => full(meter.used) + ' ' + (WORDS[meter.unit] || String(meter.unit)) + ' used of ' + full(meter.included) + ' included'
    + (meter.cost > 0 ? ', ' + money(meter.cost, true) + ' above the allowance' : '');
  // fyl's Worker over the last 24 hours, from the estimate's answer: "2 errors in 61,000 requests (exceptions 2 · client
  // went away 37)", or '' when the answer has none (a token or dataset that doesn't give it: nothing rather than a guess).
  const OUTCOMES_24H = {scriptThrewException: 'exceptions', exceededResources: 'limits exceeded', internalError: 'internal errors', clientDisconnected: 'client went away',
    responseStreamDisconnected: 'stream cut'};
  const workerErrors = value => {
    if (!value || !Number.isFinite(value.requests) || !Number.isFinite(value.errors)) return '';
    const outcomes = (Array.isArray(value.statuses) ? value.statuses : []).filter(entry => typeof entry?.name === 'string' && entry.n > 0)
      .map(entry => (OUTCOMES_24H[entry.name] || entry.name) + ' ' + count(entry.n));
    return count(value.errors) + (value.errors === 1 ? ' error' : ' errors') + ' in ' + count(value.requests) + ' requests' + (outcomes.length ? ' (' + outcomes.join(' · ') + ')' : '');
  };
  // The cycle's first and last day, as the charts write days ("28 Oct – 27 Nov").
  const period = cycle => label(cycle.start, false, true) + ' – ' + label(cycle.end, false, true);
  // The shares of `values` in `whole`, in whole percent that add up like the values do (largest remainder: the rounded
  // total, the leftover points to the largest fractions), as text: "<1" for a little more than none, ">99" for nearly all.
  const shares = (values, whole) => {
    const exact = values.map(value => whole > 0 ? value / whole * 100 : 0), result = exact.map(Math.floor);
    let left = Math.round(exact.reduce((sum, value) => sum + value, 0)) - result.reduce((sum, value) => sum + value, 0);
    for (const index of [...exact.keys()].sort((a, b) => (exact[b] - result[b]) - (exact[a] - result[a]) || a - b)) {
      if (left <= 0) break;
      result[index]++; left--;
    }
    return result.map((value, index) => values[index] > 0 && value < 1 ? '<1' : value >= 100 && values[index] < whole ? '>99' : String(value));
  };
  // A share in whole percent, "<1 %" for a little more than none.
  const percent = (part, whole) => (part > 0 && part * 100 < whole ? '<1' : Math.round(part / whole * 100)) + ' %';
  // What a query cut at its limit means for the page, named per query (an older body's `true` says lists only).
  const CUTS = {events: 'the totals and events may be low', series: 'the charts and the page-view total may be low', sizes: 'upload sizes may be incomplete',
    median: 'the median upload may be off', lifetimes: 'lifetimes may be incomplete'};
  const cutNotice = truncated => {
    const names = Array.isArray(truncated) ? truncated : truncated ? ['lists'] : [];
    const parts = [...new Set(names.map(name => CUTS[name] || 'some lists were cut'))];
    return parts.length ? 'Analytics Engine hit the query limit: ' + parts.join('; ') + '.' : '';
  };
  // Page views that are not a browser's, by kind: their sum and [short name, count] pairs, largest first.
  const ROBOTS = {curl: 'curl', wget: 'wget', cli: 'fyl CLI', bot: 'bots', script: 'scripts', other: 'other'};
  const automated = totals => {
    const parts = Object.entries(totals?.automatedViews && typeof totals.automatedViews === 'object' ? totals.automatedViews : {})
      .map(([name, n]) => [ROBOTS[name] || name, Number(n) || 0]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    return {n: parts.reduce((total, [, n]) => total + n, 0), parts};
  };
  // The tiles of the range, [value, note] each, from a statistics answer. Nested reads are guarded: a body of an older
  // shape (a location's cache right after a deploy) or a partial one draws dashes and zeros, never an exception.
  const DAYS = {'1d': '24 hours', '7d': '7 days', '30d': '30 days', '90d': '90 days'};
  // "since 31 Oct" where the range starts before a kind (pageViews, uploads, downloads, transfers) was counted, else ''.
  const since = (stats, kind) => {
    const first = stats?.firstSeen?.[kind], start = stats?.series?.[0]?.t, hourly = stats?.bucket === 'hour';
    return typeof first === 'string' && start && first > start ? 'since ' + label(first, hourly, !hourly) : '';
  };
  // "web 62 %" and "CLI 30 %" of the uploads with a recorded kind of client, or [] without any.
  const channels = stats => {
    const whole = Number(stats?.totals?.uploadsWithClient) || 0, list = Array.isArray(stats?.uploadsByClient) ? stats.uploadsByClient : [];
    const of = name => list.find(entry => entry.name === name)?.n || 0;
    return whole ? [['web', of('browser')], ['CLI', of('cli')]].filter(([, n]) => n > 0).map(([name, n]) => name + ' ' + percent(n, whole)) : [];
  };
  // The funnel from a visit to a download, [label, value, note] per step, over the buckets since both page views and
  // uploads by kind of client are counted (firstSeen.pageViews, firstSeen.clients) when the range starts before.
  const funnelFrom = stats => [stats?.firstSeen?.pageViews, stats?.firstSeen?.clients].filter(key => typeof key === 'string').sort().pop() || null;
  const funnelSteps = stats => {
    const from = funnelFrom(stats), points = (Array.isArray(stats?.series) ? stats.series : []).filter(point => !from || point?.t >= from);
    const sum = key => points.reduce((total, point) => total + (Number(point?.[key]) || 0), 0);
    const home = sum('homeViews'), started = sum('webStarted'), completed = sum('webUploads'), uploads = sum('uploads'), downloads = sum('downloads');
    const recipients = Number(stats?.ownReferrers?.download) || 0, downloadPages = (Array.isArray(stats?.pages) ? stats.pages : []).find(entry => entry.name === 'download')?.n || 0;
    const rate = (part, whole, what) => whole > 0 ? percent(part, whole) + ' of ' + what : '';
    return [
      ['Home page views', home, 'browsers'],
      ['Web uploads started', started, rate(started, home, 'home page views')],
      ['Web uploads completed', completed, rate(completed, started, 'started')],
      ['Downloads', downloads, (uploads ? full(Math.round(downloads / uploads * 10) / 10) + ' per completed upload' : 'started') + ', any client'],
      // The loop back: recipients who went from a download page to fyl.at's own pages (counted with the kinds of them).
      ['Recipients who opened the site', recipients, from ? 'from a download page' : rate(recipients, downloadPages, 'download-page views') || 'from a download page'],
    ];
  };
  const tiles = (stats, range) => {
    const totals = stats?.totals, days = DAYS[range] || 'this range', span = kind => since(stats, kind) || 'in ' + days;
    if (!totals) return {pageViews: ['–', ''], uploads: ['–', ''], uploadBytes: ['–', ''], downloads: ['–', '']};
    const views = Number(totals.pageViews) || 0, uploads = Number(totals.uploads) || 0, robots = automated(totals);
    const joined = (...parts) => parts.filter(Boolean).join(' · ');
    return {
      // Browser page views; automated traffic beside them, largest kind first ("+358 automated (other 168 · curl 147 · bots 43)"),
      // after "since …" when the range starts before page views were counted.
      pageViews: [count(views), robots.n ? joined(since(stats, 'pageViews'), '+' + count(robots.n) + ' automated (' + robots.parts.map(([name, n]) => name + ' ' + count(n)).join(' · ') + ')') : span('pageViews')],
      // The median, not the average: a few huge files would make the average a size almost nobody uploads. Then the
      // web's and the CLI's share of the uploads whose kind of client was recorded (the options have a card of their own).
      uploads: [count(uploads), uploads ? joined(Number.isFinite(totals.medianUploadBytes) ? 'median ' + size(totals.medianUploadBytes) : '', ...channels(stats))
        || span('uploads') : span('uploads')],
      uploadBytes: [size(totals.uploadBytes), span('uploads')],
      downloads: [count(totals.downloads), joined(since(stats, 'downloads'), count(totals.oneTimeDownloads) + ' of one-time links · ' + count(totals.oneTimeSessions) + (totals.oneTimeSessions === 1 ? ' session' : ' sessions'))],
    };
  };
  // A lifetime in seconds as the upload page offers it ("5 min", "1 h", "3 days").
  const duration = seconds => seconds < 3600 ? Math.round(seconds / 60) + ' min' : seconds < 86400 ? Math.round(seconds / 3600) + ' h'
    : Math.round(seconds / 86400) + (Math.round(seconds / 86400) === 1 ? ' day' : ' days');
  const ms = value => Number.isFinite(value) ? count(value) + ' ms' : '–';
  // The Events panel's groups, [title, [[name, value], …], what a non-zero value means, shown] each, guarded like
  // tiles(). A group with nothing to count in the range is left out and only named in one line below the others.
  const eventGroups = stats => {
    const pairs = list => (Array.isArray(list) ? list : []).map(entry => [entry.name || '(none)', entry.n]);
    const any = rows => rows.some(([, value]) => typeof value === 'number' && value > 0);
    const totals = stats?.totals || {}, passwords = stats?.passwords || {}, moderation = stats?.moderation || {}, previews = stats?.previewServed || {};
    const health = stats?.health || {}, speed = stats?.performance || {};
    const groups = [
      ['Performance', [['R2 completion, average', ms(speed.completionAvgMs)], ['R2 completion, slowest', ms(speed.completionMaxMs)],
        ['cleanup after due, longest', Number.isFinite(speed.cleanupLagMaxS) ? age(speed.cleanupLagMaxS) : '–'],
        ['part writes failed', Number.isFinite(speed.partFailedPct) ? speed.partFailedPct + ' %' : '–']],
      'How long R2 took to complete an upload, how late cleanup ran, and the share of part writes that failed.',
      [speed.completionAvgMs, speed.cleanupLagMaxS, speed.partFailedPct].some(Number.isFinite)],
      ['Passwords', [['right (per request)', passwords.ok ?? 0], ['wrong', passwords.wrong ?? 0], ['pauses', passwords.paused ?? 0]]],
      ['Reports filed', pairs(stats?.reportsByCategory)],
      ['Moderation', [['quarantined', moderation.quarantine ?? 0], ['restored', moderation.restore ?? 0], ['taken down', moderation.takedown ?? 0]]],
      ['Part uploads', [['failed', health.partFailed?.n ?? 0], ['failed data', size(health.partFailed?.bytes)], ['cut off by the sender', health.partDisconnected?.n ?? 0], ...pairs(health.partRefused).map(([name, n]) => ['refused: ' + name, n]),
        ['at the retry limit', health.partLimit ?? 0], ['all slots busy', health.partBusy ?? 0]],
      'Clients retry a failed or refused part, so a few are normal; a steady share points at R2 or the Budget. Parts cut off by the sender (Cancel upload, a closed tab) are no fault.'],
      ['Budget refusals', pairs(stats?.budgetRefused), 'Uploads or parts the Budget turned away: a cap or a per-network limit was reached.'],
      ['Rate limited', pairs(stats?.rateLimited)],
      ['Link previews', [['served', previews.n ?? 0], ['data', size(previews.bytes)]]],
      ['Turnstile refusals', pairs(stats?.turnstileFailed)],
      ['Cleanup', [...pairs(stats?.cleanupRetry).map(([name, n]) => ['retried: ' + name, n]), ['orphans deleted', health.cleanupOrphan ?? 0]],
        'Cleanup steps retry themselves; a count that keeps growing needs a look.'],
      ['Fallbacks', pairs(health.fallback), 'A best-effort step failed and a slower path took over; repeated ones point at a bug.'],
      ['Budget drift', pairs(health.budgetDrift), 'Reconciliation found an aggregate off and fixed it; repeated drift points at a counting bug.'],
      ['Downloads', [['interrupted one-time', health.oneTimeInterrupted ?? 0], ['opened before the upload finished', health.earlyWait ?? 0]],
        'An interrupted one-time download stays open for a resume; early opens wait for the upload.'],
      ["fyl's own checks", [['uploads', totals.ownUploads ?? 0], ['downloads', totals.ownDownloads ?? 0]],
        'The smoke test and checks marked fyl-smoke or fyl-ops: left out of every figure above.'],
      ['Access refused by the Worker', pairs(stats?.accessDenied), 'Requests to the admin host whose Access token the Worker refused.'],
      ['Misconfigured answers', [['503 misconfigured', stats?.misconfigured ?? 0]], 'A Worker secret or setting is missing or rejected: check readiness.'],
    ];
    return groups.map(([title, rows, note = '', shown = any(rows)]) => [title, rows, note, shown]);
  };
  // Readiness as npm run admin -- ready prints it, [text, bad] per line: the checks, whether uploads are taken (a pause
  // shows in the danger colour), E2EE, the report queue, capacity, cleanups and what needs attention.
  const PRIORITY_NAMES = {1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4'};
  const readyLines = body => {
    const lines = [['Ready:     ' + (body.ready ? 'yes' : 'NO'), !body.ready]];
    for (const [name, value] of Object.entries(body.checks || {})) {
      const shown = value && typeof value === 'object' ? Object.entries(value).map(([item, good]) => item + ' ' + (good === true ? 'ok' : 'MISSING')).join(', ') : value === true ? 'ok' : 'FAILED';
      lines.push(['  ' + name.padEnd(9) + ' ' + shown, /MISSING|FAILED/.test(shown)]);
    }
    if (typeof body.paused === 'boolean') lines.push(['Uploads:   ' + (body.paused ? 'PAUSED (npm run admin -- resume)' : 'accepted'), body.paused]);
    if (body.e2ee === 'on' || body.e2ee === 'off') lines.push(['E2EE:      ' + body.e2ee, false]);
    if (typeof body.turnstile === 'string') lines.push(['Turnstile: ' + body.turnstile, body.turnstile === 'incomplete']);
    if (typeof body.openReports === 'number') {
      const oldest = age(body.oldestOpenReportAge), urgent = PRIORITY_NAMES[body.highestOpenPriority];
      lines.push(['Reports:   ' + [body.openReports + ' open', ...(body.openReports && oldest ? ['oldest ' + oldest] : []),
        ...(body.openReports && urgent ? ['most urgent ' + urgent] : [])].join(' · '), body.openReports > 0]);
    }
    // No-break spaces keep "stored 8 % (sample)" and "today 0 %" whole where a phone wraps the line.
    const capacity = body.capacity || {}, percent = value => typeof value === 'number' ? value + '\u00a0%' : '-';
    lines.push(['Capacity:  stored ' + percent(capacity.storedPercent) + (capacity.sample === true ? '\u00a0(sample)' : '') + ' · today\u00a0' + percent(capacity.dailyPercent), false]);
    lines.push(['Cleanups:  ' + (typeof body.backlog?.overdueCleanups === 'number' ? body.backlog.overdueCleanups + ' overdue' : 'unknown'), Boolean(body.backlog?.overdueCleanups)]);
    const reasons = Array.isArray(body.reasons) ? body.reasons.filter(reason => typeof reason === 'string') : [];
    lines.push(['Attention: ' + (reasons.join(', ') || 'no'), reasons.length > 0]);
    return lines;
  };
  // The status strip at the top, [text, bad] per part, from readiness, the last 24 hours' statistics and the estimate's
  // Worker errors, each of which may be missing. `where` is the panel that explains a bad part: readiness and the open
  // reports (#ops) for a check, a pause, open reports or overdue cleanups, the events (#events-heading) for counters.
  const PROBLEMS = [['part writes failed', day => day.health?.partFailed?.n], ['parts at the retry limit', day => day.health?.partLimit],
    ['fallbacks', day => day.health?.fallback], ['budget drift', day => day.health?.budgetDrift], ['orphans deleted', day => day.health?.cleanupOrphan],
    ['cleanup retries', day => day.cleanupRetry], ['misconfigured answers', day => day.misconfigured]];
  const statusParts = (body, day, bill) => {
    const parts = [], total = value => Array.isArray(value) ? value.reduce((sum, entry) => sum + (Number(entry?.n) || 0), 0) : Number(value) || 0;
    let where = '#ops';
    if (!body) parts.push(['Readiness unknown', true]);
    else {
      parts.push(body.ready ? ['Ready', false] : ['NOT READY', true]);
      if (typeof body.paused === 'boolean') parts.push(body.paused ? ['Uploads PAUSED', true] : ['Uploads accepted', false]);
      if (body.e2ee === 'on' || body.e2ee === 'off') parts.push(['E2EE ' + body.e2ee, false]);
      if (typeof body.openReports === 'number') {
        const urgent = body.openReports && PRIORITY_NAMES[body.highestOpenPriority] ? ' (most urgent ' + PRIORITY_NAMES[body.highestOpenPriority] + ')' : '';
        parts.push([count(body.openReports) + (body.openReports === 1 ? ' open report' : ' open reports') + urgent, body.openReports > 0]);
      }
      if (typeof body.backlog?.overdueCleanups === 'number') parts.push([count(body.backlog.overdueCleanups) + ' overdue cleanups', body.backlog.overdueCleanups > 0]);
    }
    const counted = day ? PROBLEMS.map(([name, read]) => [name, total(read(day))]) : [];
    if (bill?.workerErrors && Number.isFinite(bill.workerErrors.errors)) counted.push(['Worker errors', bill.workerErrors.errors]);
    const problems = counted.filter(([, n]) => n > 0), sum = problems.reduce((all, [, n]) => all + n, 0);
    if (counted.length) parts.push(sum ? [count(sum) + (sum === 1 ? ' problem' : ' problems') + ' in 24 h (' + problems.map(([name, n]) => name + ' ' + count(n)).join(' · ') + ')', true]
      : ['No problems in 24 h', false]);
    // The live deploy: its tag (v2.4.1) and when it was uploaded, in Vienna time.
    const version = body?.version, time = version?.deployedAt ? Date.parse(version.deployedAt) : Number.NaN;
    const when = Number.isFinite(time) ? new Date(time).toLocaleString('en-GB', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: ZONE}).replace(',', '') : '';
    if (version?.tag || when) parts.push([version.tag ? 'Live ' + version.tag + (when ? ', deployed ' + when : '') : 'Deployed ' + when, false]);
    // Counters alone point at the events; anything of readiness at readiness.
    const readiness = !body?.ready || body.paused === true || body.openReports > 0 || body.backlog?.overdueCleanups > 0;
    if (!readiness && sum) where = '#events-heading';
    return {parts, urgent: parts.some(([, bad]) => bad), readiness, where};
  };
  globalThis.FylAdmin = {statusParts, readyLines, shares, cutNotice, duration, count, size, ticks, label, age, command, defaultAction, storage, money, charges, amount, usage, spoken, period, since, tiles, eventGroups, automated,
    funnelSteps, channels, workerErrors};
  if (typeof document === 'undefined') return; // tests load the helpers above without a page

  const $ = id => document.getElementById(id);
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svg = (tag, attributes) => {
    const node = document.createElementNS(NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
  };
  const main = $('content'), notice = $('notice'), status = $('status');
  const RANGES = ['1d', '7d', '30d', '90d'];
  let range = RANGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : '7d', stats = null, ready = null, day = null, billBody = null, readyLoaded = false;
  const billingTime = time => new Date(time).toISOString().slice(11, 16) + ' UTC';

  // One GET to the Worker: its status and JSON object. A redirect means Access wants a new sign-in (the session ended).
  async function get(path) {
    let response;
    try { response = await fetch(path, {headers: {Accept: 'application/json'}, credentials: 'same-origin', redirect: 'manual', cache: 'no-store'}); }
    catch { return {status: 0, body: null}; }
    if (response.type === 'opaqueredirect') return {status: 'signin', body: null};
    let body = null;
    try { body = await response.json(); } catch {}
    return {status: response.status, body: body && typeof body === 'object' && !Array.isArray(body) ? body : null};
  }
  function problem(answer, what) {
    const code = answer.body?.code;
    // Access itself answers a request it no longer vouches for with a redirect or its own (non-JSON) 401 or 403.
    if (answer.status === 'signin' || code === 'access_denied' || ((answer.status === 401 || answer.status === 403) && !answer.body))
      return 'Your Cloudflare Access session ended. Reload the page to sign in again.';
    if (answer.status === 0) return 'Could not reach the Worker for ' + what + '. Check the connection and press Refresh.';
    if (code === 'stats_unconfigured') return 'Statistics are not set up yet: the Worker needs the secret CF_ANALYTICS_TOKEN, a read-only API token with Account Analytics Read (docs/OPERATIONS.md#admin-host-and-statistics). Readiness and reports below work without it.';
    if (code === 'stats_unavailable') return 'Analytics Engine did not answer. Press Refresh in a minute.';
    // The secret or BILLING_CYCLE_DAY is missing, or Cloudflare refused the token: the Worker's message says which.
    if (code === 'billing_unconfigured' || code === 'billing_refused') return (typeof answer.body.error === 'string' ? answer.body.error : 'The billing estimate is not set up.') + ' The rest of the dashboard works without it.';
    if (code === 'billing_unavailable') return "Cloudflare's analytics did not answer for the billing estimate. Press Refresh in a few minutes; the statistics don't depend on it.";
    if (code === 'denied' || answer.status === 401) return 'This Access identity is not the owner (ADMIN_EMAILS), so the Worker shows it no ' + what + '.';
    if (code === 'rate_limited') return 'Too many requests for ' + what + '. Wait a minute, then press Refresh.';
    return what[0].toUpperCase() + what.slice(1) + ' answered HTTP ' + answer.status + (answer.body && typeof answer.body.error === 'string' ? ': ' + answer.body.error : '.');
  }
  const say = text => { notice.hidden = !text; notice.querySelector('span').textContent = text || ''; };

  // ---------- Charts: one series each, bars from a single baseline, a hover readout, a table for every value ----------
  // The kind of each chart, as firstSeen names when its counting began.
  const CHART_KINDS = {pageViews: 'pageViews', uploads: 'uploads', uploadBytes: 'uploads', downloads: 'downloads'};
  function chart(figure) {
    const key = figure.dataset.chart, bytes = 'bytes' in figure.dataset, plot = figure.querySelector('.plot'), readout = figure.querySelector('.readout');
    const title = figure.querySelector('h2').textContent, unit = figure.dataset.unit;
    const points = stats ? stats.series : [], hourly = stats && stats.bucket === 'hour';
    figure.querySelector('[data-per]').textContent = hourly ? 'per hour, last 24 hours (Vienna time)' : 'per day (Vienna time)';
    // Buckets before their kind was counted are not counted yet (a band, not zeros); the last one is still running.
    const first = stats?.firstSeen?.[CHART_KINDS[key]], before = index => typeof first === 'string' && points[index].t < first;
    const partial = index => points[index].t === stats?.partial;
    const values = points.map(point => Number(point[key]) || 0), max = Math.max(0, ...values), axis = ticks(max, bytes), top = axis[axis.length - 1];
    const format = bytes ? size : count, total = values.reduce((sum, value) => sum + value, 0);
    const width = Math.max(260, Math.floor(plot.clientWidth)), height = 184, left = bytes ? 62 : 46, right = 6, above = 10, below = 26;
    const base = height - below, span = base - above, slot = (width - left - right) / Math.max(1, points.length);
    const bar = Math.max(1, Math.min(24, slot - 2));
    const peak = values.findIndex((value, index) => value === max && !before(index));
    const name = index => label(points[index].t, hourly) + (partial(index) ? ' so far' : '');
    const summary = points.length ? (bytes ? size(total) : count(total)) + ' ' + unit + ' in total' + (max > 0 ? ', most on ' + name(peak) + ' (' + format(max) + ')' : '') : 'no data';
    const root = svg('svg', {viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': title + ': ' + summary});
    for (const value of axis) {
      const y = base - (top ? value / top : 0) * span;
      root.append(svg('line', {class: 'grid', x1: left, x2: width - right, y1: y, y2: y}));
      const text = svg('text', {class: 'axis', x: left - 8, y: y + 4, 'text-anchor': 'end'});
      text.textContent = value === 0 ? '0' : bytes ? size(value) : count(value);
      root.append(text);
    }
    // The not-counted buckets share one band, named when it is wide enough.
    const gap = points.findIndex((_, index) => !before(index));
    if (gap > 0) {
      root.append(svg('rect', {class: 'band', x: left, y: above, width: gap * slot, height: span}));
      if (gap * slot >= 96) {
        const note = svg('text', {class: 'axis', x: left + gap * slot / 2, y: above + span / 2 + 4, 'text-anchor': 'middle'});
        note.textContent = 'not counted yet';
        root.append(note);
      }
    }
    const bars = points.map((_, index) => {
      const value = values[index], h = top ? Math.max(value > 0 ? 1 : 0, value / top * span) : 0, x = left + index * slot + (slot - bar) / 2, y = base - h, r = Math.min(4, bar / 2, h);
      const path = svg('path', {class: partial(index) ? 'col part' : 'col', d: h ? `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + bar - r}Q${x + bar},${y} ${x + bar},${y + r}V${base}Z` : ''});
      root.append(path);
      return path;
    });
    // Three dates under the axis (first, middle, last), anchored so none runs over the edge.
    const marks = points.length > 2 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : points.map((_, index) => index);
    for (const index of marks) {
      const anchor = index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle';
      const x = anchor === 'start' ? left : anchor === 'end' ? width - right : left + (index + 0.5) * slot;
      const text = svg('text', {class: 'axis', x, y: height - 6, 'text-anchor': anchor});
      text.textContent = label(points[index].t, hourly, true);
      root.append(text);
    }
    const rest = summary[0].toUpperCase() + summary.slice(1) + '.';
    readout.textContent = rest;
    // Hovering anywhere over a day's column shows its value; the hit area is the whole column, not just the bar.
    const show = event => {
      // The SVG scales down with its panel: map the pointer back into the drawing's own units.
      const box = root.getBoundingClientRect(), scale = box.width ? width / box.width : 1, index = Math.floor(((event.clientX - box.left) * scale - left) / slot);
      bars.forEach((path, at) => path.classList.toggle('on', at === index));
      readout.textContent = index >= 0 && index < points.length ? name(index) + ': ' + (before(index) ? 'not counted yet' : format(values[index]) + ' ' + unit) : rest;
      root.classList.toggle('hovering', index >= 0 && index < points.length);
    };
    root.addEventListener('pointermove', show);
    root.addEventListener('pointerdown', show); // a tap shows the value too
    // A finger lifting fires pointerleave too: a tapped value stays until the next tap (outside the bars: the total).
    root.addEventListener('pointerleave', event => {
      if (event.pointerType !== 'mouse') return;
      bars.forEach(path => path.classList.remove('on')); root.classList.remove('hovering'); readout.textContent = rest;
    });
    plot.replaceChildren(root);
    // The same values as a table.
    const table = element('table'), head = element('tr'), body = element('tbody');
    // The page-view table also lists the automated views the chart leaves out.
    const robots = key === 'pageViews';
    head.append(element('th', '', hourly ? 'Hour (Vienna)' : 'Day (Vienna)'), element('th', 'n', title));
    if (robots) head.append(element('th', 'n', 'Automated'));
    for (const th of head.children) th.scope = 'col';
    points.forEach((point, index) => {
      const row = element('tr'), th = element('th', '', name(index));
      th.scope = 'row';
      row.append(th, element('td', 'n num', before(index) ? '–' : format(values[index])));
      if (robots) row.append(element('td', 'n num', count(point.automatedViews)));
      body.append(row);
    });
    const thead = element('thead');
    thead.append(head);
    table.append(thead, body);
    figure.querySelector('.table-wrap').replaceChildren(table);
  }

  // ---------- Ranked lists: name, count, share and a bar whose length is that share of the whole ----------
  const regions = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], {type: 'region'}) : null;
  const languages = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], {type: 'language'}) : null;
  const named = (display, code) => { try { return display ? display.of(code) || code : code; } catch { return code; } };
  const PAGES = {home: 'Home', report: 'Report form', privacy: 'Privacy', download: 'Download pages', gone: 'Closed links'};
  // `internal` is fyl.at itself in a body from before the kinds of its pages were told apart (src/stats.ts referrerOf()).
  const REFERRERS = {direct: 'Direct or hidden', internal: 'fyl.at itself', ip: 'An IP address', private: 'A private network', other: 'Not a web address'};
  const DEVICES = {desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet'};
  const CLIENTS = {browser: 'Browser', cli: 'fyl CLI', curl: 'curl', wget: 'wget', bot: 'Bot', script: 'Browser-named scripts', other: 'Other tools and scripts',
    own: "fyl's own checks"};
  const OPTIONS = {password: 'Password', once: 'One download', e2ee: 'End-to-end encrypted', none: 'No option'};
  const PLATFORMS = {install: 'Install script', 'linux-x86_64': 'Linux x86-64', 'linux-arm64': 'Linux arm64', 'macos-arm64': 'macOS Apple silicon', 'macos-x86_64': 'macOS Intel'};
  const TIMES = {0: 'Never downloaded', 1: 'Once', '2–5': '2–5 times', '6–20': '6–20 times', '>20': 'More than 20 times'};
  // Why a closed link's page said it closed (gonePage() in src/index.ts).
  const REASONS = {expired: 'Expired', consumed: 'One-time, used', deleted: 'Deleted by the sender', removed: 'Taken down', quarantined: 'Under review',
    unsupported_mode: 'Needs a newer fyl.at', busy: 'Too many requests', missing: 'No such link'};
  const NAMES = {
    pages: name => PAGES[name] || name, referrers: name => REFERRERS[name] || name, uploadOptions: name => OPTIONS[name] || name,
    uploadsByClient: name => name === 'browser' ? 'Web (browser)' : CLIENTS[name] || name,
    downloadsPerTransfer: name => TIMES[name] || name, closedReasons: name => REASONS[name] || name, cliFetches: name => PLATFORMS[name] || name,
    countries: name => name === 'XX' ? 'Unknown' : name === 'T1' ? 'Tor' : named(regions, name) + ' (' + name + ')',
    languages: name => name === 'und' ? 'Not named (*)' : named(languages, name) + ' (' + name + ')',
    devices: name => DEVICES[name] || name, clients: name => CLIENTS[name] || name, downloadsByClient: name => CLIENTS[name] || name,
  };
  // The product mix: how closed transfers ended (with the GB-days R2 held them), lifetimes chosen, upload sizes (with
  // their share of the data).
  const OUTCOMES = {expired: 'Expired', deleted: 'Deleted', consumed: 'One-time, used', aborted: 'Never finished', removed: 'Taken down'};
  const gbDays = () => (Array.isArray(stats?.outcomes) ? stats.outcomes : []).reduce((sum, entry) => sum + (Number(entry.gbDays) || 0), 0);
  const MIX = {
    // The count, its share of the transfers (the bar) and the share of the GB-days (what storage cost).
    outcomes: entry => ({name: OUTCOMES[entry.name] || entry.name, n: entry.n, detail: (gbDays() ? shares([entry.gbDays], gbDays())[0] : '0') + ' % of GB-days'}),
    lifetimes: entry => ({name: duration(entry.seconds), n: entry.n}),
    uploadSizes: entry => ({name: entry.name, n: entry.n, detail: (stats?.totals?.uploadBytes ? shares([entry.bytes], stats.totals.uploadBytes)[0] : '0') + ' % of data'}),
  };
  // The lists counted only since a later release than the rest, by firstSeen kind: their base line adds "since …".
  // (Downloads per transfer has no start to name: its rows are written when a transfer closes, so the transfers closed
  // before the count was recorded end it in a muted row instead.)
  const LIST_KINDS = {outcomes: 'transfers', lifetimes: 'transfers', uploadSizes: 'uploads', downloadsByClient: 'downloads', uploadsByClient: 'clients', uploadOptions: 'clients'};
  // Lists whose entries overlap (an upload can have several options): each share on its own, not adding up to 100.
  const OVERLAP = new Set(['uploadOptions']);
  // The share's base of a list and the line under its title that names it.
  // What a list leaves out of its base, as one muted row at its end, so the rows add up: browsers that didn't say, the
  // visits from fyl.at's own pages (counted apart, in the funnel), and what was written before it was recorded.
  const REMAINDER = {devices: 'Unknown device', languages: 'No language', referrers: "fyl.at's own pages", closedReasons: 'Not recorded (older)',
    downloadsPerTransfer: 'Not recorded (older)'};
  const baseOf = (kind, totals) => {
    if (kind === 'downloadsByClient') return [totals.downloads || 0, 'of ' + count(totals.downloads) + ' downloads'];
    if (kind === 'uploadSizes') return [totals.uploads || 0, 'of ' + count(totals.uploads) + ' uploads completed'];
    // Only uploads whose kind of client, or options, were recorded (since the release after 2.4.0).
    if (kind === 'uploadsByClient') return [totals.uploadsWithClient || 0, 'of ' + count(totals.uploadsWithClient) + ' uploads with a recorded client'];
    if (kind === 'uploadOptions') return [totals.uploadsWithOptions || 0, 'of ' + count(totals.uploadsWithOptions) + ' uploads; options combine'];
    // Download requests that started, a resumed one counting again, of every transfer closed in the range (an older body:
    // those with a count); the median and the most are of the transfers with a count.
    if (kind === 'downloadsPerTransfer') {
      const closed = Number(totals.transfersClosed) || Number(totals.transfersWithDownloads) || 0;
      return [closed, 'of ' + count(closed) + ' closed transfers'
        + (Number.isFinite(totals.medianDownloads) ? ' · median ' + count(totals.medianDownloads) + ' · most ' + count(totals.maxDownloads) : '')];
    }
    if (kind === 'cliFetches') {
      const all = (Array.isArray(stats?.cliFetches) ? stats.cliFetches : []).reduce((sum, entry) => sum + (Number(entry.n) || 0), 0) + (stats?.cut?.cliFetches?.n || 0);
      return [all, count(all) + ' fetches of the installer and the binaries'];
    }
    if (kind === 'closedReasons') {
      const views = (Array.isArray(stats?.pages) ? stats.pages : []).find(entry => entry.name === 'gone')?.n || 0;
      return [views, 'of ' + count(views) + ' closed-link views (browsers)'];
    }
    if (kind === 'outcomes' || kind === 'lifetimes') {
      const all = (Array.isArray(stats?.[kind]) ? stats[kind] : []).reduce((sum, entry) => sum + (Number(entry.n) || 0), 0);
      return kind === 'outcomes' ? [all, count(all) + ' transfers closed in this range · ' + full(gbDays()) + ' GB-days stored']
        : [all, 'of ' + count(all) + ' uploads completed'];
    }
    if (kind === 'clients') {
      const all = (totals.pageViews || 0) + automated(totals).n;
      return [all, 'of ' + count(all) + ' page views, automated ones included'];
    }
    return [totals.pageViews || 0, 'of ' + count(totals.pageViews) + ' browser page views'];
  };
  // Every card shows at most CAP rows, so cards side by side look alike: the first ones, then one muted row for the
  // rest. "Show all" opens the whole list in the same space, scrolling there (admin.css), so no row of cards grows.
  const CAP = 5;
  // The bar is n / scale: the card's base, so it measures the printed share and cards compare (the largest entry only
  // for a list without a base).
  function bar(name, n, share, scale, rest = false, detail = '') {
    const item = element('li', rest ? 'rest' : '');
    // A long count ("300 · 18 % · 2 % of GB-days") may wrap in a narrow card, but only between its parts.
    const parts = [count(n), share === null ? '' : share + ' %', detail].filter(Boolean).map(part => String(part).replace(/ /g, '\u00a0'));
    item.append(element('span', 'bar-name', name), element('span', 'bar-n num', parts.join(' · ')));
    item.querySelector('.bar-name').title = name;
    if (!rest) {
      const track = element('span', 'bar-track'), fill = element('span', 'bar-fill');
      fill.style.setProperty('--v', String(Math.min(1, n / scale)));
      track.append(fill);
      item.append(track);
    }
    return item;
  }
  // Rows [{name, n, rest}] into an ordered list, with shares that add up like the counts do.
  function rows(ol, entries, whole, max, overlap = false) {
    const percents = !whole ? [] : overlap ? entries.map(entry => shares([entry.n], whole)[0]) : shares(entries.map(entry => entry.n), whole);
    entries.forEach((entry, index) => ol.append(bar(entry.name, entry.n, whole ? percents[index] : null, whole || max, entry.rest, entry.detail)));
  }
  function list(panel) {
    const kind = panel.dataset.list, ol = panel.querySelector('.bars');
    let entries = stats ? stats[kind] || [] : [];
    if (!Array.isArray(entries)) entries = [];
    if (kind === 'campaigns') entries = entries.map(entry => ({name: (entry.source || '(no source)') + ' · ' + (entry.campaign || '(no campaign)'), n: entry.n}));
    if (MIX[kind]) entries = entries.map(MIX[kind]);
    const totals = stats?.totals || {}, cut = stats?.cut?.[kind], names = NAMES[kind] || (value => value);
    // One base per card, named under its title: browser page views, all page views for Clients, downloads for theirs.
    const [whole, base] = baseOf(kind, totals);
    // Devices, languages and referrers name what they leave out in a muted row, so the rows add up to the base.
    const listed = entries.reduce((total, entry) => total + entry.n, 0) + (cut?.n || 0), unknown = REMAINDER[kind] && whole > listed ? whole - listed : 0;
    const max = Math.max(1, ...entries.map(entry => entry.n));
    ol.replaceChildren();
    panel.querySelector('.more')?.remove();
    // An empty card keeps its neighbours' size and says so in the middle; one with only what it leaves out shows that
    // row (transfers that all closed before their downloads were counted).
    panel.classList.toggle('is-empty', Boolean(stats) && !entries.length && !unknown);
    const begun = LIST_KINDS[kind] ? since(stats, LIST_KINDS[kind]) : '';
    panel.querySelector('.list-base').textContent = stats && (entries.length || unknown) ? base + (begun ? ' · ' + begun : '') : '';
    if (!entries.length && !unknown) {
      ol.append(element('li', 'empty meta', !stats ? '–' : kind === 'campaigns' ? 'No tagged links (utm_source / utm_campaign) in this range.' : 'Nothing in this range.'));
      return;
    }
    const all = entries.length + (cut?.names || 0), named = entries.map(entry => ({name: names(entry.name || '(none)'), n: entry.n, detail: entry.detail}));
    const extra = unknown ? [{name: REMAINDER[kind], n: unknown, rest: true}] : [];
    const overlap = OVERLAP.has(kind);
    if (all + extra.length <= CAP) { rows(ol, [...named, ...extra], whole, max, overlap); return; }
    // The rest counts the names past TOP the server left out as well; muted rows of what a list leaves out stay in.
    const keep = CAP - 1 - extra.length, rest = entries.slice(keep).reduce((total, entry) => total + entry.n, 0) + (cut?.n || 0);
    rows(ol, [...named.slice(0, keep), {name: count(all - keep) + ' more', n: rest, rest: true}, ...extra], whole, max, overlap);
    const more = element('details', 'more'), full = element('ol', 'bars'), summary = element('summary');
    summary.append(element('span', 'more-open', (cut ? 'Show top ' : 'Show all ') + entries.length), element('span', 'more-close', 'Show less'));
    more.append(summary, full);
    rows(full, [...named, ...(cut ? [{name: count(cut.names) + ' more, not listed', n: cut.n, rest: true}] : []), ...extra], whole, max, overlap);
    panel.append(more);
  }

  // ---------- Events: the operational counts of the range, each group a small table of codes ----------
  function events() {
    const grid = $('events'), quiet = $('events-quiet'), table = $('counters');
    grid.replaceChildren(); table.replaceChildren();
    quiet.textContent = '';
    if (!stats) { grid.append(element('p', 'meta', '–')); return; }
    const groups = eventGroups(stats);
    for (const [title, rows, note] of groups.filter(group => group[3])) {
      const group = element('div', 'event'), dl = element('dl');
      group.append(element('h3', '', title));
      for (const [name, value] of rows) {
        if (typeof value === 'number' && !value && rows.length > 2) continue; // only the counts that happened, in a long group
        const row = element('div');
        row.append(element('dt', '', name), element('dd', 'num', typeof value === 'number' ? count(value) : String(value)));
        dl.append(row);
      }
      group.append(dl);
      if (note) group.append(element('p', 'meta event-note', note));
      grid.append(group);
    }
    const none = groups.filter(group => !group[3]).map(group => group[0]);
    quiet.textContent = none.length ? 'Nothing in this range: ' + none.join(', ') + '.' : '';
    // Every counter as counted, for anything the groups above don't show.
    const head = element('tr');
    for (const [text, className] of [['Event', ''], ['Code', ''], ['Count', 'n'], ['Total (double1)', 'n']]) { const th = element('th', className, text); th.scope = 'col'; head.append(th); }
    const thead = element('thead'), body = element('tbody'), grid2 = element('table');
    thead.append(head);
    for (const counter of Array.isArray(stats.counters) ? stats.counters : []) {
      const row = element('tr');
      row.append(element('td', 'mono', String(counter.event)), element('td', 'mono', String(counter.code || '—')), element('td', 'n num', count(counter.n)),
        element('td', 'n num', full(counter.total)));
      body.append(row);
    }
    grid2.append(thead, body);
    table.append(grid2);
  }

  // ---------- The funnel: from a home page view to a download, and back from a download page ----------
  function funnel() {
    const listing = $('funnel'), note = $('funnel-note'), from = funnelFrom(stats), hourly = stats?.bucket === 'hour';
    listing.replaceChildren();
    for (const [name, value, detail] of funnelSteps(stats)) {
      const step = element('li', 'fstep');
      step.append(element('span', 'fstep-label', name), element('span', 'fstep-value num', stats ? count(value) : '–'), element('span', 'meta', stats ? detail || '\u00a0' : '\u00a0'));
      listing.append(step);
    }
    note.textContent = !stats ? '' : from ? 'Since ' + label(from, hourly, !hourly) + (from === stats.firstSeen?.clients ? ', when uploads began to be counted by kind of client.'
      : ', when page views began to be counted.')
      : 'Web means a browser on fyl.at; each upload counts once when it is admitted and once when it completes.';
  }

  function kpis() {
    const set = (key, value, note) => {
      document.querySelector(`[data-kpi="${key}"]`).textContent = value;
      document.querySelector(`[data-note="${key}"]`).textContent = note || ' ';
    };
    const values = tiles(stats, range);
    for (const key of ['pageViews', 'uploads', 'uploadBytes', 'downloads']) set(key, ...values[key]);
    // Not a total of the range: what the upload budget holds now (readiness), in the tile the open reports had (the owner
    // asked for it there; the reports keep their window below).
    const stored = storage(ready?.capacity);
    set('storedBytes', stored ? stored[0] : '–', stored ? stored[1] : ready ? 'unknown' : '');
  }

  // ---------- This billing cycle: the estimate of the open Cloudflare bill, each meter as used / included ----------
  const PRODUCTS = {Workers: 'Workers', R2: 'R2 Standard', 'Durable Objects': 'Durable Objects'};
  function bill(answer) {
    const body = answer.body, grid = $('bill-meters'), figure = $('bill-total'), periodLine = $('bill-period'), split = $('bill-split');
    grid.replaceChildren();
    const valid = Boolean(answer.status === 200 && body && body.cycle && Array.isArray(body.meters));
    // Without an estimate the panel says why where the figure would be, and keeps the link to the real bill.
    figure.hidden = split.hidden = !valid;
    if (!valid) {
      periodLine.textContent = 'No estimate.';
      grid.append(element('p', 'bill-problem', problem(answer, 'billing estimate')));
      return;
    }
    const cycle = body.cycle;
    periodLine.textContent = period(cycle) + ' (UTC) · day ' + cycle.elapsedDays + ' of ' + cycle.days;
    // The pace is the monitor's: the usage so far at the same daily rate, priced again (src/billing.ts pace()).
    const onPace = Number.isFinite(body.pace) && cycle.elapsedDays < cycle.days ? ' · on pace for ' + money(body.pace) + ' by ' + label(cycle.end, false, true) : '';
    figure.replaceChildren('About ', element('span', 'bill-figure num', money(body.total)), ' so far ', element('span', 'bill-est', '(estimate)' + onPace));
    split.textContent = charges(body.base, body.aboveAllowance)
      + (body.sample ? ' Sample data for local development, made up at ' + billingTime(body.generatedAt) + '.' : ' Read at ' + billingTime(body.generatedAt) + '; the Worker keeps it 15 minutes.');
    if (typeof body.pricesAsOf === 'string') $('bill-prices').textContent = body.pricesAsOf;
    const groups = new Map();
    for (const meter of body.meters) {
      if (!groups.has(meter.product)) groups.set(meter.product, []);
      groups.get(meter.product).push(meter);
    }
    for (const [product, meters] of groups) {
      const group = element('div', 'bill-group'), ol = element('ol', 'bars meters');
      group.append(element('h3', '', PRODUCTS[product] || String(product)));
      for (const meter of meters) {
        const item = element('li', meter.cost > 0 ? 'over' : ''), track = element('span', 'bar-track'), fill = element('span', 'bar-fill');
        // The short figures are for the eye; a screen reader gets them in full instead.
        const shown = element('span', 'bar-n num', usage(meter));
        shown.setAttribute('aria-hidden', 'true');
        item.append(element('span', 'bar-name', String(meter.name)), shown, element('span', 'sr-only', spoken(meter)));
        fill.style.setProperty('--v', String(meter.included > 0 ? Math.min(1, meter.used / meter.included) : 1));
        track.setAttribute('aria-hidden', 'true');
        track.append(fill);
        item.append(track);
        ol.append(item);
      }
      group.append(ol);
      // Not billed: how fyl's own Worker answered over the last 24 hours, where Cloudflare's analytics say.
      const errors = product === 'Workers' ? workerErrors(body.workerErrors) : '';
      if (errors) group.append(element('h3', 'peaks-title', 'fyl-at, last 24 hours'), element('p', 'meta worker-errors' + (body.workerErrors.errors > 0 ? ' bad' : ''), errors));
      if (product === 'R2') group.append(...peaks(body.storageByDay));
      grid.append(group);
    }
  }
  // R2 storage, each day's peak of the cycle so far, as small bars (GB of 10⁹ bytes, as R2 bills it) with the figures
  // in words for a screen reader.
  function peaks(days) {
    const list = Array.isArray(days) ? days.filter(day => typeof day?.date === 'string' && Number.isFinite(day.bytes)) : [];
    if (!list.length) return [];
    const gb = bytes => full(Math.round(bytes / 1e8) / 10) + ' GB', max = Math.max(1, ...list.map(day => day.bytes)), last = list[list.length - 1];
    const width = 240, height = 40, slot = width / Math.max(list.length, 14), bar = Math.max(2, slot - 2);
    const root = svg('svg', {class: 'peaks', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'R2 storage, daily peak: ' + list.map(day => label(day.date, false, true) + ' ' + gb(day.bytes)).join(', ')});
    list.forEach((day, index) => {
      const h = Math.max(1, day.bytes / max * height);
      root.append(svg('rect', {class: 'col', x: index * slot, y: height - h, width: bar, height: h, rx: 1.5}));
    });
    const title = element('h3', 'peaks-title', 'R2 storage, daily peak');
    return [title, root, element('p', 'meta', label(last.date, false, true) + ': ' + gb(last.bytes) + ' · highest ' + gb(max))];
  }

  // ---------- Readiness, as npm run admin -- ready prints it ----------
  function readiness(answer) {
    const out = $('ready'), body = answer.body;
    out.replaceChildren();
    const line = (text, bad = false) => out.append(element('span', bad ? 'bad' : '', text + '\n'));
    if (!body || (answer.status !== 200 && answer.status !== 503)) { line(problem(answer, 'readiness'), true); return; }
    for (const [text, bad] of readyLines(body)) line(text, bad);
  }

  // ---------- Open reports: read-only, with the command that decides each one ----------
  async function copy(text, button) {
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch {}
    if (!copied) {
      // Without the clipboard API (plain HTTP elsewhere than localhost), select the command for copying by hand.
      const code = button.parentElement.querySelector('code'), selection = getSelection(), whole = document.createRange();
      whole.selectNodeContents(code); selection.removeAllRanges(); selection.addRange(whole);
      try { copied = document.execCommand('copy'); } catch {}
    }
    button.querySelector('use').setAttribute('href', copied ? '#i-check' : '#i-copy');
    button.setAttribute('aria-label', copied ? 'Copied' : 'Copy command');
    clearTimeout(button.timer);
    button.timer = setTimeout(() => { button.querySelector('use').setAttribute('href', '#i-copy'); button.setAttribute('aria-label', 'Copy command'); }, 2000);
  }
  function cases(answer) {
    const listing = $('cases'), empty = $('reports-empty'), body = answer.body;
    listing.replaceChildren();
    if (answer.status !== 200 || !body || !Array.isArray(body.reports)) { empty.hidden = false; empty.textContent = problem(answer, 'reports'); empty.classList.add('bad'); return; }
    empty.classList.remove('bad');
    empty.hidden = body.reports.length > 0;
    empty.textContent = 'No open reports.';
    for (const item of body.reports) {
      const id = String(item.case || ''), entry = element('li', 'rcase'), head = element('div', 'case-head');
      const seconds = Number.isFinite(item.createdAt) ? Math.floor((Date.now() - item.createdAt) / 1000) : NaN;
      head.append(element('span', 'case-id mono', id), element('span', 'case-p', 'P' + (item.priority || '?')), element('span', '', String(item.category || '-')),
        element('span', 'meta', age(seconds) ? age(seconds) + ' old' : ''), element('span', item.fileAvailable === false ? 'meta' : 'case-file', item.fileAvailable === false ? 'file already gone' : 'file available'));
      const pick = element('select', 'case-action');
      pick.setAttribute('aria-label', 'Decision for ' + id);
      for (const action of ACTIONS) { const option = element('option', '', action); option.value = action; pick.append(option); }
      pick.value = defaultAction(item);
      head.append(pick);
      const row = element('div', 'code'), code = element('code', '', command(id, pick.value)), button = element('button', 'btn btn-icon');
      row.append(element('span', 'ps', '$'), code, button);
      row.querySelector('.ps').setAttribute('aria-hidden', 'true');
      button.type = 'button';
      button.setAttribute('aria-label', 'Copy command');
      button.append(svg('svg', {class: 'i', 'aria-hidden': 'true'}));
      button.firstChild.append(svg('use', {href: '#i-copy'}));
      button.addEventListener('click', () => copy(code.textContent, button));
      pick.addEventListener('change', () => { code.textContent = command(id, pick.value); });
      entry.append(head, row);
      listing.append(entry);
    }
    if (body.next) listing.append(element('li', 'meta rcase-more', 'More cases: npm run admin -- reports --after ' + body.next));
  }

  // ---------- The status strip: what needs the operator, before any traffic ----------
  // When readiness has something to act on, its terminal windows (readiness, open reports) move up under the strip;
  // otherwise they stay below the billing panel.
  function strip() {
    const link = $('strip'), text = $('strip-text'), ops = $('ops');
    if (!readyLoaded) return;
    const {parts, urgent, readiness, where} = statusParts(ready, day, billBody);
    text.replaceChildren();
    parts.forEach(([part, bad], index) => {
      if (index) text.append(' · ');
      text.append(element('span', bad ? 'bad' : '', part));
    });
    link.classList.remove('is-pending');
    link.classList.toggle('is-warn', urgent);
    link.querySelector('use').setAttribute('href', urgent ? '#i-alert' : '#i-check');
    link.href = where;
    if (readiness && urgent) $('notice').after(ops); else document.querySelector('.events').before(ops);
  }

  function draw() {
    document.querySelectorAll('[data-chart]').forEach(chart);
    document.querySelectorAll('[data-list]').forEach(list);
    events(); kpis(); funnel();
  }
  // Each load takes a ticket; an answer that is no longer the newest one is dropped, so switching the range quickly or
  // pressing Refresh twice never draws an older answer over a newer one (or another range's under this one's radio).
  const tickets = {stats: 0, billing: 0, operations: 0, day: 0};
  async function loadStats() {
    const ticket = ++tickets.stats, wanted = range;
    main.setAttribute('aria-busy', 'true');
    const answer = await get('/api/stats?range=' + wanted);
    if (ticket !== tickets.stats) return;
    stats = answer.status === 200 && answer.body && Array.isArray(answer.body.series) && answer.body.range === wanted ? answer.body : null;
    if (wanted === '1d' && stats) { day = stats; strip(); }
    say(stats ? cutNotice(stats.truncated) : problem(answer, 'statistics'));
    const time = stats ? new Date(stats.generatedAt).toISOString().slice(11, 16) + ' UTC' : null;
    status.textContent = stats ? (stats.sample ? 'Sample data for local development, made up at ' + time + '.' : 'Counted at ' + time + ' from Analytics Engine; the Worker keeps each range for a minute.')
      : 'No statistics.';
    draw();
    main.setAttribute('aria-busy', 'false');
  }
  // The estimate is cached by the Worker and never waits for or blocks the statistics.
  async function loadBilling() {
    const ticket = ++tickets.billing, answer = await get('/api/billing');
    if (ticket !== tickets.billing) return;
    billBody = answer.status === 200 && answer.body ? answer.body : null;
    bill(answer); strip();
  }
  // The strip's last 24 hours: the 1-day statistics (the Worker keeps them a minute), unless the range already is 1 day.
  async function loadDay() {
    if (range === '1d') return;
    const ticket = ++tickets.day, answer = await get('/api/stats?range=1d');
    if (ticket !== tickets.day) return;
    day = answer.status === 200 && answer.body?.range === '1d' ? answer.body : null;
    strip();
  }
  async function loadOperations() {
    const ticket = ++tickets.operations;
    const [readyAnswer, reportsAnswer] = await Promise.all([get('/api/admin/ready'), get('/api/admin/reports?status=open&limit=50')]);
    if (ticket !== tickets.operations) return;
    ready = readyAnswer.body && (readyAnswer.status === 200 || readyAnswer.status === 503) ? readyAnswer.body : null;
    readyLoaded = true;
    readiness(readyAnswer); cases(reportsAnswer); kpis(); strip();
  }

  for (const input of document.querySelectorAll('#range input')) {
    input.checked = input.value === range;
    input.addEventListener('change', () => { range = input.value; history.replaceState(null, '', '#' + range); loadStats(); });
  }
  $('refresh').addEventListener('click', () => { loadStats(); loadOperations(); loadBilling(); loadDay(); });
  // Charts are drawn for their width: draw again when it changes.
  let frame = 0, width = 0;
  new ResizeObserver(entries => {
    const now = Math.round(entries[0].contentRect.width);
    if (now === width) return;
    width = now; cancelAnimationFrame(frame); frame = requestAnimationFrame(() => document.querySelectorAll('[data-chart]').forEach(chart));
  }).observe(document.querySelector('.charts'));
  loadStats(); loadOperations(); loadBilling(); loadDay();
})();

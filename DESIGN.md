# fyl.at design direction

fyl.at is a tool for getting a file to someone. It has one main action: upload a file and get a link. The options are in plain language, and the terminal is a real second way in. The page is built to be used, not to advertise.

The product's main idea is that **the link exists before the file**. The interface shows this with one object and one line:

- **The button becomes the link.** Pressing *Upload and get link* turns the button into the link object in place, and *Copy link* is right where you pressed.
- **The lifetime line.** The same line runs through every screen:
  - while uploading, it fills with the progress;
  - when the file is ready, it turns green in place;
  - after that it shows the time left, on the receipt, in recent uploads and on the recipient's page;
  - when a link closes, it becomes a dashed line with an outlined tag that says why (recent uploads, the management view); the recipient's closed page keeps the meter's track, empty, under the status.

  Words above the line always say which of these it shows: "38 %", "2 days 23 h left" or "Expired".

There is one sequence of motion that was designed as a whole: the button becomes the link, the line fills, turns green, then shows the time left. Everything else that moves is feedback.

End-to-end encryption (2.4.0, docs/E2EE.md) is on for everyone: its option shows while the Worker's `/config.js` sets `e2ee: true` (`E2EE_ENABLED`, kept only as an emergency switch; encrypted transfers stay downloadable and resumable when it is off). The upload page encrypts in the browser (`api.js` with the core in `dist/e2ee/` and the part worker `e2ee/worker.js`), and the download page decrypts (`download.js`, the same worker, and the download service worker `/_dl/sw.js`). The encrypted states below fit the 2.3.0 design: no new colours, no new components, no "Preview" wording.

## Themes and colour

The site follows the visitor's system theme by default. One 44 px button in the header (in the footer on download pages) opens a menu with *System*, *Light* and *Dark*.

- `dist/theme.js` runs before first paint.
- It sets `data-theme` only when the visitor pins *Light* or *Dark*. *System* removes the attribute and the stored value, so only the CSS media query decides.
- The choice is stored in `localStorage` under `fyl-theme`.
- There is one `theme-color` meta per scheme: `#f5f7fb` and `#070b14`.

**The design.** The layout, components, copy and behaviour, dressed in the palette of fyl.at 2.2.0, kept for its branding: slate ink, the cobalt accent with its gradient, "now." in blue, the soft glow and faint grid behind every page, the glowing upload card, and the always-dark mac-style terminal window. On top of it: a larger headline and promise line, the 2.2.0 file illustration in the empty drop zone, options that are on in the primary cobalt (the option toggles), helper text at 14 / 20 in a darker meta colour, no `fyl rm` sample in the companion (so *How it works* sits higher), and every terminal (companion, CLI dialog, the recipient's "Download in a terminal") in the same dark window.

All colours are tokens at the top of `dist/styles.css`. They are defined three times: light on `:root`, dark on `:root[data-theme="dark"]`, and dark again under `@media (prefers-color-scheme: dark)` scoped to `:root:not([data-theme="light"])`. Components use tokens only; the terminal window redefines the few it uses (see *Terminal*).

| Role | Token | Light | Dark | Measured contrast |
| --- | --- | --- | --- | --- |
| Ground | `--bg` | `#f5f7fb` | `#070b14` | |
| Surface (inputs, the link field, docked bar; menus in light) | `--surface` | `#ffffff` | `#101a2e` | |
| Panel and dialog fill, top to bottom | `--surface-top` / `--surface-bottom` | `#ffffff` / `#fbfcfe` | `#131c32` / `#0d1424` | |
| Well (drop zone, chosen file, link object, segmented control) | `--well` / `--well-2` | `#f2f5fa` / `#e7ecf4` | `#0b1222` / `#1b2539` | in dark the well is an inset, darker than the panel, as in 2.2.0 |
| Secondary button fill | `--btn-2` | `#ffffff` | `#1b2539` | raised in dark, so it never reads as a hole in the inset |
| Lines | `--line` / `--line-2` / `--line-3` | `#e3e8ef` / `#d5dce6` / `#a9b3c4` | `#222d41` / `#303b4f` / `#4b576c` | |
| Faint rule (between the option sections) | `--line-faint` | `#eef2f6` | `#1a2335` | decorative: 1.12 : 1 / 1.08 : 1 on the panel, one step under `--line` (1.23 : 1), which draws the options block's edge |
| Field borders, dashed "closed" line, outlined tags | `--field-line` | `#7d8aa0` | `#6b7a93` | 3.49 : 1 on surface, 3.19 : 1 on well / 3.99 : 1, 4.30 : 1 (WCAG 1.4.11) |
| Text | `--ink` | `#0f172a` | `#f1f5fb` | |
| Secondary text | `--ink-2` | `#334155` | `#cbd5e1` | 9.48 : 1 / 12.59 : 1 on well |
| Meta text (hints, descriptions, meta lines, footnotes, captions) | `--ink-3` | `#4b5870` | `#9aa8bd` | light 7.17 : 1 on surface, 6.98 on the panel's bottom, 6.68 on ground, 6.56 on well, 6.04 on well-2, 6.41 on the accent wash, 5.64 on ground under the cobalt glow; dark 7.20 on surface, 7.02 / 7.62 on the panel's top / bottom, 8.16 on ground, 7.75 on well, 6.36 on well-2, 6.07 on the accent wash, 6.00 under the glow (was `#526079` / `#94a3b8`, lowest 4.99 / 5.64 : 1) |
| Primary fill (buttons, expiry pill) | `--accent-fill` / `--accent-fill-hover` | `linear-gradient(180deg, #3f6ef5, #2f5ee8 62%)` / `#3567f0 → #2552d6` | same | white under the label at least 4.76 : 1; `#3f6ef5` alone is 4.41 : 1, so the gradient reaches `#2f5ee8` (5.40 : 1) at 62 % of the height |
| Accent (solid: caret, checkboxes, skip link) | `--accent` / `--accent-hover` | `#2f5ee8` / `#2552d6` | same | white 5.40 : 1 / 6.45 : 1 |
| Bright accent (wordmark dot, middle of "now.", the drop-zone arrow) | `--accent-bright` | `#3f6ef5` | `#5b8cff` | logo, 44 px heading and illustration only |
| Accent text, links, focus ring | `--accent-ink` | `#2851d6` | `#9db9ff` | 6.49 : 1 / 8.95 : 1 |
| Key after `#` in a link | `--accent-ink` on `--accent-wash` | `#2851d6` on `#eef2fe` | `#9db9ff` on `#192847` | 5.80 : 1 / 7.53 : 1 |
| Upload progress line | `--bar` on `--track` | `#2f5ee8` on `#e2e7f0` | `#5b8cff` on `#1e2940` | 4.35 : 1 / 4.59 : 1 |
| Lifetime line ("this link works now") | `--life`, `--ok-bar` | `#15803d` | `#4ade80` | 4.04 : 1 / 8.33 : 1 on track |
| Ready text and chip | `--ok` on `--ok-wash` | `#15803d` on `#edf8f1` | `#4ade80` on `#0e2729` | 4.61 : 1 / 8.99 : 1 |
| Paused line (upload stalled) | `--stall` | `#64748b` | `#8090a8` | 3.83 : 1 / 4.47 : 1 on track |
| Danger text | `--danger` | `#dc2626` | `#f87171` | 4.83 : 1 / 6.28 : 1 on surface |
| Danger button | `--danger-bg` / `--danger-hover` | `#dc2626` / `#b91c1c` | same | white 4.83 : 1 |
| Cancel upload (at rest / hover and press) | `--danger-soft` text, `--danger-line` edge / `--danger-strong` on `--danger-wash`, `--danger-line-2` edge | `#b83238`, `#f4bebe` / `#c81e1e` on `#fff5f5`, `#ee9292` | `#e07f84`, `#583645` / `#f87171` on `#2a1520`, `#864652` | at rest 5.91 to 5.76 : 1 / 6.08 to 6.60 : 1 down the panel; hover 5.36 : 1 / 6.19 : 1. The edge is decorative: the words name the button |
| Failed chip | `--danger` on `--danger-wash` | `#dc2626` on `#fff5f5` | `#f87171` on `#2a1520` | 4.51 : 1 / 6.19 : 1 |
| Files that can run code | `--warn-wash` / `--warn-line` / `--warn` (icon) | `#fffaf0` / `#f5d49b` / `#d97706` | `#261f10` / `#5a4520` / `#fbbf24` | text stays ink; icon 3.06 : 1 / 9.78 : 1 |
| Option toggle | off: `--ink-2` on `--btn-2`, `--line-2` edge, icon `--ink-3`; on: `--on-accent` on `--accent-fill` | `#334155` on `#ffffff` / white on the primary fill | `#cbd5e1` on `#1b2539` / the same | off text 10.35 : 1 / 10.32 : 1, icon 7.17 : 1 / 6.36 : 1; on, white at least 4.76 : 1 (measured from the pixels at the top of the label's line, 8 px into the 36 px toggle), and the fill against the panel 5.12 : 1 / 3.30 : 1. Outlined off like a secondary button; the fill fades in on |
| Disabled button | `--disabled-ink` on `--disabled-bg` | `#4b5a75` on `#ecf1fe` | `#a3b1c6` on `#18274e` | 6.16 : 1 / 6.71 : 1; the label says why |
| Menu (choose a file or folder, theme, copy, expiry) | `--menu` / `--menu-line` / `--menu-hover` | `--surface` / `--line` / `--well` | `#1c2740` / `#3d4a62` / `#26324d` | in dark a raised surface with a visible edge, lighter than the panel, so a menu never melts into it |
| Toast | `--toast-bg` / `--toast-line` / `--toast-action` | `#0f1a2c` / `#0f1a2c` (the fill) / `#9db9ff` | `#0f1a2c` / `#24304a` / `#9db9ff` | action 8.98 : 1; the dark edge sets it off the dark ground |
| Selection | `--sel` | `#c5d4fc` | `#343f5b` | |
| Scrim | `--scrim` | `rgb(15 23 42 / .35)` | `rgb(3 6 12 / .72)` | |
| Floating shadow (menu, toast) | `--shadow-pop` | `0 1px 2px rgb(15 23 42/.06), 0 10px 28px -8px rgb(15 23 42/.18)` | `0 0 0 1px rgb(0 0 0/.5), inset 0 1px 0 rgb(255 255 255/.06), 0 2px 4px rgb(0 0 0/.45), 0 16px 40px -8px rgb(0 0 0/.75)` | in dark a black outline, a faint top highlight and a deeper drop |
| Dialog shadow | `--shadow-dialog` | `0 2px 6px rgb(15 23 42/.06), 0 40px 90px -24px rgb(15 23 42/.3)` | `0 40px 100px -20px rgb(0 0 0/.7)` | |
| Card glow (tool panel, download card) | `--shadow-card` | depth plus `0 0 80px -30px` of `--accent-glow` `rgb(47 94 232/.45)` | the same with `rgb(63 110 245/.9)` | |
| Backdrop | `--glow-a` / `--glow-b` / `--grid` | `rgb(63 110 245/.14)` / `rgb(34 197 94/.06)` / `rgb(15 23 42/.045)` | `rgb(63 110 245/.28)` / `rgb(34 197 94/.07)` / `rgb(148 163 184/.05)` | |

Supporting tokens, defined in the same three places: `--on-accent` (text on the accent), `--accent-line`, `--accent-soft`, `--violet` (`#6d4cf5` / `#7c5cff`, only at the end of "now."), `--ok-line`, `--warn-ink`, `--toast-ink`, and the drop-zone illustration's tones from 2.2.0, `--art-back` / `--art-back-line` / `--art-sheet` / `--art-fold` / `--art-edge` / `--art-lines` (light `#e6ecf7` / `#c9d5ea` / `#ffffff` / `#e7eefc` / `#93a6c8` / `#c1cee6`; dark `#1b2742` / `#2c3b5c` / `#22304f` / `#2c3d63` / `#4b6190` / `#3d5280`), so the sheet sits lighter than the well in light and as a raised slate sheet in dark. `--brand-fill` (`linear-gradient(140deg, #5b8cff, #3f6ef5)`) is the wordmark tile.

Each colour has one meaning, and it carries no other:

- **Cobalt** is for actions, the link and options that are on (and the brand: wordmark, "now.", the drop-zone arrow).
- **Green** means "this link works now". It is used for the ready chip and for the lifetime line, and as the small dot on the drop-zone illustration, which promises it. In the terminal windows it also colours the prompts, as in 2.2.0.
- **Amber** means only "this file can run code".
- **Red** is for errors, a failed upload and deletion, and, muted, for *Cancel upload*, a way out rather than a call to action.

The rest of the surface rules:

- Option toggles take the primary fill when on (it fades in, with a soft cobalt glow under it) and their icon becomes a check.
- Shadows: floating things (menu, toast, dialog), the cobalt glow under primary buttons, the card glow under the tool panel and the download card, and the terminal windows' drop shadow (not on the download page's window, which sits inside a disclosure). Every shadow has an offset or a blur.
- Gradients only where 2.2.0 had them: the primary fill, the expiry pill and the option toggles that are on, the wordmark tile and favicon, "now." in the headline (cobalt to violet), the cobalt wash at the top of the drop zone, and a faint top-to-bottom fill on panels and dialogs.
- Behind every page: a soft cobalt glow at the top right, a faint green one on the left, and a 56 px grid that fades out towards the bottom (`body::before` and `body::after`, fixed, decorative). No glass, no gradient borders.
- Every terminal is the same always-dark window, in both themes, like a real terminal: the companion beside the tool, the commands in the CLI dialog, and the recipient's "Download in a terminal" once opened (see *Terminal*).
- The favicon and the wordmark tile use the cobalt gradient `#5b8cff → #3f6ef5` with a white mark: a file whose top-right corner leaves as an arrow (filled sheet, 2.4-unit arrow stroke on a 24-unit grid; 18 px in the 28 px wordmark tile). Link previews use `dist/og/<lang>.jpg` and `dist/apple-touch-icon.png`, both rendered by `scripts/og_images.mjs`.

## Typography

Two families, both already self-hosted as WOFF2 in `dist/fonts/` under the SIL Open Font License, so the CSP stays `'self'`:

- **IBM Plex Sans** (400, 600, 700) for everything.
- **JetBrains Mono** (400), only for links, commands, passwords, keys and IDs.

The 600 weight is preloaded on every page. The privacy page preloads 400 instead. There is no 500 file: weight 500 (quiet buttons, chips, tags) is served by the 600 face, and the mono face covers 400 to 600.

| Token | Size / line height | Use |
| --- | --- | --- |
| `--t-xs` | 13 / 18 to 20 | chips, badges, tags, commands and mono values in the terminal blocks |
| `--t-meta` | 14 / 20 | hints, option descriptions, the options' "nothing on" line, meta lines, file meta, the expiry summary, footnotes, captions, the footer (was 13 / 18). Still clearly secondary: `--ink-3`, weight 400, under 15 / 600 titles |
| `--t-small` | 14 / 20 | segment labels, option toggles and section titles, the link (mono), inline messages, toast, time left in recent rows |
| `--t-ui` | 15 / 22 | body, controls, labels, buttons, group headings |
| `--t-lead` | 16 / 24 | drop-zone title, large buttons, every input (16 px stops iOS zoom), the report lead; privacy body text uses 16 / 26 |
| `--t-intro` | 18 / 28 | the privacy lead on tablet and desktop (16 / 26 on phones) |
| `--t-promise` | 20 / 30 | the promise line under "Fyl for now." on tablet and desktop, with "No account needed." kept on one line so the sentence starts the second line; 17 / 26 on phones (was 18 / 28) |
| `--t-h` | 22 / 28 | state headings ("Your link works already", "Ready to share"), the file name on the download page, dialog titles, privacy section titles |
| `--t-form` | 26 / 32 | the report form's titles ("Report a file", "Report received"), in their panel (was 32) |
| `--t-page` | 32 / 38 | the privacy page's title |
| `--t-title-sm` | 36 / 1.05 | "Fyl for now." on phones; one line down to 360 px (it takes about 200 of the 328 px there) |
| `--t-title` | 44 / 1.05, tracking −0.03em | "Fyl for now." on tablet and desktop (was 32, then 36) |

Rules:

- Sentence case everywhere. No uppercase micro-labels, eyebrows or mono captions.
- Sizes, times, percentages and countdowns use `font-variant-numeric: tabular-nums`.
- The 11 px extension tag belongs to the file icon. It is not running text.
- File names break after `_ - .` first, then anywhere (`<wbr>` plus `overflow-wrap: anywhere`), but never just before the extension; the download page title breaks the same way. They are isolated with `dir="auto"` and `unicode-bidi: plaintext`, and start at the left edge like their meta line, also when they are right-to-left.
- The link field shows the name in the path decoded (`Wiśniewska…`, not `Wi%C5%9B…`) inside a `<bdi dir="auto">`; the clipboard, the QR code and the commands keep the encoded link. The field never wraps: the id and the name are cut in the middle to what fits, the name keeping its extension (see *Link object*). Only after a failed copy does it show the whole link, breaking anywhere, to be selected by hand.
- Commands wrap after `/ _ - .` in their links, then anywhere; the link's last 8 characters stay together with the closing quote, so no line holds just one or two of them. Nothing hides behind a horizontal scrollbar.
- Link ids made in the browser are 64 hex characters (the server derives them from the upload's key and idempotency key); CLI ids are 43 base64url characters. Layouts are checked with the 64-character ones.
- Browser surfaces are themed too: `::selection`, the caret (`caret-color: --accent`), focus rings, underline offset (3 px) and scrollbar colour.

## Layout

**Shell.** Content is `min(100% − 64px, 1040px)` wide, with 16 px side gutters below 560 px. The header is 72 px tall (64 px on phones) and holds the wordmark (44 px target) and, on the right, *CLI* plus the theme button. Download, report and privacy pages show *Send a file* instead of *CLI*. The footer reads "fyl.at · Fyl for now." with *Report a file*, *Privacy* and *For AI agents* (the llms.txt, in a new tab on the upload and download pages); on download pages the theme button sits there too. On short pages the footer stays at the bottom of the screen (the shell is a column at least 100svh tall).

**Home.** The tool comes first.

- **Desktop:** a CSS grid with two columns, a 600 px tool and a 340 px terminal companion, 56 px apart. Areas: `"intro ." "tool side" "recent side"`.
  - The intro is the title "Fyl for now." plus one sentence.
  - Recent uploads sit directly under the tool.
  - The companion holds:
    - the terminal window "Made for cli, too." (always dark: window dots, "bash — fyl" title bar, green prompts): the install and upload commands with their real output, and nothing else, so *How it works* starts 96 px higher than with the old `fyl rm` sample (at y = 688 instead of 784 on a 1440 × 900 screen);
    - once a file is uploading and its link exists, "This file in a terminal": the recipient's `curl` command (with `--retry 120` until the upload is done; for an encrypted file `fyl download` with the link without its key, which asks for the key) and, on the receipt, the `fyl rm` command;
    - *All CLI options*, with the `>_` terminal glyph of *CLI* in the header in front and ↗ after it, which opens the CLI dialog;
    - "How it works" as a short ordered list.
- **Below 1000 px:** one column in the order intro, tool, recent uploads, terminal.
- **Phones (≤ 560 px):**
  - The whole idle tool fits a 390 × 844 screen; *Choose a file first* ends at about y = 768 (y = 788 on a 360 × 780 screen, just past its edge).
  - Once a file is chosen, the Upload button docks to the bottom of the screen inside the panel until the panel ends. It undocks while the on-screen keyboard is open, and `scroll-padding-bottom: 96px` keeps focused fields clear of it.
  - Once an upload starts, the intro steps aside, so the link sits directly under the header.

**Panel and nesting.**

- **Panel:** one surface with a 1 px line, padding 24 (16 on phones) and radius 18 (16 on phones).
- **Inside a panel there are no boxes in boxes.**
  - Rows are separated by 1 px rules.
  - Wells are a tone step with no border: the drop zone, the chosen file, the segmented control and the link object.
  - The exceptions are two edges without a fill, the options block (only while an option is on, see *Options*) and the open key block (see *Encrypted receipt*), and the link field, a surface with an edge like a browser's address bar inside the link object (see *Link object*).
  - Once an upload starts, the file becomes a plain row.
  - The QR code sits on its own white tile, the 4-module quiet zone drawn inside the SVG so it scans in dark mode too, with no surface box around it.

**Shape.** Radii step down as they nest:

| Element | Radius |
| --- | --- |
| Panel | `--r-panel` 18 |
| Wells, menus, toast, `.btn-lg` | `--r-well` 12 |
| Controls | `--r-ctl` 10 |
| Option toggles, the expiry pill | 9 |
| Small parts | `--r-sm` 6 |
| Status chip, badges | 999 |

**The lifetime line.**

- 4 px (`--line-w`) with round caps in the link object and on the download page; 3 px (`--line-w-list`) in recent uploads.
- Its track is always visible, so it reads as a meter, not as a border.
- A closed link shows a 2 px dashed `--field-line` instead, except on the recipient's closed page, which drains the meter to its empty track (see *Gone*).

**Spacing and targets.** Spacing uses a 4 px base. Every control has a hit area of at least 44 px, except the icon copy buttons in the link field and the key block, 40 px inside rows 48 and 56 px tall.

**Alignment**: what is meant to align must actually align. Everything in a panel starts on its content edge, or on one deliberate inset, never a few pixels off.

- Text, fields, buttons, wells and rules start on the panel's content edge; a well's own content starts on the well's padding (16 px, 14 on phones).
- Icons that end a row sit on the right edge by their ink as well: the download page's *Download in a terminal* chevron (`margin-right: -5px`) ends where the Download button and the window end, and the CLI dialog's X (`right: 7px`: the 24 px padding less the X's 17 px inset in its 44 px target) ends where the tabs and the window end. On phones the padding is 16 px, so the X's target meets the sheet's edge (`right: 0`, 1 px short) and its focus ring is drawn inside the target (the sheet clips at its edge).
- Icons that start a line of text sit on the text column by their ink, not their box: a negative margin as wide as the glyph's own inset (−1 to −3 px at 14 to 18 px), for the private link's key, the notes (`.note`), the unfinished-upload notice, the meta icons in recent uploads and the file row, the report form's errors and alert (both a 14 px icon with a 6 px gap, so the alert's text starts where the errors' does), the minimum line, the download page's *Download in a terminal* and *Report this file*, and *All CLI options*.
- The file icon's extension tag is the icon's leftmost part, so the tag (not the sheet) sits on the edge: on the chosen file, in the plain file row once uploading, and on the download page.
- Under the download card, the trust line and *Report this file* start and end on the card's outer edge.
- Columns side by side share one gap: the report form's category list and the name / email pair both use 16 px, so their second columns line up.
- In every terminal window, text has one column (`--tw-x`, 18 px from the frame; see *Terminal*).
- Measured, not eyeballed: a Playwright audit (kept out of the repository) collects the left and right edges of everything visible in each panel (painted boxes, icon ink, line starts) for every home state, the CLI dialog, the expiry dialog, the download page states, report and privacy, at 360, 390, 768 and 1440 px in both themes, and flags any two edges 0.5 to 8.5 px apart. For 2.3.1 it went from 158 findings (state and pair of edges) to 23, all intended: the command rows' fill hanging 8 px into the terminal's gutter (their text is on the column), the download page's terminal on phones (rows 4 px from the frame, so a link's first line fits), the privacy page's wrapped row of contents links (not a column), and the custom unit select's chevron meeting a switch track by chance at 360 px. The segmented controls' pills sit 3 px inside their well by design and are not measured.

**Download page** (`i18n/templates/download.html`, built into `dist/<lang>/`, page styles in `download.css` on top of `styles.css`, behaviour in `download.js`):

- One centred card, 520 px wide (padding 28, 20 on phones). The Worker sets `<html data-state>` and the flags `data-once`, `data-risky` and `data-protected`; `download.js` adds `data-stalled` and `data-error` (`wrong`, `paused`, or `format` for a password the server would refuse).
- Card order:
  - file icon and name (or a lock tile with "Password required");
  - a meta line ("size · type");
  - for protected links, the field directly under its instruction;
  - one expiry line with the lifetime line;
  - the warning for files that can run code;
  - Download ("Download · 1.2 MB"); for one-time links (the meta line already says "One download") a note under it: "If the download is interrupted, resume it within 15 minutes from the same network.";
  - "Download in a terminal" as a disclosure; opened, the command sits in the dark terminal window.
- Under the card, starting and ending on the card's outer edge:
  - *Report this file*, an ink link with a flag icon and a 44 px target; it opens the form in a new tab without an opener (as do the footer's *Report a file* on the upload and download pages), so the form's Turnstile script never runs in a tab that holds keys;
  - the line "Files on fyl.at are deleted when their link expires. They aren't scanned for viruses."
- There is no topline and no second expiry.

**Report** (`/report`): one 600 px panel holding the form. **Privacy** (`/privacy`): a reading page with no card, a 680 px column, about 70 characters per line, and links to its sections.

## Interaction

**Drop zone.**

- Empty, it shows the file illustration of 2.2.0: a sheet with a folded corner over a tilted back sheet, three text lines, a cobalt up arrow (`--accent-bright`) and a small green dot (`--life`), inline SVG in the 2.2.0 `--art-*` tones, 80 × 75 (56 × 52 on phones), over the cobalt wash at the top of the zone. It doesn't move, so reduced motion has nothing to remove.
- The whole zone is a native button: click, Enter or Space opens the picker.
- Hover tint only on `(hover: hover) and (pointer: fine)`. Pressing scales it to `.99`.
- Touch screens read "Choose a file"; fine pointers read "Drop, paste or choose a file" (the paste hint is desktop only).
- Files can be dropped anywhere on the page. Dragging shows an opaque "Drop to upload" layer that fades in over 120 ms, with no ghost text and no scale.
- **Paste**: a file pasted anywhere on the page, but not into a field, a select or editable text, is chosen like a dropped one. Pasted images named only `image.png`, `blob` and the like get `pasted-image-YYYYMMDD-HHMMSS.<ext>` from their type and this device's clock. Several files get the same message as several dropped ones; pasted text does nothing; while an upload runs a pasted file is ignored, as a drop is.
- Choosing, dropping or pasting a file folds the zone into the file row with a 280 ms view transition.
- **Folders** (docs/FOLDER-ZIP.md): exactly one dropped folder is sent as one zip; several dropped items, folders among them, get the "one file at a time" message, as before. Where the browser can pick folders (not iOS or iPadOS), the zone says "Drop, paste or *choose a file or folder*" ("Choose a file or folder" on touch screens) over "Up to 50 GB. A folder is shared as one zip file.", and its picker opens a menu (*Choose a file*, *Choose a folder*) centred under the "choose" words, so there is one way to choose and no second picker in the zone; the zone keeps its hover look while the menu is open. Elsewhere it keeps "choose a file" over "One file, up to 50 GB. Zip folders first." and opens the file picker. `html.no-folders` (set by theme.js before the first paint, confirmed by app.js) picks the text, so the zone's height doesn't change.
  - The zone folds into the file row once the folder is listed (after at most 150 ms; a folder that takes longer shows "Reading the folder…" until then), so the row arrives with its final lines: **`<folder>.zip`**, the ZIP label, "5.2 MB · Folder · 4 files", and, when names were left out, one quiet line "Left out 1 item with an unsafe name." (`--ink-3`, `--t-meta`). If that line joins later, the panel eases to its new height (`resize()`); measured frame by frame at 1440 and 360 px, the options below only move up.
  - While the files are read once for their checksums, the row already says what will be sent and the Upload button, disabled, counts: "Preparing the folder… 42 %" (its label is the reason, as always; one line at 360 px, so nothing moves while the figure grows); while a slow folder is still listed it reads "Reading the folder…", as the row does. When it is done the button crossfades to its action like after choosing a file. Removing the row or choosing anything else stops the reading.
  - For a folder the row's buttons are *Choose a different folder* (it opens the folder picker) and *Remove folder*, and removing it says "Folder removed." The left-out line is part of the pick button's description. Screen readers hear "Preparing the folder…" when the row appears and, when it is ready, "photos.zip selected. Folder · 4 files." with the left-out line.
  - A refusal (nothing to send, more than 100,000 files, two items whose names become equal, a zip over 50 GB, a file that changed while it was read) folds back to the zone with the reason under it, in `--danger` like every error under the zone. Several dropped files get "Choose one file at a time. For several, put them in a folder and drop the folder here." where folders can be sent (the archive wording elsewhere); a folder input that hands over plain files (a browser that ignores `webkitdirectory`) says "This browser can't choose folders. Zip the folder first, or drag it here."
  - The live command shows the folder (`fyl './photos'`); an unfinished folder upload's notice says "Choose the same folder to resume."
- An unfinished upload shows one row above the zone: "Unfinished upload of **name**. Choose the same file to resume." with *Discard* (the record doesn't know how far it got, so there is no percentage). While another tab runs it: "The upload of **name** continues in another tab.", without *Discard*, and the button reads "Continuing in another tab".
- When the same file is chosen, the button reads "Resume upload" and the notice row goes away, with the hint "Resuming keeps the password the upload started with."
- If pressing would discard the unfinished upload, the button reads "Upload and discard the unfinished one".

**Expiry.**

- Options: `1 hour · 1 day · 3 days · 7 days · Custom`. All five stay in one row at 390 px; below 360 px they form a 3 + 2 grid.
- The selected pill glides to the chosen cell. It is a window (`.seg-pill`, the primary fill, rounded by `clip-path: inset(0 round 9px)`) moved by `transform`, holding a copy of the row in white that moves the opposite way (the copy carries the pill's fill itself, so contrast checkers, which ignore `clip-path`, measure white on cobalt and not on the well, where Lighthouse and axe found 1.09 : 1), so the copy's labels stay exactly over the row's and each label turns white as far as the pill has come: the colour change can't run ahead of or behind the pill. Both use one CSS transition (`--d-slide` 220 ms, `--ease-out`), so they start at once and a new choice mid-way retargets from where the pill is. It glides on a pointer press; with the arrow keys it jumps, like every keyboard change (see *What never moves*), and a resize or restored options place it without moving. The pill takes the chosen cell's size, so the 3 + 2 grid works the same. Nothing around it moves.
- *Custom* opens a row below with "Keep it for" over a number field and a unit select ("From 5 minutes to 7 days." under them), 16 px below the control. The fields look like every other field: 48 px, `--r-ctl`, the `--field-line` border on `--surface`, the focus ring drawn as the border plus 1 px in `--accent-ink` (red while invalid), 16 px text with tabular figures and no spinner; the select has the site's chevron instead of the system arrow. The expiry dialog uses the same row.
- The row opens by `grid-template-rows` 0fr → 1fr over 280 ms (`--d-reveal`) on the drawer curve (`--ease-drawer`), which eases into the push on the options below instead of landing most of it in the first frames (first frames 18, 42, 72, 94 of 124 px, against 36, 65, 87, 101 with `--ease-out`), while its content fades in 40 ms behind and settles 6 px; it closes in 180 ms (`--d-close`), the content fading first. What follows slides down with it. Transitions, so a quick change of mind reverses smoothly.
- One summary line names the result: "Expires **3 days** after the upload." An invalid value names the problem ("2 minutes is too short. Choose at least 5 minutes."), and the disabled button says "Set an expiry from 5 min to 7 days".

**Options** (a row of toggles; it replaced three switch rows without a group heading). Under the group heading "Options", 22 px under the expiry summary (18 on phones), one row of toggles: *One download*, *Password*, *Encryption*. Under them one quiet block holds a section for each toggle that is on, in the toggles' order; with none on, one line takes its place: "Anyone with the link can download it until it expires." With nothing on, the card is 122 px shorter than with the rows at 1440 px (483 instead of 605 px) and 148 px at 360 px (506 instead of 654 px).

- **Toggles** (`.opt-toggle`; "chip" stays the round status chip of the link object): 36 px tall, radius 9, 6 px apart, `--t-small` at weight 500. Off, outlined like a secondary button (`--btn-2`, `--line-2` edge, `--ink-2` text) with the option's icon (`i-one`, `i-lock`, `i-shield`) in `--ink-3`; hover (fine pointers) takes `--line-3` and `--ink`. On, the expiry pill's primary fill fades in under the label (`--d-base`; the fill is its own layer, because a gradient can't fade) with a soft cobalt glow, the label turns white and the icon cross-fades to a check (`--d-swap`, `scale(.85)` and a 2 px blur, like Copy). Pressing scales the face to `.97`.
  - Each is a native checkbox (no `role="switch"`) that covers the whole toggle and reaches 4 px past it above and below: a 44 px target, which touch screen readers find too. The face follows the checkbox in the markup, so the on state is styled with `input:checked + .opt-face` and works without `:has()`. Tab reaches each toggle, Space toggles it, and the focus ring (2 px `--accent-ink`, 2 px out) is drawn around the face. Each is described by its section's description (`aria-describedby`) and controls its section (`aria-controls`).
  - At 560 px and below the icons go, so the three stay on one line (12 px padding, −0.01em tracking); at 380 px and below the padding is 8 px, so "Encryption" stays on that line down to 360 px (287 of the 294 px there). Below 360 px they may wrap, 8 px apart, so their targets don't overlap.
  - In forced colours the fill is dropped (and phones have no icons), so a toggle that is on keeps a 2 px `Highlight` border; its icons take the forced text colour (`CanvasText`), since Chromium doesn't force an SVG icon's own colour and the white check would vanish on a light high-contrast face.
- **The block** has an edge (`--line`, radius 12) only while something is on and no fill. Sections open and close like the custom expiry (`.reveal`, 280 ms on the drawer curve, 180 ms closing), parted by a fainter rule (`--line-faint`). Each section has its icon (`--accent-ink`, its ink on the section's edge) and title (`--t-small`, 600), one description line, then its field or note, all on the title's text column (25 px in; no indent on phones). Padding 13 / 16 / 15 px (12 / 14 / 14 on phones).
- **No jump** (content must never jump first and then slide): the "nothing on" line and the block share one grid cell, so the cell is as tall as the taller of the two. When the first option turns on, the line fades out at once (100 ms) and the content below only moves down as the block opens; when the last one turns off, it only moves up as the block closes, and the line fades back in (150 ms, after 100 ms) once the block has nearly closed. Each section draws its rule at its own top inside its reveal, and the block's first rule sits 1 px up under the clipped edge, so no rule (and no margin) appears or goes in one frame. Measured with Playwright every animation frame for twelve changes in a row at 1440 and 360 px: the footnote under the options never moves against the direction of the change.
- **One download:** title "One download", "The link closes after the first download."
- **Password:** title "Password", "Recipients need it to see the name or download."
  - When it is on, the passphrase shows in full (three common words and two digits, such as `pilot-tide-arch-64`), with a 48 px "Make a new password" icon button.
  - Hint: "Send it separately from the link. It controls access; it doesn't encrypt."
  - The live command adds `--password`.
- **Encryption** (2.4.0, on for everyone; `E2EE_ENABLED` only as an emergency switch; no "Preview" badge): the section's title is "End-to-end encryption (E2EE)", then "Encrypted in your browser. The key travels only in the link." The toggle and its section show while `/config.js` sets `e2ee: true` (see the top of this file); otherwise both are hidden and the section never opens.
  - Under the description, a note: "Recipients need a browser or the fyl CLI; curl only gets encrypted data.", and under it the claims of docs/E2EE.md §1 as a hint: "Anyone with the full link can open it, and a lost key can't be recovered. In the browser, this relies on the code fyl.at serves." followed by the link *Why?* to `/privacy#encrypted` (accent ink, underlined; its 44 px target drawn by `::after`, so the line keeps its height). It opens in a new tab (`target="_blank" rel="noopener"`), so the chosen file and the options stay.
  - The live command adds `--encrypt`.
  - A browser without WebCrypto X25519 turns the toggle back off: "This browser can't encrypt files. Update it, or use the fyl tool with --encrypt." A file too large once encrypted (the limit counts stored bytes, 16 bytes more per 64 KiB): "This file is too large to encrypt. Turn encryption off, or choose a file a little smaller than 50 GB."
  - **Resuming an encrypted upload** keeps its mode (the toggle comes back as it was, and its section opens). In a tab without the key (another tab, a closed browser, keys not remembered) a group of its own appears under the options, above the footnote, its label like a group heading (15 px, 600; 22 px under the options, 18 on phones): "Key of the unfinished upload" / "This tab doesn't have it. Paste the link or the key you got when the upload started." over a mono field (no name, no autofill). An empty or malformed entry: "Paste the link or the key you got when this upload started."; another upload's link: "This link is for another upload. Paste the link you got when this one started."
  - **Refusals** (the file changed, a key that doesn't open the upload, a resume that can't be checked) go back to the form with the reason and keep the unfinished upload for *Resume upload* or *Discard*: "The file changed since this upload started. Start a new upload.", "This key doesn't open this upload. Paste the link you got when it started.", "This upload can't be resumed safely. Start a new upload." A server answering with a foreign link stops before any link shows: "fyl.at answered with an unexpected link, so none was shown. Please try again later."

**Upload button.**

- When disabled, it stays readable (5.1 : 1) and its label is the reason: "Choose a file first", or the expiry message. That reason is also its accessible name.
- When it becomes enabled, the label crossfades through a 2 px blur.
- Above it: "You'll also get a private link to change or delete it."
- Pressing it runs the view transition that turns the button into the link object, and the panel eases to the link view's height meanwhile (`resize()` inside the morph; see *Motion*). Focus moves to *Copy link* when the transition ends and the link is there; until the link arrives it rests on the panel's heading.

**Link object.** A well with no border.

- **Contents:**
  - the heading "Download link" with a status chip ("Uploading" until there is a rate, then "Ready in 47 s", then "✓ Ready");
  - the link in a field, the way a browser shows an address: one line in a 48 px field (`--surface`, a `--line-2` edge, radius 12), mono at `--t-small`. The host without `https://` and the `/` before the name are in `--ink-3`, the id in `--accent-ink`, the name in `--ink`. `fitUrl()` cuts the id and the name in the middle to the characters that fit (the font is monospaced, so a width is a count of characters), the name keeping its end so the extension shows; with encryption the key after `#` is cut to 9 characters (`#abc…wxyz`) on an accent wash, because screens get shared. It is a real link to the download page in a new tab, underlined on hover (fine pointers) and selectable by dragging (`draggable="false"`). A 40 px icon copy button sits at the field's end, 3 px from its edges: it copies the same link as *Copy link*, and its icon turns into a tick. When copying fails, the field shows the whole link, wrapping, to be selected by hand. The clipboard, the QR code and the link's target are always the whole link;
  - while the link is being created, the field has no address and no copy button: a quiet bar shows where the link will be (`--well-2`, 10 px tall, at most 340 px wide), pulsing like the placeholders under it, and "Creating your link…" stays in the field for screen readers (CSS only). After a failure the field has no address and is struck through;
  - the actions: a split *Copy link* button with a menu, plus labelled *Share* (only where `navigator.share` exists) and *QR code*. On phones *Copy link* takes the full width and *Share* and *QR code* share the next row (*QR code* alone takes it where there is no *Share*). While the link is being created they hold their place as quiet placeholders (`--well-2`, no label, `inert`), so the link arriving changes no height: the field and the actions fade up 4 px where they were (280 ms, the actions 40 ms later).
- **Uploading:**
  - The panel heading is "Your link works already".
  - Hint: "Recipients can open it now. Their download starts when the upload is done. Keep this tab open until then."
  - The meter: "38 %", "0.70 of 1.84 GB · 24.6 MB/s", and on the right "Then open for 3 days".
  - The expiry starts only when the upload completes (`src/transfer.ts`), so no countdown shows before then.
  - Under the link object, centred: *Cancel upload*, a way out rather than a call to action: muted red text in a faint red outline (`--danger-soft`, `--danger-line`), the full red on a red wash with a stronger outline on hover (fine pointers) or press (see the colour table).
- **Ready beat:** the line completes and turns green, the chip draws its tick and changes its label, and the heading crossfades to "Ready to share". Nothing moves: *Cancel upload* fades out in place (`--d-swap`) and keeps its space until the receipt replaces it, so the panel doesn't shrink here only to grow again a moment later.
- **Receipt** (700 ms later):
  - The meter shows "2 days 23 h left" and "Until Mon 2 Nov, 10:10", with *Change* on the right.
  - *Change* opens a menu: 1 hour, 1 day, 3 days or 7 days, counted from the upload, plus *Custom…*, which opens the expiry dialog.
  - The line shows the share of the lifetime left.
- **Connection lost:** "Upload paused", a grey line and the chip "Paused" while `api.js` retries a part (after 1 s, then 2 s).
  - Hint: "Your connection dropped. The upload continues by itself when it's back, and the link keeps working. Keep this tab open."
  - "Waiting for the network" on the right of the meter.
  - When the retries run out while the browser is offline, the upload is kept for a resume and the link object stays: *Retry now* appears, and the upload resumes by itself on the `online` event (same locks and record checks as *Resume upload*). *Cancel upload* discards it. If another tab took it over meanwhile, the form says "The unfinished upload changed in another tab. Choose the file again."
  - When they run out while online (the server keeps failing), the form comes back with "The upload was interrupted. Your progress is saved: press "Resume upload" to continue."
- **Error retrying can't fix:**
  - The heading is "Upload failed" and the chip "Failed" (red).
  - The link is struck through and the line is dashed.
  - The copy actions are removed.
  - Hint: "The upload can't continue, so this link won't open. Your file and options are kept." (the server's reason is about one part and isn't shown), with *Upload again*. *Cancel upload* becomes *Change options*, which goes back to the form.
  - "This file in a terminal" disappears with the link.
  - A refusal before the link exists (at init) goes back to the form with the reason.

**Copy.**

- The icon swaps from copy to check (`scale(.85)` to 1, opacity, 2 px blur) and the label from "Copy link" to "Copied", in one grid cell, so the width never changes. It reverts after 2 s.
- The split button (*Copy link* and its chevron) is one control: pressing *Copy link* scales the pair together (`scale(.97)` on `.split`, not on the half), so the halves never come apart and the divider stays a hairline. The chevron presses on its own: its half darkens (`--accent-fill-hover`) and its icon shrinks (`scale: .86`), while *Copy link* stays still. The half under the pointer takes the hover fill. Focus rings stay keyboard-only (`:focus-visible`).
- A live region announces each copy. There is no toast on top.
- The copy menu is a popover that grows out of the chevron (`scale(.96)` plus opacity, 150 ms), lined up with the split button's right edge (`data-align="end"`). Where that doesn't fit (phones), it spans the link object exactly (`data-frame=".lo"`). Opened from the keyboard, it appears instantly with the first item focused; arrow keys, Home, End and Escape work, and focus returns to the chevron.
- Readable values show a preview line: *Link*, *Download command* (`curl -fOJ [-u fyl] '…'`).
- With encryption, each item shows its consequence instead:
  - *Link with key*: "Anyone with it can open the file."
  - *Link without key*: "Send the key another way."
  - *Key only*: "The 43 characters after #. Recipients paste it into the key field."
  - *Terminal command*: "fyl download, with the key." (the link lands in shell history)
  - *Terminal command without key*: "fyl download asks for the key."
- Only what carries the key (the link, the key, the command with it, *Share*) counts as the key having left the tab for the warning before closing it.

**Encrypted receipt** (2.4.0).

- The link with the key stays the one to share (like MEGA's export link). Under the actions (and the QR code when it is open) a note: "The key is only in this tab and in the link. fyl.at can’t show it again." It stays outside the block below, so whoever never opens that block still learns that closing the tab loses the key.
- Under the note, at every width, one quiet line offers the parts: a shield icon (16 px, `--accent-ink`) and "Even safer: send the key separately" (`--t-small`, `--ink-2`), with a disclosure chevron at the line's end (`--ink-3`, turning 180° over `--d-base` when open). The whole line is one 44 px button with `aria-expanded` and `aria-controls`; hover (fine pointers) takes `--ink`. A new upload closes it again.
- It opens (`.reveal`, like the option sections) one quiet block like the options' block (a `--line` edge, radius 12, no fill) with two rows parted by `--line-faint`: *Link without key* (shown without `https://`) and *Key*. Each row has its label (`--t-meta`, 600, `--ink-2`) over its value on one line (mono, `--t-xs`), cut in the middle to the characters that fit (`fitValue()`, refitted on resize), and a 40 px icon-only copy button ("Copy the link without the key", "Copy the key") whose icon turns into a tick for 2 s. The buttons copy the whole value. There is no `title`, so hovering never puts a whole key on the screen. The block's last row, under another `--line-faint` rule, is the checkbox "Remember keys on this device" ("Otherwise they’re forgotten when you close this tab."). It applies to every key (local storage while ticked, this tab's session storage otherwise), and *Forget this device* clears it with the keys.
- There is no terminal row: "This file in a terminal" shows the command without the key (see *Terminal*), and the command with the key stays in the copy menu.
- On phones the chevron of *Copy link* is hidden for an encrypted link: *Copy link* takes the full width, and this line stands in for the menu.
- Opened in a tab without the key (`#manage`, keys not remembered), the link object shows the link without the key and no key line; the copy menu offers *Link without key* ("Recipients also need the key.") and the keyless command, and the note reads "This tab doesn’t have the key, so this link alone can’t open the file. Send the link you copied when uploading; fyl.at can’t show the key again."
- Leaving the tab asks for confirmation until something with the key has been copied or shared.
- The password never rides in the link, the QR code or a copied command. The QR code encodes the link *Copy link* copies; *Share* passes only the link.
- The file row and recent uploads show the file's own size (not the stored one) and an *Encrypted* flag (shield icon) beside *Password* and *One download*. The name is known only to this browser, so a record without it reads "Encrypted file".

**Receipt sections.** Right after the ready beat they enter below the link object, which does not move (`@starting-style`, opacity plus 6 px, 220 ms, 40 ms stagger), while the panel eases once to its new height (`resize()`, 280 ms on the drawer curve). From Upload to the receipt the panel changes height twice, both eased: to the link view, then as the receipt enters. For a raw file the link arriving and the ready beat move nothing; an encrypted link arriving adds the key note and the key line, eased the same way. Drawn again (a reload, the `#manage` route, a new expiry, a lifted pause) they just appear. In order:

1. The password: value and *Copy* joined (the value wraps rather than hiding its end, and one tap selects it; a 20-character passphrase stays on one line at 390 px), "Send it separately from the link, in another app.", and the checkbox "Remember the password on this device" ("Otherwise it's forgotten when you close this tab.").
2. The private link: "Only you have it. Use it later to change the expiry or delete the file." with *Copy private link* and *Delete file*. While wrong passwords pause the link: "Too many wrong passwords have paused this link." and *Lift pause*. Under review, only *Delete file* is offered.
3. *Send another file* as a full-width secondary button.

The private link is never shown in full on screen, including in the terminal companion, because screens get shared.

**Recent uploads** work like a departures board.

- Each row starts with the time left (14 px, 600, tabular) and a 3 px lifetime line, then the middle-truncated name, so the end with the version and extension always shows. The meta line of a live link carries icons for Password and One download, plus the size. Its separators sit in front of their items and are clipped at the start of a line, so no line starts or ends with a lone dot.
- Live links come first. Closed links stay, muted, with an outlined tag ("Used", "Expired", "Deleted", "Removed"), a dashed line, the size and the reason ("Downloaded once · link closed", "Link closed Thu 29 Oct", "You deleted it", "Removed for breaking the rules"), without the Password and One download flags. A live link under review carries the tag "Under review" in its meta line; its time left keeps running.
- On phones the time leads the meta line, and the line runs under the row.
- Each row has *Manage* (a labelled button, a chevron on phones; the accessible name includes the file name) and *Forget* (×).
- Forget removes the row at once and offers *Undo* in the toast. There is no row animation. Focus moves to the next row's *Forget* (the picker once the list is empty); *Undo* puts it back on the restored row.
- *Forget this device* asks first.
- Status refreshes once the page is idle. An upload running in this tab keeps recent uploads opening in a new tab (existing rule).

**Dialogs.**

- Native `<dialog>`. Focus starts at the title (`tabindex="-1"`, no ring), so screen readers read it first and no button looks chosen when the dialog was opened with the pointer (Chrome rings a button focused by script). Tab then reaches the first control: the safe action in *Delete this file?* and *Forget this device?* (*Keep it*, *Keep them*), the number field in *Change the expiry*. Escape closes.
- On wide screens they are centred and scale from `.96`. Below 560 px they are bottom sheets: `translateY(100%)` to 0 over 320 ms with `--ease-drawer`, out in 200 ms.
- Exits use `transition-behavior: allow-discrete`.
- Titles name the action: "Delete this file?" (*Keep it* / *Delete file*), "Forget this device?" (*Keep them* / *Forget*), "Change the expiry" (*Cancel* / *Save expiry*), and the CLI guide "Use fyl in your terminal".

**Toast.**

- It is a `popover="manual"`, so it shows above dialogs. It enters from the bottom edge (200 ms) and leaves the same way (150 ms).
- It uses transitions, so rapid repeats retarget.
- Its timer pauses while the tab is hidden and while the pointer or focus is on it, then gives 2.5 s more.
- Its message is announced through the page's live region; the toast itself is not a live region.
- It offers *Undo* where an action can be reversed.

**Download page states.**

- **Ready.**
  - Meta "size · type"; for one-time links "One download" joins it.
  - One expiry line: "23 h 57 min left" and, beside it in meta text, "Until Sat 31 Oct, 10:09".
  - Download, then "Download in a terminal" (`curl -fOJ '…'`, "Saves the file under its original name."; for a protected link `curl -fOJ -u fyl '…'` with curl's password prompt as output and "curl asks for the password, then saves the file. The user name “fyl” is ignored.").
- **Files that can run code:** an amber notice above Download, "**This file can run code on your computer.** fyl.at doesn't scan files or know who sent it. Open it only if you trust the sender."
- **Protected.**
  - The page shows "Password required" with "size · Name hidden until unlocked".
  - The label "Enter the password the sender gave you." sits directly above the field, which has show/hide. Then the *Unlock* button and "After 5 wrong tries, this link pauses for 15 minutes."
  - The field is focused only with a fine pointer.
  - **Wrong password:** the form posts to the page, so the field comes back empty (the page never keeps a typed password). One 300 ms shake (−6 / 5 / −3 px), focus on the field with a fine pointer, and "Wrong password. 4 tries left." appears and is announced once. A password the server would refuse (outside 6 to 200 characters, control characters) isn't sent: "Passwords have 6 to 200 characters. Check what you typed."
  - **Paused:** a dashed field reading "Paused" and "Too many wrong tries. This link is paused for 15 minutes."
    - The disabled button counts down: "Try again in 14:57", tabular, never announced each second.
    - The 5-tries note is hidden.
    - At zero the page announces "You can enter the password again."
- **Unlocked:**
  - The lock tile becomes the file icon and the title becomes the name, in a cross-document view transition (`@view-transition {navigation: auto}`; groups `dlicon` and `dltitle`).
  - "Unlocked. Your download is starting." The download starts by itself; the button stays as a fallback.
- **Uploading.**
  - "Uploading · 1.14 of 1.84 GB" and "about 6 min left" over a real line (`transform: scaleX`, 300 ms per poll), with no dead button.
  - "Keep this page open. The download starts by itself when the file is ready."
  - The terminal command uses `--retry 120` ("Waits for the upload to finish, then saves the file.").
  - When it finishes, the line turns green and Download takes the status row's place.
- **Waiting for the sender** (stalled):
  - "Waiting for the sender · 0.78 of 1.84 GB" and "Paused", over a grey line.
  - "The sender may have closed their tab. The upload continues if they resume it within 24 hours. Keep this page open."
- **Encrypted** (2.4.0, `html[data-e2ee]`; `download.js` adds the state `key` and `data-key-error`).
  - **Address.** The key is read from the fragment once; the address becomes `/d/ID#KEY` (a crafted name or query in the path goes). The title stays "Encrypted file · fyl.at", every element and announcement with the decrypted name or the key (the terminal command; on the upload page the link, both values of the key block and the terminal command) has `translate="no"`, and the skip link moves focus without touching the fragment. A key sent in the path after `%23` is used, the address loses it, and a plain note says: "This key was sent to fyl.at in the address. For sensitive files, upload again and share the new link."
  - **Key missing:** the protected-card pattern with a key tile and "Key required", meta "size · Encrypted" (the file's own size, computed from the stored one).
    - "This link is missing its key. Paste the key the sender gave you." over a mono field (outside any form, no name, no autofill or spell check), then *Open file*.
    - Under it: "The key is the part of the link after #, which browsers don’t send to fyl.at." (the docs/E2EE.md §1 claim; a key sent after `%23` did reach fyl.at, and the note above may say so.)
    - The field takes the key, the whole link or an `AGE-SECRET-KEY-1…` identity, and the key is checked against the file's head and meta in the browser before any download request. A key that verified is kept in this tab's session storage, so a reload keeps working; it never goes into the address.
  - **Wrong key** (red field, the message under it): "This key doesn’t open this file. Check that you copied the whole link." Malformed: "This key is incomplete or damaged." Another file's link: "This link is for another file." The lead becomes "Paste the key or the whole link the sender gave you."
  - **Code didn't load** (a network blip while the page fetched its decryption code; never shown as a damaged file or a wrong key): the field goes, the red message reads "Couldn’t load the decryption code. Check your connection, then try again.", the lead "The link has its key, but this page couldn’t load what it needs to open the file." (without a key in the link: "This page couldn’t load what it needs to open the file."), and *Try again* (also on the password card) reloads the page: browsers keep a failed module load for the page's life. The key in the link survives the reload; a typed key is pasted again.
  - **Ready:**
    - The name, "size · type" and the amber warning, computed in the browser (the risky list adds pages, shortcuts and scripts for encrypted files).
    - Download is a button ("Download · 68.4 KB"), never a link to `/d/`, and starts only on a click, also after an early upload finishes. Under it: "Decrypted in your browser. fyl.at only stores the encrypted file."
    - The line under the card reads "fyl.at can’t check encrypted files or who sent them. Only open files you expected."
    - The terminal disclosure shows `fyl download '…#KEY'` once the key verified and `fyl download '…/d/ID'` before that, with "Needs the fyl tool, which [asks for the password, ][asks for the key, ]decrypts and saves the file. curl would get only encrypted data."
  - **Downloading:** the button looks disabled ("Decrypting…"; `aria-disabled`, so keyboard focus stays on it) over the status row and progress line of the uploading state: "Decrypting · 0.70 of 1.84 GB" and the percentage, then the info note "Keep this page open until the download finishes." The page decrypts, so leaving it asks first. Where the button goes (saved one-time, saved from memory, too large), focus moves to what replaces it.
  - **Saved:** the green ok-line "Decrypted and verified, saved by your browser as NAME." only after the last chunk verified and the browser closed the stream; the button reads "Download again" (gone for one-time links, which the page closes at once). Decrypted in memory (no service worker, at most 256 MiB): "Decrypted and verified: NAME." with *Save again*.
  - **Failed** (red message, an alert announced once; the button reads "Try again"): "The download failed, so the saved file is incomplete." followed by the reason: "The file is damaged or was changed. It can’t be decrypted safely.", "The file is incomplete.", "Download interrupted. Try again.", "The download was cancelled.", "Couldn’t load the decryption code. Check your connection, then try again." One-time links add "You can try again from this network for 15 minutes."
  - **Too large for this browser** (no streaming download, over 256 MiB, decided before any request): browsers other than Chromium save from memory until the browser matrix is measured (docs/E2EE.md §9.4), so the button goes and the note reads "This browser can save encrypted files of up to 256 MB. Use Download in a terminal below, or another browser." (iPhone and iPad: "Encrypted files over 256 MB can’t be saved on iPhone or iPad yet. Open the link on a computer.") In Chromium, when its download worker didn't start the download, the button stays as *Try again* and the note reads "Your browser didn’t start the download. Try again, or use Download in a terminal below."
  - **Password and encryption:** the password card, with the key block above the password field while the key is missing ("This link is missing its key. Paste the key the sender gave you, then the password."; *Open file* and the key note hidden, *Unlock* sends both). Without a key: "Paste the key first. The password alone doesn’t open the file." The page never navigates: the password goes as Basic to the info route and stays in page memory for the download; wrong tries and the pause look as for raw links.
  - **Still uploading:** as for raw links, with "Keep this page open. You can download the file once the upload is done."; when it finishes, the card changes in place.
  - **Can't be opened** (the gone layout, no line): "This file can’t be opened" / "The file is damaged or was changed. It can’t be decrypted safely. Ask the sender to upload it again."; "This file needs a newer fyl" / "It was made by a newer version of fyl. Open the link again later, or use the newest fyl tool."; from the server's unknown-mode rule, "This file needs a newer fyl.at" / "fyl.at can’t open this kind of file yet. Try the link again later." A raw file opened with a key in its link: "This link doesn’t fit the file" / "This link has a key, but the file isn’t encrypted. Ask the sender for the right link."
  - **Browser can't decrypt** (no WebCrypto X25519; the gone layout, no line, `data-platform`): "This browser can’t decrypt files" / "Update it or open the link in another browser, or use the fyl tool below." No key field (no key could work); the terminal disclosure stays, with the key from the link.
  - **Without JavaScript:** "This file is encrypted. Decrypting it needs JavaScript, or the fyl tool: `fyl download` with the link."
- **Gone**. The card keeps the ready page's shape, drained: the tile with the reason's icon, a plain title and a meta line under it ("fyl.at link · closed" for a link closed for good, "fyl.at link · paused" under review, "fyl.at link" where it may still work), the status in bold with a short note over the meter's empty track (where the time left was), the next step in the text, and *Send your own file* as the wide primary button with the wordmark's arrow:

  | Reason | Title | Status · note | Text |
  | --- | --- | --- | --- |
  | expired | This link has expired | Expired · No time left · the file is gone | "Files on fyl.at are deleted when their link expires. Ask the sender for a new link." (The Worker doesn't send the closing time; once it does, "It closed on Fri 30 Oct at 09:40." can lead.) |
  | consumed | This link was used | Link used · Its one download has started | "It allowed one download, and that download has started. Ask the sender for a new link if you need the file again." |
  | deleted | The sender deleted this file | Deleted · The file is gone | "The link no longer works. Ask the sender for a new one." |
  | removed | This file was removed | Removed · Taken down after a report | "It broke the rules of fyl.at and can't be downloaded." |
  | quarantined | This file is under review | Under review · Paused until a person has checked it | "Someone reported it. It can't be downloaded until a person has checked it." |
  | busy | Too many requests | Busy · Try again in a minute | "Your network opened a lot of links in a short time. Wait a minute, then try again." |
  | missing | This link doesn't work | Not found · No file at this link | "It may be incomplete, or the file is gone. Check the link, or ask the sender for a new one." |

  Encrypted links add *Damaged*, *Newer format*, *Wrong link* and *Not supported here* (a browser that can't decrypt, which keeps the terminal with the key).

  Under the card of a closed link: "Files on fyl.at are temporary. They're deleted when their link closes." The sender's own view of a closed link (home page, `#manage`) uses the same tags and lines with the owner's titles ("This file was deleted", "This private link doesn't work", "Can't reach fyl.at").

**Report form.**

- The title "Report a file" is `--t-form` (26 / 32), a step under the privacy page's title.
- Fields: the link (prefilled from *Report this file*), seven categories as a two-column radio list without boxes (one column on phones), details, name and email, and the good-faith checkbox.
- Details have one counter against the maximum, "12 / 4,000" (red past 4,000), on the hint's line, and the minimum on its own line under it: "At least 20 characters" with a ring, which becomes a green tick once there are 20 (one counter, never "/ 20" first and then "/ 4,000"). Characters are counted as the server counts them (code points, trimmed).
- Name and email are required. "(optional)" appears only when *Child sexual abuse* is chosen, following DSA Art. 16(2)(c) and `report.js`.
- Errors appear on submit, next to their fields, with one alert: "Check the 5 marked fields." The first invalid field gets focus, and fixing a field clears its own error at once; the count follows without announcing each key.
- Details error: "Write at least 20 characters. You have 12."
- Cloudflare Turnstile, only when the Worker's `/config.js` hands the page a site key: the widget sits above *Send report*, as wide as the form (`flexible`, 65 px), `compact` where the form is under 300 px wide (phones), in the page's theme. *Send report* stays usable; a refused check shows the server's "Please confirm you are human and send again." in the form's error line, and the widget starts a new check after every answer. If the widget can't load: "The check didn't load. Reload the page, or allow challenges.cloudflare.com." under it. Only `/report` allows `challenges.cloudflare.com` in its CSP.
- Success: "Report received", the case number in a field joined to a *Copy* button, "Your case number. Mention it if you write to us about this report.", and "A person will check the file. It may be paused while we look, and it's removed if it breaks the law. If you gave an email address, we may write to you about this case." For a file that closed already: "The file is no longer available for download, but your report is on record. …"

**Terminal.**

- Every terminal is one component, `.tw`: a window, always dark (`#131d33` to `#0b1120`), with a title bar holding three window dots (red, amber, green) and its title. Each command sits in a darker row with a green `$` and its copy button; its output follows under the row in mono, marked with a green `↳`.
- The window sets its own tokens (`--ink` `#f1f5fb`, `--ink-2` `#cbd5e1`, `--ink-3` `#9aa8bd`, `--accent-ink` `#9db9ff` for flags, links and focus rings, output and comments `#8a9ab1`, prompts `#4ade80`), so it reads the same in both themes. On its lightest ground: lead and notes 6.96 : 1, output and comments 5.86 : 1 (6.48 : 1 on a row), prompts 9.63 : 1, flags and links 8.65 : 1, commands 15.3 : 1.
- One text column per window (`--tw-x`, 18 px from the frame): headings, leads, `# comments`, notes, the `$` prompts and the `↳` arrows start on it. The command rows reach `--tw-inset` (10 px) from the frame, so their darker fill hangs 8 px into the gutter while their text sits on the column, and the output text starts where the command text does (the column, one prompt character, the 10 px gap). The download page's window narrows the column to 12 px and the rows to 4 px from the frame on phones, so a link's first line still fits.
- **Companion** ("bash — fyl"): the heading "Made for cli, too." with "cli" in green mono, "Install once. Send files straight from your terminal.", then the install and upload commands with their real output ("Installed fyl to /usr/local/bin"; the printed link, or with `--password` the prompt "Password (press Enter to generate one):" and "Password: …"). There is no `fyl rm` sample in it. "This file in a terminal" joins the same window under a rule once the link exists (the recipient's `curl`, or for an encrypted file `fyl download '…/d/ID'` without the key, which asks for it, under "For recipients who use the fyl tool, which decrypts, and to delete it later.", so the companion never shows the key; and, on the receipt, `fyl rm`), and *`>_` All CLI options ↗* closes it.
- The upload command follows the chosen options (`--expires 3d --once --password --encrypt`) token by token: a flag that appears is added, one that goes is removed, and a changed value (`--expires 3d` to `7d`) is rewritten in place. Nothing else is redrawn, so nothing blinks. A flag fades in only the first time it appears; when it comes back (passing through the default 1 day, which has no flag, or after a briefly invalid custom value) it is simply there again. When a flag makes the command wrap onto a second line (the first `--expires`) or the password lines join its output, the section eases to its new height (`resize()`, the custom expiry's timing: 280 ms on the drawer curve, 180 ms closing) instead of pushing the page at once; a new file's command just changes, inside the file card's morph.
- **CLI dialog** ("All CLI options", *CLI* in the header): the heading, the one-line intro and the tabs (Install, Upload, Download, Delete) stay in theme colours; under them the commands sit in a "bash — fyl" window, radius 12: `# comments` in mono, each command row with its output, and the tab's note at the bottom of the window under a rule ("Deleted archive.zip." is the Delete tab's output). Every tab's panel sits in the same grid cell and the hidden ones keep their space (`visibility: hidden`), so the window is as tall as the tallest tab at every width and switching tabs never changes the dialog's height; shorter tabs keep their note at the bottom.
- **Download page**: "Download in a terminal" stays a disclosure in the card; opened, it shows a "bash" window, radius 12 and without a drop shadow (the disclosure clips it), with the command row, curl's real output where there is one, and the hint under it. It eases open and shut like the upload page's reveals in every browser (download.js runs the height, since only Chromium can ease a `<details>` to its auto height in CSS): the window fades and slides 6 px, a click on the way turns it around, and it stays open until the closing ease ends; reduced motion toggles at once.
- Commands that carry a link may break after `/ _ - .` in the link (flags stay whole), and the link's last 8 characters stay together with the closing quote.

### Motion

Motion tokens:

| Token | Value | Use |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(.23, 1, .32, 1)` | enter, exit, press, reveal |
| `--ease-drawer` | `cubic-bezier(.32, .72, 0, 1)` | phone bottom sheet, reveals opening |
| `ease` / `linear` | | colour and hover / progress fill |
| `--d-press` | 160 ms | `scale(.97)` on every button (`.99` on the drop zone) |
| `--d-hover`, `--d-swap` | 150 ms | hover colour, label and icon swaps, menus, every exit |
| `--d-base` | 200 ms | an option toggle's fill and the options block's edge, toast and dialog enter, chevrons |
| `--d-slide` | 220 ms | the expiry pill gliding (`--ease-out`), receipt sections (40 ms stagger) |
| `--d-reveal`, `--d-close` | 280 ms, 180 ms | reveals opening (`--ease-drawer`) and closing (`--ease-out`): custom expiry, option sections, QR code, the key block; a block easing to a new height (`.sizing`, `resize()` in `app.js`): the panel from Upload to the link, back to the start and as the receipt enters, the terminal when its command wraps; the link field and its actions fading up 4 px as the link arrives (`--d-reveal`, `--ease-out`, the actions 40 ms later) |
| (pulse) | 1200 ms, alternating | the placeholders and the link field's bar while the link is being created (opacity 1 to .55) |
| `--d-morph` | 280 ms | view transitions: file chosen, Upload to link, back to start, unlock |
| `--d-sheet` | 320 ms in, 200 ms out | phone sheet |
| `--d-fill` | 150 ms linear | the meter, per update |

Every duration is written as `calc(Xms * var(--slow))`, so setting `--slow: 4` on `:root` slows everything down for review.

The view transitions:

- They are used only for changes that happen once per task.
- While one runs (at most 280 ms), the browser sends clicks to the document element; that is how view transitions work, and `pointer-events` on the pseudo-elements doesn't change it.
- The download page opts in to cross-document transitions for the unlock reload only; a link to another page skips the transition (`pageswap`).
- Only the named groups morph: `linkobj` (`#create-button`, `#lo`), `filecard` (`#dropzone`, `#chosen-file`), and on the download page `dlicon` and `dltitle`.
- The rest of the page (root) switches at once: its new picture is live, so the transitions inside it (the Upload label, a reveal, the panel's height) still play. A crossfade of the page let it show through to the empty canvas behind, a blink of the whole page (measured: the unchanged header lost half its brightness in the dark theme). The link object's old picture fades out in 100 ms, the new one in over 200 ms after 60 ms. No blur anywhere.

What never moves:

- data (countdowns, percentages);
- the page on load;
- rows in recent uploads;
- changes made from the keyboard (arrow keys, menus opened from the keyboard);
- the theme change (`html.theme-change` switches transitions off for two frames);
- hover lifts and glows (there are none).

Hover styles exist only inside `(hover: hover) and (pointer: fine)`.

**Reduced motion** is written under `@media (prefers-reduced-motion: reduce)`.

- Kept: opacity and colour fades (≤ 150 ms), the progress fill, the line's colour change, the red error border, the link field and actions arriving as a 150 ms fade, and view transitions as 150 ms crossfades of the named groups with no delay and no morph (the rest of the page switches at once, as always). The phone sheet fades out instead of sliding.
- Removed: press scale, travel, the option toggles' icon scale and blur, the pill sliding, the shake, the reveal settle, the tick drawing, new-flag fades, the placeholders' and the link bar's pulse, the key line's turning chevron, height easing (panel and terminal) and smooth scrolling (`html` scrolls smoothly only under `no-preference`).
- One script asks about reduced motion: `resize()` in `app.js` sets no eased height under it. Everything else is in the CSS.

### Language menu

- Every page's footer ends with a quiet button: a globe icon (16 px) and the current language's own name ("Deutsch"), `aria-label` "Language: Deutsch" in that language. On the download page it sits next to the theme button.
- It opens a popover exactly like the theme menu (same `.menu`, placement, growth from the trigger, keyboard handling by `theme.js`). Each item is a link (`<a class="menu-item" role="menuitemradio">`) to the same page in that language, with the language code in small caps where the theme menu has its icon, the native name, and the check on the current one. No cookie remembers the choice; the address is the choice.
- Download links keep their address: their menu links to `?lang=<code>`, and `download.js` carries the fragment (an encrypted link's key) along.
- A translated privacy page has one bordered note under the lead that the English version is binding, with a link to it.

## Admin dashboard

The operator's dashboard on `admin.fyl.at` (`dist/admin/`) uses the site's stylesheet, tokens, header, theme menu (light, dark, system) and the always-dark terminal window; `admin.css` adds only its layout (its class names must not collide with the site's: the funnel's are `funnel-steps` and `fstep`, because `styles.css` already numbers `.steps`). Its order puts what needs acting on before traffic: the title row, a **status strip**, the notice, the tiles, the funnel, the charts, the product mix, the audience lists, the billing panel, readiness and open reports, Events. The strip is one line of small text under the title (it wraps on a phone), a 44 px link with an icon: readiness, uploads accepted or paused, E2EE, open reports with the most urgent priority, overdue cleanups, the last 24 hours' problem counters and the live version, joined by " · ". All well, it is quiet: the `--ok` wash and line with a check icon; once something needs a look it takes the notice's amber (`--warn-wash`, `--warn-line`, the alert icon), and the parts that need it are set in weight 600, so the state never depends on colour alone. While readiness has something to act on, the readiness and open-reports windows move up under the strip (moved in the DOM, so reading and tab order follow); otherwise they stay above Events. Totals are tiles, five in a row: four totals of the range and *Storage in use*, a figure of now (its note ends "· now", "· sample" on the local dashboard), whose 44 px info button in the tile's corner opens a popover (the menus' surface, placed by `theme.js`) saying what it counts. *This billing cycle* is a full-width panel of its own, not a tile, because it doesn't follow the range: the period and day, the estimate as one figure ("About **$5.00** so far (estimate)"), the meters grouped by product as the ranked lists draw them (name, used / included, the thin cobalt bar as the share of the allowance), dollars only where a meter went above its allowance (its amount then in ink, weight 600; no colour of its own; a meter's row may show a third decimal, the line under the total is in cents like the total), the short amounts ("10M") hidden from screen readers, which hear them in full ("10,000,000 requests"), *Open billing* as a secondary button that opens Cloudflare in a new tab, and two meta lines on what the estimate is and leaves out. Each chart is one series of cobalt (`--bar`) bars with 4 px rounded tops from a single baseline, a hairline grid and ticks in meta ink, a hover readout under it (also on a tap, mapped through the SVG's scale; a tapped value stays until the next tap, since lifting a finger also fires `pointerleave`) and the same values as a table behind *Show as table*, so nothing depends on colour or hover alone. Charts show whole buckets in Vienna time (captions say so): the running bucket is drawn lighter and read as "… so far", and buckets before their kind was counted (page views, uploads and downloads each have their own start) share one `--track` band labelled "not counted yet" (left out of the "most on" readout; the tiles then say "since 31 Oct", the Page views tile before its automated views: "since 31 Oct · +358 automated (…)", and the product-mix and downloads cards add it to their base line). An empty byte axis reads 0 to 1 KB, never "1 bytes". The Page views tile, chart and audience lists count browsers that named a language; the tile's note names the automated views beside them ("+358 automated (other 168 · curl 147 · scripts 52 · bots 43)"), tile notes wrap rather than being cut, and the Uploads note gives the median and the web's and the CLI's share of the uploads with a recorded client ("median 1 MB · web 62 % · CLI 29 %"), not the average. Under the tiles, the funnel *From visit to download* is a panel of five figures in wells (`--well`, the tile's label style, a 24 px figure, a meta line with the step's rate such as "31 % of home page views"), a quiet chevron in `--ink-3` between them while they sit in one row; three to a row up to 900 px, two on a phone, without chevrons. Ranked lists show the name, count and share with a thin bar whose length is that share of the card's base (not of the largest entry, so a bar never reads fuller than its percentage and cards compare), and each card names its base under its title ("of 203 browser page views"). A name is never cut to fit its count: it keeps at least 6.5em, a long count wraps between its parts ("300 · 18 % ·" over "2 % of GB-days"), a long name to a second line, and only past two lines (a visitor's long referrer or campaign tag) does it end in an ellipsis. Where entries overlap (Upload options: an upload can have a password and one download), each share stands alone and the base says "options combine". Cards look alike: each shows at most 5 rows, the first ones then a muted "N more" row (its name in `--ink-3`, no bar; muted rows of what a list leaves out count toward the 5), names on one line ending in an ellipsis (the title has the whole name), and a 44 px *Show all N* (*Show top 20* when the server cut more) at the card's foot that opens the whole list in the short list's place, scrolling within about the same height, with *Show less* staying at the foot. Shares use largest-remainder rounding, so they add up to 100, with "<1" and ">99" at the ends. Devices and Languages end with a muted "Unknown device" / "No language" row, Referrers with "fyl.at's own pages" (counted in the funnel instead), and Closed links by reason and Downloads per transfer with "Not recorded (older)" (written before the field existed; Downloads per transfer's base is every transfer closed in the range), so each adds up to its base. Cards side by side are as tall as the tallest, rows start at the top, and an empty card keeps the size with "Nothing in this range" centred. Each section holds eight cards (the product mix and the audience lists, *Downloads by client* among the first), in four columns, two below 1100 px and one below 560 px, so rows are always full. A product-mix row (how transfers ended, downloads per transfer, lifetimes, upload sizes, uploads by client, upload options, CLI downloads) uses the same cards; buckets that have an order (sizes, downloads per transfer) keep it instead of being ranked; a row's bar always measures what its first share does (how transfers ended: the count and its share of the transfers, then "· 2 % of GB-days"). The Events panel draws only groups with something to count, each health group with one meta sentence on what a non-zero value means, names the empty groups in one line below, and keeps every counter in a closed *All counters* table. The billing panel adds "on pace for …" to its figure, R2's daily storage peaks as small cobalt bars without an axis, and under the Workers meters "fyl-at, last 24 hours" with its errors and outcomes ("0 errors in 4,321 requests (client went away 7)"; weight 600 and ink once an error is counted; left out when the estimate has no such answer). The range buttons keep their 38 px pill inside a 44 px label. Readiness and the open reports sit in terminal windows titled "bash — fyl admin", as `npm run admin` prints them (readiness with `Uploads: accepted | PAUSED`, a pause in the danger colour, `E2EE` and the report queue line), and each case offers its `npm run admin -- decide` command with a decision picker and Copy. Values from visitors (referrers, campaign tags) are inserted as text only.

## Accessibility rules

- **Contrast.** Every text pair in the colour table is at least 4.5 : 1 in both themes. Field borders, the fill of an option toggle that is on and every line that carries meaning (progress, lifetime, paused, dashed closed) are at least 3 : 1. Words always name what a line shows.
- **Targets.** At least 44 px: the theme button, wordmark, the option toggles (36 px tall, their checkbox 44 px), *Why?* under encryption, *Make a new password*, *Change*, *Manage*, *Forget*, every *Copy* (the terminal blocks' copy buttons too; the icon copy buttons in the link field and the key block are 40 px, in rows 48 and 56 px tall), the key line "Even safer: send the key separately", the CLI tabs, the footer links, *Report this file*, every icon button, toast actions.
- **Focus.** The ring is 2 px `--accent-ink`. Text fields show it as their border plus a 1 px ring (red while invalid); the expiry control draws it around the whole control, above the pill.
- **Keyboard.**
  - Native buttons, radios and dialogs.
  - Arrow keys work in the expiry control and in menus; Escape and light dismiss come from the Popover API.
  - `aria-expanded` is set on menu triggers. Focus goes to the first item when a menu opens from the keyboard, and back to the trigger when it closes.
  - After the Upload morph, focus is on *Copy link* (on the panel's heading until the link arrives). After Cancel and *Change options*, on Upload. After *Send another file* and after removing the chosen file, on the picker. After *Forget this device*, on the picker. After a failure, on *Upload again*. After unlocking, the download starts by itself.
  - A skip link is on every page.
- **Screen readers.**
  - One polite live region announces: file chosen, upload started or resumed, upload paused, upload complete, each copy, cancel, every toast message, the end of a password pause, and a closed link. A wrong password is said once, by the message the field is described by (itself a live region).
  - A swapped label (Copy / Copied, the headings, the chip) hides its other half with `visibility: hidden` once it has faded, so accessible names hold only the shown one. The drag layer's text and the sr-only "Upload a file" heading are hidden whenever they don't apply.
  - On phones the page heading stays for screen readers (visually hidden) once the upload starts.
  - While a management link loads, the panel reads "Loading your link…" and is `aria-busy`.
  - The report form's error count is an alert only when the form is sent; while fields are fixed it updates quietly.
  - Countdowns and the time left are never live.
  - Progress uses `role="progressbar"`. The meter is a `role="group"` named "Upload progress" or "Time left".
  - Option toggles are native checkboxes (no `role="switch"`), each described by its section's description and controlling that section.
  - A disabled button's accessible name is its reason.
  - Middle-truncated names (recent uploads) keep their full text in the DOM and in `title`. The link field and the key block cut their values in the DOM itself and have no `title`, so no whole key reaches the screen or a tooltip; their copy buttons and the copy menu copy the whole value.
- **Touch.**
  - "Choose a file" wording on touch screens.
  - Password and key fields are focused automatically only with a fine pointer, so the phone keyboard doesn't cover the card.
  - Inputs are 16 px.
  - The docked Upload undocks while the keyboard is open.
- **Content security.** No external fonts, scripts, styles or images. There are no inline style attributes: dynamic values such as the lines' `--v` and the expiry pill's size and position are set through the CSSOM (`element.style.setProperty`). There are no inline handlers.
- **Content rules.** No customer sign-up, invented statistics or decorative dashboard widgets.

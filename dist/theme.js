// Runs in <head> before first paint, on every page. It drops an unfinished upload's record whose window has closed.
// The colour theme: System (default) leaves it to the CSS media query; Light or Dark pin it with html[data-theme].
// Then, once the page is parsed, the popover menus every page shares: placed under (or above) their trigger and grown
// out of it, instant when opened from the keyboard, with arrow keys, Home and End. Escape and light dismiss come from
// the Popover API.
(() => {
  'use strict';
  // Every fyl.at page drops an unfinished upload's record once the server's 24-hour upload window has closed
  // (docs/E2EE.md §2.5): nothing can resume it then, and an encrypted upload's record holds its part checksums.
  try {
    const pending = JSON.parse(localStorage.getItem('fyl-upload') || 'null');
    if (pending?.uploadId && !(Date.now() < pending.created + 86400000)) localStorage.removeItem('fyl-upload');
  } catch {}
  // The upload page's drop zone says "file or folder" where the browser can pick folders (not iOS or iPadOS); set
  // before the first paint so its text doesn't change under the reader (app.js decides for good, FOLDERS).
  try {
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios || !(window.showDirectoryPicker || 'webkitdirectory' in document.createElement('input'))) document.documentElement.classList.add('no-folders');
  } catch {}
  const KEY = 'fyl-theme', root = document.documentElement, dark = matchMedia('(prefers-color-scheme: dark)');
  const COLOURS = {light: '#f5f7fb', dark: '#070b14'}, ICONS = {system: 'monitor', light: 'sun', dark: 'moon'}, NAMES = {system: 'System', light: 'Light', dark: 'Dark'};
  // The trigger's name says the choice in the page's language: its data-label ("Colour theme: {name}") with the menu
  // item's own text; a page without them (the dashboard) keeps the English names.
  const nameOf = theme => document.querySelector('[data-theme-choice="' + theme + '"] span')?.textContent || NAMES[theme];
  let choice = 'system';
  try { const saved = localStorage.getItem(KEY); if (saved === 'light' || saved === 'dark') choice = saved; } catch {}

  function apply() {
    if (choice === 'system') delete root.dataset.theme; else root.dataset.theme = choice;
    // One theme-color per scheme; a pinned theme sets both.
    document.querySelectorAll('meta[name="theme-color"]').forEach(meta => { meta.content = COLOURS[choice === 'system' ? (meta.media.includes('dark') ? 'dark' : 'light') : choice]; });
    document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.themeChoice === choice)));
    document.querySelectorAll('[data-theme-trigger]').forEach(button => {
      button.querySelector('use')?.setAttribute('href', '#i-' + ICONS[choice]);
      button.setAttribute('aria-label', (button.dataset.label || 'Colour theme: {name}').replace('{name}', nameOf(choice)));
    });
  }
  apply();
  // A theme change is instant: no colour transition runs while the tokens switch.
  function change() {
    root.classList.add('theme-change'); apply();
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-change')));
  }
  dark.addEventListener('change', change);

  // Was the last interaction a key press? Menus opened from the keyboard appear at once, with the first item focused.
  let viaKeyboard = false;
  addEventListener('keydown', event => { if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) viaKeyboard = true; }, true);
  addEventListener('pointerdown', () => { viaKeyboard = false; }, true);
  function place(menu, trigger) {
    menu.style.width = '';
    // A trigger with data-anchor (the drop zone, a large button) places its menu at the first visible element it names
    // (the zone's "choose" words), centred under it with data-align="center".
    const anchor = trigger.dataset.anchor && [...document.querySelectorAll(trigger.dataset.anchor)].find(element => element.getClientRects().length);
    const box = (anchor || trigger).getBoundingClientRect(), gap = 6;
    let width = menu.offsetWidth;
    // A trigger with data-align="end" (the chevron of a split button) lines the menu up with its right edge. Where that
    // doesn't fit (a phone), a trigger with data-frame takes the box it names instead: the menu spans exactly that box.
    const frame = trigger.dataset.align === 'end' && box.right - width < 8 && trigger.dataset.frame ? trigger.closest(trigger.dataset.frame)?.getBoundingClientRect() : null;
    if (frame) { menu.style.width = frame.width + 'px'; width = menu.offsetWidth; }
    const height = menu.offsetHeight;
    const right = box.right - width >= 8 && (trigger.dataset.align === 'end' || box.left + width > innerWidth - 8 || box.left + box.width / 2 > innerWidth / 2);
    const below = box.bottom + gap + height <= innerHeight - 8 || box.top - gap - height < 8;
    const centre = trigger.dataset.align === 'center' ? Math.min(innerWidth - width - 8, Math.max(8, box.left + box.width / 2 - width / 2)) : null;
    const left = frame ? frame.left : centre ?? Math.max(8, right ? box.right - width : Math.min(box.left, innerWidth - width - 8));
    menu.style.left = left + 'px';
    menu.style.top = (below ? box.bottom + gap : box.top - gap - height) + 'px';
    menu.style.setProperty('--origin', Math.min(width - 12, Math.max(12, box.left + box.width / 2 - left)).toFixed(0) + 'px ' + (below ? '0' : '100%'));
  }
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.addEventListener('click', event => {
      const trigger = event.target.closest?.('[popovertarget]'), menu = trigger && document.getElementById(trigger.getAttribute('popovertarget'));
      if (menu) menu.trigger = trigger;
    }, true);
    document.querySelectorAll('.menu[popover]').forEach(menu => {
      menu.addEventListener('beforetoggle', event => {
        if (event.newState === 'open') menu.classList.toggle('instant', viaKeyboard);
        else menu.trigger?.setAttribute('aria-expanded', 'false');
      });
      menu.addEventListener('toggle', event => {
        if (event.newState !== 'open' || !menu.trigger) return;
        place(menu, menu.trigger); menu.trigger.setAttribute('aria-expanded', 'true');
        if (viaKeyboard) menu.querySelector('.menu-item:not(:disabled)')?.focus();
      });
      menu.addEventListener('keydown', event => {
        // Tab leaves the menu: it closes, which hands focus back to its trigger, so Tab then moves on from there in
        // the page's own order instead of to whatever sits under the menu.
        if (event.key === 'Tab') { menu.hidePopover(); return; }
        const items = [...menu.querySelectorAll('.menu-item:not(:disabled)')], index = items.indexOf(document.activeElement);
        const next = {ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1}[event.key];
        if (next === undefined || !items.length) return;
        event.preventDefault(); items[(next + items.length) % items.length].focus();
      });
    });
    addEventListener('resize', () => document.querySelectorAll('.menu[popover]').forEach(menu => { if (menu.matches(':popover-open') && menu.trigger) place(menu, menu.trigger); }));
    // A scroll closes an open menu, as native menus do, so it never drifts away from its trigger (fixed, it would stay put
    // while the trigger scrolls; re-placed, it would flip above and below as the trigger leaves the screen). Capture
    // catches scrolls of any scrolling box, not only the page; a scroll inside the menu itself leaves it open.
    addEventListener('scroll', event => document.querySelectorAll('.menu[popover]').forEach(menu => { if (menu.matches(':popover-open') && !menu.contains(event.target)) menu.hidePopover(); }), {passive: true, capture: true});
    document.querySelectorAll('[data-theme-choice]').forEach(button => button.addEventListener('click', () => {
      choice = button.dataset.themeChoice;
      try { if (choice === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch {}
      change();
      const menu = button.closest('.menu');
      menu?.hidePopover?.(); menu?.trigger?.focus({preventScroll: true});
    }));
  });
})();

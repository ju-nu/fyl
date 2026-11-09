// The scripted page tests/web-app.test.ts runs dist/ scripts against: an element exists once a script asks for it and
// keeps what the script sets, storage lives in memory, and Web Locks behave like the browser's. Moved here unchanged
// from tests/web-app.test.ts, which describes how the tests use it.
export type Listener = (event: Record<string, unknown>) => unknown;
export const camel = (name: string) => name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

export class El {
  textContent = ''; innerHTML = ''; value = ''; title = ''; type = ''; placeholder = ''; href = ''; className = '';
  hidden = false; checked = false; disabled = false; open = false; translate = true; isConnected = true;
  tabIndex = 0; scrollLeft = 0; clientWidth = 0; scrollWidth = 0; opened = 0;
  files: File[] = [];
  dataset: Record<string, string> = {}; style: Record<string, string> = {};
  attributes = new Map<string, string>(); listeners = new Map<string, Listener[]>(); found = new Map<string, El>();
  classes = new Set<string>();
  classList = {
    add: (name: string) => { this.classes.add(name); }, remove: (name: string) => { this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force = !this.classes.has(name)) => { if (force) this.classes.add(name); else this.classes.delete(name); return force; },
  };
  constructor(public id = '') {}
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  toggleAttribute(name: string, force = !this.attributes.has(name)) { if (force) this.attributes.set(name, ''); else this.attributes.delete(name); return force; }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  removeEventListener() {}
  // Dispatches an event to the listeners; resolves once async ones are done.
  fire(type: string, event: Record<string, unknown> = {}) {
    return Promise.all((this.listeners.get(type) || []).map(listener => listener({ target: this, preventDefault() {}, ...event })));
  }
  closest(selector: string): El | null {
    if (selector.startsWith('#')) return this.id === selector.slice(1) ? this : null;
    const data = /^\[data-([a-z-]+)\]$/.exec(selector)?.[1];
    return data && camel(data) in this.dataset ? this : null;
  }
  querySelector(selector: string) {
    if (!this.found.has(selector)) this.found.set(selector, new El());
    return this.found.get(selector) as El;
  }
  querySelectorAll(): El[] { return []; }
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0 }; }
  getAnimations() { return []; }
  animate() { return { finished: Promise.resolve() }; }
  showModal() { this.opened++; }
  focus() {}
  select() {}
  scrollIntoView() {}
  replaceChildren() {}
  append() {}
  remove() {}
  close() {}
  showPopover() {}
  togglePopover() {}
  clicks = 0; offsetWidth = 0; src = ''; download = ''; rel = '';
  click() { this.clicks++; }
  get previousElementSibling() { return new El(); }
}

export class Doc extends El {
  elements = new Map<string, El>(); documentElement = new El(); body = new El(); head = new El(); activeElement = this.body;
  getElementById(id: string) {
    if (!this.elements.has(id)) this.elements.set(id, new El(id));
    return this.elements.get(id) as El;
  }
  created: El[] = [];
  createElement() { const element = new El(); this.created.push(element); return element; }
  execCommand() { return false; }
}

export class MemoryStorage {
  items = new Map<string, string>(); log: string[] = []; refuse = new Set<string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.refuse.has(key)) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.items.set(key, String(value)); this.log.push('set ' + key);
  }
  removeItem(key: string) { this.items.delete(key); this.log.push('remove ' + key); }
  json(key: string) { return JSON.parse(this.getItem(key) ?? 'null'); }
}

// Web Locks as the browser grants them: exclusive or shared, ifAvailable, an abort signal, and query().
export interface Held { name: string; mode: string; page: number }
export interface LockOptions { mode?: string; ifAvailable?: boolean; signal?: AbortSignal }
export class Locks {
  held: Held[] = []; waiting: { lock: Held; start: () => void }[] = []; page = 0;
  // Runs just before a request is decided: a test changes storage here the way another tab could meanwhile.
  beforeGrant: (name: string) => void = () => {};
  query() { return Promise.resolve({ held: this.held.map(({ name, mode }) => ({ name, mode })), pending: [] }); }
  request(name: string, options: LockOptions, callback: (lock: object | null) => unknown) {
    const lock = { name, mode: options.mode || 'exclusive', page: this.page };
    return new Promise((resolve, reject) => {
      const start = () => {
        this.held.push(lock);
        Promise.resolve(callback({ name, mode: lock.mode })).then(resolve, reject).finally(() => this.release(lock));
      };
      queueMicrotask(() => {
        this.beforeGrant(name);
        if (this.free(lock)) start();
        else if (options.ifAvailable) Promise.resolve(callback(null)).then(resolve, reject);
        else {
          this.waiting.push({ lock, start });
          options.signal?.addEventListener('abort', () => {
            this.waiting = this.waiting.filter(wait => wait.lock !== lock); reject(new DOMException('Aborted.', 'AbortError'));
          }, { once: true });
        }
      });
    });
  }
  // Another tab takes the lock and keeps it until the returned function is called.
  take(name: string) {
    let release = () => {};
    const page = this.page;
    this.page = -1;
    void this.request(name, {}, () => new Promise<void>(done => { release = done; }));
    this.page = page;
    return () => release();
  }
  // A closed page frees its locks and its requests are dropped.
  close(page: number) {
    this.waiting = this.waiting.filter(wait => wait.lock.page !== page);
    for (const lock of this.held.filter(held => held.page === page)) this.release(lock);
  }
  private free(lock: Held) { return !this.held.some(held => held.name === lock.name && (lock.mode === 'exclusive' || held.mode === 'exclusive')); }
  private release(lock: Held) {
    this.held = this.held.filter(held => held !== lock);
    for (const wait of [...this.waiting]) if (this.free(wait.lock)) { this.waiting = this.waiting.filter(other => other !== wait); wait.start(); }
  }
}

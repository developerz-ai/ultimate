/**
 * Just enough DOM for the client router's unit tests, written for them the way `hydrate-replay`'s
 * fakes are: elements with attributes and children, the selectors the router uses (tag, `[a]`,
 * `[a="v"]`, `[a~="v"]`, `:not([src])`, comma lists), documents that adopt and swap bodies, a
 * window with history, location and timers, and a `DOMParser` that answers a fetched string with a
 * document the test built. What a browser DOES with a document is proven in Chrome
 * (`packages/cli/e2e/client-navigation-*.e2e.test.ts`); this is the branch coverage beside it.
 */

import { CLIENT_BUILD_META } from '@ultimat3/core';

type Attrs = Readonly<Record<string, string>>;

/** One compound selector: a tag and attribute conditions, optionally excluding a `src`. */
interface Simple {
  readonly tag: string;
  readonly conditions: readonly { name: string; op: string | undefined; value: string }[];
  readonly notSrc: boolean;
}

const parse = (selector: string): readonly Simple[] =>
  selector.split(',').map((part) => {
    const text = part.trim();
    const notSrc = text.includes(':not([src])');
    const clean = text.replace(':not([src])', '');
    const tag = /^[a-z0-9]*/i.exec(clean)?.[0] ?? '';
    const conditions = [...clean.matchAll(/\[([\w:-]+)(?:(~?=)"?([^"\]]*)"?)?\]/g)].map((m) => ({
      name: m[1] ?? '',
      op: m[2],
      value: m[3] ?? '',
    }));
    return { tag: tag.toUpperCase(), conditions, notSrc };
  });

const matches = (el: FakeElement, selector: string): boolean =>
  parse(selector).some(
    (simple) =>
      (simple.tag === '' || simple.tag === el.tagName) &&
      !(simple.notSrc && el.hasAttribute('src')) &&
      simple.conditions.every(({ name, op, value }) => {
        const said = el.getAttribute(name);
        if (said === null) return false;
        if (op === undefined) return true;
        if (op === '~=') return said.split(/\s+/).includes(value);
        return said === value;
      }),
  );

export class FakeElement {
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  ownerDocument: FakeDocument;
  text = '';
  style: Record<string, string> = {};
  nonce = '';
  async = true;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  __x?: Promise<unknown>;
  clicks = 0;

  constructor(
    doc: FakeDocument,
    tag: string,
    attrs: Attrs = {},
    content: readonly FakeElement[] | string = [],
  ) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value);
    if (typeof content === 'string') this.text = content;
    else for (const child of content) this.append(child);
  }

  get id(): string {
    return this.getAttribute('id') ?? '';
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  getAttributeNames(): string[] {
    return [...this.attrs.keys()];
  }
  get attributes(): { name: string; value: string }[] {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get className(): string {
    return this.getAttribute('class') ?? '';
  }
  get outerHTML(): string {
    const attrs = [...this.attrs].map(([n, v]) => ` ${n}="${v}"`).join('');
    const tag = this.tagName.toLowerCase();
    return `<${tag}${attrs}>${this.text}${this.children.map((c) => c.outerHTML).join('')}</${tag}>`;
  }
  // The properties the router reads and writes on links, scripts and anchors.
  get href(): string {
    return new URL(this.getAttribute('href') ?? '', this.ownerDocument.baseURI).href;
  }
  set href(value: string) {
    this.setAttribute('href', value);
  }
  set rel(value: string) {
    this.setAttribute('rel', value);
  }
  get target(): string {
    return this.getAttribute('target') ?? '';
  }
  set download(value: string) {
    this.setAttribute('download', value);
  }
  get type(): string {
    return this.getAttribute('type') ?? '';
  }

  get connected(): boolean {
    let at: FakeElement | null = this;
    while (at.parentElement !== null) at = at.parentElement;
    return at === this.ownerDocument.documentElement;
  }

  /** A `src` script or a stylesheet link inserted into the live document "loads". */
  private loaded(): void {
    if (!this.connected) return;
    if (this.tagName === 'SCRIPT')
      this.ownerDocument.ran.push(this.getAttribute('src') ?? this.text);
    if (this.tagName === 'SCRIPT' || this.tagName === 'LINK') {
      const failed = (this.getAttribute('src') ?? this.getAttribute('href') ?? '').includes('fail');
      queueMicrotask(() => (failed ? this.onerror?.() : this.onload?.()));
    }
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      node.adopt(this.ownerDocument);
      this.children.push(node);
      node.loaded();
    }
  }
  remove(): void {
    const parent = this.parentElement;
    if (parent === null) return;
    parent.children = parent.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  replaceWith(node: FakeElement): void {
    const parent = this.parentElement;
    if (parent === null) return;
    node.remove();
    const index = parent.children.indexOf(this);
    parent.children.splice(index, 1, node);
    node.parentElement = parent;
    this.parentElement = null;
    node.adopt(parent.ownerDocument);
    node.loaded();
  }
  replaceChild(next: FakeElement, old: FakeElement): void {
    old.replaceWith(next);
  }
  adopt(doc: FakeDocument): void {
    this.ownerDocument = doc;
    for (const child of this.children) child.adopt(doc);
  }
  contains(node: FakeElement): boolean {
    for (let at: FakeElement | null = node; at !== null; at = at.parentElement) {
      if (at === this) return true;
    }
    return false;
  }
  private descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((el) => matches(el, selector));
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  closest(selector: string): FakeElement | null {
    for (let at: FakeElement | null = this; at !== null; at = at.parentElement) {
      if (matches(at, selector)) return at;
    }
    return null;
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  click(): void {
    this.clicks += 1;
  }
}

/** A form the router's `instanceof HTMLFormElement` accepts once installed as that global. */
export class FakeForm extends FakeElement {
  fields: [string, string | File][] = [];
}

export class FakeDocument extends EventTarget {
  readonly documentElement: FakeElement;
  baseURI = 'https://app.test/';
  activeElement: FakeElement | null = null;
  /** Every script that "ran": its `src`, or its text for an inline one. */
  readonly ran: string[] = [];
  startViewTransition?: (update: () => void) => {
    updateCallbackDone: Promise<void>;
    ready: Promise<void>;
    finished: Promise<void>;
  };

  constructor(head: readonly FakeElement[] = [], body: readonly FakeElement[] = [], lang = 'en') {
    super();
    this.documentElement = new FakeElement(this, 'html', { lang });
    this.documentElement.append(new FakeElement(this, 'head'), new FakeElement(this, 'body'));
    this.head.append(...head.map((el) => this.take(el)));
    this.body.append(...body.map((el) => this.take(el)));
  }
  private take(el: FakeElement): FakeElement {
    el.adopt(this);
    return el;
  }
  get head(): FakeElement {
    return this.documentElement.children.find((c) => c.tagName === 'HEAD') as FakeElement;
  }
  get body(): FakeElement {
    return this.documentElement.children.find((c) => c.tagName === 'BODY') as FakeElement;
  }
  get title(): string {
    return this.head.querySelector('title')?.textContent ?? '';
  }
  set title(value: string) {
    const el = this.head.querySelector('title');
    if (el === null) this.head.append(new FakeElement(this, 'title', {}, value));
    else el.textContent = value;
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
  adoptNode(node: FakeElement): FakeElement {
    node.remove();
    node.adopt(this);
    return node;
  }
  /** What a test says is under the pointer, for a click the browser aimed at `<html>`. */
  underPointer: FakeElement | null = null;
  elementFromPoint(): FakeElement | null {
    return this.underPointer;
  }
  getElementById(id: string): FakeElement | null {
    return this.documentElement.querySelectorAll('[id]').find((el) => el.id === id) ?? null;
  }
  querySelector(selector: string): FakeElement | null {
    return this.documentElement.querySelector(selector);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }
}

/** `h('a', { href: '/b' }, 'b')` — builds an element owned by a scratch document until adopted. */
const scratch = new FakeDocument();
export const h = (
  tag: string,
  attrs: Attrs = {},
  content: readonly FakeElement[] | string = [],
): FakeElement =>
  tag === 'form'
    ? new FakeForm(scratch, tag, attrs, content)
    : new FakeElement(scratch, tag, attrs, content);

/** The head an opted-in document carries, plus whatever the page adds. */
export const routerHead = (
  title: string,
  extra: readonly FakeElement[] = [],
  meta: { surface?: string; build?: string; scope?: string } = {},
): FakeElement[] => [
  h('title', {}, title),
  h('meta', { name: 'ultimate-navigation', content: meta.surface ?? 'web:app' }),
  h('meta', { name: CLIENT_BUILD_META, content: meta.build ?? 'b1' }),
  ...(meta.scope === undefined ? [] : [h('meta', { name: 'ultimate-scope', content: meta.scope })]),
  ...extra,
];

interface HistoryEntry {
  state: unknown;
  url: string;
}

/** A window: location, history (with a back/forward that fires `popstate`), timers, `fetch`. */
export class FakeWindow extends EventTarget {
  document: FakeDocument;
  readonly assigned: string[] = [];
  readonly entries: HistoryEntry[];
  index = 0;
  scrollX = 0;
  scrollY = 0;
  reducedMotion = false;
  navigator: { connection?: { saveData?: boolean; effectiveType?: string } } = {};
  readonly DOMParser = true;
  readonly BroadcastChannel = true;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  __xNavigation?: unknown;

  constructor(doc: FakeDocument, url: string, fetch: FakeWindow['fetch']) {
    super();
    this.document = doc;
    this.entries = [{ state: null, url }];
    this.fetch = fetch;
  }

  readonly location = {
    get href(): string {
      return self.entries[self.index]?.url ?? '';
    },
    assign: (url: string): void => {
      this.assigned.push(url);
    },
  };

  readonly history = {
    scrollRestoration: 'auto',
    get state(): unknown {
      return self.entries[self.index]?.state ?? null;
    },
    pushState: (state: unknown, _title: string, url?: string): void => {
      this.entries.splice(this.index + 1);
      this.entries.push({ state, url: url ?? this.location.href });
      this.index += 1;
    },
    replaceState: (state: unknown, _title: string, url?: string): void => {
      this.entries[this.index] = { state, url: url ?? this.location.href };
    },
  };

  /** Back or forward, as a browser does it: the entry moves, then `popstate` fires. */
  go(delta: number): void {
    this.index += delta;
    this.dispatchEvent(Object.assign(new Event('popstate'), { state: this.history.state }));
  }

  scrollTo(options: { left: number; top: number }): void {
    this.scrollX = options.left;
    this.scrollY = options.top;
  }
  matchMedia(): { matches: boolean } {
    return { matches: this.reducedMotion };
  }
  setTimeout(fn: () => void, ms?: number): number {
    return globalThis.setTimeout(fn, ms) as unknown as number;
  }
  clearTimeout(id: number | undefined): void {
    globalThis.clearTimeout(id);
  }
}

// `location` and `history` are object literals whose getters need the window; `self` is set per
// instance by `fakeWindow`, one window per test.
let self: FakeWindow;

/** The window a test drives; installs the three globals the router reaches for by name. */
export function fakeWindow(doc: FakeDocument, url: string, fetch: FakeWindow['fetch']): FakeWindow {
  self = new FakeWindow(doc, url, fetch);
  const globals = globalThis as unknown as Record<string, unknown>;
  globals['DOMParser'] = FakeParser;
  globals['HTMLFormElement'] = FakeForm;
  globals['FormData'] = FakeFormData;
  globals['HTMLElement'] = FakeElement;
  return self;
}

/** Documents a `DOMParser` answers, keyed by the HTML string a fake `fetch` returned. */
export const parsed = new Map<string, FakeDocument>();

class FakeParser {
  parseFromString(html: string): FakeDocument {
    const doc = parsed.get(html);
    if (doc === undefined) throw new TypeError(`no fake document registered for ${html}`);
    return doc;
  }
}

const RealFormData = globalThis.FormData;
class FakeFormData extends RealFormData {
  constructor(form?: FakeForm, submitter?: FakeElement | null) {
    super();
    for (const [name, value] of form?.fields ?? []) this.append(name, value);
    const name = submitter?.getAttribute('name');
    if (name !== undefined && name !== null)
      this.append(name, submitter?.getAttribute('value') ?? '');
  }
}

/** A registered page: `answer('/b', doc)` is what the fake fetch returns for `/b`. */
export function htmlAnswer(key: string, doc: FakeDocument, init: ResponseInit = {}): Response {
  parsed.set(key, doc);
  return new Response(key, {
    ...init,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...(init.headers as Record<string, string>),
    },
  });
}

/** Lets queued microtasks and a few macrotasks run — a swap awaits loads, transitions, scripts. */
export const settle = async (ms = 5): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, ms));
};

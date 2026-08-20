// The island the browser actually runs: this builds `settings.island.tsx` with the same
// `buildIslands` `x build` and `x dev` use, imports the emitted chunk the way the hydration runtime
// does, and drives `mount` against a DOM small enough to read. Anything less proves the file
// exists — and a file that exists is exactly what shipped, dead, through five majors.

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from '@ultimat3/testing';
// A reach into the framework's own source, and the only one in this app. `buildIslands` is not on
// `@ultimat3/cli`'s public surface (`packages/cli/src/index.ts` re-exports no island symbol) and
// `@ultimat3/testing` has no island fixture, so an app outside this monorepo cannot write this
// test at all. That gap is the finding; this import is the workaround until it closes.
import { buildIslands } from '../../../../../../packages/cli/src/island-bundle';

const APP_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const ISLAND = 'apps/web/app/settings/settings.island.tsx';

const NOW = '2026-03-14T08:30:00.000Z';
const ENDPOINT = '/api/settings/save-preferences';

const option = (value: string): { value: string; label: string } => ({ value, label: value });

const PROPS = {
  endpoint: ENDPOINT,
  nowIso: NOW,
  locale: 'en',
  timezone: 'UTC',
  theme: 'system',
  digestOptIn: true,
  locales: ['en', 'es'].map(option),
  timezones: ['UTC', 'Asia/Tokyo'].map(option),
  themes: ['system', 'light', 'dark'].map(option),
  labels: {
    locale: 'Language',
    localeHelp: 'Applies to the interface.',
    timezone: 'Timezone',
    timezoneHelp: 'Every date you see is rendered in this zone.',
    theme: 'Theme',
    digest: 'Nightly digest',
    digestHelp: 'One email at 09:00 your time.',
    save: 'Save',
    saved: 'Saved',
    retry: 'Try again',
  },
} as const;

/** What the island must produce for a zone — computed here rather than pasted, so the assertion
 *  survives an ICU data bump and still fails when the zone stops reaching the formatter. */
const expectedPreview = (locale: string, zone: string): string =>
  new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(new Date(NOW));

// ---------------------------------------------------------------------------------------------
// A DOM implementing what compiled Solid touches and nothing else. `bun test` has none and a DOM
// library is a dependency this repo will not take. `generate: 'dom'` builds every element from
// `_$template("<label …>")`, so a stub without a parsed `<template>` cannot run one line of it.
// ---------------------------------------------------------------------------------------------

class FakeNode {
  readonly nodeType: number = 1;
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  appendChild(child: FakeNode): FakeNode {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child: FakeNode, ref: FakeNode | null): FakeNode {
    const at = ref === null ? -1 : this.children.indexOf(ref);
    child.parentNode = this;
    this.children.splice(at < 0 ? this.children.length : at, 0, child);
    return child;
  }
  replaceChild(next: FakeNode, prev: FakeNode): FakeNode {
    const at = this.children.indexOf(prev);
    if (at >= 0) this.children[at] = next;
    next.parentNode = this;
    return prev;
  }
  removeChild(child: FakeNode): FakeNode {
    this.children = this.children.filter((each) => each !== child);
    return child;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  cloneNode(deep?: boolean): FakeNode {
    const copy = new FakeNode();
    if (deep === true) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  get childNodes(): readonly FakeNode[] {
    return this.children;
  }
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get textContent(): string {
    return this.children.map((child) => child.textContent).join('');
  }
  set textContent(text: string) {
    this.children = text === '' ? [] : [new FakeText(text)];
  }
}

/** `data`, not a private field: Solid updates a text node in place through `node.data = value`. */
class FakeText extends FakeNode {
  override readonly nodeType = 3;
  constructor(public data: string) {
    super();
  }
  override get textContent(): string {
    return this.data;
  }
  override set textContent(text: string) {
    this.data = text;
  }
  override cloneNode(): FakeText {
    return new FakeText(this.data);
  }
}

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, (event: unknown) => void>();
  readonly dataset: Record<string, string> = {};
  readonly classList = { add: (): void => {} };
  readonly style = {};
  /** Properties, not attributes: Solid assigns both of these straight onto the node. */
  value = '';
  checked = false;
  constructor(readonly tagName: string) {
    super();
  }
  get nodeName(): string {
    return this.tagName.toUpperCase();
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  addEventListener(name: string, fn: (event: unknown) => void): void {
    this.listeners.set(name, fn);
  }
  removeEventListener(name: string): void {
    this.listeners.delete(name);
  }
  override cloneNode(deep?: boolean): FakeElement {
    const copy = new FakeElement(this.tagName);
    for (const [name, value] of this.attributes) copy.attributes.set(name, value);
    if (deep === true) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }
  /** Only what the assertions below ask for: `[data-role="…"]`, anywhere in the subtree. */
  querySelector(selector: string): FakeElement | null {
    const role = /^\[data-role="([^"]+)"\]$/.exec(selector)?.[1];
    const tag = role === undefined ? selector : null;
    const hit = (node: FakeNode): FakeElement | null => {
      if (node instanceof FakeElement) {
        if (role !== undefined && node.getAttribute('data-role') === role) return node;
        if (tag !== null && node.tagName === tag) return node;
      }
      for (const child of node.children) {
        const found = hit(child);
        if (found !== null) return found;
      }
      return null;
    };
    return hit(this);
  }
  all(tag: string): readonly FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (node: FakeNode): void => {
      if (node instanceof FakeElement && node.tagName === tag) found.push(node);
      for (const child of node.children) walk(child);
    };
    walk(this);
    return found;
  }
}

class FakeTemplate extends FakeElement {
  content: FakeNode = new FakeNode();
  constructor() {
    super('template');
  }
  set innerHTML(html: string) {
    this.content = parseHtml(html);
  }
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
const TOKEN =
  /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;

/** Only what `babel-preset-solid` emits into a template: tags, static attributes and text. */
function parseHtml(html: string): FakeNode {
  const root = new FakeNode();
  const open: FakeNode[] = [root];
  for (const match of html.matchAll(TOKEN)) {
    const parent = open[open.length - 1] as FakeNode;
    if (match[5] !== undefined) {
      parent.appendChild(new FakeText(match[5]));
      continue;
    }
    if (match[1] === '/') {
      if (open.length > 1) open.pop();
      continue;
    }
    const element = new FakeElement(match[2] as string);
    for (const attr of (match[3] ?? '').matchAll(
      /([^\s=/>]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g,
    )) {
      if (attr[1] !== undefined) element.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    parent.appendChild(element);
    if (match[4] !== '/' && !VOID_TAGS.has(element.tagName)) open.push(element);
  }
  return root;
}

const documentElement = new FakeElement('html');

interface FetchCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

const calls: FetchCall[] = [];
let ok = true;

const DOM_GLOBALS: Readonly<Record<string, unknown>> = {
  window: globalThis,
  Element: FakeElement,
  SVGElement: FakeElement,
  Node: FakeNode,
  Text: FakeText,
  document: {
    documentElement,
    createElement: (tag: string): FakeElement =>
      tag === 'template' ? new FakeTemplate() : new FakeElement(tag),
    createElementNS: (_ns: string, tag: string): FakeElement => new FakeElement(tag),
    createTextNode: (text: string): FakeText => new FakeText(text),
    createComment: (): FakeText => new FakeText(''),
    importNode: (node: FakeNode, deep?: boolean): FakeNode => node.cloneNode(deep),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  },
  fetch: (url: string, init: { body: string }): Promise<{ ok: boolean }> => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return Promise.resolve({ ok });
  },
};

const host = globalThis as unknown as Record<string, unknown>;
const saved = new Map<string, unknown>();

beforeAll(() => {
  for (const key of Object.keys(DOM_GLOBALS)) saved.set(key, host[key]);
  Object.assign(host, DOM_GLOBALS);
});

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete host[key];
    else host[key] = value;
  }
});

/** The delegated handler Solid parks on the node, or a listener it attached — either counts. */
const handlerOf = (element: FakeElement, name: string): ((event: unknown) => void) | undefined =>
  (element as unknown as Record<string, ((event: unknown) => void) | undefined>)[`$$${name}`] ??
  element.listeners.get(name);

interface Mounted {
  readonly code: string;
  readonly el: FakeElement;
  /** `<select>`s in document order: language, timezone, theme. */
  readonly selects: readonly FakeElement[];
  readonly text: (role: string) => string;
  choose(select: FakeElement, value: string): void;
  save(): void;
}

let mounted: Mounted;

/** Build the real chunk once — Babel plus a browser bundle is seconds, and every case shares it. */
async function mountIsland(): Promise<Mounted> {
  const chunk = (await buildIslands(APP_ROOT)).chunks.find((each) => each.file === ISLAND);
  const code = chunk?.code ?? '';
  // Under `.x/`, which is gitignored, and deleted on the way out: a chunk is a build artifact and
  // the only reason it touches disk at all is that `import()` needs a path.
  const out = join(APP_ROOT, '.x', 'settings-island-test.mjs');
  await Bun.write(out, code);
  const entry = (await import(out)) as { mount: (el: unknown, props: unknown) => void };
  await rm(out, { force: true });

  const el = new FakeElement('div');
  // The shell the page server-renders. `mount` replaces it, which is the assertion below.
  el.appendChild(new FakeElement('dl'));
  entry.mount(el, PROPS);

  return {
    code,
    el,
    selects: el.all('select'),
    text: (role) => el.querySelector(`[data-role="${role}"]`)?.textContent ?? '',
    choose(select, value) {
      select.value = value;
      handlerOf(select, 'change')?.({ currentTarget: select, target: select });
    },
    save() {
      const button = el.all('button')[0] as FakeElement;
      handlerOf(button, 'click')?.({ currentTarget: button, target: button });
    },
  };
}

beforeAll(async () => {
  mounted = await mountIsland();
}, 60_000);

/**
 * One mount, driven as a session: the cases below run in order against the same island, because
 * building the real chunk is a Babel pass plus a browser bundle and repeating it per case would
 * pay seconds for state each case sets up anyway. What each one asserts is independent.
 */
describe('the settings island', () => {
  test('mount replaces the server shell with the editor', () => {
    expect(mounted.el.querySelector('dl')).toBeNull();
    expect(mounted.selects).toHaveLength(3);
    expect(mounted.el.all('button')).toHaveLength(1);
    // Solid compiles to real DOM calls; a chunk falling back to the classic React factory names a
    // global that is not in it, and `Bun.build` answers `success: true` over that all the same.
    expect(mounted.code).not.toMatch(/\bReact\b/);
  });

  test('the preview re-renders in the zone the member just picked', () => {
    expect(mounted.text('preview')).toBe(expectedPreview('en', 'UTC'));

    mounted.choose(mounted.selects[1] as FakeElement, 'Asia/Tokyo');

    // The one assertion that a compile-time reactivity contract either honours or silently drops:
    // an eager JSX factory hands the formatter an evaluated string once and never runs it again.
    expect(mounted.text('preview')).toBe(expectedPreview('en', 'Asia/Tokyo'));
    expect(mounted.text('preview')).not.toBe(expectedPreview('en', 'UTC'));
  });

  test('the locale reaches the same preview, so both signals are tracked', () => {
    mounted.choose(mounted.selects[0] as FakeElement, 'es');
    expect(mounted.text('preview')).toBe(expectedPreview('es', 'Asia/Tokyo'));
  });

  test("theme writes <html data-theme> at once, and 'system' takes it back off", () => {
    mounted.choose(mounted.selects[2] as FakeElement, 'dark');
    expect(documentElement.dataset['theme']).toBe('dark');

    mounted.choose(mounted.selects[2] as FakeElement, 'system');
    // Removed, never set to '': `system` means the inline head script and the OS decide again,
    // and an empty attribute is still an attribute the CSS selector matches.
    expect('theme' in documentElement.dataset).toBe(false);
  });

  test('save posts the CURRENT selection to the path the server minted', async () => {
    mounted.save();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ENDPOINT);
    // The values the three changes above left behind, not the props the island booted with.
    expect(calls[0]?.body).toEqual({
      locale: 'es',
      tz: 'Asia/Tokyo',
      theme: 'system',
      digestOptIn: true,
    });
  });

  test('the status line answers the response, both ways', async () => {
    expect(mounted.text('status')).toBe(PROPS.labels.saved);

    ok = false;
    mounted.save();
    await Promise.resolve();
    await Promise.resolve();

    expect(mounted.text('status')).toBe(PROPS.labels.retry);
  });
});

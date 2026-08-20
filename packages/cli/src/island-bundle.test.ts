// The bundler half of an island, against real files and a real `Bun.build`: the property under
// test is what lands in the chunk table, and a fake builder would prove nothing about it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { buildIslands, discoverIslands, ISLAND_BASE_PATH, islandBundle } from './island-bundle';
import { transformIslandTsx } from './solid-loader';

const ROOT = join(import.meta.dir, '..', '.island-fixture');

const MODULE = (text: string): string =>
  `export function mount(el: HTMLElement): void { el.textContent = ${JSON.stringify(text)}; }\n`;

const write = (path: string, source: string): Promise<number> =>
  Bun.write(join(ROOT, path), source);

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'island-fixture' }));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

const codeOf = (error: unknown): string =>
  error instanceof UltimateError ? error.code : `not an UltimateError: ${String(error)}`;

describe('discoverIslands', () => {
  test('finds a client entry on every surface that renders a document, and only those', async () => {
    await write('apps/web/site/counter.island.tsx', MODULE('site'));
    await write('apps/web/app/panel.island.tsx', MODULE('app'));
    await write('apps/web/shared/modal.island.tsx', MODULE('shared'));
    // Not islands: an API route emits no document, and a page is not a client entry.
    await write('apps/web/api/hook.island.tsx', MODULE('api'));
    await write('apps/web/site/page.tsx', 'export const Page = (): string => "";\n');

    expect(await discoverIslands(ROOT)).toEqual([
      'apps/web/app/panel.island.tsx',
      'apps/web/shared/modal.island.tsx',
      'apps/web/site/counter.island.tsx',
    ]);
  });

  test('an app with no island builds an empty table rather than failing', async () => {
    expect((await buildIslands(ROOT)).chunks).toEqual([]);
  });
});

describe('buildIslands', () => {
  test('one content-addressed chunk per island, keyed by the id the document names', async () => {
    await write('apps/web/site/counter.island.tsx', MODULE('one'));
    const bundle = await buildIslands(ROOT);
    const chunk = bundle.chunks[0];

    expect(bundle.chunks).toHaveLength(1);
    expect(chunk?.moduleId).toBe('counter');
    expect(chunk?.url).toMatch(new RegExp(`^${ISLAND_BASE_PATH}/counter-[0-9a-f]{8}\\.js$`));
    expect(chunk?.bytes).toBeGreaterThan(0);
    expect(bundle.chunkAt(chunk?.url ?? '')).toBe(chunk);
  });

  test('the same source hashes to the same URL, and an edited one does not', async () => {
    await write('apps/web/site/counter.island.tsx', MODULE('one'));
    const first = (await buildIslands(ROOT)).chunks[0]?.url;
    expect((await buildIslands(ROOT)).chunks[0]?.url).toBe(first);

    await write('apps/web/site/counter.island.tsx', MODULE('two'));
    expect((await buildIslands(ROOT)).chunks[0]?.url).not.toBe(first);
  });

  test('two islands sharing a filename are two chunks — the hash is what keeps them apart', async () => {
    await write('apps/web/site/a/modal.island.tsx', MODULE('a'));
    await write('apps/web/site/b/modal.island.tsx', MODULE('b'));
    const urls = (await buildIslands(ROOT)).chunks.map((chunk) => chunk.url);
    expect(new Set(urls).size).toBe(2);
  });

  test('a client entry that will not compile fails the build naming the file', async () => {
    await write(
      'apps/web/site/broken.island.tsx',
      "import { gone } from './nowhere';\nexport const mount = (): unknown => gone;\n",
    );
    expect(await buildIslands(ROOT).then(() => 'built', codeOf)).toBe('X_BUILD_FAILED');
  });
});

describe('resolverFor', () => {
  test('a page specifier becomes the chunk URL, resolved against the page file', async () => {
    await write('apps/web/site/pricing/calculator.island.tsx', MODULE('calc'));
    await write('apps/web/shared/modal.island.tsx', MODULE('modal'));
    const bundle = await buildIslands(ROOT);
    const resolve = bundle.resolverFor('apps/web/site/pricing/page.tsx');

    expect(resolve('./calculator.island.tsx')).toMatch(/^\/islands\/calculator-/);
    expect(resolve('../../shared/modal.island.tsx')).toMatch(/^\/islands\/modal-/);
  });

  test('a src naming a file the build never bundled is X_ISLAND_INVALID, with the resolved path', async () => {
    const resolve = islandBundle([]).resolverFor('apps/web/site/page.tsx');
    let thrown: unknown;
    try {
      resolve('./missing.island.tsx');
    } catch (error) {
      thrown = error;
    }
    // Loud and by name: the alternative is a `data-x-entry` pointing at nothing, which is a page
    // that renders, serves, passes every gate and does nothing when clicked.
    expect(codeOf(thrown)).toBe('X_ISLAND_INVALID');
    expect((thrown as UltimateError).message).toContain('apps/web/site/missing.island.tsx');
  });
});

// A minimal DOM, because `bun test` has none and no DOM library may be added. It implements what
// compiled Solid touches and nothing else: `nodeType`, `Text.data`, `insertBefore`/`replaceChild`,
// `className`, delegated `$$event` properties, and a `<template>` whose `innerHTML` is parsed —
// `generate: 'dom'` builds every element from `_$template("<button …>")`, so a stub without one
// cannot run a single compiled island.
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

// `data`, not a private field: Solid updates a text node in place through `node.data = value`, and
// a stub without it reports a mount that renders once and never re-renders.
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
  readonly classList = { add: (): void => {} };
  readonly style = {};
  constructor(readonly tagName: string) {
    super();
  }
  get nodeName(): string {
    return this.tagName.toUpperCase();
  }
  /** `_$className` assigns the PROPERTY, never the attribute — the class assertions read this. */
  get className(): string {
    return this.attributes.get('class') ?? '';
  }
  set className(value: string) {
    this.attributes.set('class', String(value));
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

const DOM_GLOBALS: Readonly<Record<string, unknown>> = {
  // Solid's event delegation reads `window` before it reads anything else.
  window: globalThis,
  Element: FakeElement,
  SVGElement: FakeElement,
  Node: FakeNode,
  Text: FakeText,
  document: {
    createElement: (tag: string): FakeElement =>
      tag === 'template' ? new FakeTemplate() : new FakeElement(tag),
    createElementNS: (_ns: string, tag: string): FakeElement => new FakeElement(tag),
    createTextNode: (text: string): FakeText => new FakeText(text),
    createComment: (): FakeText => new FakeText(''),
    importNode: (node: FakeNode, deep?: boolean): FakeNode => node.cloneNode(deep),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  },
};

/** Installed for one assertion and taken straight back out: these are process-global. */
async function withFakeDom<T>(body: () => Promise<T>): Promise<T> {
  const host = globalThis as unknown as Record<string, unknown>;
  const saved = new Map(Object.keys(DOM_GLOBALS).map((key) => [key, host[key]]));
  Object.assign(host, DOM_GLOBALS);
  try {
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete host[key];
      else host[key] = value;
    }
  }
}

/** The delegated handler Solid parks on the node, or a listener it attached — either counts. */
function clickHandlerOf(element: FakeElement): ((event: unknown) => void) | undefined {
  const delegated = (element as unknown as { $$click?: (event: unknown) => void }).$$click;
  return delegated ?? element.listeners.get('click');
}

interface Mounted {
  readonly code: string;
  readonly el: FakeElement;
  readonly button: FakeElement;
  click(): void;
}

/**
 * Build the island at `ISLAND`, import the chunk the way `hydrate.ts` does and run its `mount`.
 * A unique chunk name per call: a module is cached by resolved path for the life of the process.
 */
async function mountIsland(props: unknown): Promise<Mounted> {
  const chunk = (await buildIslands(ROOT)).chunks[0];
  const code = chunk?.code ?? '';
  const out = join(ROOT, `chunk-${Math.random().toString(36).slice(2)}.mjs`);
  await Bun.write(out, code);
  return withFakeDom(async () => {
    const entry = (await import(out)) as { mount: (el: unknown, props: unknown) => void };
    const el = new FakeElement('div');
    entry.mount(el, props);
    const button = el.children[0] as FakeElement;
    return { code, el, button, click: (): void => clickHandlerOf(button)?.({}) };
  });
}

const ISLAND = 'apps/web/site/counter.island.tsx';

// The island an author actually writes: `{n()}` straight into the markup, `class={…}` straight onto
// the element, no hand-written thunk anywhere. Solid's reactivity is a COMPILE-time contract, so
// this exact source is dead under any runtime factory — `jsxFactory` hands `h()` an evaluated
// number and an evaluated string, outside any tracking scope, and the island paints correctly and
// never updates again with no error anywhere.
const NAIVE_ISLAND = `import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';

export interface CounterProps {
  readonly label: string;
}

export function mount(el: HTMLElement, props: CounterProps): void {
  const [n, setN] = createSignal(0);
  render(
    () => (
      <button type="button" class={n() > 0 ? 'pos' : 'zero'} onClick={() => setN(n() + 1)}>
        {props.label} {n()}
      </button>
    ),
    el,
  );
}
`;

/** The same island written with explicit thunks and a fragment. Must keep working. */
const THUNK_ISLAND = `import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';

export function mount(el: HTMLElement, props: { readonly label: string }): void {
  const [clicks, setClicks] = createSignal(0);
  const Counter = () => (
    <>
      <button type="button" onClick={() => setClicks(clicks() + 1)}>
        {() => props.label + ' ' + clicks()}
      </button>
    </>
  );
  render(() => <Counter />, el);
}
`;

/** An island importing a PLAIN `.tsx` component — the case a `.island.tsx`-only filter breaks. */
const COMPOSED_ISLAND = `import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { Badge } from './badge';

export function mount(el: HTMLElement): void {
  const [n, setN] = createSignal(0);
  render(() => <button type="button" onClick={() => setN(n() + 1)}><Badge n={n()} /></button>, el);
}
`;

const BADGE_COMPONENT = `export function Badge(props: { readonly n: number }) {
  return <span class="badge">{props.n}</span>;
}
`;

describe('an island that renders JSX', () => {
  test('the naive island — no hand-written thunk — is reactive in text AND in an attribute', async () => {
    await write(ISLAND, NAIVE_ISLAND);
    const mounted = await mountIsland({ label: 'count' });

    expect(mounted.button.tagName).toBe('button');
    expect(mounted.el.textContent).toBe('count 0');
    expect(mounted.button.className).toBe('zero');

    mounted.click();

    // Text and attribute bindings fail INDEPENDENTLY — a compiler emitting the wrong effect
    // convention keeps text working while every attribute silently dies — so both are asserted.
    expect(mounted.el.textContent).toBe('count 1');
    expect(mounted.button.className).toBe('pos');
  });

  test('the transform emits Solid compiled output, never a runtime hyperscript call', async () => {
    const out = await transformIslandTsx(NAIVE_ISLAND, '/app/counter.island.tsx');

    // `_$insert(el, n, …)` passes the GETTER, and `_$effect(() => _$className(…))` wraps the
    // attribute — those two lines are the whole difference between reactive and dead.
    expect(out).toContain('_$template');
    expect(out).toContain('_$insert');
    expect(out).toContain('_$effect');
    // The factory the first cut shipped. If this string is back, so is the eager-argument bug.
    expect(out).not.toContain('__xh(');
  });

  test('the chunk carries no React free variable', async () => {
    await write(ISLAND, NAIVE_ISLAND);
    const mounted = await mountIsland({ label: 'count' });

    // `React` is undefined in a browser chunk that imports nothing: `mount` throws on its first
    // line, forever, and `Bun.build` still answers `success: true` with no log.
    expect(mounted.code).not.toMatch(/\bReact\b/);
  });

  test('an island importing a plain .tsx compiles that component too', async () => {
    await write(ISLAND, COMPOSED_ISLAND);
    await write('apps/web/site/badge.tsx', BADGE_COMPONENT);
    const mounted = await mountIsland({});

    // A `.island.tsx`-only filter leaves `badge.tsx` to Bun's own bundler, which reads the app's
    // `jsx: "preserve"` and emits `React.createElement("span", …)` — the original bug, one import
    // away. The island build's graph only ever holds islands and what they import, so `.tsx` is
    // already exactly the set that ships to a browser.
    expect(mounted.code).not.toMatch(/\bReact\b/);
    expect(mounted.el.textContent).toBe('0');
    mounted.click();
    expect(mounted.el.textContent).toBe('1');
  });

  test('an island written with explicit thunks keeps working', async () => {
    await write(ISLAND, THUNK_ISLAND);
    const mounted = await mountIsland({ label: 'clicks' });

    expect(mounted.el.textContent).toBe('clicks 0');
    mounted.click();
    expect(mounted.el.textContent).toBe('clicks 1');
  });

  test('the transform cache is keyed by path, so an edited island recompiles', async () => {
    const path = '/app/counter.island.tsx';
    const first = await transformIslandTsx('export const a = <b>one</b>;\n', path);
    // Same path, different source: a cache keyed by path alone would answer the stale chunk here,
    // which in `x dev` is an edit that never reaches the browser.
    const second = await transformIslandTsx('export const a = <b>two</b>;\n', path);

    expect(first).toContain('one');
    expect(second).toContain('two');
    // And the same source is answered from the cache rather than recompiled.
    expect(await transformIslandTsx('export const a = <b>two</b>;\n', path)).toBe(second);
  });
});

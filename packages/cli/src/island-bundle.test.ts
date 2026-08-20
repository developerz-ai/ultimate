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

// A minimal DOM, because `bun test` has none and no DOM library may be added. It implements
// exactly what Solid's runtime touches — `nodeType`, `Text.data`, `insertBefore`/`replaceChild`
// and delegated `$$event` properties — so the assertions below run the REAL Solid that the chunk
// carries rather than a stand-in for it.
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
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  get textContent(): string {
    return this.children.map((child) => child.textContent).join('');
  }
  set textContent(text: string) {
    this.children = text === '' ? [] : [new FakeText(text)];
  }
}

// `data`, not a private field: Solid updates a text node in place through `node.data = value`,
// and a stub without it reports a mount that renders and never re-renders.
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
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
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
}

class FakeSvgElement extends FakeElement {}

const DOM_GLOBALS: Readonly<Record<string, unknown>> = {
  // Solid's event delegation reads `window` before it reads anything else.
  window: globalThis,
  Element: FakeElement,
  SVGElement: FakeSvgElement,
  Node: FakeNode,
  Text: FakeText,
  document: {
    createElement: (tag: string): FakeElement => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string): FakeElement => new FakeSvgElement(tag),
    createTextNode: (text: string): FakeText => new FakeText(text),
    createComment: (): FakeText => new FakeText(''),
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

/** The delegated handler Solid parks on the node, or the listener it attached — either counts. */
function clickHandlerOf(element: FakeElement): ((event: unknown) => void) | undefined {
  const delegated = (element as unknown as { $$click?: (event: unknown) => void }).$$click;
  return delegated ?? element.listeners.get('click');
}

// Real JSX, a real signal and a real `render` — the shape the generated island template does NOT
// use, which is why a chunk that crashed on its first line shipped through five majors under a
// green gate. Concatenation rather than a template literal: this source is itself a template.
const JSX_ISLAND = `import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';

export interface CounterProps {
  readonly label: string;
}

export function mount(el: HTMLElement, props: CounterProps): void {
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

describe('an island that renders JSX', () => {
  test('compiles to Solid, never to a React factory the chunk does not import', async () => {
    await write('apps/web/site/counter.island.tsx', JSX_ISLAND);
    const code = (await buildIslands(ROOT)).chunks[0]?.code ?? '';

    // `React` is a free variable in a browser chunk that imports nothing: `mount` throws on its
    // first line, forever, and the build says `success: true`.
    expect(code).not.toMatch(/\bReact\b/);
  });

  test('the transform imports Solid and points both factories at it', () => {
    const out = transformIslandTsx('export const node = <><b>hi</b></>;\n');

    // The import is the half `Bun.build`'s own `jsx: { runtime: "classic" }` option cannot do —
    // it emits the factory NAME and no import, which is a free variable in the chunk.
    expect(out).toContain("import __xh from 'solid-js/h'");
    expect(out).toContain('__xh("b"');
    // `h.Fragment` is Solid's children passthrough, reached as a property of the same binding.
    expect(out).toContain('__xh(__xh.Fragment');
    expect(out).not.toContain('React');
  });

  test('the chunk the runtime imports mounts, and a signal write re-renders it', async () => {
    await write('apps/web/site/counter.island.tsx', JSX_ISLAND);
    const code = (await buildIslands(ROOT)).chunks[0]?.code ?? '';
    // Imported the way `hydrate.ts` imports it — `import(entry).then((m) => m.mount(el, props))`.
    // A unique name per run: a module is cached by resolved path for the life of the process.
    const chunk = join(ROOT, `chunk-${Math.random().toString(36).slice(2)}.mjs`);
    await Bun.write(chunk, code);

    await withFakeDom(async () => {
      const entry = (await import(chunk)) as {
        mount: (el: unknown, props: unknown) => void;
      };
      const el = new FakeElement('div');
      entry.mount(el, { label: 'clicks' });

      const button = el.children[0];
      expect(button).toBeInstanceOf(FakeElement);
      expect((button as FakeElement).tagName).toBe('button');
      expect((button as FakeElement).getAttribute('type')).toBe('button');
      expect(el.textContent).toBe('clicks 0');

      // The failure this whole slice exists for, stated as an assertion: the island does nothing
      // when clicked. A React chunk never reaches here — `mount` has already thrown.
      const onClick = clickHandlerOf(button as FakeElement);
      expect(typeof onClick).toBe('function');
      onClick?.({});
      expect(el.textContent).toBe('clicks 1');
    });
  });
});

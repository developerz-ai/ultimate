// The bundler half of an island, against real files and a real `Bun.build`: the property under
// test is what lands in the chunk table, and a fake builder would prove nothing about it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity: Bun ships no path API, and `rm(…, { force: true })` removes a fixture
// root that may not exist without a branch.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins, resolves or relativises a path.
import { dirname, join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import type { MountedIsland } from '@ultimat3/testing';
import { mountIsland } from '@ultimat3/testing';
import {
  buildIslands,
  describeBuildError,
  discoverIslands,
  ISLAND_BASE_PATH,
  islandBundle,
} from './island-bundle';
import { transformIslandTsx } from './solid-loader';

// `.island-fixture/bundle`, never `.island-fixture` itself. This suite wipes its root in both
// `beforeEach` and `afterEach`, and `templates/island-fixture.ts` puts every labelled app root
// under that same directory — so owning the parent deleted a sibling suite's app mid-build, which
// bun surfaced only under the full concurrent run as `ENOENT … counter.island.tsx`. Nobody owns
// the parent now.
const ROOT = join(import.meta.dir, '..', '.island-fixture', 'bundle');

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

const fixOf = (error: unknown): string =>
  error instanceof UltimateError ? error.fix : `not an UltimateError: ${String(error)}`;

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

  test('only: builds the one island named, and nothing else in the app', async () => {
    await write('apps/web/site/counter.island.tsx', MODULE('one'));
    await write('apps/web/app/panel.island.tsx', MODULE('two'));

    const bundle = await buildIslands(ROOT, { only: 'apps/web/app/panel.island.tsx' });
    expect(bundle.chunks.map((chunk) => chunk.file)).toEqual(['apps/web/app/panel.island.tsx']);
    // The same chunk either way: `only` is a filter on the entry LIST, never a second build.
    const whole = await buildIslands(ROOT);
    expect(bundle.chunks[0]?.url).toBe(whole.chunkAt(bundle.chunks[0]?.url ?? '')?.url);
  });

  test('only: naming a file the app does not have is X_ISLAND_INVALID, not an empty bundle', async () => {
    await write('apps/web/site/counter.island.tsx', MODULE('one'));
    // An empty bundle would surface two steps later, as a chunk table with no entry for a path the
    // caller can see on disk — which is the shape of the bug, not a report of it.
    expect(
      await buildIslands(ROOT, { only: 'apps/web/site/typo.island.tsx' }).then(
        () => 'built',
        codeOf,
      ),
    ).toBe('X_ISLAND_INVALID');
  });

  // The `fix:` RUN, not read. It said `pass only: '<app-root-relative path>.island.tsx'` — a
  // placeholder, and no gate could see it: `fixProblem` fails a fix only for advice with no
  // command token, and that sentence carried neither. Pasting what the error hands back has to
  // build, or the line is prose about a repair rather than the repair.
  test('only: the fix names a path that builds, and pasting it does', async () => {
    await write('apps/web/app/panel.island.tsx', MODULE('two'));
    const fix = await buildIslands(ROOT, { only: 'panel.island.tsx' }).then(() => '', fixOf);

    // The basename survives a wrong PREFIX, which is what a route-relative specifier is.
    expect(fix).toBe("buildIslands(root, { only: 'apps/web/app/panel.island.tsx' })");
    const pasted = /only: '(?<file>[^']+)'/.exec(fix)?.groups?.['file'] ?? '';
    const bundle = await buildIslands(ROOT, { only: pasted });
    expect(bundle.chunks.map((chunk) => chunk.file)).toEqual(['apps/web/app/panel.island.tsx']);
  });

  test('only: an app with no islands at all is told to write the one it asked for', async () => {
    // Nothing to point at, so the fix cannot be a path — it is the command that creates the file,
    // split off the caller's own argument, exactly as an unresolvable page `src` is answered.
    const fix = await buildIslands(ROOT, { only: 'apps/web/site/typo.island.tsx' }).then(
      () => '',
      fixOf,
    );
    expect(fix).toBe('x g island typo --at apps/web/site');
    // Neither form may hand back a shape to fill in: that is the defect, stated once for both.
    expect(fix).not.toContain('<');
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

const ISLAND = 'apps/web/site/counter.island.tsx';

/**
 * The micro-DOM and the mount driver are `@ultimat3/testing`'s — `cli -> testing` is a declared
 * sideways edge and `@ultimat3/testing` is already a runtime dependency of this package. A second
 * copy here was ~195 lines that could only drift away from the one the reference app is tested
 * against, which is the whole of issue #260.
 *
 * `only:` because these cases mount ONE island and `buildIslands` otherwise Babel-compiles and
 * bundles every other island in the fixture on every case.
 */
async function mountCounter(props: unknown): Promise<MountedIsland> {
  return mountIsland({
    build: (root: string) => buildIslands(root, { only: ISLAND }),
    root: ROOT,
    file: ISLAND,
    props,
  });
}

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
    using mounted = await mountCounter({ label: 'count' });

    expect(mounted.all('button')).toHaveLength(1);
    expect(mounted.el.textContent).toBe('count 0');
    expect(mounted.find('button')?.className).toBe('zero');

    // `fire` answers whether a handler RAN: a compiled island that attached none and a selector
    // that matched nothing are the same silence, and the local driver reported neither.
    expect(mounted.fire('button', 'click')).toBe(true);

    // Text and attribute bindings fail INDEPENDENTLY — a compiler emitting the wrong effect
    // convention keeps text working while every attribute silently dies — so both are asserted.
    expect(mounted.el.textContent).toBe('count 1');
    expect(mounted.find('button')?.className).toBe('pos');
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
    using mounted = await mountCounter({ label: 'count' });

    // `React` is undefined in a browser chunk that imports nothing: `mount` throws on its first
    // line, forever, and `Bun.build` still answers `success: true` with no log.
    expect(mounted.code).not.toMatch(/\bReact\b/);
  });

  test('an island importing a plain .tsx compiles that component too', async () => {
    await write(ISLAND, COMPOSED_ISLAND);
    await write('apps/web/site/badge.tsx', BADGE_COMPONENT);
    using mounted = await mountCounter({});

    // A `.island.tsx`-only filter leaves `badge.tsx` to Bun's own bundler, which reads the app's
    // `jsx: "preserve"` and emits `React.createElement("span", …)` — the original bug, one import
    // away. The island build's graph only ever holds islands and what they import, so `.tsx` is
    // already exactly the set that ships to a browser.
    expect(mounted.code).not.toMatch(/\bReact\b/);
    expect(mounted.el.textContent).toBe('0');
    // The <span class="badge"> the plain component renders, INSIDE the button — `find` walks
    // descendants only, so this is the compiled component and never the host the test built.
    expect(mounted.find('span')?.className).toBe('badge');
    expect(mounted.fire('button', 'click')).toBe(true);
    expect(mounted.el.textContent).toBe('1');
  });

  test('an island written with explicit thunks keeps working', async () => {
    await write(ISLAND, THUNK_ISLAND);
    using mounted = await mountCounter({ label: 'clicks' });

    expect(mounted.el.textContent).toBe('clicks 0');
    expect(mounted.fire('button', 'click')).toBe(true);
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

/**
 * What `Bun.build`'s throw becomes, and it is not a log line: `IslandBuildFailedError` interpolates
 * it straight into a `cause:` (`errors.ts`). A cross-FILE hop, which is why neither
 * `scripts/catch-render.ts` nor `scripts/error-render.ts` can see it — and it read the value three
 * unsafe ways at once: `instanceof` (a `Proxy` answers it through `getPrototypeOf`), `.message` (a
 * getter that can raise) and `String()` (throws outright on a Symbol). A throw there replaces the
 * whole refusal with a TypeError about reporting it.
 */
describe('unit · the bundler diagnostic a cause is built from', () => {
  test('an ordinary Error keeps its message', () => {
    expect(describeBuildError(new TypeError('Could not resolve: "solid-js"'))).toContain(
      'Could not resolve: "solid-js"',
    );
  });

  test('an aggregate is flattened, which is what puts a line number in the cause', () => {
    const rendered = describeBuildError(
      new AggregateError([new Error('a.tsx:3 unresolved'), new Error('b.tsx:9 syntax')], 'nope'),
    );
    expect(rendered).toContain('a.tsx:3 unresolved');
    expect(rendered).toContain('b.tsx:9 syntax');
    expect(rendered).toContain(';');
  });

  test('a message getter that throws is rendered, never re-thrown', () => {
    const hostile = new Error('unused');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new TypeError('message is a trap');
      },
    });
    expect(() => describeBuildError(hostile)).not.toThrow();
    expect(describeBuildError(hostile)).not.toContain('message is a trap');
  });

  test('a Symbol is rendered, where String() throws outright', () => {
    expect(() => describeBuildError(Symbol('boom'))).not.toThrow();
    expect(describeBuildError(Symbol('boom')).length).toBeGreaterThan(0);
  });

  test('a Proxy that traps getPrototypeOf and get is rendered too', () => {
    const trap = new Proxy(
      { errors: [] },
      {
        getPrototypeOf() {
          throw new TypeError('no prototype for you');
        },
        get() {
          throw new TypeError('no properties for you');
        },
      },
    );
    expect(() => describeBuildError(trap)).not.toThrow();
  });

  test('a non-Error throw is not flattened to a placeholder', () => {
    expect(describeBuildError('bundle failed')).toContain('bundle failed');
  });
});

/**
 * A string only Solid's DEVELOPMENT core carries (`dist/dev.js`), and a string literal, so it
 * survives minification. `dist/solid.js` does not contain it — the negative control in the first
 * case below is what proves that, since an assertion on a string present in neither build passes
 * against both.
 */
const DEV_ONLY = 'Potential Infinite Loop Detected';

/** Reads the one value a chunk built on a laptop and a chunk built in the image disagreed about. */
const ENV_ISLAND = `export function mount(el: HTMLElement): void {
  el.textContent = process.env.NODE_ENV ?? 'unset';
}
`;

describe('an island chunk is built to be shipped, not to match the box that built it', () => {
  test('carries Solid production build, never the development one', async () => {
    await write(ISLAND, NAIVE_ISLAND);
    const chunk = (await buildIslands(ROOT, { only: ISLAND })).chunks[0];

    expect(chunk?.code).not.toContain(DEV_ONLY);
    // The negative control: the marker IS in the build an unpinned resolution reaches, so the
    // assertion above is a real one rather than a string that appears in neither file.
    const solid = Bun.resolveSync('solid-js/package.json', import.meta.dir);
    expect(await Bun.file(join(dirname(solid), 'dist/dev.js')).text()).toContain(DEV_ONLY);
  });

  test('does not depend on the NODE_ENV of the process that built it', async () => {
    await write(ISLAND, ENV_ISLAND);
    const here = (await buildIslands(ROOT, { only: ISLAND })).chunks[0]?.url ?? '';

    // A SECOND process, because `Bun.build` reads NODE_ENV once at start-up — mutating
    // `process.env` in this one changes nothing it resolves, which is what made an in-process
    // version of this case pass with the `define` deleted. This suite runs under `test`, the
    // child under `production`: the two ambient modes that pick different Solid builds and
    // inline different values, so an equal URL is the whole property.
    const script = [
      `const { buildIslands } = await import(${JSON.stringify(join(import.meta.dir, 'island-bundle.ts'))});`,
      `const bundle = await buildIslands(${JSON.stringify(ROOT)}, { only: ${JSON.stringify(ISLAND)} });`,
      `console.log(bundle.chunks[0]?.url ?? '');`,
    ].join('\n');
    const child = Bun.spawn(['bun', '-e', script], {
      env: { ...process.env, NODE_ENV: 'production' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const there = (await new Response(child.stdout).text()).trim();

    expect(there).not.toBe('');
    expect(there).toBe(here);
  });

  test("the island's own process.env.NODE_ENV is production, not the build box's", async () => {
    await write(ISLAND, ENV_ISLAND);
    using mounted = await mountCounter({});

    // An app branching on NODE_ENV — a debug panel, a verbose logger, a mock transport — took the
    // development branch in the file a browser downloads, because the chunk inherited the mode of
    // whatever process ran `x build`.
    expect(mounted.el.textContent).toBe('production');
  });
});

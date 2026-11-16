// An island mounted through the micro-DOM: one that renders JSX, a chunk built to ship rather than
// to match the box that built it, and one URL per size. Split from island-bundle.test.ts, which
// keeps discovery, the build and the resolver.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity: Bun ships no path API, and `rm(…, { force: true })` removes a fixture
// root that may not exist without a branch.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins, resolves or relativises a path.
import { dirname, join } from 'node:path';
import type { MountedIsland } from '@ultimat3/testing';
import { mountIsland } from '@ultimat3/testing';
import { buildIslands } from './island-bundle';
import { clearIslandChunkCache, stableChunk } from './island-identity';
import { processRoot } from './process-root-fixture';
import { transformIslandTsx } from './solid-loader';

// `.island-fixture/bundle-jsx`: its own root, never `island-bundle.test.ts`'s `bundle`. Both suites
// wipe their root in `beforeEach` and `afterEach`, and under `--parallel` one owner of a shared
// directory deletes the other's app mid-build (`ENOENT … counter.island.tsx`).
const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'bundle-jsx'));

const write = (path: string, source: string): Promise<number> =>
  Bun.write(join(ROOT, path), source);

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'island-fixture' }));
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
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
async function mountCounter(props: unknown, file: string = ISLAND): Promise<MountedIsland> {
  return mountIsland({
    build: (root: string) => buildIslands(root, { only: file }),
    root: ROOT,
    file,
    props,
  });
}

/**
 * The composed island lives in a directory NO earlier build in this process has resolved. CI
 * (2026-09-05, main at the 19.1.0 release commit, six workers) failed this suite's composed case
 * with `Could not resolve "./badge"` while `badge.tsx` had been written and awaited: the bundler
 * had already walked `apps/web/site/` for the cases above, when the file was not there. A fresh
 * directory is a listing nothing has cached.
 */
const COMPOSED_DIR = 'apps/web/site/composed';
const COMPOSED_ISLAND_FILE = `${COMPOSED_DIR}/counter.island.tsx`;

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
    await write(`${COMPOSED_DIR}/badge.tsx`, BADGE_COMPONENT);
    await write(COMPOSED_ISLAND_FILE, COMPOSED_ISLAND);
    using mounted = await mountCounter({}, COMPOSED_ISLAND_FILE);

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

describe('unit · one URL, one size', () => {
  test('a rebuild that renamed differently is served AND weighed as the first build', () => {
    // `Bun.build` under `minify` renames non-deterministically, so the same inputs can come back
    // as two byte strings of different length. The served code is the first; the size has to be
    // its size, or `x dev` and the budget report bytes no browser receives.
    clearIslandChunkCache();
    try {
      const first = stableChunk('/app/like.island.tsx', 'graph-1', 'let a=1;export{a};');
      const second = stableChunk('/app/like.island.tsx', 'graph-1', 'let abc=1;export{abc as a};');

      expect(second.code).toBe(first.code);
      expect(second.bytes).toBe(new TextEncoder().encode(second.code).byteLength);
      expect(second.bytes).toBe(first.bytes);
      // New inputs are a new chunk, weighed on their own bytes.
      const changed = stableChunk('/app/like.island.tsx', 'graph-2', 'let b=22;export{b};');
      expect(changed.bytes).toBe(new TextEncoder().encode('let b=22;export{b};').byteLength);
    } finally {
      clearIslandChunkCache();
    }
  });
});

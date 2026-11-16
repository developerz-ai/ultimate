// The bundler half of an island, against real files and a real `Bun.build`: the property under
// test is what lands in the chunk table, and a fake builder would prove nothing about it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity: Bun ships no path API, and `rm(…, { force: true })` removes a fixture
// root that may not exist without a branch.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins, resolves or relativises a path.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import { buildIslands, discoverIslands, ISLAND_BASE_PATH, islandBundle } from './island-bundle';
import { processRoot } from './process-root-fixture';

// `.island-fixture/bundle`, never `.island-fixture` itself. This suite wipes its root in both
// `beforeEach` and `afterEach`, and `templates/island-fixture.ts` puts every labelled app root
// under that same directory — so owning the parent deleted a sibling suite's app mid-build, which
// bun surfaced only under the full concurrent run as `ENOENT … counter.island.tsx`. Nobody owns
// the parent now.
const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'bundle'));

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

  test('an app checked out under a node_modules directory still finds its islands', async () => {
    // The segment is in every absolute path such an app holds: only the root-relative one is tested.
    const nested = processRoot(
      join(import.meta.dir, '..', '.island-fixture', 'node_modules', 'disc'),
    );
    await rm(nested, { recursive: true, force: true });
    try {
      await Bun.write(join(nested, 'apps/web/app/panel.island.tsx'), MODULE('app'));
      await Bun.write(join(nested, 'apps/web/app/node_modules/x/vendored.island.tsx'), MODULE('v'));
      expect(await discoverIslands(nested)).toEqual(['apps/web/app/panel.island.tsx']);
    } finally {
      await rm(nested, { recursive: true, force: true });
    }
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

  // Security audit of plan 101 sweep 1c, M1: `only` is the caller's own argument, and both halves of
  // it ride into `x g island <name> --at <dir>`.
  test('only: a requested path carrying shell syntax is quoted, and a leading - is never an option', async () => {
    const hostile = await buildIslands(ROOT, { only: 'apps/$(touch pwned)/a;b.island.tsx' }).then(
      () => '',
      fixOf,
    );
    expect(hostile).toBe("x g island 'a;b' --at 'apps/$(touch pwned)'");
    const option = await buildIslands(ROOT, { only: 'apps/web/--json.island.tsx' }).then(
      () => '',
      fixOf,
    );
    expect(option).toBe("x g island '<name>' --at apps/web");
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

  // The realtime probe parses the graph BEFORE `Bun.build` runs, and a file that will not parse
  // rejected there with a raw `AggregateError: Failed to scan imports` — the web boot died on it.
  test('a client entry that will not parse fails the same way, naming the file', async () => {
    await write('apps/web/site/unparsed.island.tsx', 'export const mount = ( => {;\n');
    const failure = await buildIslands(ROOT).then(
      () => undefined,
      (error: unknown) => error as { code?: string; cause?: string },
    );
    expect(failure?.code).toBe('X_BUILD_FAILED');
    expect(failure?.cause).toContain('apps/web/site/unparsed.island.tsx');
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

  test('importsOf answers the shared chunks an entry loads — what its document preloads', () => {
    const chunk = {
      file: 'apps/web/app/form.island.tsx',
      moduleId: 'form',
      url: '/islands/form-1.js',
      code: '',
      bytes: 0,
      imports: ['/islands/chunk-11111111.js', '/islands/page-runtime.abc.js'],
    };
    const resolve = islandBundle([chunk]).resolverFor('apps/web/app/page.tsx');
    expect(resolve.importsOf?.(resolve('./form.island.tsx'))).toEqual(chunk.imports);
    expect(resolve.importsOf?.('/islands/unknown-0.js')).toEqual([]);
  });
});

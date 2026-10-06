// What one import from `@ultimat3/ui` costs a browser chunk, measured rather than argued.
//
// Two claims, and they answer issue #275 in opposite directions. The barrel SHAKES — a deep path
// into a component module and the barrel retain the same MODULES, so component subpath exports
// (`@ultimat3/ui/button`) would buy zero bytes and cost a second import idiom. What does not shake
// is `sideEffects`: `./src/error-registry.ts` runs `registerErrorCodes()` at import and `errors.ts`
// imports it bare, so any module that constructs a `UiError` drags @ultimat3/core's whole error
// registry along — which is why the runtime slot is its own module and why the ceiling below is
// small enough to notice it coming back.
//
// **The parity half is a MODULE LIST and the code behind it, never a byte allowance.** It compared
// byte counts against a hand-copied `BUN_SHAKE_FLAP_BYTES = 512`, which a 51-byte source change
// planted between the two builds slipped under. `Bun.build` with `minify: false` emits one
// `// <path>` banner per retained module and strips every source comment, so the retained module
// SET is readable off the artifact itself: the two paths must retain the same modules and, once
// the banners are out, the same bytes.
//
// **No flap branch, `As of 2026-10-05` (issue #354).** Until Bun 1.4.1 the shaker dropped
// `@ultimat3/core`'s `schema-error-codes.ts` — a module core's own `sideEffects` array NAMES —
// from some builds and not others (oven-sh/bun#40650: an array read as `false`), so a pair whose
// module sets differed by exactly that module and what only it reaches was tolerated. Measured on
// Bun 1.4.2 (`744846f8`), this file's own `chunkOf` in two batches of 12 concurrent processes,
// both exports, 2 pairs a round: **288 pairs, 0 differing module sets, 0 differing code**, and the
// module retained in all 576 builds. The same comparison measured 19 flaps in 240 pairs on 1.4.0.
// So any difference is now the retention regression this file exists to catch.
//
// **The third claim is the scaffold's one island, `As of 2026-09-19` (issue #490).** `<UiProvider>
// <ThemeToggle mode="toggle" /></UiProvider>` measured 62,463 B minified under CI's own `file:`
// links — solid-js TWICE (the symlinked package resolved its own copy: 12.4 kB, now
// `packages/cli/src/island-solid-dedupe.ts`'s), and 16.1 kB of `@ultimat3/i18n` — the framework
// catalog `index.ts` installs at import, `@ultimat3/time`, and core's logger behind both — reached
// by `useUi()`'s SERVER branch alone. That branch now reads a slot `theme/ambient.ts` fills, and
// `package.json`'s `browser` field maps that file to `theme/ambient.browser.ts` for a browser
// build. The test below reads the module list the browser build retains and refuses those
// packages by PATH — a list, on both sides of Bun's `sideEffects` change (1.4.0 ignored the array,
// oven-sh/bun#40650; 1.4.2 honours it), where any byte ceiling would have to pick one.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no path API and no directory-removal API, and the entry has to be written INSIDE
// packages/ui — module resolution for `@ultimat3/core` walks up from the importing file, and only
// this package's own node_modules has it. `rmdir` rather than a second `rm` because refusing a
// non-empty directory is the concurrency check the shared parent needs.
import { rm, rmdir } from 'node:fs/promises';
// why: same import, same reason — `relative` is what keeps the generated entry's specifier honest
// when the fixture directory moves, instead of a hand-counted `../`.
import { dirname, join, relative, resolve } from 'node:path';

/**
 * `.tmp/` is gitignored repo-wide, so an interrupted run leaves nothing tracked behind. It has to
 * be inside the package: an entry in the system tmpdir resolves `@ultimat3/core` from nowhere.
 *
 * One directory per PROCESS, because `afterAll` removes it. A fixed path meant two concurrent runs
 * of this file deleted each other's entries mid-build — reproduced with six, 3 of them red with
 * `File not found ".../packages/ui/.tmp/moneyText-deep.ts"`.
 */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `barrel-bytes-${process.pid}`);
const TMP_ROOT = dirname(FIXTURE_DIR);

/** `packages/<name>` — the directory a retained module's path is refused or allowed by. */
const packageDir = (name: string): string => `${resolve(import.meta.dir, '..', '..', name)}/`;

/**
 * Packages the theme-toggle island's graph must not reach at all. Each was in it on 2026-09-19 and
 * each is reachable only from `useUi()`'s server branch — `currentLocale()`, `currentTimeZone()`,
 * `useI18n()` — which a DOM never takes. `money` was never in this graph; it is listed because
 * `context.ts` is what every formatting component retains, and the day it reaches money it
 * reaches money for every island.
 */
const SERVER_ONLY_PACKAGES = ['i18n', 'time', 'money'] as const;

/**
 * Every module of THIS package the island may retain — `ThemeToggle` (both modes: `mode` is a
 * prop, so `Select` rides along), `IconButton`, the provider and the runtime adapter, the theme
 * rules, and `errors.ts` with its registry behind the throw sites. A list rather than a count so
 * a regression names its module. The `.module.scss` files ride along as assets and are allowed by
 * suffix below rather than named one by one.
 */
const THEME_TOGGLE_UI_MODULES: readonly string[] = [
  'a11y.ts',
  'cx.ts',
  'error-registry.ts',
  'errors.ts',
  'i18n-keys.ts',
  'index.ts',
  'components/IconButton.tsx',
  'components/Select.tsx',
  'components/ThemeToggle.tsx',
  'theme/ambient-slot.ts',
  'theme/context.ts',
  'theme/inert-runtime.ts',
  'theme/provider.tsx',
  'theme/runtime-slot.ts',
  'theme/solid-adapter.ts',
  'theme/theme.ts',
].map((module) => resolve(import.meta.dir, module));

async function bundle(name: string, source: string, minify: boolean): Promise<string> {
  const entry = join(FIXTURE_DIR, `${name}.ts`);
  await Bun.write(entry, source);
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    splitting: false,
    minify,
  });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    expect.unreachable(
      `${name} did not bundle: ${built.logs.map((log) => String(log)).join('; ')}`,
    );
  }
  return await output.text();
}

/** Production shape, and the one `packages/cli/src/island-bundle.ts` builds an island with. */
async function chunkBytes(name: string, source: string): Promise<number> {
  return new TextEncoder().encode(await bundle(name, source, true)).byteLength;
}

/**
 * Bun writes each banner relative to the process cwd, so that is the base. `/` is the fallback: a
 * banner that walks all the way up to the root recovers its absolute path from there whatever the
 * cwd was, so a runner started somewhere else cannot silently produce the empty list two builds
 * would happily agree on.
 */
async function bannerPath(banner: string): Promise<string | null> {
  for (const base of [process.cwd(), '/']) {
    const path = resolve(base, banner);
    if (await Bun.file(path).exists()) return path;
  }
  return null;
}

interface Chunk {
  /** Every source module the chunk retained, sorted — what a subpath export could remove. */
  readonly modules: readonly string[];
  /**
   * The retained CODE, with the banners removed, so two entries are comparable byte for byte —
   * module by module, in PATH order rather than the order Bun wrote them. The order it writes is
   * evaluation order, which is import order: the barrel reaches `errors.ts` through its first
   * import and `money-view.ts` reaches `@ultimat3/money`'s before its own, so the same modules
   * with the same bytes came out 35 lines apart and the whole-artifact comparison this used to
   * make read that as a retention difference (`As of 2026-09-19`). What either path retains of a
   * module is the claim; where Bun put it is not.
   */
  readonly code: string;
}

/** The key the entry's own code is filed under — the two entries have different names. */
const ENTRY_KEY = '';

/**
 * A banner resolving to a file that exists IS a module — Bun strips source comments, so nothing
 * else in the artifact starts `// `. The banners are what has to come out of the code before the
 * two builds can be compared: each names its own entry file, and the two entries have different
 * names by construction. Blank lines go with them because Bun writes one before each banner.
 */
async function chunkOf(name: string, source: string): Promise<Chunk> {
  const output = await bundle(name, source, false);
  const sections = new Map<string, string[]>();
  let current = ENTRY_KEY;
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    if (line.startsWith('// ')) {
      const path = await bannerPath(line.slice(3).trim());
      if (path !== null) {
        current = path.startsWith(FIXTURE_DIR) ? ENTRY_KEY : path;
        continue;
      }
    }
    const section = sections.get(current) ?? [];
    section.push(line);
    sections.set(current, section);
  }
  const modules = [...sections.keys()].filter((key) => key !== ENTRY_KEY).sort();
  const code = [ENTRY_KEY, ...modules].map((key) => (sections.get(key) ?? []).join('\n'));
  return { modules, code: code.join('\n') };
}

/** The generated entry's specifier for a module in `src/`, so the fixture depth is never spelled. */
const specifier = (module: string): string => relative(FIXTURE_DIR, join(import.meta.dir, module));

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  // The parent is shared with every other run: `rmdir` refuses a non-empty directory, and that
  // refusal is the right answer rather than an error.
  await rmdir(TMP_ROOT).catch(() => undefined);
});

/**
 * Measured 2026-08-23: 72 B once the slot is its own module, 5,713 B while it sat beside `solid()`
 * and reached `errors.ts`. A kilobyte is the ceiling because the failure this pins is not a drift
 * of a few bytes — it is the error registry re-entering the graph, which is ~5.6 kB every time.
 */
const SETTER_CEILING_BYTES = 1024;

describe('the @ultimat3/ui barrel', () => {
  test('costs a browser chunk almost nothing for the runtime registration alone', async () => {
    const bytes = await chunkBytes(
      'setter',
      [
        `import { setSolidRuntime } from '${specifier('index')}';`,
        'export const mount = (runtime: never): void => setSolidRuntime(runtime);',
        '',
      ].join('\n'),
    );
    expect(bytes).toBeLessThanOrEqual(SETTER_CEILING_BYTES);
  }, 30_000);

  /**
   * The subpath-exports question, decided by measurement instead of by intuition: if the barrel
   * retained what a deep path does not, the barrel's module list would hold it and the deep path's
   * would not. It does not, for either a component-shaped export or a pure formatting core — so
   * `@ultimat3/ui/button` would be a second way to import one name for no bytes, which is axiom 1
   * refusing itself.
   */
  test.each([
    ['useUi', 'theme/context'],
    ['moneyText', 'components/money-view'],
  ])(
    'retains no more for %s than the module path does, so a subpath export would buy nothing',
    async (name, module) => {
      const source = (from: string): string =>
        [`import { ${name} } from '${from}';`, `export const held = ${name};`, ''].join('\n');
      const [barrel, deep] = await Promise.all([
        chunkOf(`${name}-barrel`, source(specifier('index'))),
        chunkOf(`${name}-deep`, source(specifier(module))),
      ]);

      // Not vacuous: two empty lists are equal, and an extraction that read nothing would satisfy
      // every assertion below. The module under test has to be in both.
      const own = resolve(import.meta.dir, `${module}.ts`);
      expect(barrel.modules).toContain(own);
      expect(deep.modules).toContain(own);

      // No tolerance: both paths owe the same modules AND the same bytes. The list is asserted
      // first so a retention failure names its module instead of printing 25 kB.
      expect(barrel.modules).toEqual(deep.modules);
      expect(barrel.code.length).toBe(deep.code.length);
      expect(barrel.code).toBe(deep.code);
    },
    30_000,
  );

  /**
   * The scaffold's island, as an entry this package can build without the JSX plugin: the same
   * three names `theme-toggle.island.tsx` imports, held so nothing shakes. What is asserted is
   * the module LIST — which packages are absent, and which of this package's modules are present
   * — because the bytes of a build without Solid's compiler are not the island's bytes.
   */
  test('the theme-toggle island retains no server-only package, and only its own modules', async () => {
    const chunk = await chunkOf(
      'theme-toggle',
      [
        `import { setSolidRuntime, ThemeToggle, UiProvider } from '${specifier('index')}';`,
        'export const held = [setSolidRuntime, ThemeToggle, UiProvider];',
        '',
      ].join('\n'),
    );
    // Not vacuous: the island's own modules are in the list.
    expect(chunk.modules).toContain(resolve(import.meta.dir, 'components/ThemeToggle.tsx'));
    expect(chunk.modules).toContain(resolve(import.meta.dir, 'theme/provider.tsx'));

    // The mechanism: the browser build took the mapped file and not the server's. Only the
    // absence is asserted — `ambient.browser.ts` is one unused function, so Bun shakes every
    // statement it has and writes no banner for it, while `ambient.ts` registers at import and
    // would be here, i18n behind it, if the `browser` field had not been read.
    expect(chunk.modules).not.toContain(resolve(import.meta.dir, 'theme/ambient.ts'));

    // The packages a DOM render has no use for, refused by path.
    for (const name of SERVER_ONLY_PACKAGES) {
      const reached = chunk.modules.filter((path) => path.startsWith(packageDir(name)));
      expect(`@ultimat3/${name} modules in the theme-toggle graph: ${reached.join(', ')}`).toBe(
        `@ultimat3/${name} modules in the theme-toggle graph: `,
      );
    }

    // And of this package, nothing outside the list — a new import in any of these modules that
    // reaches a component, a formatter or the icon tables lands here by name.
    const own = chunk.modules.filter((path) => path.startsWith(packageDir('ui')));
    const unexpected = own.filter(
      (path) => !path.endsWith('.module.scss') && !THEME_TOGGLE_UI_MODULES.includes(path),
    );
    expect(`@ultimat3/ui modules outside the theme-toggle list: ${unexpected.join(', ')}`).toBe(
      '@ultimat3/ui modules outside the theme-toggle list: ',
    );
  }, 30_000);
});

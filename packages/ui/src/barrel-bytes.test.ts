// What one import from `@ultimat3/ui` costs a browser chunk, measured rather than argued.
//
// Two claims, and they answer issue #275 in opposite directions. The barrel SHAKES — a deep path
// into a component module and the barrel retain the same MODULES, so component subpath exports
// (`@ultimat3/ui/button`) would buy zero bytes and cost a second import idiom. What does not shake
// is `sideEffects`: `./src/errors.ts` runs `registerErrorCodes()` at import, so any module that
// reaches it drags @ultimat3/core's whole error registry along — which is why the runtime slot is
// its own module and why the ceiling below is small enough to notice it coming back.
//
// **The parity half is a MODULE LIST, not a byte allowance, `As of 2026-08-25`.** It compared byte
// counts against a hand-copied `BUN_SHAKE_FLAP_BYTES = 512`, measured when Bun 1.4.0's
// non-deterministic drop of `@ultimat3/core`'s `schema-error-codes.ts` — a module core's own
// `sideEffects` array NAMES — cost 377 B. That module then grew a `registerErrorRetry` table, the
// drop became 1,116 B, and the assertion started failing on a loaded machine (issues #273, #276):
// reproduced as 1 red in 12 serial runs under load, and the drop is load-correlated, so it passes
// on an idle laptop and reds on a free CI runner. The number it allowed was also the wrong SHAPE:
// a 51-byte source change planted between the two builds moved the minified chunk by 47 B, which
// that assertion waved through and this one fails on. A measured constant describing somebody else's
// non-determinism goes stale in silence, and 512 B was already wider than any retention difference
// a subpath export could repair — `useUi` alone is 14 kB and `moneyText` 25 kB.
//
// `Bun.build` with `minify: false` emits one `// <path>` banner per retained module and strips
// every source comment, so the retained module SET is readable off the artifact itself and the
// drop is a NAMED module instead of a number. Same set on both sides: the two chunks must be
// byte-identical once the banners are out, which they are — measured, to the character, for both
// exports. Different sets: they must differ by that one module and by nothing else. Stronger than
// the allowance it replaces in both directions, since that one waved through any difference under
// 512 B whatever caused it. Measured 2026-08-25 over 240 pairs across six concurrent processes:
// 19 flapped, 221 equal, 0 failures in either branch — and with one extra module planted on the
// barrel side, 144 pairs, every one red, in whichever branch it landed in.
//
// **The dropped module's TITLES cannot discriminate here, which is where this differs from
// `examples/dummy/apps/web/island-bytes.test.ts`.** `SCHEMA_ERROR_CODE_TITLES` is a deliberate
// duplicate of `SCHEMA_ERROR_CODES` in `@ultimat3/schema`, and `@ultimat3/money` puts schema in the
// `moneyText` graph — so all four titles are in the chunk whether core's module survived or not
// (measured: a shaken 33,876 B chunk carrying every one of them). A predicate reading `true` on
// both sides of a flap sends the pair to the equality branch and fails it: 3 reds in 240 pairs.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no path API and no directory-removal API, and the entry has to be written INSIDE
// packages/ui — module resolution for `@ultimat3/core` walks up from the importing file, and only
// this package's own node_modules has it. `rmdir` rather than a second `rm` because refusing a
// non-empty directory is the concurrency check the shared parent needs.
import { rm, rmdir } from 'node:fs/promises';
// why: same import, same reason — `relative` is what keeps the generated entry's specifier honest
// when the fixture directory moves, instead of a hand-counted `../`.
import { join, relative, resolve } from 'node:path';

/**
 * `.tmp/` is gitignored repo-wide, so an interrupted run leaves nothing tracked behind. It has to
 * be inside the package: an entry in the system tmpdir resolves `@ultimat3/core` from nowhere.
 *
 * One directory per PROCESS, because `afterAll` removes it. A fixed path meant two concurrent runs
 * of this file deleted each other's entries mid-build — reproduced with six, 3 of them red with
 * `File not found ".../packages/ui/.tmp/moneyText-deep.ts"`.
 */
const TMP_ROOT = join(import.meta.dir, '..', '.tmp');
const FIXTURE_DIR = join(TMP_ROOT, `barrel-bytes-${process.pid}`);

/** The one module Bun 1.4.0's tree-shaker answers differently from one build to the next. */
const SHAKEN_MODULE = resolve(import.meta.dir, '..', '..', 'core', 'src', 'schema-error-codes.ts');
const CORE_MANIFEST = resolve(import.meta.dir, '..', '..', 'core', 'package.json');

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
  /** The retained CODE, with the banners removed, so two entries are comparable byte for byte. */
  readonly code: string;
}

/**
 * A banner resolving to a file that exists IS a module — Bun strips source comments, so nothing
 * else in the artifact starts `// `. The banners are what has to come out of the code before the
 * two builds can be compared: each names its own entry file, and the two entries have different
 * names by construction. Blank lines go with them because Bun writes one before each banner.
 */
async function chunkOf(name: string, source: string): Promise<Chunk> {
  const output = await bundle(name, source, false);
  const modules = new Set<string>();
  const code: string[] = [];
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    if (!line.startsWith('// ')) {
      code.push(line);
      continue;
    }
    const path = await bannerPath(line.slice(3).trim());
    if (path !== null && !path.startsWith(FIXTURE_DIR)) modules.add(path);
  }
  return { modules: [...modules].sort(), code: code.join('\n') };
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

  test('the module the shaker drops is a real file its own package declares side-effectful', async () => {
    // Both halves of the discriminator's premise. A rename makes the parity test below answer
    // "same set" forever and go quietly back to comparing whatever the shaker felt like doing.
    expect(await Bun.file(SHAKEN_MODULE).exists()).toBe(true);
    const manifest = (await Bun.file(CORE_MANIFEST).json()) as { sideEffects?: readonly string[] };
    expect(manifest.sideEffects ?? []).toContain('./src/schema-error-codes.ts');
  });

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

      if (barrel.modules.includes(SHAKEN_MODULE) === deep.modules.includes(SHAKEN_MODULE)) {
        // The shaker answered the same way for both, so the two paths owe the same modules AND the
        // same bytes — no allowance, because there is nothing left for one to differ by. The list
        // is asserted first so a retention failure names its module instead of printing 25 kB.
        expect(barrel.modules).toEqual(deep.modules);
        expect(barrel.code.length).toBe(deep.code.length);
        expect(barrel.code).toBe(deep.code);
        return;
      }
      // It answered differently, and then the flap is the WHOLE difference. A second module riding
      // along is the retention regression this file exists to catch, and it fails here rather than
      // hiding under a byte budget. A mismatched pair has no byte statement to make, which is why
      // the equality branch above is what holds a second difference riding along.
      const difference = [
        ...barrel.modules.filter((path) => !deep.modules.includes(path)),
        ...deep.modules.filter((path) => !barrel.modules.includes(path)),
      ];
      expect(difference).toEqual([SHAKEN_MODULE]);
    },
    30_000,
  );
});

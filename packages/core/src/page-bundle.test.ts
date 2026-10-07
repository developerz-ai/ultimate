// A browser island reads the page handle, the principal fence, the page's shared names and
// `UltimateError`; it must not carry a titles TABLE with them. Measured on the artifact: `Bun.build` with
// `minify: false` writes one `// <path>` banner per retained module, so the retained SET is read
// off the chunk and a regression names its file.
//
// Two entries, two claims. `@ultimat3/core/page` retains no titles table. The barrel is measured
// beside it and DOES retain both — the anchored `core-error-codes.ts` and `schema-error-codes.ts`
// ride every barrel import — which is the whole reason the subpath exists; if the barrel ever shakes clean, that
// assertion fails and the subpath can be deleted as a second import idiom (axiom 1).

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API, and the fixture directory is this process's own.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the entry is written INSIDE the package so `@ultimat3/core/page`
// resolves through the workspace, and each banner is resolved back to an absolute path.
import * as nodePath from 'node:path';
import { join, resolve } from 'node:path';

/** Gitignored repo-wide; one directory per process so concurrent runs never delete each other. */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `page-bundle-${process.pid}`);
const PACKAGES = resolve(import.meta.dir, '..', '..');

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

const ENTRY = (specifier: string): string =>
  `import { onRescope, pageClient } from '${specifier}';\n` +
  'onRescope(() => {});\nglobalThis.probe = pageClient();\n';

async function build(
  name: string,
  specifier: string,
  minify: boolean,
  source: string = ENTRY(specifier),
): Promise<{ modules: string[]; bytes: number }> {
  const entry = join(FIXTURE_DIR, `${name}.ts`);
  await Bun.write(entry, source);
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return expect.unreachable(`${name} did not bundle: ${built.logs.map(String).join('; ')}`);
  }
  const modules: string[] = [];
  for (const banner of bannerModules(await output.text(), PACKAGES, process.cwd())) {
    if (await Bun.file(banner.absolute).exists()) modules.push(banner.module);
  }
  return { modules: modules.sort(), bytes: output.size };
}

/** The slice of `node:path` a banner is read with — `path.win32` in the test that proves Windows. */
type PathApi = Pick<typeof nodePath, 'isAbsolute' | 'relative' | 'resolve' | 'sep'>;

/**
 * Each `// <path>` banner under `packagesDir`'s `src/` trees, named `<pkg>/src/<file>` with `/`
 * whatever the platform. Compared as a RELATIVE path, never as a `${packagesDir}/` prefix: on
 * Windows every resolved path is `\`-separated, so the prefix test matched nothing and each
 * module-set assertion read an empty list (windows-latest, 2026-10-05).
 */
function bannerModules(
  code: string,
  packagesDir: string,
  cwd: string,
  path: PathApi = nodePath,
): { module: string; absolute: string }[] {
  const found: { module: string; absolute: string }[] = [];
  for (const line of code.split('\n')) {
    if (!line.startsWith('// ')) continue;
    const absolute = path.resolve(cwd, line.slice(3));
    const inside = path.relative(packagesDir, absolute);
    if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) continue;
    const module = inside.split(path.sep).join('/');
    if (module.includes('/src/')) found.push({ module, absolute });
  }
  return found;
}

describe('reading the retained set off the banners', () => {
  const chunk = (...banners: string[]): string =>
    banners.map((banner) => `// ${banner}\nvar x = 1;`).join('\n');

  test('a Windows checkout names each module with forward slashes, as on Linux', () => {
    const code = chunk(
      'packages/core/src/page-meta.ts',
      'packages\\core\\src\\record-sink.ts',
      'node_modules/other/src/index.js',
      'packages/core/package.json',
    );
    const read = bannerModules(code, 'D:\\a\\u\\packages', 'D:\\a\\u', nodePath.win32);
    expect(read).toEqual([
      { module: 'core/src/page-meta.ts', absolute: 'D:\\a\\u\\packages\\core\\src\\page-meta.ts' },
      {
        module: 'core/src/record-sink.ts',
        absolute: 'D:\\a\\u\\packages\\core\\src\\record-sink.ts',
      },
    ]);
  });

  test('a POSIX checkout reads the same names', () => {
    const code = chunk('packages/core/src/page-meta.ts', '../elsewhere/src/x.ts');
    expect(bannerModules(code, '/r/packages', '/r', nodePath.posix).map((b) => b.module)).toEqual([
      'core/src/page-meta.ts',
    ]);
  });
});

/**
 * A titles table: core's own and schema's, each a side-effect anchor the barrel loads. Any schema
 * module counts — except `error-brand.ts`, the one symbol `UltimateError` brands with: a leaf that
 * declares `Symbol.for('ultimate.error')` and imports nothing, split out of `errors.ts` so exactly
 * this edge carries no table.
 */
const isTitlesTable = (module: string): boolean =>
  module === 'core/src/core-error-codes.ts' ||
  module === 'core/src/schema-error-codes.ts' ||
  (module.startsWith('schema/src/') && module !== 'schema/src/error-brand.ts');

const THROWING_PAGE =
  "import { onRescope, pageClient, renderFixShellArg, UltimateError } from '@ultimat3/core/page';\n" +
  'onRescope(() => {});\n' +
  "globalThis.probe = [pageClient(), new UltimateError({ code: 'X_A', cause: 'c', fix: renderFixShellArg('v', '<v>') })];\n";

describe('the browser path to the page seam', () => {
  test('the handle and the fence retain exactly their four modules', async () => {
    const { modules } = await build('page', '@ultimat3/core/page', false);
    expect(modules.filter(isTitlesTable)).toEqual([]);
    expect(modules).toEqual([
      'core/src/client-scope.ts',
      'core/src/page-meta.ts',
      'core/src/pending-records.ts',
      'core/src/record-sink.ts',
    ]);
  }, 60_000);

  test('the handle and the fence stay under 1.5 kB minified (1,286 B as of 2026-09-22)', async () => {
    const { bytes } = await build('page-min', '@ultimat3/core/page', true);
    expect(bytes).toBeLessThan(1_536);
  }, 60_000);

  test('a page that also throws retains the class and the lookup, and no titles table', async () => {
    const { modules } = await build('throws', '', false, THROWING_PAGE);
    expect(modules.filter(isTitlesTable)).toEqual([]);
    expect(modules).toContain('core/src/errors.ts');
  }, 60_000);

  // measured: 4,096 B (2026-10-01), against 4,403. It was 3,789 on 2026-09-22 and 4,010 at 22.15.0.
  // why: +307 B, every byte of it in the modules `UltimateError` retains. +221 B before this
  // change — 21.0.0's client store (`03904536`) and the caller-facing fix renderers (`e82f562d`).
  // +86 B in it: three `X_SEAL_*` rows in `error-retry.ts`'s classification map (85 B — a job
  // opening a sealed column must not spend its retry policy on a missing key) and one `@` in
  // `error-render.ts`'s shell-safe set (a scoped package name is one word). The ceiling moves by
  // the measured growth and keeps the headroom it had: 4,096 + 307. The map is ONE table for the
  // server and the browser, so the browser carries rows for codes it never throws — the 85 B are
  // function on a worker and none in an island, and splitting the table is `error-retry.ts`'s to do.
  test('the handle, the fence and UltimateError stay under 4,403 B minified (4,096 B as of 2026-10-01)', async () => {
    const { bytes } = await build('throws-min', '', true, THROWING_PAGE);
    expect(bytes).toBeLessThan(4_403);
  }, 60_000);

  // Everything the entry exports at once — the transport, the URL rule, the fence and the helpers a
  // browser hook uses — is the ceiling a realtime island can reach through this path.
  //
  // measured: 16,975 B (2026-10-05, Bun 1.4.2), against 17,408. It was 16,004 at the tip before
  // this change (15,470 on 2026-09-28). why: +971 B, what a browser reads off an http refusal it
  // never loaded the package for — `client-retry-after.ts` (the one `Retry-After` reader), the
  // `retry-after` rule in `retryForStatus`, `remoteTitleOf` + `UltimateError`'s `remoteTitle` (the
  // problem body's title for an unregistered code) — and the retry wait and a queued gate slot that `bump()`
  // and the caller's abort can now end. That is what let `@ultimat3/http`'s 11.5 kB leave every action island.
  // The next whole kilobyte above the measurement.
  test('the whole entry reaches no titles table and stays under 17 kB (16,975 B as of 2026-10-05)', async () => {
    const whole = "import * as page from '@ultimat3/core/page';\nglobalThis.probe = page;\n";
    const { modules } = await build('whole', '', false, whole);
    expect(modules.filter(isTitlesTable)).toEqual([]);
    const { bytes } = await build('whole-min', '', true, whole);
    expect(bytes).toBeLessThan(17_408);
  }, 60_000);

  test('the barrel still drags both titles tables — the reason the subpath exists', async () => {
    const { modules } = await build('barrel', '@ultimat3/core', false);
    expect(modules.filter(isTitlesTable).length).toBeGreaterThan(0);
  }, 60_000);
});

// Core's own 40 titles are a side-effect anchor the BARREL loads (`core-error-codes.ts`), so a
// module that only constructs an `UltimateError` pays for the class and the registry lookup, never
// the table: an untitled code renders humanised, and the barrel is what titles it.
describe("UltimateError's own subgraph", () => {
  const THROWS =
    // JSON-quoted: a raw Windows path in single quotes reads `\\u…` as an escape — a Syntax Error.
    `import { UltimateError } from ${JSON.stringify(join(import.meta.dir, 'errors.ts'))};\n` +
    "globalThis.probe = new UltimateError({ code: 'X_A', cause: 'c', fix: 'f' });\n";

  test('excludes the core titles table', async () => {
    const { modules } = await build('errors', '', false, THROWS);
    expect(modules).toContain('core/src/errors.ts');
    expect(modules).not.toContain('core/src/core-error-codes.ts');
  }, 60_000);

  test('the barrel still loads it, so every core code is titled through @ultimat3/core', async () => {
    const { modules } = await build('titled', '@ultimat3/core', false);
    expect(modules).toContain('core/src/core-error-codes.ts');
  }, 60_000);
});

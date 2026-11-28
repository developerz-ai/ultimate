// TEST-ONLY. What one import from `@ultimat3/ui` costs a browser chunk, built the way an island is:
// the bundler settings, the per-process fixture directory and the module list read off the
// `minify: false` banners — shared by `ui-barrel-bytes.test.ts` and `ui-motion-bytes.test.ts`, so
// the two files measure with one ruler. The WHY of each piece is in `ui-barrel-bytes.test.ts`.

import { expect } from 'bun:test';
// why: Bun ships no path API and no directory-removal API, and the entry has to be written INSIDE
// packages/ui — module resolution for `@ultimat3/core` walks up from the importing file, and only
// this package's own node_modules has it. `rmdir` rather than a second `rm` because refusing a
// non-empty directory is the concurrency check the shared parent needs.
import { rm, rmdir } from 'node:fs/promises';
// why: same import, same reason — `relative` is what keeps the generated entry's specifier honest
// when the fixture directory moves, instead of a hand-counted `../`.
import { dirname, join, relative, resolve } from 'node:path';
import { solidJsxPlugin } from '../packages/cli/src/solid-loader';

/** `packages/ui/src` — what every claim below is about. */
export const UI_SRC = resolve(import.meta.dir, '..', 'packages', 'ui', 'src');

/**
 * `.tmp/` is gitignored repo-wide, so an interrupted run leaves nothing tracked behind. It has to
 * be inside the package: an entry in the system tmpdir resolves `@ultimat3/core` from nowhere.
 *
 * One directory per PROCESS, because `afterAll` removes it. A fixed path meant two concurrent runs
 * of this file deleted each other's entries mid-build — reproduced with six, 3 of them red with
 * `File not found ".../packages/ui/.tmp/moneyText-deep.ts"`.
 */
export const FIXTURE_DIR = join(UI_SRC, '..', '.tmp', `barrel-bytes-${process.pid}`);
const TMP_ROOT = dirname(FIXTURE_DIR);

/** `packages/<name>` — the directory a retained module's path is refused or allowed by. */
export const packageDir = (name: string): string => `${resolve(UI_SRC, '..', '..', name)}/`;

export async function bundle(name: string, source: string, minify: boolean): Promise<string> {
  const entry = join(FIXTURE_DIR, `${name}.ts`);
  await Bun.write(entry, source);
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    splitting: false,
    minify,
    // The island build's own JSX transform (`island-bundle.ts`), so a `.tsx` the barrel reaches
    // compiles as it ships. Without it Bun compiles the `.tsx` itself, which Bun 1.4.3 refuses to
    // link (`No matching export … for import "jsxDEV"`, issue #883) and no Bun got right.
    plugins: [solidJsxPlugin],
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
export async function chunkBytes(name: string, source: string): Promise<number> {
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

export interface Chunk {
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
const ENTRY_SECTION = '';

/**
 * A banner resolving to a file that exists IS a module — Bun strips source comments, so nothing
 * else in the artifact starts `// `. The banners are what has to come out of the code before the
 * two builds can be compared: each names its own entry file, and the two entries have different
 * names by construction. Blank lines go with them because Bun writes one before each banner.
 */
export async function chunkOf(name: string, source: string): Promise<Chunk> {
  const output = await bundle(name, source, false);
  const sections = new Map<string, string[]>();
  let current = ENTRY_SECTION;
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    if (line.startsWith('// ')) {
      const path = await bannerPath(line.slice(3).trim());
      if (path !== null) {
        current = path.startsWith(FIXTURE_DIR) ? ENTRY_SECTION : path;
        continue;
      }
    }
    const section = sections.get(current) ?? [];
    section.push(line);
    sections.set(current, section);
  }
  const modules = [...sections.keys()].filter((key) => key !== ENTRY_SECTION).sort();
  const code = [ENTRY_SECTION, ...modules].map((key) => (sections.get(key) ?? []).join('\n'));
  return { modules, code: code.join('\n') };
}

/** The generated entry's specifier for a module in `src/`, so the fixture depth is never spelled. */
export const specifier = (module: string): string => relative(FIXTURE_DIR, join(UI_SRC, module));

/** A component-only island entry: the names imported from the barrel, held so nothing shakes. */
export const islandOf = (name: string, names: readonly string[]): Promise<Chunk> =>
  chunkOf(
    name,
    [
      `import { ${names.join(', ')} } from '${specifier('index')}';`,
      `export const held = [${names.join(', ')}];`,
      '',
    ].join('\n'),
  );

export const under = (chunk: Chunk, dir: string): string[] =>
  chunk.modules.filter((path) => path.startsWith(resolve(UI_SRC, dir)));

/** Remove this process's fixture directory, and the shared parent when it is empty. */
export async function cleanFixtures(): Promise<void> {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
  // The parent is shared with every other run: `rmdir` refuses a non-empty directory, and that
  // refusal is the right answer rather than an error.
  await rmdir(TMP_ROOT).catch(() => undefined);
}

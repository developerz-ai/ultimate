// A group's output reused across processes while every file it read is unchanged — and rebuilt
// the moment one is not. Against real builds: what a hit must reproduce (the bytes, the URLs, the
// stylesheet registration) is what the bundler emitted, and a fake builder would prove nothing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity — Bun ships no recursive delete or directory listing.
import { readdir, rm, utimes } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';
import { clearStylesheets, contentHash, stylesFor } from '@ultimat3/render/server';
import type { IslandBundle } from './island-bundle';
import { buildIslands } from './island-bundle';
import { ISLAND_CACHE_DIR } from './island-group-cache';
import { clearIslandChunkCache } from './island-identity';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'group-cache'));
const CACHE = join(ROOT, ISLAND_CACHE_DIR);
const MARK = '/*reused*/';

const PANEL = 'apps/web/site/panel/panel.island.tsx';
const BADGE = 'apps/web/site/badge/badge.island.tsx';

const write = (path: string, source: string): Promise<number> =>
  Bun.write(join(ROOT, path), source);

beforeEach(async () => {
  clearIslandChunkCache();
  await rm(ROOT, { recursive: true, force: true });
  await write('package.json', JSON.stringify({ name: 'group-cache-fixture' }));
  await write(
    'apps/web/shared/label.ts',
    `export const label = (n: string): string => 'L:' + n;\n`,
  );
  await write('apps/web/site/panel/panel.module.scss', '.panel { color: teal; }\n');
  await write(
    PANEL,
    `import { label } from '../../shared/label';
import styles from './panel.module.scss';
export function mount(el: { className: string; textContent: string }): void {
  el.className = styles['panel'] ?? ''; el.textContent = label('panel');
}
`,
  );
  await write(
    BADGE,
    `export function mount(el: { textContent: string }): void { el.textContent = 'badge'; }\n`,
  );
});

afterEach(async () => {
  clearIslandChunkCache();
  await rm(ROOT, { recursive: true, force: true });
});

/** Marks every cached entry's code, so a build that answers the mark provably read the cache. */
async function markEntries(): Promise<void> {
  for (const name of await readdir(CACHE)) {
    const file = Bun.file(join(CACHE, name));
    const entry = (await file.json()) as { chunks: { code: string; codeHash: string }[] };
    for (const chunk of entry.chunks) {
      chunk.code = `${MARK}${chunk.code}`;
      // Re-hashed, as a writer would: the entry's own integrity check is not what is under test.
      chunk.codeHash = contentHash(chunk.code);
    }
    await Bun.write(file, JSON.stringify(entry));
  }
}

/**
 * Every fixture file and directory an hour old. One modified within seconds of a build's start is
 * treated as raced (`writeGroup`'s mtime slack), so a fixture written just now is never cached.
 */
async function age(): Promise<void> {
  const old = new Date(performance.timeOrigin + performance.now() - 3_600_000);
  for await (const one of new Bun.Glob('**/*').scan({ cwd: ROOT, onlyFiles: false })) {
    await utimes(join(ROOT, one), old, old);
  }
}

/** A build as a new process does it: no in-process chunk memory, the fixture already old. */
async function rebuild(options: Parameters<typeof buildIslands>[1] = {}): Promise<IslandBundle> {
  clearIslandChunkCache();
  await age();
  return buildIslands(ROOT, options);
}

const codeOf = (bundle: IslandBundle, file: string): string =>
  bundle.chunks.find((chunk) => chunk.file === file)?.code ?? '';

describe('a group whose inputs are unchanged', () => {
  test('is answered from the cache, at the URLs the build gave it', async () => {
    const first = await rebuild();
    await markEntries();
    const second = await rebuild();

    expect(codeOf(second, PANEL).startsWith(MARK)).toBe(true);
    expect(codeOf(second, BADGE).startsWith(MARK)).toBe(true);
    expect(second.chunks.map((chunk) => chunk.url)).toEqual(first.chunks.map((chunk) => chunk.url));
  });

  test('registers its stylesheets again, as the build it skipped would have', async () => {
    await rebuild();
    clearStylesheets();
    expect(stylesFor('site')).not.toContain('teal');
    await rebuild();
    expect(stylesFor('site')).toContain('teal');
  });

  test('reuse: false builds it afresh', async () => {
    await rebuild();
    await markEntries();
    expect(codeOf(await rebuild({ reuse: false }), PANEL).startsWith(MARK)).toBe(false);
  });
});

describe('a changed input', () => {
  test("rebuilds the island's own group, and only that group", async () => {
    await rebuild();
    await markEntries();
    await write(
      BADGE,
      `export function mount(el: { textContent: string }): void { el.textContent = 'b2'; }\n`,
    );
    const after = await rebuild();

    expect(codeOf(after, BADGE)).toContain('b2');
    expect(codeOf(after, BADGE).startsWith(MARK)).toBe(false);
    expect(codeOf(after, PANEL).startsWith(MARK)).toBe(true);
  });

  test('a module the island imports, not only the island file, invalidates it', async () => {
    await rebuild();
    await markEntries();
    await write(
      'apps/web/shared/label.ts',
      `export const label = (n: string): string => 'M:' + n;\n`,
    );
    const after = await rebuild();

    expect(codeOf(after, PANEL)).toContain('M:');
    expect(codeOf(after, PANEL).startsWith(MARK)).toBe(false);
  });

  test('a stylesheet the island imports invalidates it', async () => {
    await rebuild();
    await markEntries();
    await write(
      'apps/web/site/panel/panel.module.scss',
      '.panel { color: tomato; }\n.x { top: 0 }\n',
    );
    expect(codeOf(await rebuild(), PANEL).startsWith(MARK)).toBe(false);
  });
});

describe('a change no bundler input shows', () => {
  test("a Sass partial the island's sheet @uses invalidates it", async () => {
    await write('apps/web/site/panel/_tokens.scss', '$tone: teal;\n');
    await write(
      'apps/web/site/panel/panel.module.scss',
      "@use 'tokens';\n.panel { color: tokens.$tone; }\n",
    );
    await rebuild();
    await markEntries();
    await write('apps/web/site/panel/_tokens.scss', '$tone: tomato;\n');
    const after = await rebuild();

    // The partial moves the sheet's class hash; a reused entry would carry the old class name
    // while the sheet registered beside it carries the new one, and the island renders unstyled.
    expect(codeOf(after, PANEL).startsWith(MARK)).toBe(false);
    expect(stylesFor('site')).toContain('tomato');
  });

  test('a new file that now wins the resolution of an import invalidates its importers', async () => {
    await write('apps/web/shared/util/index.ts', "export const word = 'from-index';\n");
    await write(
      BADGE,
      "import { word } from '../../shared/util';\nexport function mount(el: { textContent: string }): void { el.textContent = word; }\n",
    );
    await rebuild();
    await markEntries();
    // `./util` now resolves to the file, not the directory's index: no recorded input changed.
    await write('apps/web/shared/util.ts', "export const word = 'from-file';\n");
    const after = await rebuild();

    expect(codeOf(after, BADGE)).toContain('from-file');
    expect(codeOf(after, PANEL).startsWith(MARK)).toBe(false);
  });

  test('a tsconfig or package.json edit invalidates every group', async () => {
    await rebuild();
    await markEntries();
    await write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: {} } }));
    expect(codeOf(await rebuild(), BADGE).startsWith(MARK)).toBe(false);

    await markEntries();
    await write('package.json', JSON.stringify({ name: 'group-cache-fixture', imports: {} }));
    expect(codeOf(await rebuild(), BADGE).startsWith(MARK)).toBe(false);
  });
});

describe('a cache that cannot be written', () => {
  test('still answers the build: a slower next boot, never a failed one', async () => {
    // `.x` as a FILE: no directory can be made under it, as on a read-only tree.
    await write('.x', 'not a directory');
    const bundle = await buildIslands(ROOT);
    expect(bundle.chunks.map((chunk) => chunk.file).sort()).toEqual([BADGE, PANEL]);
  });
});

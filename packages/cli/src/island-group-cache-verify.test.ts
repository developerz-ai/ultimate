// What a cache entry must prove before it is served, and how entries are written and swept —
// against entries on disk, without a build: the key, the stamps, the integrity of what a hit
// serves, a write raced by an edit, a write that fails half-way, and entries nobody reads.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity — Bun ships no recursive delete, directory listing, mkdir or utimes.
import { mkdir, readdir, rm, utimes } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a directory to a file.
import { join } from 'node:path';
import type { IslandChunk } from './island-bundle';
import { inputDigester, listingDigester } from './island-cache-inputs';
import type { GroupOutput } from './island-group-cache';
import {
  groupKey,
  ISLAND_CACHE_DIR,
  readGroup,
  sweepGroupCache,
  writeGroup,
} from './island-group-cache';
import { clearIslandChunkCache } from './island-identity';
import { processRoot } from './process-root-fixture';

const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'group-cache-verify'));
const CACHE = join(ROOT, ISLAND_CACHE_DIR);
const ISLAND = join(ROOT, 'apps/web/site/one.island.tsx');
const SHEET = join(ROOT, 'apps/web/site/one.module.scss');
const DAY = 86_400_000;

const chunk = (code: string): IslandChunk => ({
  file: 'apps/web/site/one.island.tsx',
  moduleId: 'one',
  url: '/islands/one-abcd1234.js',
  code,
  bytes: code.length,
  imports: [],
});

const output = (over: Partial<GroupOutput> = {}): GroupOutput => ({
  chunks: [chunk('export const a=1;')],
  shared: [],
  inputs: [ISLAND, SHEET],
  stylesheets: [SHEET],
  ...over,
});

const key = groupKey({ group: ['one'], splitting: false, environment: 'e', persists: undefined });
const entryFile = (name = key): string => join(CACHE, `${name}.json`);
/** Well after every fixture file's mtime: the build "started" after they were written. */
const later = (): number => performance.timeOrigin + performance.now() + 10_000;

beforeEach(async () => {
  clearIslandChunkCache();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(ISLAND, 'export const a = 1;\n');
  await Bun.write(SHEET, '.one { color: teal; }\n');
  // Old mtimes: no file is "edited while the build ran" unless a test says so.
  const old = new Date(Date.UTC(2026, 0, 1));
  await utimes(ISLAND, old, old);
  await utimes(SHEET, old, old);
  // And its directory: a listing that changed during the build refuses the write too.
  await utimes(join(ROOT, 'apps/web/site'), old, old);
});

afterEach(async () => {
  clearIslandChunkCache();
  await rm(ROOT, { recursive: true, force: true });
});

/** Rewrites the stored entry through `edit`, as an attacker or a corrupted disk would. */
async function tamper(edit: (entry: Record<string, unknown>) => void): Promise<void> {
  const entry = (await Bun.file(entryFile()).json()) as Record<string, unknown>;
  edit(entry);
  await Bun.write(entryFile(), JSON.stringify(entry));
}

describe('readGroup refuses an entry that cannot prove what it serves', () => {
  test('a valid entry is a hit — the baseline every refusal below departs from', async () => {
    await writeGroup(ROOT, key, output(), later(), inputDigester());
    expect((await readGroup(ROOT, key, inputDigester()))?.chunks[0]?.code).toBe(
      'export const a=1;',
    );
  });

  test('no recorded inputs: nothing would ever be rehashed', async () => {
    await writeGroup(ROOT, key, output(), later(), inputDigester());
    await tamper((entry) => {
      // And no stylesheet, which would otherwise be refused as unrecorded: the empty list alone.
      entry['inputs'] = [];
      entry['stylesheets'] = [];
    });
    expect(await readGroup(ROOT, key, inputDigester())).toBeUndefined();
  });

  test('chunk code that does not hash to its recorded digest', async () => {
    await writeGroup(ROOT, key, output(), later(), inputDigester());
    await tamper((entry) => {
      const [first] = entry['chunks'] as { code: string }[];
      if (first !== undefined) first.code = 'alert(1)';
    });
    expect(await readGroup(ROOT, key, inputDigester())).toBeUndefined();
  });

  test.each([
    ['no url', (one: Record<string, unknown>) => delete one['url']],
    ['no file', (one: Record<string, unknown>) => delete one['file']],
    ['imports not a list of strings', (one: Record<string, unknown>) => (one['imports'] = [1])],
    ['bytes not a count', (one: Record<string, unknown>) => (one['bytes'] = '12')],
    ['an unknown realtime kind', (one: Record<string, unknown>) => (one['realtime'] = 'maybe')],
  ])('a chunk with valid code but %s', async (_, edit) => {
    await writeGroup(ROOT, key, output(), later(), inputDigester());
    await tamper((entry) => {
      const [first] = entry['chunks'] as Record<string, unknown>[];
      if (first !== undefined) edit(first);
    });
    expect(await readGroup(ROOT, key, inputDigester())).toBeUndefined();
  });

  test('a shared chunk with valid code but no importers', async () => {
    const shared = { url: '/islands/chunk-ab12cd34.js', code: 'x', bytes: 1, importers: [] };
    await writeGroup(ROOT, key, output({ shared: [shared] }), later(), inputDigester());
    await tamper((entry) => {
      const [first] = entry['shared'] as Record<string, unknown>[];
      if (first !== undefined) delete first['importers'];
    });
    expect(await readGroup(ROOT, key, inputDigester())).toBeUndefined();
  });

  test('a stylesheet that is not one of the recorded inputs', async () => {
    await writeGroup(ROOT, key, output(), later(), inputDigester());
    await tamper((entry) => {
      entry['stylesheets'] = ['/etc/hostname'];
    });
    expect(await readGroup(ROOT, key, inputDigester())).toBeUndefined();
  });
});

describe('writeGroup', () => {
  test('records nothing when an input changed while the build ran, even by a coarse clock', async () => {
    // A 1–2 s mtime resolution, or a clock stepped back: the edit's mtime reads BEFORE the start.
    const edited = new Date(later() - 10_000 - 1_000);
    await utimes(ISLAND, edited, edited);
    await writeGroup(ROOT, key, output(), later() - 10_000, inputDigester());
    expect(await Bun.file(entryFile()).exists()).toBe(false);
  });

  test('stamps the digest read BEFORE the build, so an edit that kept its mtime still misses', async () => {
    const digestOf = inputDigester();
    await digestOf(ISLAND); // what the pre-build read of the previous entry saw
    await Bun.write(ISLAND, 'export const a = 2;\n');
    const old = new Date(Date.UTC(2026, 0, 1));
    await utimes(ISLAND, old, old);
    await writeGroup(ROOT, key, output(), later(), digestOf);
    expect(await readGroup(ROOT, key, inputDigester())).toBeUndefined();
  });

  test('records nothing when a file was added beside an input while the build ran', async () => {
    // `util.ts` landing beside `util/` mid-build: every input's bytes are unchanged, the listing is
    // not — and the bundle was resolved against the listing before it.
    await Bun.write(join(ROOT, 'apps/web/site/util.ts'), 'export const word = 1;\n');
    await writeGroup(ROOT, key, output(), later() - 10_000, inputDigester());
    expect(await Bun.file(entryFile()).exists()).toBe(false);
  });

  test('stamps the listing read BEFORE the build when the pre-build read took one', async () => {
    const listingOf = listingDigester();
    await listingOf(join(ROOT, 'apps/web/site')); // the pre-build `readGroup` saw this listing
    await Bun.write(join(ROOT, 'apps/web/site/util.ts'), 'export const word = 1;\n');
    const old = new Date(Date.UTC(2026, 0, 1));
    await utimes(join(ROOT, 'apps/web/site'), old, old);
    await writeGroup(ROOT, key, output(), later(), inputDigester(), listingOf);
    expect(await readGroup(ROOT, key, inputDigester())).toBeUndefined();
  });

  test('a rename that fails leaves no partial file behind', async () => {
    // A non-empty directory where the entry goes: the rename over it fails, as EPERM does on Windows.
    await mkdir(join(entryFile(), 'occupied'), { recursive: true });
    await expect(writeGroup(ROOT, key, output(), later(), inputDigester())).rejects.toThrow();
    expect((await readdir(CACHE)).filter((name) => name !== `${key}.json`)).toEqual([]);
  });
});

describe('sweepGroupCache', () => {
  test('drops entries and partials nobody touched for 14 days; a hit keeps its entry alive', async () => {
    const now = Date.now();
    await writeGroup(ROOT, key, output(), later(), inputDigester());
    const stale = groupKey({
      group: ['old'],
      splitting: false,
      environment: 'e',
      persists: undefined,
    });
    await Bun.write(entryFile(stale), '{}');
    await Bun.write(join(CACHE, `${stale}.json.123.abc`), '{');
    const old = new Date(now - 15 * DAY);
    await utimes(entryFile(stale), old, old);
    await utimes(join(CACHE, `${stale}.json.123.abc`), old, old);
    await utimes(entryFile(), old, old);
    // Read today: the hit refreshes the entry's mtime.
    expect(await readGroup(ROOT, key, inputDigester())).toBeDefined();

    await sweepGroupCache(ROOT, now);
    expect((await readdir(CACHE)).sort()).toEqual([`${key}.json`]);
  });
});

describe('groupKey', () => {
  test('moves with every input a file digest cannot see', () => {
    const base = {
      group: ['one'],
      splitting: false,
      environment: 'e',
      persists: undefined,
    } as const;
    const same = groupKey(base);
    expect(groupKey({ ...base })).toBe(same);
    expect(groupKey({ ...base, group: ['one', 'two'] })).not.toBe(same);
    expect(groupKey({ ...base, splitting: true })).not.toBe(same);
    expect(groupKey({ ...base, environment: 'other' })).not.toBe(same);
    expect(groupKey({ ...base, persists: true })).not.toBe(same);
  });
});

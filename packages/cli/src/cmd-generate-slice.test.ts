// Which generators read the slice they write into. A template is a pure string function, so what
// the slice's `entity.ts` declares reaches it only if `x g` reads the file — and `x g query` was
// never told, so its unit test could not store a row: it could not know the columns.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { Generator } from './cmd-generate';
import { GENERATORS, generate, readSliceFile, writeFiles } from './cmd-generate';

const SLICE = 'apps/web/app/invoice';

const withSlice = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-generate-slice-'));
  try {
    // The entity `x g entity invoice` writes, as the slice's own file on disk.
    for (const file of generate({ kind: 'entity', name: 'invoice', feature: 'invoice' })) {
      if (file.path.startsWith(`${SLICE}/`)) await Bun.write(join(root, file.path), file.contents);
    }
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe('unit · x g reads the slice it writes into', () => {
  test('query reads entity.ts and repo.ts, beside the four kinds that already did', async () => {
    await withSlice(async (root) => {
      const reads: Generator[] = [];
      for (const kind of GENERATORS) {
        if ((await readSliceFile(root, kind, SLICE, 'entity.ts')) !== undefined) reads.push(kind);
      }
      expect(reads.sort()).toEqual(['action', 'job', 'mutator', 'query', 'task']);
      expect(await readSliceFile(root, 'query', SLICE, 'repo.ts')).toContain(
        'export async function',
      );
    });
  });

  test('a slice with no entity yet reads as absent, never as an empty file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-generate-slice-'));
    try {
      expect(await readSliceFile(root, 'query', SLICE, 'entity.ts')).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('what was read reaches the template: the query test stores rows in the scaffold slice', async () => {
    await withSlice(async (root) => {
      const sliceEntity = await readSliceFile(root, 'query', SLICE, 'entity.ts');
      const sliceRepo = await readSliceFile(root, 'query', SLICE, 'repo.ts');
      if (sliceEntity === undefined || sliceRepo === undefined) {
        return expect.unreachable('the slice on disk was not read');
      }
      const told = generate({
        kind: 'query',
        name: 'invoice-search',
        feature: 'invoice',
        sliceEntity,
        sliceRepo,
      });
      const untold = generate({ kind: 'query', name: 'invoice-search', feature: 'invoice' });
      const specOf = (files: typeof told): string =>
        String(
          files.find((file) => file.path.endsWith('/queries/invoice-search.test.ts'))?.contents,
        );
      expect(specOf(told)).toContain('stored rows read back newest first');
      expect(specOf(untold)).not.toContain('stored rows read back newest first');
    });
  });
});

describe('unit · x g resource and --feature', () => {
  // `x g resource run --feature runs` wrote the slice into `app/run/` and said nothing: the flag
  // was read, then overwritten with the name. A resource IS its feature — every file it composes
  // names the entity after the slice — so a second name is refused, never dropped.
  test('a --feature that names another slice is refused, with the run that works', () => {
    let refused: unknown;
    try {
      generate({ kind: 'resource', name: 'run', feature: 'runs' });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeUltimateError('X_CLI_BAD_FLAG');
    expect((refused as { fix?: string }).fix).toBe('x g resource run');
    expect(String((refused as { cause?: string }).cause)).toContain('apps/web/app/run/');
  });

  test('a --feature that says what the name already says is not a second name', () => {
    const paths = (feature?: string): readonly string[] =>
      generate({
        kind: 'resource',
        name: 'BlogPost',
        ...(feature === undefined ? {} : { feature }),
      })
        .map((file) => file.path)
        .sort();
    expect(paths('blog-post')).toEqual(paths());
    expect(paths('BlogPost')).toEqual(paths());
    expect(paths()).toContain('apps/web/app/blog-post/entity.ts');
  });
});

describe('unit · a generator run leaves a catalog a minimal diff', () => {
  test('a hand-ordered catalog keeps every line it had; the run only adds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-generate-catalog-'));
    try {
      const path = 'packages/i18n/catalogs/en.json';
      // Grouped by screen, not alphabetised — the reference app's own shape.
      const before = `${JSON.stringify({ site: { home: { title: 'Home' } }, app: { feed: { title: 'Feed' } } }, null, 2)}\n`;
      await Bun.write(join(root, path), before);
      const report = await writeFiles(
        root,
        [{ path, contents: JSON.stringify({ app: { apple: { title: 'Apple' } } }), merge: 'json' }],
        false,
      );
      expect(report.written).toEqual([path]);
      const after = await Bun.file(join(root, path)).text();
      const kept = before.split('\n').filter((line) => line.trim().length > 1);
      // Every line the file held is still there, in the order it was in: nothing was re-sorted.
      const positions = kept.map((line) => after.split('\n').indexOf(line));
      expect(positions.every((at) => at >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(JSON.parse(after)).toEqual({
        site: { home: { title: 'Home' } },
        app: { feed: { title: 'Feed' }, apple: { title: 'Apple' } },
      });
      expect(Object.keys(JSON.parse(after) as object)).toEqual(['site', 'app']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

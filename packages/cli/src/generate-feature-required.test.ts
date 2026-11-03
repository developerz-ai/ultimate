// D5: a read and a one-off sweep each laid down a table. `x g query order` wrote 14 files, an entity
// and `next: x db gen "create orders"`; `x g backfill reindex` wrote 12 and `create reindexes`. Run
// through the real command on a real disk, because "0 files written" is a fact about the disk.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API, no listing and no recursive delete.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { REQUIRED_BUN } from './app-root';
import { generate, generateCommand } from './cmd-generate';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { SPECS } from './registry';

let root = '';

const contextFor = (argv: readonly string[]): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: root,
  runner: exec,
  env: {},
  bunVersion: REQUIRED_BUN,
});

const refusal = (
  argv: readonly string[],
): Promise<{ code?: string; cause?: string; fix?: string }> =>
  generateCommand.run(contextFor(argv)).then(
    () => expect.unreachable(`${argv.join(' ')} wrote files`),
    (error: { code?: string; cause?: string; fix?: string }) => error,
  );

const written = async (argv: readonly string[]): Promise<readonly string[]> => {
  const result = await generateCommand.run(contextFor(argv));
  return (result.data as { files: readonly string[] }).files;
};

/** The slice `x g entity post` leaves: a real `entity.ts`, so the kinds below have a table to read. */
const withPostSlice = async (): Promise<void> => {
  for (const file of generate({ kind: 'entity', name: 'post' })) {
    if (typeof file.contents === 'string' && file.path.endsWith('.ts')) {
      await Bun.write(join(root, file.path), file.contents);
    }
  }
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-feature-required-'));
  await Bun.write(join(root, 'app.config.ts'), 'export default {};\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('unit · x g query and x g backfill never create a table', () => {
  for (const kind of ['query', 'backfill']) {
    test(`x g ${kind} with no slice is refused, and writes nothing`, async () => {
      const refused = await refusal(['g', kind, 'order']);
      expect(refused.code).toBe('X_FEATURE_REQUIRED');
      expect(refused.cause).toContain('apps/web/app/order');
      expect(refused.fix).toStartWith('x g resource order');
      expect(await readdir(root)).toEqual(['app.config.ts']);
    });

    test(`x g ${kind} near a slice: the fix is the command the author meant`, async () => {
      await withPostSlice();
      const refused = await refusal(['g', kind, 'posts']);
      expect(refused.code).toBe('X_FEATURE_REQUIRED');
      expect(refused.fix).toStartWith(`x g ${kind} posts --feature post`);
      expect(refused.fix).toContain('x g resource posts');
    });

    test(`x g ${kind} far from every slice: lists them, and leads with the new table`, async () => {
      await withPostSlice();
      const refused = await refusal(['g', kind, 'order']);
      expect(refused.fix).toStartWith('x g resource order');
      expect(refused.cause).toContain('post');
    });

    test(`x g ${kind} --feature post writes under the slice, and no entity`, async () => {
      await withPostSlice();
      const files = await written(['g', kind, 'recent', '--feature', 'post']);
      expect(files.some((path) => path.includes('/post/'))).toBe(true);
      expect(files).not.toContain('apps/web/app/post/entity.ts');
      expect(files.some((path) => path.includes('/recent/'))).toBe(false);
    });

    test(`x g ${kind} post, a slice of that name: today's path`, async () => {
      await withPostSlice();
      const files = await written(['g', kind, 'post']);
      expect(files.some((path) => path.startsWith('apps/web/app/post/'))).toBe(true);
    });

    test(`x g ${kind} --feature naming no slice is X_FEATURE_UNKNOWN`, async () => {
      const refused = await refusal(['g', kind, 'recent', '--feature', 'nope']);
      expect(refused.code).toBe('X_FEATURE_UNKNOWN');
      expect(await readdir(root)).toEqual(['app.config.ts']);
    });

    test(`x g ${kind} into a slice holding no entity: the fix is the entity`, async () => {
      await written(['g', 'job', 'nightly']);
      const refused = await refusal(['g', kind, 'recent', '--feature', 'nightly']);
      expect(refused.code).toBe('X_FEATURE_REQUIRED');
      expect(refused.fix).toBe('x g entity nightly');
      expect(await Bun.file(join(root, 'apps/web/app/nightly/entity.ts')).exists()).toBe(false);
    });
  }

  test('the fix keeps every flag the caller set', async () => {
    await withPostSlice();
    const refused = await refusal(['g', 'query', 'posts', '--live']);
    expect(refused.fix).toStartWith('x g query posts --feature post --live');
  });

  test('a job and an action still write no entity with no slice: unchanged', async () => {
    const job = await written(['g', 'job', 'nightly']);
    expect(job.some((path) => path.endsWith('/entity.ts'))).toBe(false);
    const action = await written(['g', 'action', 'close-thing']);
    expect(action.some((path) => path.endsWith('/entity.ts'))).toBe(false);
  });

  test('a dry run refuses the same way', async () => {
    const refused = await refusal(['g', 'query', 'order', '--dry-run']);
    expect(refused.code).toBe('X_FEATURE_REQUIRED');
  });
});

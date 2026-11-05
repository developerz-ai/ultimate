// The generated `statements` assertions, RUN: a generated slice on a real disk, its own test file
// under `bun test`, once as emitted and once with a loop added to its handler. An assertion about
// a statement count is exactly the kind that passes for ever on a driver that reports nothing, so
// reading the emitted text would prove nothing about whether it can fail.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp, symlink or recursive remove — a throwaway app root is node:fs's.
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import { generate } from '../cmd-generate';
import { exec } from '../exec';
import { DIR_LINK } from '../scaffold-typecheck-fixture';
import type { GeneratedFile } from './naming';

let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-emitted-statements-'));
  // What `bun install` would have linked: this package's own `@ultimat3/*` workspace links.
  await mkdir(join(root, 'node_modules'), { recursive: true });
  const framework = join(import.meta.dir, '..', '..', 'node_modules', '@ultimat3');
  await symlink(framework, join(root, 'node_modules', '@ultimat3'), DIR_LINK);
  await Bun.write(join(root, 'bunfig.toml'), '[test]\npreload = ["@ultimat3/testing/preload"]\n');
  await Bun.write(
    join(root, 'db.ts'),
    `import { database, memoryDriver } from '@ultimat3/entity';
import { invoice } from './apps/web/app/invoice/entity';

export const driver = memoryDriver();
export const db = database({ invoices: invoice }, { driver });
`,
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The planned files as `x g` would land them, the first of a path winning, as `dedupe` does. */
const land = async (files: readonly GeneratedFile[]): Promise<void> => {
  for (const file of files) {
    if (typeof file.contents === 'string') await Bun.write(join(root, file.path), file.contents);
  }
};

/** One generated test file, run the way an app's `unit` step runs it. */
const suite = async (path: string): Promise<{ readonly ok: boolean; readonly output: string }> => {
  const result = await exec(['bun', 'test', `./${path}`], { cwd: root });
  return { ok: result.ok, output: `${result.stdout}\n${result.stderr}` };
};

const edit = async (path: string, from: string, to: string): Promise<void> => {
  const source = await Bun.file(join(root, path)).text();
  expect(source).toContain(from);
  await Bun.write(join(root, path), source.replace(from, to));
};

const dbModule = () => join(root, 'db.ts');

describe('unit · a generated statements assertion fails when its handler gains a loop', () => {
  test('x g query', async () => {
    const entity = generate({ kind: 'entity', name: 'invoice', dbModule: dbModule() });
    const entitySource = String(entity.find((file) => file.path.endsWith('/entity.ts'))?.contents);
    await land(
      generate({
        kind: 'query',
        name: 'invoice-search',
        feature: 'invoice',
        dbModule: dbModule(),
        sliceEntity: entitySource,
      }),
    );
    const source = 'apps/web/app/invoice/queries/invoice-search.ts';
    const test = 'apps/web/app/invoice/queries/invoice-search.test.ts';
    const clean = await suite(test);
    expect(clean.ok, clean.output).toBe(true);

    await edit(
      source,
      '() => repo.list(limit, sort, dir))',
      `async () => {
        const rows = await repo.list(limit, sort, dir);
        for (const row of rows) await repo.byId(row.id);
        return rows;
      })`,
    );
    const looped = await suite(test);
    expect(looped.ok).toBe(false);
    expect(looped.output).toContain('(fail) unit · the read is one statement, however many rows');
  }, 60_000);

  for (const [kind, file, handler] of [
    ['action', 'ship-invoice', 'async handle({ input }) {'],
    ['mutator', 'rename-invoice', 'async server(_ctx, input) {'],
  ] as const) {
    test(`x g ${kind}`, async () => {
      const entity = generate({ kind: 'entity', name: 'invoice', dbModule: dbModule() });
      const entitySource = String(entity.find((one) => one.path.endsWith('/entity.ts'))?.contents);
      await land(
        generate({
          kind,
          name: file,
          feature: 'invoice',
          dbModule: dbModule(),
          sliceEntity: entitySource,
        }),
      );
      const source = `apps/web/app/invoice/actions/${file}.ts`;
      const test = `apps/web/app/invoice/actions/${file}.test.ts`;
      const clean = await suite(test);
      expect(clean.ok, clean.output).toBe(true);

      await edit(source, handler, `${handler}\n    await repo.byId(input.id);`);
      const looped = await suite(test);
      expect(looped.ok).toBe(false);
      expect(looped.output).toContain('(fail) unit · the handler reads its row in one statement');
    }, 60_000);
  }
});

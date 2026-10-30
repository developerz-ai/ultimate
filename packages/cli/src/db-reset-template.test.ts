import { afterEach, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete; the data directory is real.
import { existsSync } from 'node:fs';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { dbUnavailable, type PgliteClient } from '@ultimat3/db';
import { layTemplate } from './db-reset-template';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const scratch = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'ultimate-reset-template-'));
  dirs.push(dir);
  return dir;
};

test('the template is opened ON the data directory, with the app extensions, then closed', async () => {
  const root = await scratch();
  const dataDir = join(root, '.x', 'pgdata');
  const asked: unknown[] = [];
  let closed = 0;
  const laid = await layTemplate(root, dataDir, {
    extensions: async () => ['citext'],
    open: async (options) => {
      asked.push(options);
      return {
        execute: async () => 0,
        close: async () => {
          closed += 1;
        },
      } as unknown as PgliteClient;
    },
  });
  expect(laid).toBe(true);
  expect(asked).toEqual([{ root, dataDir, extensions: ['citext'] }]);
  expect(closed).toBe(1);
});

test('a template that cannot be laid down leaves no half-written directory, and never throws', async () => {
  const root = await scratch();
  const dataDir = join(root, '.x', 'pgdata');
  let closed = 0;
  const laid = await layTemplate(root, dataDir, {
    extensions: async () => [],
    open: async () => {
      await mkdir(join(dataDir, 'base'), { recursive: true });
      return {
        execute: async () => {
          throw dbUnavailable('the restore failed half-way');
        },
        close: async () => {
          closed += 1;
        },
      } as unknown as PgliteClient;
    },
  });
  expect(laid).toBe(false);
  expect(closed).toBe(1);
  expect(existsSync(dataDir)).toBe(false);
  expect(
    await layTemplate(root, dataDir, {
      extensions: async () => {
        throw dbUnavailable('unreadable migrations');
      },
    }),
  ).toBe(false);
});

test('laid for real: a migrated app on disk, its ledger full before any migrate runs', async () => {
  const root = await scratch();
  await Bun.write(join(root, 'app.config.ts'), 'export default {};\n');
  await Bun.write(
    join(root, 'packages/db/migrations/20260101000000_notes.sql'),
    'create table notes (id text primary key);\n-- down\ndrop table notes;\n',
  );
  const dataDir = join(root, '.x', 'pgdata');
  expect(await layTemplate(root, dataDir)).toBe(true);
  const { pgliteClient, raw } = await import('@ultimat3/db');
  const client = pgliteClient({ dataDir });
  try {
    const rows = await client.query<{ n: number }>(
      raw("select count(*)::int as n from information_schema.tables where table_name = 'notes'"),
    );
    expect(rows[0]?.n).toBe(1);
  } finally {
    await client.close();
  }
}, 60_000);

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteClient } from './pglite';
import { branchPglite, pgliteBranchDir } from './pglite-branch';
import { sql } from './sql';

let root: string;
let from: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-pglite-branch-'));
  from = join(root, 'pgdata');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const seedDataDir = async (): Promise<void> => {
  await mkdir(join(from, 'base'), { recursive: true });
  await writeFile(join(from, 'PG_VERSION'), '16\n');
  await writeFile(join(from, 'base', '1247'), 'x'.repeat(64));
};

// Booting PGlite is a WASM compile plus an initdb — ~1.5s each, and the test below pays it three
// times. bun's default 5s per test is under the honest cost of the thing being measured, so a
// slow runner turns a passing test into a timeout whose teardown then races the copy. Stated
// here, generous on purpose: this bound exists to catch a hang, not to police a boot.
const THREE_PGLITE_BOOTS_MS = 60_000;

const failure = async (run: () => Promise<unknown>): Promise<{ code: string; fix: string }> => {
  try {
    await run();
  } catch (error) {
    return error as { code: string; fix: string };
  }
  throw new Error('expected the branch to be refused');
};

describe('pgliteBranchDir', () => {
  test('a branch lives beside the data directory it was copied from', () => {
    expect(pgliteBranchDir('/app/.x/pgdata', 'feature_x')).toBe('/app/.x/pgdata-feature_x');
  });
});

describe('branchPglite', () => {
  test('copies the data directory and reports where the branch is', async () => {
    await seedDataDir();
    const info = await branchPglite('feature_x', { from, now: new Date('2026-08-09T00:00:00Z') });

    expect(info.dataDir).toBe(join(root, 'pgdata-feature_x'));
    expect(info.name).toBe('feature_x');
    expect(info.createdAt).toBe('2026-08-09T00:00:00.000Z');
    expect(info.sizeBytes).toBe(67);
    expect(await Bun.file(join(info.dataDir, 'base', '1247')).text()).toBe('x'.repeat(64));
  });

  test('an explicit target wins over the default layout', async () => {
    await seedDataDir();
    const to = join(root, 'elsewhere', 'copy');
    expect((await branchPglite('feature_x', { from, to })).dataDir).toBe(to);
    expect(await Bun.file(join(to, 'PG_VERSION')).exists()).toBe(true);
  });

  test('a pglite:// url is accepted wherever a data directory is', async () => {
    await seedDataDir();
    const info = await branchPglite('from_url', { from: `pglite://${from}` });
    expect(await Bun.file(join(info.dataDir, 'PG_VERSION')).exists()).toBe(true);
  });

  test('an existing branch is refused with X_BRANCH_EXISTS, never silently overwritten', async () => {
    await seedDataDir();
    await branchPglite('feature_x', { from });
    const error = await failure(() => branchPglite('feature_x', { from }));
    expect(error.code).toBe('X_BRANCH_EXISTS');
    expect(error.fix).toContain('x db branch drop feature_x');
  });

  test('force replaces the branch outright, leaving no file from the old one', async () => {
    await seedDataDir();
    const first = await branchPglite('feature_x', { from });
    await writeFile(join(first.dataDir, 'stale'), 'gone');
    const second = await branchPglite('feature_x', { from, force: true });
    expect(second.dataDir).toBe(first.dataDir);
    expect(await Bun.file(join(second.dataDir, 'stale')).exists()).toBe(false);
  });

  test('a name that would escape the state directory is refused before any path is built', async () => {
    await seedDataDir();
    const error = await failure(() => branchPglite('../../etc', { from }));
    expect(error.code).toBe('X_SQL_UNSAFE');
    expect(await Bun.file(join(root, 'pgdata-../../etc')).exists()).toBe(false);
  });

  test('an in-memory database has no directory to copy and says so', async () => {
    const error = await failure(() => branchPglite('feature_x', { from: 'pglite://memory/t' }));
    expect(error.code).toBe('X_NOT_IMPLEMENTED');
    expect(error.fix).toContain('x dev');
  });

  test('a data directory that was never created reports X_DB_UNAVAILABLE', async () => {
    const error = await failure(() => branchPglite('feature_x', { from }));
    expect(error.code).toBe('X_DB_UNAVAILABLE');
  });

  // The point of a branch is that the copy is a working database, not that files moved.
  test(
    'the branch is a real database carrying the rows the source committed',
    async () => {
      const source = createPgliteClient({ dataDir: from });
      await source.execute(sql`create table posts (id int primary key, title text)`);
      await source.execute(sql`insert into posts values (${1}, ${'shipped'})`);
      await source.close();

      const info = await branchPglite('feature_x', { from });
      const branch = createPgliteClient({ dataDir: info.dataDir });
      try {
        expect(
          await branch.one<{ title: string }>(sql`select title from posts where id = ${1}`),
        ).toEqual({ title: 'shipped' });
        await branch.execute(sql`insert into posts values (${2}, ${'branch only'})`);
      } finally {
        await branch.close();
      }

      const reopened = createPgliteClient({ dataDir: from });
      try {
        expect(await reopened.query(sql`select id from posts`)).toEqual([{ id: 1 }]);
      } finally {
        await reopened.close();
      }
    },
    THREE_PGLITE_BOOTS_MS,
  );
});

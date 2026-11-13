// `x explain` end to end on a fixture app and a real embedded database: the statements the query
// SENT (physical, not `toSQL()`'s logical rendering) are planned by the exercise gate's oracle, so
// an unindexed filter is red with the `indexes:` entry as its fix and an indexed one is green.
// Registries are process-global, so every test puts back what it found.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { db, raw, sql } from '@ultimat3/db';
import { entity, text, uuid } from '@ultimat3/entity';
import { can, clearPermissions, definePermissions } from '@ultimat3/policy';
import { from, query, resetQueries, t } from '@ultimat3/query';
import { registerQueries } from '@ultimat3/query/loader';
import { isolateEntityRegistry } from '@ultimat3/testing/registry-isolation';
import { REQUIRED_BUN } from './app-root';
import { explainCommandOver, type OpenDb } from './cmd-explain';
import type { CommandContext } from './command';
import { exec } from './exec';
import { parseArgs } from './parse';
import { processRoot } from './process-root-fixture';
import { SPECS } from './registry';
import { openAppQueue } from './runtime-boot-ports';

const ROOT = processRoot(join(import.meta.dir, '..', '.explain-fixture'));
const ENV = { ULTIMATE_STATE_DIR: join(ROOT, '.x') };

const ctxFor = (
  argv: readonly string[],
  env: Readonly<Record<string, string>> = ENV,
): CommandContext => ({
  args: parseArgs(argv, SPECS),
  cwd: ROOT,
  runner: exec,
  env,
  bunVersion: REQUIRED_BUN,
});

/** The dev database the shipped command opens, with the fixture's table made on it. */
const openWithTable: OpenDb = async (root, ctx) => {
  const queue = await openAppQueue(root, ctx.env);
  await queue.db.execute(
    raw('create table if not exists xe_items (id uuid primary key, name text not null)'),
  );
  return { db: queue.db, close: () => queue.stop() };
};

let opened = 0;
const command = explainCommandOver(async (root, ctx) => {
  opened += 1;
  return openWithTable(root, ctx);
});

let restoreEntities: () => void = () => undefined;
beforeAll(async () => {
  await Bun.write(join(ROOT, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
});
afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});
beforeEach(() => {
  opened = 0;
  restoreEntities = isolateEntityRegistry();
  entity('xe_items', { columns: { id: uuid().primaryKey(), name: text({ max: 40 }) } });
  definePermissions(['xe:read'] as const);
  registerQueries({
    xeByName: query({
      input: t.object({ name: t.string }),
      policy: can('xe:read'),
      sql: (input) =>
        from<{ id: string }>('xe_items', async () =>
          db().query<{ id: string }>(sql`select id from xe_items where name = ${input.name}`),
        ),
    }),
    xeById: query({
      input: t.object({ id: t.string }),
      policy: can('xe:read'),
      sql: (input) =>
        from<{ id: string }>('xe_items', async () =>
          db().query<{ id: string }>(sql`select id from xe_items where id = ${input.id}::uuid`),
        ),
    }),
  });
});
afterEach(() => {
  resetQueries();
  clearPermissions();
  restoreEntities();
});

describe('unit · x explain', () => {
  test('a filter no index serves is red, and the fix is the index to declare', async () => {
    const result = await command.run(ctxFor(['explain', 'xeByName', '--input', '{"name":"a"}']));
    expect(result.ok).toBe(false);
    expect((result.data as { statements: string[] }).statements).toEqual([
      'select id from xe_items where name = $1',
    ]);
    const [finding] = result.findings ?? [];
    expect(finding?.code).toBe('X_QUERY_UNINDEXED');
    expect(finding?.fix).toContain("indexes: [{ on: ['name'] }]");
  }, 60_000);

  test('a read the primary key serves is green', async () => {
    const result = await command.run(
      ctxFor(['explain', 'xeById', '--input', '{"id":"00000000-0000-4000-8000-000000000001"}']),
    );
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect((result.data as { planned: number }).planned).toBe(1);
  }, 60_000);

  test('no query, bad JSON and an unknown name are refused before the database opens', async () => {
    await expect(command.run(ctxFor(['explain']))).rejects.toBeUltimateError('X_CLI_BAD_FLAG');
    await expect(
      command.run(ctxFor(['explain', 'xeByName', '--input', '{nope'])),
    ).rejects.toBeUltimateError('X_CLI_BAD_FLAG');
    await expect(command.run(ctxFor(['explain', 'xeByNam']))).rejects.toBeUltimateError(
      'X_DECLARATION_UNKNOWN',
    );
    expect(opened).toBe(0);
  }, 60_000);

  test('an external database in production is refused before anything opens: policy is skipped', async () => {
    const external = { ...ENV, DATABASE_URL: 'postgres://app@db.internal:5432/shop' };
    for (const env of [
      { ...external, ULTIMATE_ENV: 'production' },
      { ...external, NODE_ENV: 'production' },
      // A typo cannot say which deploy this is, so it reads as the most dangerous one.
      { ...external, ULTIMATE_ENV: 'prodution' },
    ]) {
      const failure = await command.run(ctxFor(['explain', 'xeById'], env)).then(
        () => expect.unreachable('x explain ran against a production database'),
        (error: unknown) => error,
      );
      expect(failure).toBeUltimateError('X_EXPLAIN_PRODUCTION_DATABASE');
      expect((failure as { fix: string }).fix).toStartWith(
        'env -u DATABASE_URL x explain xeById --json',
      );
    }
    expect(opened).toBe(0);
  }, 60_000);

  test('an external database outside production is planned as before', async () => {
    const refusedBefore = await command
      .run(
        ctxFor(['explain', 'xeById'], {
          ...ENV,
          DATABASE_URL: 'postgres://app@127.0.0.1:1/never',
          ULTIMATE_ENV: 'staging',
        }),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    // The fake opener reached: the refusal is the environment's, never the database mode's alone.
    expect(opened).toBe(1);
    expect(refusedBefore).not.toBeUltimateError('X_EXPLAIN_PRODUCTION_DATABASE');
  }, 60_000);
});

// The tables that reach `x db gen` as `replicaIdentityFull` — a params channel's `records` tables,
// and since #518 never a live query's `subscribes:` — and the refusal for a declared `subscribes:`
// name no entity's table matches, the check only this tier can make because it alone holds the
// manifest and the entity registry at once. The end-to-end test asserts the emitted SQL.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive remove, and a fixture tree left behind grows one directory per run.
import { rmSync } from 'node:fs';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { can, clearPermissions } from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry, t } from '@ultimat3/query';
import { generateAppMigration } from './db-generate';
import { replicaIdentityTables } from './db-subscribes';

/** A descriptor pair is all `replicaIdentityTables` reads — the manifest's own two fields. */
const declared = (name: string, subscribes: readonly string[] | null) => ({ name, subscribes });

const roots: string[] = [];

/** `Bun.write` creates intermediate directories, so it is this repo's `mkdir -p`. */
const tempRoot = async (): Promise<string> => {
  const root = `${Bun.env['TMPDIR'] ?? '/tmp'}/x-subscribes-${Bun.randomUUIDv7()}`;
  await Bun.write(`${root}/package.json`, '{"name":"subscribes-fixture","version":"0.0.0"}\n');
  roots.push(root);
  return root;
};

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  clearRegistry();
  resetRegistry();
});

// Every `can()` here names a permission no `definePermissions()` declares, which is legal only
// while the set is EMPTY. A file that ran first in this process may have imported
// `@ultimat3/admin`, whose module scope declares `admin:*` for good — so this file empties the set
// itself; the file boundary (`registry-leak-guard.ts`) puts it back after.
beforeAll(clearPermissions);

describe('unit · the tables a live query declares it is patched from', () => {
  // #518: every entity has a primary key (`entity()` refuses one without), and a live query over a
  // keyed table is correct on DEFAULT identity — the shared window holds the whole row the
  // in/out/delete decision needs (`realtime/src/pg-identity-window.live.test.ts`, real WAL). FULL
  // on those tables bought nothing but every UPDATE and DELETE logging the whole old row.
  test('a subscribed keyed table is not granted FULL — the declaration is validated, not granted', () => {
    const tables = new Set(['comments', 'posts']);
    expect(
      replicaIdentityTables(
        [
          declared('liveFeed', ['posts']),
          declared('liveThread', ['comments', 'posts']),
          declared('publicPosts', null),
        ],
        tables,
        [],
      ),
    ).toEqual([]);
  });

  // A channel declared with params routes a DELETE by columns of the OLD row, which only FULL
  // identity logs — so its records tables are the ones the generator still grants, deduped and
  // sorted, whether or not a live read also subscribes to them.
  test('the records tables of a params channel are granted FULL, and only they', () => {
    const tables = new Set(['comments', 'notifications', 'posts']);
    expect(
      replicaIdentityTables([declared('liveFeed', ['comments'])], tables, [
        'posts',
        'notifications',
      ]),
    ).toEqual(['notifications', 'posts']);
    expect(replicaIdentityTables([], tables, ['notifications'])).toEqual(['notifications']);
  });

  test('a channel table no entity declares is not handed to the generator', () => {
    // A projection's table is always an entity's; one that is not here belongs to an entity whose
    // module did not load, and the generator would emit an ALTER for a table it never creates.
    expect(replicaIdentityTables([], new Set(['posts']), ['ghosts'])).toEqual([]);
  });

  test('an app whose reads declare none asks for no ALTER at all', () => {
    expect(replicaIdentityTables([declared('publicPosts', null)], new Set(['posts']))).toEqual([]);
  });

  /**
   * The gap this exists to close. `@ultimat3/db` keeps only the declared names an entity's table
   * matches (`replica-identity.ts`'s `.filter`), so an EXTRA name is dropped in silence — and
   * `@ultimat3/query` has no table catalog and cannot see it. A typo therefore granted REPLICA
   * IDENTITY FULL to nothing while its author read the declaration as granted.
   */
  test('a declared name no entity table matches is refused, even beside one that matches', () => {
    let thrown: unknown;
    try {
      replicaIdentityTables([declared('liveFeed', ['posts', 'user'])], new Set(['posts', 'users']));
    } catch (error) {
      thrown = error;
    }
    if (thrown === undefined) expect.unreachable('a name matching no table was accepted');
    expect(thrown).toBeUltimateError('X_QUERY_SUBSCRIBES_UNKNOWN');
    const failure = thrown as { cause: string; fix: string };
    expect(failure.cause).toContain('liveFeed');
    expect(failure.cause).toContain('"user"');
    // The near miss is in the cause too, or the reader retypes the same typo.
    expect(failure.fix).toContain('subscribes:');
    expect(failure.fix).toContain('users');
  });

  test('the refusal names the query, so an app with many live reads knows which file to open', () => {
    let thrown: unknown;
    try {
      replicaIdentityTables(
        [declared('liveFeed', ['posts']), declared('liveInbox', ['inbox'])],
        new Set(['posts']),
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { cause: string }).cause).toContain('liveInbox');
  });
});

describe('unit · x db gen and a live query that subscribes', () => {
  const declareApp = (): void => {
    entity('subscribes_test_note', {
      table: 'subscribes_test_notes',
      columns: { id: uuid().primaryKey(), body: text({ max: 200 }) },
    });
    registerQuery(
      'subscribesTestFeed',
      query({
        input: t.object({}),
        policy: can('note:read'),
        live: true,
        subscribes: ['subscribes_test_notes'],
        sql: () => from<{ id: string }>('subscribes_test_notes', []).orderBy('id').limit(50),
      }),
    );
  };

  // Additive by omission: no ALTER is emitted, and none is recorded, so an app already on FULL
  // keeps it (`replica-identity.ts` never reverts one, and the drift step reads a recorded FULL
  // nothing needs as agreement) while a new table is created on DEFAULT.
  test('a subscribed table is created with no REPLICA IDENTITY FULL, and none is recorded', async () => {
    declareApp();
    const root = await tempRoot();
    const first = await generateAppMigration(root, { name: 'init' });
    expect(first.outcome).toBe('generated');

    const sql = await Bun.file(
      `${root}/packages/db/migrations/${first.migration?.id ?? ''}.sql`,
    ).text();
    expect(sql).toContain('create table "subscribes_test_notes"');
    // The statement itself, not the call: an emitted ALTER is the only thing a database reads.
    expect(sql).not.toContain('replica identity');
    expect(first.migration?.destructive).toBe(false);

    const snapshot = await Bun.file(
      `${root}/packages/db/migrations/${first.migration?.id ?? ''}.snapshot.json`,
    ).json();
    expect(snapshot).not.toMatchObject({ tables: [{ replicaIdentityFull: true }] });

    const second = await generateAppMigration(root, { name: 'again' });
    expect(second.outcome).not.toBe('generated');
  });
});

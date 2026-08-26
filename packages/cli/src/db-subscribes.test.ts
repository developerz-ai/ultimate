// The `subscribes:` half of #357, both directions: the tables that reach `x db gen` as
// `replicaIdentityFull`, and the refusal for a declared name no entity's table matches — the check
// only this tier can make, because it is the only one holding the manifest and the entity registry
// at once. The end-to-end test asserts the emitted SQL, never that the call was made.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive remove, and a fixture tree left behind grows one directory per run.
import { rmSync } from 'node:fs';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { can } from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry, t } from '@ultimat3/query';
import { generateAppMigration } from './db-generate';
import { replicaIdentityTables } from './db-subscribes';

/** A descriptor pair is all `replicaIdentityTables` reads — the manifest's own two fields. */
const declared = (name: string, subscribes: readonly string[] | null) => ({ name, subscribes });

const roots: string[] = [];

/** `Bun.write` creates intermediate directories, so it is this repo's `mkdir -p`. */
const tempRoot = async (): Promise<string> => {
  const root = `${process.env['TMPDIR'] ?? '/tmp'}/x-subscribes-${Bun.randomUUIDv7()}`;
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

describe('unit · the tables a live query declares it is patched from', () => {
  test('every declared name reaches the generator, deduped and sorted', () => {
    const tables = new Set(['comments', 'posts']);
    expect(
      replicaIdentityTables(
        [
          declared('liveFeed', ['posts']),
          declared('liveThread', ['comments', 'posts']),
          declared('publicPosts', null),
        ],
        tables,
      ),
    ).toEqual(['comments', 'posts']);
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

describe('unit · x db gen emits the ALTER the declaration asks for', () => {
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

  test('the declared table gets its ALTER, recorded so the next run emits nothing', async () => {
    declareApp();
    const root = await tempRoot();
    const first = await generateAppMigration(root, { name: 'init' });
    expect(first.outcome).toBe('generated');

    const sql = await Bun.file(
      `${root}/packages/db/migrations/${first.migration?.id ?? ''}.sql`,
    ).text();
    expect(sql).toContain('create table "subscribes_test_notes"');
    // The statement itself, not the call: an emitted ALTER is the only thing a database reads.
    expect(sql).toContain('alter table "subscribes_test_notes" replica identity full;');
    // Additive, so the migration must not have earned the destructive marker.
    expect(first.migration?.destructive).toBe(false);

    // Recorded on the sidecar, which is what makes it a one-time statement.
    const snapshot = await Bun.file(
      `${root}/packages/db/migrations/${first.migration?.id ?? ''}.snapshot.json`,
    ).json();
    expect(snapshot).toMatchObject({ tables: [{ replicaIdentityFull: true }] });

    const second = await generateAppMigration(root, { name: 'again' });
    expect(second.outcome).not.toBe('generated');
  });
});

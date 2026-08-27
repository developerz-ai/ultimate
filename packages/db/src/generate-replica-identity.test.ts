// The half of issue #357 this package owns: `@ultimat3/realtime` refuses a live query on a table
// without `REPLICA IDENTITY FULL`, and nothing emitted it. What is pinned here is that the
// statement is emitted ONCE — the snapshot records it, so the second `x db gen` is an empty diff —
// that it is never read as destructive, and that a table nobody subscribes to keeps Postgres' own
// default.

import { describe, expect, test } from 'bun:test';
import { destructiveStatements } from './destructive';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import type { SchemaDescription } from './introspect';
import { snapshotJson } from './snapshot-json';
import { parseSnapshot } from './snapshot-parse';

const column = (name: string): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: false,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
});

const entity = (table: string): EntityDescriptionLike => ({
  name: table,
  table,
  primaryKey: ['id'],
  columns: [column('id'), column('body')],
  indexes: [],
});

const at = new Date('2026-08-26T00:00:00.000Z');
const EMPTY: SchemaDescription = { tables: [] };

/** What `x db gen` does the second time: the sidecar on disk, read back through its own parser. */
function roundTrip(snapshot: SchemaDescription): SchemaDescription {
  const parsed = parseSnapshot(JSON.parse(snapshotJson(snapshot)));
  if (parsed === undefined) expect.unreachable('the generator wrote a snapshot it cannot parse');
  return parsed;
}

const generate = (
  entities: readonly EntityDescriptionLike[],
  current: SchemaDescription,
  replicaIdentityFull?: readonly string[],
) =>
  generateMigration({
    entities,
    current,
    name: 'live',
    now: at,
    ...(replicaIdentityFull === undefined ? {} : { replicaIdentityFull }),
  });

describe('replica identity full, from the live-query set (issue #357)', () => {
  test('a subscribed table gets the ALTER and an unsubscribed one keeps the default', () => {
    const migration = generate([entity('posts'), entity('tags')], EMPTY, ['posts']);

    expect(migration.up).toContain('alter table "posts" replica identity full;');
    expect(migration.up).not.toContain('"tags" replica identity');
  });

  test('the ALTER lands after the table it names exists', () => {
    const up = generate([entity('posts')], EMPTY, ['posts']).up;
    const created = up.indexOf('create table "posts"');
    const altered = up.indexOf('alter table "posts" replica identity full;');

    // Both must be PRESENT: `indexOf` answers -1, and -1 precedes every real offset, so an
    // ordering assertion alone holds when neither statement was emitted at all.
    expect(created).toBeGreaterThanOrEqual(0);
    expect(altered).toBeGreaterThanOrEqual(0);
    expect(created).toBeLessThan(altered);
  });

  test('the snapshot records it, so a second generation against the sidecar emits nothing', () => {
    const first = generate([entity('posts')], EMPTY, ['posts']);
    const recorded = roundTrip(first.snapshot);

    expect(recorded.tables[0]?.replicaIdentityFull).toBe(true);
    expect(generate([entity('posts')], recorded, ['posts']).up.trim()).toBe('');
  });

  test('the recorded fact survives a run whose caller passes no live-query set', () => {
    const first = roundTrip(generate([entity('posts')], EMPTY, ['posts']).snapshot);
    // `x db gen` from a command that never learned about live queries must not silently forget it,
    // or the run after it emits the ALTER again on a table that already carries it.
    const second = generate([entity('posts')], first);

    expect(second.up.trim()).toBe('');
    expect(second.snapshot.tables[0]?.replicaIdentityFull).toBe(true);
  });

  test('the statement is not destructive, in the verdict and in the classifier', () => {
    const migration = generate([entity('posts')], EMPTY, ['posts']);

    expect(migration.destructive).toBe(false);
    expect(destructiveStatements(migration.up)).toEqual([]);
    expect(migration.up).not.toContain('-- destructive: true');
  });

  test('a table name that needs quoting is quoted, in both directions', () => {
    const recorded: SchemaDescription = {
      tables: [
        {
          schema: 'public',
          name: 'user-likes',
          columns: [
            { name: 'body', dataType: 'text', nullable: true, default: null, position: 1 },
            { name: 'id', dataType: 'text', nullable: true, default: null, position: 2 },
          ],
          primaryKey: ['id'],
          indexes: [],
          foreignKeys: [],
        },
      ],
    };
    const migration = generate([entity('user-likes')], recorded, ['user-likes']);

    expect(migration.up).toContain('alter table "user-likes" replica identity full;');
    expect(migration.down).toContain('alter table "user-likes" replica identity default;');
  });

  test('a table this migration creates reverses by being dropped, with no second statement', () => {
    const migration = generate([entity('posts')], EMPTY, ['posts']);

    expect(migration.down).toContain('drop table "posts";');
    expect(migration.down).not.toContain('replica identity default');
  });

  test('an absent set emits nothing and records nothing', () => {
    const migration = generate([entity('posts')], EMPTY);

    expect(migration.up).not.toContain('replica identity');
    expect(migration.snapshot.tables[0]?.replicaIdentityFull).toBeUndefined();
  });

  test('an empty set emits nothing', () => {
    expect(generate([entity('posts')], EMPTY, []).up).not.toContain('replica identity');
  });

  test('a name no entity declares emits no ALTER against a table that will not exist', () => {
    const migration = generate([entity('posts')], EMPTY, ['posts', 'ghosts']);

    expect(migration.up).toContain('alter table "posts" replica identity full;');
    expect(migration.up).not.toContain('"ghosts"');
  });

  test('a sidecar written before the field existed reads as nothing recorded, not as none', () => {
    const older = roundTrip(generate([entity('posts')], EMPTY).snapshot);

    expect(older.tables[0]?.replicaIdentityFull).toBeUndefined();
    expect(generate([entity('posts')], older, ['posts']).up).toContain(
      'alter table "posts" replica identity full;',
    );
  });
});

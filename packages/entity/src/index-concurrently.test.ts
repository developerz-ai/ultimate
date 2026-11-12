// `indexes: [{ on, concurrently: true }]` from the declaration to the migration: it reaches the
// description, it never reaches the NAME (how an index is built is not what it is), an index that
// does not ask carries no key at all, and a foreign key's own index asked for again concurrently
// is still one index — built concurrently.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  generateMigration,
  LOCK_HEAVY_MARKER,
  lockHeavyStatements,
  snapshotOf,
} from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { entity } from './entity';
import { distinctIndexes } from './index-identity';
import { clearRegistry } from './registry';
import type { IndexDef } from './types';

afterAll(() => {
  clearRegistry();
});

describe('unit · an index declared `concurrently: true`', () => {
  const runs = entity('entity_test_concurrent_runs', {
    columns: { id: uuid().primaryKey(), status: text({ max: 20 }), rank: integer().default(0) },
    indexes: [{ on: ['status'], concurrently: true }, { on: ['rank'] }],
  });

  test('reaches the description, named exactly as the same index declared plainly', () => {
    const [status, rank] = runs.$describe().indexes;
    expect(status).toEqual({
      name: 'entity_test_concurrent_runs_status_idx',
      columns: ['status'],
      unique: false,
      where: null,
      order: null,
      concurrently: true,
    });
    // `true` or absent, never `false`: `x verify`'s source drift hashes this projection.
    expect(rank !== undefined && 'concurrently' in rank).toBe(false);
  });

  test('builds outside a transaction on a live table, and regenerates nothing after', () => {
    const before = snapshotOf([
      { ...runs.$describe(), indexes: runs.$describe().indexes.slice(1) },
    ]);
    const migration = generateMigration({
      entities: [runs.$describe()],
      current: before,
      name: 'index status',
      now: new Date('2026-10-31T00:00:00.000Z'),
    });
    expect(migration.transactional).toBe(false);
    expect(migration.up).toContain(
      'create index concurrently if not exists "entity_test_concurrent_runs_status_idx"',
    );

    const again = generateMigration({
      entities: [runs.$describe()],
      current: migration.snapshot,
      name: 'again',
      now: new Date('2026-10-31T00:00:00.000Z'),
    });
    expect(again.up).toBe('');
  });

  test('a foreign key index asked for again concurrently is one index, built concurrently', () => {
    // `teamId`, not `orgId`: an inferred tenant column is covered by the `(tenant, pk)` index and
    // gets no foreign-key index of its own (`tenant-index.ts`).
    const teams = entity('entity_test_concurrent_teams', { columns: { id: uuid().primaryKey() } });
    const members = entity('entity_test_concurrent_members', {
      columns: { id: uuid().primaryKey(), teamId: uuid().references(() => teams.id) },
      indexes: [{ on: ['teamId'], concurrently: true }],
    });
    const indexes = members.$describe().indexes.filter((each) => each.columns[0] === 'team_id');
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.concurrently).toBe(true);
  });
});

describe('unit · an index declared `concurrently: false`', () => {
  const runs = entity('entity_test_plain_runs', {
    columns: { id: uuid().primaryKey(), status: text({ max: 20 }), rank: integer().default(0) },
    indexes: [{ on: ['status'], concurrently: false }, { on: ['rank'] }],
  });
  const at = new Date('2026-12-01T00:00:00.000Z');
  const withoutStatus = () =>
    snapshotOf([{ ...runs.$describe(), indexes: runs.$describe().indexes.slice(1) }]);

  test('reaches the description as `false`, named as the same index declared plainly', () => {
    const [status, rank] = runs.$describe().indexes;
    expect(status?.name).toBe('entity_test_plain_runs_status_idx');
    expect(status?.concurrently).toBe(false);
    // Absent stays absent: every index an existing app declares projects what it did before.
    expect(rank !== undefined && 'concurrently' in rank).toBe(false);
  });

  test('on an existing table it is a plain build, with the marker the gate reads', () => {
    const migration = generateMigration({
      entities: [runs.$describe()],
      current: withoutStatus(),
      name: 'index status',
      now: at,
    });
    expect(migration.transactional).toBe(true);
    expect(migration.followUp).toBeUndefined();
    expect(migration.up).toContain(
      'create index "entity_test_plain_runs_status_idx" on "entity_test_plain_runs" ("status");',
    );
    const lines = migration.up.split('\n');
    // Directly above the build: the one statement the marker admits, so the gate reports nothing.
    expect(lines[lines.indexOf(LOCK_HEAVY_MARKER) + 1]).toContain('create index');
    expect(lockHeavyStatements(migration.up)).toEqual([]);
  });

  test('false, absent and true over a recorded index rebuild nothing', () => {
    const recorded = snapshotOf([runs.$describe()]);
    for (const concurrently of [false, undefined, true]) {
      const [status, ...rest] = runs.$describe().indexes;
      if (status === undefined) return expect.unreachable('the status index was not described');
      const { concurrently: _, ...plain } = status;
      const declared = concurrently === undefined ? plain : { ...plain, concurrently };
      const again = generateMigration({
        entities: [{ ...runs.$describe(), indexes: [declared, ...rest] }],
        current: recorded,
        name: 'again',
        now: at,
      });
      expect(again.up).toBe('');
      expect(again.followUp).toBeUndefined();
    }
  });
});

describe('unit · duplicates that disagree on how to build', () => {
  const base: IndexDef = { name: 'i', columns: ['a'], unique: false };
  const kept = (...asks: readonly (boolean | undefined)[]) =>
    distinctIndexes(
      asks.map((concurrently) => (concurrently === undefined ? base : { ...base, concurrently })),
    ).map((index) => index.concurrently);

  test('true wins, then an explicit false over absent; one index either way', () => {
    expect(kept(undefined, true)).toEqual([true]);
    expect(kept(false, true)).toEqual([true]);
    expect(kept(undefined, false)).toEqual([false]);
    expect(kept(undefined, undefined)).toEqual([undefined]);
  });
});

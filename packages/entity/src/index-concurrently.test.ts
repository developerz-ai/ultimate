// `indexes: [{ on, concurrently: true }]` from the declaration to the migration: it reaches the
// description, it never reaches the NAME (how an index is built is not what it is), an index that
// does not ask carries no key at all, and a foreign key's own index asked for again concurrently
// is still one index — built concurrently.

import { afterAll, describe, expect, test } from 'bun:test';
import { generateMigration, snapshotOf } from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { entity } from './entity';
import { clearRegistry } from './registry';

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
    const orgs = entity('entity_test_concurrent_orgs', { columns: { id: uuid().primaryKey() } });
    const members = entity('entity_test_concurrent_members', {
      columns: { id: uuid().primaryKey(), orgId: uuid().references(() => orgs.id) },
      indexes: [{ on: ['orgId'], concurrently: true }],
    });
    const indexes = members.$describe().indexes.filter((each) => each.columns[0] === 'org_id');
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.concurrently).toBe(true);
  });
});

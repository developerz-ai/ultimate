// `x db gen` with `database.rowSecurity`: the policy on every tenant table, typed off the column,
// recorded on the snapshot so a second run writes nothing, and dropped when the flag goes off.

import { describe, expect, test } from 'bun:test';
import type { EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import type { RowSecurityOption } from './generate-row-security';
import { findTable, type SchemaDescription } from './introspect';
import { snapshotJson } from './snapshot-json';
import { parseSnapshot } from './snapshot-parse';

const col = (column: string, kind: string, primaryKey = false) => ({
  property: column,
  column,
  kind,
  notNull: true,
  primaryKey,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
});

const posts: EntityDescriptionLike = {
  name: 'posts',
  table: 'posts',
  primaryKey: ['id'],
  columns: [col('id', 'uuid', true), col('org_id', 'uuid')],
  indexes: [],
};
const tags: EntityDescriptionLike = { ...posts, name: 'tags', table: 'tags' };
const ON: RowSecurityOption = { enabled: true, tenants: [{ table: 'posts', column: 'org_id' }] };
const NOW = new Date('2026-11-06T00:00:00Z');

const gen = (current: SchemaDescription, rowSecurity?: RowSecurityOption) =>
  generateMigration({
    entities: [posts, tags],
    current,
    name: 'row security',
    now: NOW,
    ...(rowSecurity === undefined ? {} : { rowSecurity }),
  });

describe('x db gen · row security', () => {
  const initial = gen({ tables: [] }).snapshot;

  test('flag on: enable, force and the policy on the tenant table only, cast to its type', () => {
    const migration = gen(initial, ON);
    expect(migration.up).toContain('alter table "posts" enable row level security;');
    expect(migration.up).toContain('alter table "posts" force row level security;');
    expect(migration.up).toContain(
      `create policy "ultimate_tenant" on "posts" using ("org_id" = nullif(current_setting('x.tenant', true), '')::uuid`,
    );
    expect(migration.up).not.toContain('"tags" enable');
    expect(migration.down).toContain('drop policy if exists "ultimate_tenant" on "posts";');
    expect(findTable(migration.snapshot, 'posts')?.rowSecurity).toBe(true);
    expect(findTable(migration.snapshot, 'tags')).not.toHaveProperty('rowSecurity');
  });

  test('the record survives the sidecar, so the second run writes nothing', () => {
    const recorded = parseSnapshot(JSON.parse(snapshotJson(gen(initial, ON).snapshot)));
    expect(recorded === undefined ? undefined : findTable(recorded, 'posts')?.rowSecurity).toBe(
      true,
    );
    expect(gen(recorded ?? initial, ON).up.trim()).toBe('');
  });

  test('flag off (or absent) on a recorded table: the policy is dropped and down restores it', () => {
    const recorded = gen(initial, ON).snapshot;
    const off = gen(recorded, { enabled: false, tenants: ON.tenants });
    expect(off.up).toContain('drop policy if exists "ultimate_tenant" on "posts";');
    expect(off.down).toContain('create policy "ultimate_tenant" on "posts"');
    expect(findTable(off.snapshot, 'posts')).not.toHaveProperty('rowSecurity');
    expect(gen(recorded).up).toContain('alter table "posts" disable row level security;');
  });

  test('a recorded table this migration drops is dropped once, never its policy after it', () => {
    const recorded = gen(initial, ON).snapshot;
    const dropped = generateMigration({
      entities: [tags],
      current: recorded,
      name: 'drop posts',
      now: NOW,
      allowDestructive: true,
      rowSecurity: { enabled: true, tenants: [] },
    });
    expect(dropped.up).toContain('drop table "posts";');
    expect(dropped.up).not.toContain('drop policy');
  });
});

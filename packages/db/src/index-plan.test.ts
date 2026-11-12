// `x db gen` never writes what `X_MIGRATION_LOCK_HEAVY` refuses: an existing table's index is built
// concurrently by default, and every plain build it still writes has the marker on the line directly
// above it. Judged by the gate's own classifier over the generated `up`, so the two cannot disagree.

import { describe, expect, test } from 'bun:test';
import type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  IndexDescriptionLike,
} from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import type { SchemaDescription } from './introspect';
import { LOCK_HEAVY_MARKER, lockHeavyStatements } from './migration-lock-lint';

const column = (name: string, notNull = false): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
});

const index = (overrides: Partial<IndexDescriptionLike> = {}): IndexDescriptionLike => ({
  name: 'runs_status_idx',
  columns: ['status'],
  unique: false,
  where: null,
  order: null,
  ...overrides,
});

const runs = (
  indexes: readonly IndexDescriptionLike[],
  extra: Partial<EntityDescriptionLike> = {},
): EntityDescriptionLike => ({
  name: 'Run',
  table: 'runs',
  primaryKey: ['id'],
  columns: [{ ...column('id', true), kind: 'uuid', primaryKey: true }, column('status', true)],
  indexes,
  ...extra,
});

const recorded = (indexes: readonly IndexDescriptionLike[] = []): SchemaDescription =>
  snapshotOf([runs(indexes)]);

const at = new Date('2026-12-01T12:00:00.000Z');

/** Every file the generator wrote for this change, `up` only, as the gate reads them. */
function ups(entities: readonly EntityDescriptionLike[], current?: SchemaDescription): string[] {
  const migration = generateMigration({ entities, current, name: 'index status', now: at });
  return [migration.up, ...(migration.followUp === undefined ? [] : [migration.followUp.up])];
}

/** What the gate would report over those files: a marker admits only the statement under it. */
const refused = (files: readonly string[]): readonly string[] =>
  files.flatMap((up) => lockHeavyStatements(up).map(({ statement }) => statement));

/** Every line that directly follows a marker line. */
const marked = (up: string | undefined): readonly string[] => {
  const lines = (up ?? '').split('\n');
  return lines.flatMap((line, at) => (lines[at - 1] === LOCK_HEAVY_MARKER ? [line] : []));
};

describe('indexPlan · an existing table', () => {
  test('a new index is built concurrently by default, and the rule admits it', () => {
    const files = ups([runs([index()])], recorded());
    expect(files.join('\n')).toContain(
      'create index concurrently if not exists "runs_status_idx" on "runs" ("status");',
    );
    expect(files.join('\n')).not.toContain(LOCK_HEAVY_MARKER);
    expect(refused(files)).toEqual([]);
  });

  test('a moved index is rebuilt concurrently by default', () => {
    const files = ups([runs([index({ where: '("status" <> \'done\')' })])], recorded([index()]));
    expect(files.join('\n')).toContain('create index concurrently');
    expect(refused(files)).toEqual([]);
  });

  test('a moved index under concurrently: false is a plain rebuild, marked', () => {
    const files = ups(
      [runs([index({ concurrently: false, where: '("status" <> \'done\')' })])],
      recorded([index()]),
    );
    expect(files.join('\n')).not.toContain('concurrently');
    expect(marked(files[0])).toEqual([
      'create index "runs_status_idx" on "runs" ("status") where (("status" <> \'done\'));',
    ]);
    expect(refused(files)).toEqual([]);
  });

  test('concurrently: false is the opt-out: a plain build, with the marker that admits it', () => {
    const files = ups([runs([index({ concurrently: false })])], recorded());
    const [up] = files;
    expect(up).toContain('create index "runs_status_idx" on "runs" ("status");');
    expect(marked(up)).toEqual(['create index "runs_status_idx" on "runs" ("status");']);
    expect(refused(files)).toEqual([]);
  });

  test('two plain builds in one file carry a marker each, directly above it', () => {
    const second = index({ name: 'runs_id_status_idx', columns: ['id', 'status'] });
    const files = ups(
      [runs([index({ concurrently: false }), { ...second, concurrently: false }])],
      recorded(),
    );
    expect(marked(files[0])).toEqual([
      'create index "runs_status_idx" on "runs" ("status");',
      'create index "runs_id_status_idx" on "runs" ("id", "status");',
    ]);
    expect(refused(files)).toEqual([]);
  });

  test('a partitioned parent cannot build concurrently (0A000): plain, and marked', () => {
    const events = (indexes: readonly IndexDescriptionLike[]): EntityDescriptionLike =>
      runs(indexes, {
        primaryKey: ['id', 'at'],
        columns: [
          { ...column('id', true), kind: 'uuid', primaryKey: true },
          { ...column('at', true), kind: 'timestamp', primaryKey: true },
          column('status', true),
        ],
        partition: { column: 'at', interval: 'month', ahead: 1 },
      });
    const files = ups([events([index()])], snapshotOf([events([])]));
    expect(files.join('\n')).not.toContain('concurrently');
    expect(marked(files[0])).toHaveLength(1);
    expect(refused(files)).toEqual([]);
  });

  test('a lock hand-added beside a marked plain build is still refused', () => {
    const [up] = ups([runs([index({ concurrently: false })])], recorded());
    const edited = `${up}\nalter table "runs" alter column "status" set not null;`;
    expect(refused([edited])).toEqual(['alter table "runs" alter column "status" set not null']);
  });
});

describe('indexPlan · a table this migration creates', () => {
  test('its indexes stay plain and unmarked: an empty table has nothing to scan', () => {
    const files = ups([runs([index()])], { tables: [] });
    expect(files.join('\n')).toContain('create index "runs_status_idx" on "runs" ("status");');
    expect(files.join('\n')).not.toContain(LOCK_HEAVY_MARKER);
    expect(refused(files)).toEqual([]);
  });
});

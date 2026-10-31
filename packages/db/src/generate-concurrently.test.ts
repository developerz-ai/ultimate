// `concurrently: true` on an index, through `generateMigration`: which step each statement lands
// in, the ids and snapshots of the two files, and — just as load-bearing — that an index declaring
// nothing generates byte-for-byte what it always did. `migration-step.test.ts` pins how the runner
// applies the step; `concurrent-index-embedded.test.ts` that it applies on a real engine.

import { describe, expect, test } from 'bun:test';
import type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  IndexDescriptionLike,
} from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import type { SchemaDescription } from './introspect';

const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: false,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

const index = (
  name: string,
  columns: readonly string[],
  overrides: Partial<IndexDescriptionLike> = {},
): IndexDescriptionLike => ({
  name,
  columns,
  unique: false,
  where: null,
  order: null,
  ...overrides,
});

const runs = (
  indexes: readonly IndexDescriptionLike[],
  extra: readonly ColumnDescriptionLike[] = [],
): EntityDescriptionLike => ({
  name: 'Run',
  table: 'runs',
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('status', { notNull: true }),
    column('bank'),
    ...extra,
  ],
  indexes,
});

/** What a previous migration recorded: `runs` with whatever indexes the entity then declared. */
const recorded = (indexes: readonly IndexDescriptionLike[] = []): SchemaDescription =>
  snapshotOf([runs(indexes)]);

const at = new Date('2026-10-31T12:00:00.000Z');
const STATUS = index('runs_status_idx', ['status'], { concurrently: true });

describe('generateMigration · `concurrently: true`', () => {
  test('a new index on a live table is the whole migration, built outside a transaction', () => {
    const migration = generateMigration({
      entities: [runs([STATUS])],
      current: recorded(),
      name: 'index status',
      now: at,
    });

    expect(migration.id).toBe('20261031120000_index_status');
    expect(migration.transactional).toBe(false);
    expect(migration.followUp).toBeUndefined();
    expect(migration.up).toBe(
      '-- transaction: false\n' +
        'create index concurrently if not exists "runs_status_idx" on "runs" ("status");',
    );
    expect(migration.down).toBe('drop index concurrently if exists "runs_status_idx";');
    expect(migration.destructive).toBe(false);
  });

  test('HOW an index is built is never recorded, so toggling it regenerates nothing', () => {
    const migration = generateMigration({
      entities: [runs([STATUS])],
      current: recorded(),
      name: 'index status',
      now: at,
    });
    // Recorded exactly as a plain index is — no `concurrently` key in any sidecar, ever.
    expect(JSON.stringify(migration.snapshot)).not.toContain('concurrently');
    expect(migration.snapshot).toEqual(recorded([index('runs_status_idx', ['status'])]));

    // The same index, now declared plainly (or the other way round): the same index, no diff.
    for (const [before, after] of [
      [[index('runs_status_idx', ['status'])], [STATUS]],
      [[STATUS], [index('runs_status_idx', ['status'])]],
    ] as const) {
      const again = generateMigration({
        entities: [runs(after)],
        current: recorded(before),
        name: 'again',
        now: at,
      });
      expect(again.up).toBe('');
      expect(again.followUp).toBeUndefined();
    }
  });

  test('beside other changes it is a SECOND file, `<id>_concurrently`, applied after the first', () => {
    const migration = generateMigration({
      entities: [
        runs([STATUS, index('runs_note_idx', ['note'], { concurrently: true })], [column('note')]),
      ],
      current: recorded(),
      name: 'add note',
      now: at,
    });

    expect(migration.transactional).toBe(true);
    expect(migration.up).toBe('alter table "runs" add column "note" text;');
    expect(migration.down).toBe('alter table "runs" drop column "note";');
    const later = migration.followUp;
    expect(later?.id).toBe('20261031120000_add_note_concurrently');
    expect(later?.fileName).toBe('migrations/20261031120000_add_note_concurrently.sql');
    // Sorts after the plain id: as a ledger id, as an `.sql`, as every sidecar.
    expect([later?.id ?? '', migration.id].sort()).toEqual([migration.id, later?.id ?? '']);
    expect(later?.transactional).toBe(false);
    // An index over the column the first step adds: the column exists by the time this runs.
    expect(later?.up).toBe(
      '-- transaction: false\n' +
        'create index concurrently if not exists "runs_status_idx" on "runs" ("status");\n' +
        'create index concurrently if not exists "runs_note_idx" on "runs" ("note");',
    );
    expect(later?.down).toBe(
      'drop index concurrently if exists "runs_note_idx";\n' +
        'drop index concurrently if exists "runs_status_idx";',
    );
  });

  test('the first file records what IT leaves behind; the second records the whole diff', () => {
    const migration = generateMigration({
      entities: [runs([STATUS], [column('note')])],
      current: recorded([index('runs_bank_idx', ['bank'])]),
      name: 'add note',
      now: at,
    });
    const indexesOf = (schema: SchemaDescription | undefined): readonly string[] =>
      (schema?.tables[0]?.indexes ?? []).map((each) => each.name).sort();

    // After the transaction alone: the new index not built yet, the removed one still there.
    expect(indexesOf(migration.snapshot)).toEqual(['runs_bank_idx']);
    expect(migration.snapshot.tables[0]?.columns.map((each) => each.name)).toContain('note');
    // After both: exactly what the entities declare — what the NEXT `x db gen` diffs against.
    expect(indexesOf(migration.followUp?.snapshot)).toEqual(['runs_status_idx']);
    expect(migration.followUp?.snapshot).toEqual(snapshotOf([runs([STATUS], [column('note')])]));
  });

  test('a concurrent index whose definition moved is dropped and rebuilt, both concurrently', () => {
    const migration = generateMigration({
      entities: [runs([{ ...STATUS, where: "status <> 'done'" }])],
      current: recorded([index('runs_status_idx', ['status'])]),
      name: 'narrow status',
      now: at,
    });

    expect(migration.up).toBe(
      '-- transaction: false\n' +
        'drop index concurrently if exists "runs_status_idx";\n' +
        'create index concurrently if not exists "runs_status_idx" on "runs" ("status") ' +
        "where (status <> 'done');",
    );
    // Back to the RECORDED definition, last.
    expect(migration.down).toBe(
      'drop index concurrently if exists "runs_status_idx";\n' +
        'create index concurrently if not exists "runs_status_idx" on "runs" ("status");',
    );
  });

  test('on a table this migration CREATES the index is built inside its transaction', () => {
    // The table is empty and invisible to every other session until COMMIT: there is nothing to
    // protect, and building it there keeps the table's creation one atomic step.
    const migration = generateMigration({
      entities: [runs([STATUS])],
      current: { tables: [] },
      name: 'create runs',
      now: at,
    });

    expect(migration.transactional).toBe(true);
    expect(migration.followUp).toBeUndefined();
    expect(migration.up).toContain('create index "runs_status_idx" on "runs" ("status");');
    expect(migration.up).not.toContain('concurrently');
  });

  test('an ordinary index generates exactly what it always did — no marker, no second file', () => {
    const migration = generateMigration({
      entities: [runs([index('runs_bank_idx', ['bank'])])],
      current: recorded(),
      name: 'index bank',
      now: at,
    });

    expect(migration.transactional).toBe(true);
    expect(migration.followUp).toBeUndefined();
    expect(migration.up).toBe('create index "runs_bank_idx" on "runs" ("bank");');
    expect(migration.down).toBe('drop index "runs_bank_idx";');
  });
});

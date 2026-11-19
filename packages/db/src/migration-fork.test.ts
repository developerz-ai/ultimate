// What makes a migration chain forked, and what merging one produces. Hand-built sidecars and real
// SQL text, because the detector reads exactly those two things and no database.

import { describe, expect, test } from 'bun:test';
import type { ColumnDescription, SchemaDescription, TableDescription } from './introspect';
import { migrationForked } from './migration-errors';
import { migrationFork } from './migration-fork';
import type { Migration } from './migration-ledger';

const column = (name: string, position = 1): ColumnDescription => ({
  name,
  dataType: 'text',
  nullable: true,
  default: null,
  position,
});

const table = (name: string, extra: Partial<TableDescription> = {}): TableDescription => ({
  schema: 'public',
  name,
  columns: [column('id')],
  primaryKey: [],
  indexes: [],
  foreignKeys: [],
  ...extra,
});

const schema = (...tables: readonly TableDescription[]): SchemaDescription => ({ tables });

const step = (id: string, up: string, snapshot?: SchemaDescription): Migration => ({
  id,
  name: id,
  up,
  down: '',
  ...(snapshot === undefined ? {} : { snapshot }),
});

const INITIAL = step('1_initial', 'create table "base" (id text);', schema(table('base')));
const ALPHAS = step(
  '2_create_alphas',
  'create table "alphas" (id text);',
  schema(table('alphas'), table('base')),
);
/** Generated from `1_initial` on another branch, so its sidecar has never heard of `alphas`. */
const BETAS = step(
  '3_create_betas',
  'create table "betas" (id text);',
  schema(table('base'), table('betas')),
);

const namesIn = (described: SchemaDescription | undefined): readonly string[] =>
  (described?.tables ?? []).map((entry) => entry.name);

describe('migrationFork: a linear chain is not a fork', () => {
  test('tables added one after another', () => {
    const linear = step(
      '3_create_betas',
      'create table "betas" (id text);',
      schema(table('alphas'), table('base'), table('betas')),
    );
    expect(migrationFork([INITIAL, ALPHAS, linear])).toBeUndefined();
  });

  test.each([
    ['drop table "alphas";', []],
    ['DROP TABLE IF EXISTS public.alphas CASCADE;', []],
    ['drop table "other", "alphas";', []],
    ['alter table "alphas" rename to "renamed";', [table('renamed')]],
  ])('a table the next migration removes with %s', (up, added) => {
    const removed = step('3_drop', up, schema(table('base'), ...added));
    expect(migrationFork([INITIAL, ALPHAS, removed])).toBeUndefined();
  });

  test.each([
    ['alter table "base" drop column "note";'],
    ['alter table base drop note;'],
    ['alter table "base" rename column "note" to "body";'],
  ])('a column removed with %s, and the index and key that went with it', (up) => {
    const before = table('base', {
      columns: [column('id'), column('note', 2)],
      indexes: [
        {
          name: 'base_note_idx',
          columns: ['note'],
          unique: false,
          primary: false,
          where: null,
          order: null,
        },
      ],
      foreignKeys: [
        {
          name: 'base_note_fk',
          columns: ['note'],
          referencedTable: 'base',
          referencedColumns: ['id'],
          onDelete: null,
        },
      ],
      checks: [{ name: 'base_note_check', expression: 'length(note) > 0' }],
    });
    expect(
      migrationFork([
        step('1_a', 'create table "base" (id text, note text);', schema(before)),
        step('2_b', up, schema(table('base'))),
      ]),
    ).toBeUndefined();
  });

  test('an index dropped by the concurrent follow-up after the step that forgot it', () => {
    const indexed = table('base', {
      indexes: [
        {
          name: 'base_id_idx',
          columns: ['id'],
          unique: false,
          primary: false,
          where: null,
          order: null,
        },
      ],
    });
    expect(
      migrationFork([
        step('1_a', 'create table "base" (id text);', schema(indexed)),
        step('2_b', 'select 1;', schema(table('base'))),
        step('3_c', 'drop index concurrently if exists "base_id_idx";', schema(table('base'))),
      ]),
    ).toBeUndefined();
  });

  test('a hand-written migration with no sidecar ends what the earlier sidecars can claim', () => {
    expect(
      migrationFork([
        ALPHAS,
        step('3_hand', "do $$ begin execute 'drop table alphas'; end $$;"),
        step('4_next', 'create table "base" (id text);', schema(table('base'))),
      ]),
    ).toBeUndefined();
  });

  test('a newest migration with no sidecar belongs to X_MIGRATION_SNAPSHOT_MISSING', () => {
    expect(migrationFork([INITIAL, ALPHAS, BETAS, step('4_hand', 'select 1;')])).toBeUndefined();
  });

  test('nothing to read is no fork', () => {
    expect(migrationFork([])).toBeUndefined();
  });
});

describe('migrationFork: two branches', () => {
  test('the newest sidecar lost a table: reported, and the merge holds both', () => {
    const fork = migrationFork([BETAS, INITIAL, ALPHAS]);
    expect(fork?.newest).toBe('3_create_betas');
    expect(fork?.lost).toEqual([
      { kind: 'table', table: 'alphas', name: 'alphas', recordedBy: '2_create_alphas' },
    ]);
    expect(fork?.collisions).toEqual([]);
    expect(namesIn(fork?.merged)).toEqual(['alphas', 'base', 'betas']);
  });

  test('merging is the repair: the merged sidecar is no longer a fork', () => {
    const merged = migrationFork([INITIAL, ALPHAS, BETAS])?.merged;
    expect(migrationFork([INITIAL, ALPHAS, { ...BETAS, snapshot: merged }])).toBeUndefined();
  });

  test('branches interleaved: only what the newest sidecar still lacks is lost', () => {
    const second = step(
      '4_alphas_more',
      'create table "gammas" (id text);',
      schema(table('alphas'), table('base'), table('gammas')),
    );
    const fork = migrationFork([INITIAL, ALPHAS, BETAS, second]);
    expect(fork?.lost.map((entry) => entry.name)).toEqual(['betas']);
    expect(namesIn(fork?.merged)).toEqual(['alphas', 'base', 'betas', 'gammas']);
  });

  test('two branches adding columns to one table: the column is lost, positions stay dense', () => {
    const left = table('base', { columns: [column('id'), column('left_note', 2)] });
    const right = table('base', { columns: [column('id'), column('right_note', 2)] });
    const fork = migrationFork([
      INITIAL,
      step('2_left', 'alter table "base" add column "left_note" text;', schema(left)),
      step('3_right', 'alter table "base" add column "right_note" text;', schema(right)),
    ]);
    expect(fork?.lost).toEqual([
      { kind: 'column', table: 'base', name: 'left_note', recordedBy: '2_left' },
    ]);
    expect(fork?.merged.tables[0]?.columns.map((entry) => [entry.name, entry.position])).toEqual([
      ['id', 1],
      ['left_note', 2],
      ['right_note', 3],
    ]);
  });

  test('an index and a view one branch added are lost the same way', () => {
    const indexed = table('base', {
      indexes: [
        {
          name: 'base_id_idx',
          columns: ['id'],
          unique: false,
          primary: false,
          where: null,
          order: null,
        },
      ],
    });
    const fork = migrationFork([
      INITIAL,
      step('2_left', 'create index "base_id_idx" on "base" ("id"); create view "v" as select 1;', {
        tables: [indexed],
        views: [{ name: 'v', create: ['create view "v" as select 1;'] }],
      }),
      step('3_right', 'select 1;', schema(table('base'))),
    ]);
    expect(fork?.lost.map((entry) => [entry.kind, entry.name])).toEqual([
      ['index', 'base_id_idx'],
      ['view', 'v'],
    ]);
    expect(fork?.merged.views?.map((view) => view.name)).toEqual(['v']);
  });

  test('a table one branch dropped and the other still records is stale, and merged away', () => {
    const fork = migrationFork([
      step(
        '1_a',
        'create table "base" (id text); create table "old" (id text);',
        schema(table('base'), table('old')),
      ),
      step('2_left', 'drop table "old";', schema(table('base'))),
      step(
        '3_right',
        'create table "betas" (id text);',
        schema(table('base'), table('betas'), table('old')),
      ),
    ]);
    expect(fork?.stale).toEqual([
      { kind: 'table', table: 'old', name: 'old', droppedBy: '2_left' },
    ]);
    expect(namesIn(fork?.merged)).toEqual(['base', 'betas']);
  });

  test('a table created again after a drop is not stale', () => {
    expect(
      migrationFork([
        INITIAL,
        step('2_drop', 'drop table "base";', schema()),
        step('3_again', 'create table "base" (id text);', schema(table('base'))),
      ]),
    ).toBeUndefined();
  });
});

describe('migrationFork: a statement that cannot replay', () => {
  test('both branches created one table', () => {
    const fork = migrationFork([
      INITIAL,
      ALPHAS,
      step(
        '3_alphas_too',
        'create table "alphas" (id text);',
        schema(table('alphas'), table('base')),
      ),
    ]);
    expect(fork?.collisions).toEqual([
      {
        kind: 'table',
        table: 'alphas',
        name: 'alphas',
        first: '2_create_alphas',
        again: '3_alphas_too',
      },
    ]);
  });

  test('the state the old `record` fix left behind', () => {
    const recorded = step(
      '4_record_alphas',
      'create table "alphas" (id text);',
      schema(table('alphas'), table('base'), table('betas')),
    );
    const fork = migrationFork([INITIAL, ALPHAS, BETAS, recorded]);
    expect(fork?.lost).toEqual([]);
    expect(fork?.collisions.map((entry) => entry.again)).toEqual(['4_record_alphas']);
  });

  test('both branches added one column', () => {
    const noted = table('base', { columns: [column('id'), column('note', 2)] });
    const fork = migrationFork([
      INITIAL,
      step('2_left', 'alter table "base" add column "note" text;', schema(noted)),
      step('3_right', 'alter table "base" add "note" text;', schema(noted)),
    ]);
    expect(fork?.collisions.map((entry) => [entry.kind, entry.name])).toEqual([['column', 'note']]);
  });

  test('`if not exists` replays, so it is no collision', () => {
    expect(
      migrationFork([
        INITIAL,
        ALPHAS,
        step(
          '3_safe',
          'create table if not exists "alphas" (id text);',
          schema(table('alphas'), table('base')),
        ),
      ]),
    ).toBeUndefined();
  });
});

describe('migrationForked: the refusal', () => {
  const lost = migrationFork([INITIAL, ALPHAS, BETAS]);
  const collided = migrationFork([
    INITIAL,
    ALPHAS,
    step(
      '3_alphas_too',
      'create table "alphas" (id text);',
      schema(table('alphas'), table('base')),
    ),
  ]);

  test('a lost table: names it, and the fix deletes nothing', () => {
    if (lost === undefined) return expect.unreachable('the chain forks');
    const error = migrationForked(lost);
    expect(error.code).toBe('X_MIGRATION_FORKED');
    expect(error.cause).toContain('table "alphas"');
    expect(error.cause).toContain('2_create_alphas');
    expect(error.cause).toContain('3_create_betas');
    expect(error.fix).toStartWith('x db gen --merge-fork');
    expect(error.fix).not.toMatch(/\brm\b|delete /);
  });

  test('a collision: never an unconditional delete, always the applied check first', () => {
    if (collided === undefined) return expect.unreachable('the chain collides');
    const { fix } = migrationForked(collided);
    expect(fix).toStartWith('x db status --json');
    expect(fix).not.toMatch(/(^|[;&|]\s*)rm\s/);
    expect(fix).toContain('data.pending');
    expect(fix).toContain('keep');
  });

  test('a filename a shell would read never reaches the fix', () => {
    const hostile = '3_$(touch pwned)';
    const fork = migrationFork([
      INITIAL,
      ALPHAS,
      step(hostile, 'create table "alphas" (id text);', schema(table('alphas'), table('base'))),
    ]);
    if (fork === undefined) return expect.unreachable('the chain collides');
    expect(migrationForked(fork).fix).not.toContain('$(');
  });
});

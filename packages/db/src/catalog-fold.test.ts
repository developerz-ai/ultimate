// Single responsibility: the pure rules of the catalog fold — the order a reading answers in, and
// how rows become one table. The queries that feed it are asserted against the real embedded
// database in `schema-dump.test.ts`, which already pays for the one boot the dump tests share.

import { describe, expect, test } from 'bun:test';
import { by, byCodeUnit, tableOf } from './catalog-fold';
import type { ColumnRow, SequenceRow, TableRow } from './catalog-relations';

describe('byCodeUnit', () => {
  test('uppercase, underscore, lowercase — never a locale’s order', () => {
    // `en_US` sorts `a_table` before `A_table`; `C` the reverse. Two servers do not share one.
    expect(['b', 'A', 'a', '_'].sort(byCodeUnit)).toEqual(['A', '_', 'a', 'b']);
    expect(byCodeUnit('same', 'same')).toBe(0);
  });
});

describe('by', () => {
  test('compares key by key, the first that differs deciding', () => {
    const rows = [
      { table: 'b', name: 'x' },
      { table: 'a', name: 'z' },
      { table: 'a', name: 'y' },
    ];
    const sorted = [...rows].sort(
      by(
        (row) => row.table,
        (row) => row.name,
      ),
    );
    expect(sorted.map((row) => `${row.table}.${row.name}`)).toEqual(['a.y', 'a.z', 'b.x']);
  });
});

describe('tableOf', () => {
  const table = (overrides: Partial<TableRow> = {}): TableRow => ({
    name: 'posts',
    persistence: 'p',
    replica_identity: 'd',
    replica_index: null,
    options: null,
    ...overrides,
  });
  const column = (
    name: string,
    position: number,
    overrides: Partial<ColumnRow> = {},
  ): ColumnRow => ({
    table_name: 'posts',
    name,
    position,
    type: 'integer',
    not_null: true,
    identity: '',
    generated: '',
    expression: null,
    collation: null,
    ...overrides,
  });
  const sequence = (name: string, overrides: Partial<SequenceRow>): SequenceRow => ({
    name,
    data_type: 'integer',
    seq_start: '1',
    seq_increment: '1',
    seq_min: '1',
    seq_max: '2147483647',
    seq_cache: '1',
    seq_cycle: false,
    ownership: null,
    owner_table: null,
    owner_column: null,
    ...overrides,
  });

  test('columns in ordinal order; another table’s rows are not this table’s', () => {
    const described = tableOf(
      table(),
      [column('b', 2), column('a', 1), { ...column('other', 1), table_name: 'orgs' }],
      [],
      [],
    );
    expect(described.columns.map((each) => each.name)).toEqual(['a', 'b']);
  });

  test('one expression column, read as a default or as a generation by attgenerated', () => {
    const described = tableOf(
      table(),
      [
        column('plain', 1, { expression: '0' }),
        column('stored', 2, { expression: 'lower(title)', generated: 's' }),
        column('virtual', 3, { expression: 'upper(title)', generated: 'v' }),
      ],
      [],
      [],
    );
    expect(described.columns.map((each) => [each.default, each.generated])).toEqual([
      ['0', null],
      [null, { expression: 'lower(title)', storage: 'stored' }],
      // Postgres 18's `attgenerated = 'v'`: read as `stored`, it loaded back as a different column.
      [null, { expression: 'upper(title)', storage: 'virtual' }],
    ]);
  });

  test('an identity sequence rides on its column; a serial one is the table’s; a free one is neither', () => {
    const described = tableOf(
      table(),
      [column('id', 1, { identity: 'd' }), column('n', 2)],
      [],
      [
        sequence('posts_id_seq', { ownership: 'i', owner_table: 'posts', owner_column: 'id' }),
        sequence('posts_n_seq', { ownership: 'a', owner_table: 'posts', owner_column: 'n' }),
        sequence('ticket_seq', {}),
      ],
    );
    expect(described.columns[0]?.identity?.mode).toBe('by default');
    expect(described.columns[0]?.identity?.sequence.name).toBe('posts_id_seq');
    expect(described.sequences.map((each) => [each.name, each.column])).toEqual([
      ['posts_n_seq', 'n'],
    ]);
  });

  test('constraints: primary key, unique, check, exclusion — and never a foreign key', () => {
    const constraint = (name: string, type: string) => ({
      table_name: 'posts',
      name,
      type,
      definition: type,
    });
    const described = tableOf(
      table(),
      [],
      [
        constraint('z_check', 'c'),
        constraint('a_check', 'c'),
        constraint('posts_fkey', 'f'),
        constraint('posts_excl', 'x'),
        constraint('posts_key', 'u'),
        constraint('posts_pkey', 'p'),
      ],
      [],
    );
    expect(described.constraints.map((each) => each.name)).toEqual([
      'posts_pkey',
      'posts_key',
      'a_check',
      'z_check',
      'posts_excl',
    ]);
  });

  test('persistence and replica identity are read off the row’s one-letter codes', () => {
    expect(tableOf(table({ persistence: 'u' }), [], [], []).unlogged).toBe(true);
    const identity = (code: string, index: string | null = null) =>
      tableOf(table({ replica_identity: code, replica_index: index }), [], [], []).replicaIdentity;
    expect(identity('d')).toEqual({ kind: 'default' });
    expect(identity('f')).toEqual({ kind: 'full' });
    expect(identity('n')).toEqual({ kind: 'nothing' });
    expect(identity('i', 'posts_key')).toEqual({ kind: 'index', index: 'posts_key' });
    // `i` with no index found is a catalog in an impossible state; default is the safe reading.
    expect(identity('i')).toEqual({ kind: 'default' });
  });
});

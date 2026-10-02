// Single responsibility: catalog ROWS into one table's description — its columns in ordinal order,
// its constraints ranked, the sequences its `serial` and identity columns own. Pure; the queries
// are `catalog-relations.ts`'s and the orchestration is `introspect-catalog.ts`'s.

import type {
  CatalogColumn,
  CatalogOwnedSequence,
  CatalogReplicaIdentity,
  CatalogSequence,
  CatalogTable,
} from './catalog';
import type { ColumnRow, ConstraintRow, SequenceRow, TableRow } from './catalog-relations';

/**
 * By UTF-16 code unit, never `localeCompare` and never SQL's `order by`: both follow a locale, and
 * the same database must produce the same bytes on a laptop and in CI.
 */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const by =
  <T>(...keys: readonly ((value: T) => string)[]) =>
  (a: T, b: T): number => {
    for (const key of keys) {
      const order = byCodeUnit(key(a), key(b));
      if (order !== 0) return order;
    }
    return 0;
  };

export const sequenceOf = (row: SequenceRow): CatalogSequence => ({
  name: row.name,
  dataType: row.data_type,
  start: row.seq_start,
  increment: row.seq_increment,
  min: row.seq_min,
  max: row.seq_max,
  cache: row.seq_cache,
  cycle: row.seq_cycle,
});

function columnOf(row: ColumnRow, sequences: readonly SequenceRow[]): CatalogColumn {
  const identity = sequences.find(
    (sequence) =>
      sequence.ownership === 'i' &&
      sequence.owner_table === row.table_name &&
      sequence.owner_column === row.name,
  );
  const generated = row.generated !== '' && row.generated !== null;
  return {
    name: row.name,
    type: row.type,
    notNull: row.not_null,
    default: generated ? null : row.expression,
    generated:
      generated && row.expression !== null
        ? { expression: row.expression, storage: row.generated === 'v' ? 'virtual' : 'stored' }
        : null,
    identity:
      identity === undefined
        ? null
        : { mode: row.identity === 'a' ? 'always' : 'by default', sequence: sequenceOf(identity) },
    collation: row.collation,
  };
}

function replicaIdentityOf(row: TableRow): CatalogReplicaIdentity {
  if (row.replica_identity === 'f') return { kind: 'full' };
  if (row.replica_identity === 'n') return { kind: 'nothing' };
  if (row.replica_identity === 'i' && row.replica_index !== null)
    return { kind: 'index', index: row.replica_index };
  return { kind: 'default' };
}

/** Primary key first, then unique, check, exclusion — each group by name. */
const CONSTRAINT_RANK: ReadonlyMap<string, string> = new Map([
  ['p', '0'],
  ['u', '1'],
  ['c', '2'],
  ['x', '3'],
]);

export function tableOf(
  row: TableRow,
  columns: readonly ColumnRow[],
  constraints: readonly ConstraintRow[],
  sequences: readonly SequenceRow[],
): CatalogTable {
  return {
    name: row.name,
    unlogged: row.persistence === 'u',
    options: row.options,
    columns: columns
      .filter((column) => column.table_name === row.name)
      .sort((a, b) => a.position - b.position)
      .map((column) => columnOf(column, sequences)),
    constraints: constraints
      .filter((constraint) => constraint.table_name === row.name && constraint.type !== 'f')
      .sort(
        by(
          (c) => CONSTRAINT_RANK.get(c.type) ?? '9',
          (c) => c.name,
        ),
      )
      .map((constraint) => ({ name: constraint.name, definition: constraint.definition })),
    sequences: sequences
      .filter((sequence) => sequence.ownership === 'a' && sequence.owner_table === row.name)
      .sort(by((sequence) => sequence.name))
      .map(
        (sequence): CatalogOwnedSequence => ({
          ...sequenceOf(sequence),
          column: sequence.owner_column ?? '',
        }),
      ),
    replicaIdentity: replicaIdentityOf(row),
  };
}

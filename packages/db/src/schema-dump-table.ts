// Single responsibility: one table as the statements that rebuild it — its `serial` sequences, the
// `create table`, the ownership that ties each sequence back, and its replica identity. Split from
// `schema-dump.ts`, which decides which file a statement goes to and never how a table is spelled.

import type { CatalogColumn, CatalogConstraint, CatalogSequence, CatalogTable } from './catalog';

/**
 * Every catalog name, quoted — `identifier()` (`sql.ts`) refuses whitespace and `"`, which are
 * legal in a name a migration created, and a dump that threw on one could not describe the
 * database it was pointed at. Doubling the quote is the whole of Postgres' identifier escape.
 */
export const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Each option spelled, `no cycle` included, so the statement reads the same on every server. */
export const sequenceOptions = (sequence: CatalogSequence): string =>
  [
    `start with ${sequence.start}`,
    `increment by ${sequence.increment}`,
    `minvalue ${sequence.min}`,
    `maxvalue ${sequence.max}`,
    `cache ${sequence.cache}`,
    sequence.cycle ? 'cycle' : 'no cycle',
  ].join(' ');

export const createSequence = (sequence: CatalogSequence): string =>
  `create sequence ${quoted(sequence.name)} as ${sequence.dataType} ${sequenceOptions(sequence)};`;

/** `constraint "name" <definition>` — the definition is `pg_get_constraintdef`'s, verbatim. */
export const constraintClause = (constraint: CatalogConstraint): string =>
  `constraint ${quoted(constraint.name)} ${constraint.definition}`;

/** Type, collation, then value (default, generation or identity), then nullability — one order. */
function columnClause(column: CatalogColumn): string {
  const parts = [quoted(column.name), column.type];
  if (column.collation !== null) parts.push(`collate ${quoted(column.collation)}`);
  if (column.default !== null) parts.push(`default ${column.default}`);
  if (column.generated !== null) {
    const { expression, storage } = column.generated;
    parts.push(`generated always as (${expression}) ${storage}`);
  }
  if (column.identity !== null) {
    const { mode, sequence } = column.identity;
    parts.push(
      `generated ${mode} as identity (sequence name ${quoted(sequence.name)} ${sequenceOptions(sequence)})`,
    );
  }
  if (column.notNull) parts.push('not null');
  return parts.join(' ');
}

/**
 * `create table`, or for a partition `create table … partition of <parent> [(constraints)] <bound>`
 * — a partition's columns are its parent's, so only the constraints it holds of its own are
 * spelled. `partition by` follows either on a partitioned table, Postgres' clause order.
 */
function createTable(table: CatalogTable): string {
  const name = quoted(table.name);
  const head = table.unlogged ? 'create unlogged table' : 'create table';
  const by = table.partitionBy === undefined ? '' : ` partition by ${table.partitionBy}`;
  const options = table.options === null ? '' : ` with (${table.options})`;
  const constraints = table.constraints.map((line) => `  ${constraintClause(line)}`);
  if (table.partitionOf !== undefined) {
    const { table: parent, bound } = table.partitionOf;
    const body = constraints.length === 0 ? '' : ` (\n${constraints.join(',\n')}\n)`;
    return `${head} ${name} partition of ${quoted(parent)}${body} ${bound}${by}${options};`;
  }
  const body = [...table.columns.map((column) => `  ${columnClause(column)}`), ...constraints];
  return [`${head} ${name} (`, body.join(',\n'), `)${by}${options};`].join('\n');
}

/**
 * The statements of one table, in the order they must run: a `serial` column's default names its
 * sequence, so the sequence comes first and is handed to the column only once the table exists.
 */
export function tableStatements(table: CatalogTable): readonly string[] {
  const name = quoted(table.name);
  const statements = [
    ...table.sequences.map(createSequence),
    createTable(table),
    ...table.sequences.map(
      (sequence) =>
        `alter sequence ${quoted(sequence.name)} owned by ${name}.${quoted(sequence.column)};`,
    ),
  ];
  // `index` waits for the indexes file: the index it names does not exist yet.
  if (table.replicaIdentity.kind === 'full' || table.replicaIdentity.kind === 'nothing') {
    statements.push(`alter table ${name} replica identity ${table.replicaIdentity.kind};`);
  }
  return statements;
}

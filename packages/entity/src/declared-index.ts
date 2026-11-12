// One `indexes: [...]` entry of `entity(name, { indexes })` turned into the `IndexDef` it declares,
// refusing what Postgres would refuse later. Split out of `entity.ts` at the 500-line ceiling.

import { declaredKeyPartsOf } from './declared-index-keys';
import { invariantViolated } from './errors';
import type { InvariantColumns, Resolve } from './expr';
import type { IndexInit } from './index-init';
import { indexName } from './index-name';
import type { ColumnMap, IndexDef } from './types';

export interface DeclaredIndexContext<C extends ColumnMap> {
  readonly name: string;
  readonly table: string;
  readonly resolve: Resolve;
  readonly columns: InvariantColumns<C>;
}

export const declaredIndexOf = <C extends ColumnMap>(
  index: IndexInit<C>,
  context: DeclaredIndexContext<C>,
): IndexDef => {
  const { name, table, resolve, columns: columnsExpr } = context;
  const columns = index.on.map((property) => resolve([property]));
  const unique = index.unique === true;
  // `on: []` is type-legal and names nothing: the generated DDL would be `on "posts" ()`, a
  // syntax error one migration later. Refused where it was written instead.
  if (columns.length === 0) {
    throw invariantViolated(name, 'index', 'an index must name at least one column');
  }
  const where = index.where?.(columnsExpr).toSql(resolve) ?? null;
  if (index.where !== undefined && where === null) {
    throw invariantViolated(
      name,
      'index',
      'a partial index predicate must be expressible in SQL; a JS predicate cannot be one',
    );
  }
  // Two rules Postgres has that a declaration can break, refused where the author wrote it.
  // `@ultimat3/db` refuses both again at `createIndex` — that is not a duplicate, it is the
  // guard for a description nobody built here — but its refusal lands at `x db gen` or, if a
  // migration was already written, inside `ROLE=migrate` as the server's own syntax error with
  // none of the entity's words in it.
  if (index.using !== undefined && index.using !== 'btree') {
    if (unique) {
      throw invariantViolated(
        name,
        'index',
        `the index on (${columns.join(', ')}) is unique and ${index.using}; ` +
          `Postgres has no unique ${index.using} index — drop unique, or drop using`,
      );
    }
    if (index.order !== undefined) {
      throw invariantViolated(
        name,
        'index',
        `the index on (${columns.join(', ')}) is ${index.using} and ${index.order}; ` +
          'only a btree orders its keys — drop order, or drop using',
      );
    }
  }
  const keys = declaredKeyPartsOf(name, index, resolve);
  return {
    name: indexName(name, table, columns, unique, index.order, where, index.using, keys),
    columns,
    unique,
    ...(index.order === undefined ? {} : { order: index.order }),
    ...(where === null ? {} : { where }),
    // Absent stays absent: `btree` written out would be a field every existing snapshot lacks,
    // and `indexMethodOf` reads the two the same way precisely so nothing regenerates.
    ...(index.using === undefined || index.using === 'btree' ? {} : { using: index.using }),
    // How it is BUILT, so not part of the name. Absent stays absent — the default every existing
    // index already projects — and only an explicit ask, either way, rides along.
    ...(index.concurrently === undefined ? {} : { concurrently: index.concurrently }),
    // The four key parts (E8), each absent unless declared — so no name, description or snapshot
    // of an index that declares none moves.
    ...keys,
  };
};

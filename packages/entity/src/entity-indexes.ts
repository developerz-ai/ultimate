// Every index one `entity()` holds — each column's own, the `indexes:` entries, the search gin, the
// tenant index — and which implicit ones another already serves. Split out of `entity.ts` at the
// 500-line ceiling: the assembly is one job, and E9's covering rule is judged here, once.

import type { IndexMethod } from '@ultimat3/db';
import { columnName, moneyColumns } from './column';
import { declaredIndexOf } from './declared-index';
import type { InvariantColumns, Resolve } from './expr';
import { distinctIndexes } from './index-identity';
import type { IndexInit } from './index-init';
import { indexName } from './index-name';
import type { Invariant } from './invariants';
import type { CoveredIndex } from './registry';
import type { SearchVector } from './search';
import {
  coveredByTenantIndex,
  coveredImplicitIndexes,
  coverersOf,
  tenantIndexOf,
} from './tenant-index';
import type { AnyColumn, ColumnMap, IndexDef } from './types';

export interface EntityIndexesInput<C extends ColumnMap, Row> {
  readonly name: string;
  readonly table: string;
  readonly entries: readonly (readonly [string, AnyColumn])[];
  readonly declared: readonly IndexInit<C>[] | undefined;
  readonly resolve: Resolve;
  readonly columns: InvariantColumns<C>;
  readonly search: SearchVector | null;
  /** The tenant column's PHYSICAL name, `null` on an untenanted table. */
  readonly tenant: string | null;
  /** The primary key's physical columns, in declared order. */
  readonly primaryKey: readonly string[];
  readonly plainView: boolean;
  readonly invariants: readonly Invariant<Row>[];
}

export interface EntityIndexes {
  /** Deduplicated, in declaration order, the tenant index last. */
  readonly indexes: readonly IndexDef[];
  /** The tenant index, when one was added — `withoutDerivedDuplicate` reads it at describe time. */
  readonly tenantIndex: IndexDef | undefined;
  readonly covered: readonly CoveredIndex[];
}

/** Each column's own index: `.unique()`, `.index()`, `.references()`, `.tenant()`. */
const columnIndexes = (
  name: string,
  table: string,
  entries: readonly (readonly [string, AnyColumn])[],
  tenant: string | null,
): readonly IndexDef[] =>
  entries.flatMap(([property, column]) => {
    const meta = column.$meta;
    if (!meta.unique && !meta.index) return [];
    const physical = [
      meta.kind === 'money' ? moneyColumns(property, meta).minor : columnName(property, meta),
    ];
    if (coveredByTenantIndex(physical[0] ?? '', tenant, meta.unique)) return [];
    return [
      {
        name: indexName(name, table, physical, meta.unique),
        columns: physical,
        unique: meta.unique,
      },
    ];
  });

export const entityIndexesOf = <C extends ColumnMap, Row>(
  input: EntityIndexesInput<C, Row>,
): EntityIndexes => {
  const { name, table, search } = input;
  const own = columnIndexes(name, table, input.entries, input.tenant);
  const written = (input.declared ?? []).map((index) =>
    declaredIndexOf(index, { name, table, resolve: input.resolve, columns: input.columns }),
  );
  const declared: readonly IndexDef[] = [
    ...own,
    ...written,
    // The one index nobody declared and every search needs. Through the SAME `IndexInit` path a
    // hand-written `using: 'gin'` takes — `indexName` gives it the method discriminator, so it can
    // never collide with a btree an author declares on the same column.
    ...(search === null
      ? []
      : [
          {
            name: indexName(name, table, [search.column], false, undefined, null, 'gin'),
            columns: [search.column],
            unique: false,
            using: 'gin' as IndexMethod,
          },
        ]),
  ];
  const uniques = input.invariants.filter((inv) => inv.kind === 'unique');
  const { primaryKey } = input;
  // After every other index, so one that already starts with `(tenant, pk)` is seen.
  const [tenantIndex] = tenantIndexOf({
    entityName: name,
    table,
    tenant: input.tenant,
    primaryKey,
    plainView: input.plainView,
    covering: coverersOf(table, primaryKey, declared, uniques),
  });
  // A foreign key's own index named again in `indexes` is one index, not two (`index-identity.ts`).
  const indexes = distinctIndexes(
    tenantIndex === undefined ? declared : [...declared, tenantIndex],
  );
  // Implicit: a column's own non-unique index the author did not also write in `indexes:` — one
  // they wrote is theirs to keep. A unique one is a rule, never an access path to drop.
  const handWritten = new Set(written.map((index) => index.name));
  const implicit = own.filter((index) => !index.unique && !handWritten.has(index.name));
  const covered = input.plainView
    ? []
    : coveredImplicitIndexes(implicit, coverersOf(table, primaryKey, indexes, uniques));
  return { indexes, tenantIndex, covered };
};

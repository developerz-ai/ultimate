// The readers a GDPR export or erase job walks by: every column `.personalData(kind)` marked, per
// entity and across the registry. The mark is `$meta.personalData`, never on `$describe()` — being
// personal data changes no column, so it must not move the drift hash.

import { columnName } from './column';
import type { EntityCore } from './entity';
import type { PersonalDataKind } from './personal-data-kind';
import { registeredEntities } from './registry';
import type { AnyColumn, ColumnKind } from './types';

// The kind set's home is `personal-data-kind.ts` (the chain reads it); the barrel takes it from here.
export type { PersonalDataKind } from './personal-data-kind';
export { PERSONAL_DATA_KINDS } from './personal-data-kind';

/** The kind a column was marked with, or `undefined` for a column that holds no personal data. */
export const personalDataKindOf = (column: AnyColumn): PersonalDataKind | undefined =>
  column.$meta.personalData;

/** One marked column of one entity, resolved to where it landed. */
export interface PersonalDataColumn {
  /** The row property — what a repository write names. */
  readonly property: string;
  /** The physical column (the base name, for a money column's parts). */
  readonly column: string;
  readonly kind: PersonalDataKind;
  readonly columnKind: ColumnKind;
  /** Whether an erase may write `null`; otherwise it must write a replacement value. */
  readonly nullable: boolean;
}

/** Every marked column of `entity`, in declaration order. */
export const personalDataOf = (
  entity: Pick<EntityCore<unknown>, '$columns'>,
): readonly PersonalDataColumn[] =>
  Object.entries(entity.$columns).flatMap(([property, column]) => {
    const kind = column.$meta.personalData;
    if (kind === undefined) return [];
    return [
      {
        property,
        column: columnName(property, column.$meta),
        kind,
        columnKind: column.$meta.kind,
        nullable: !column.$meta.notNull,
      },
    ];
  });

/** A registered entity holding personal data, with the tenant a subject's rows are scoped by. */
export interface PersonalDataEntity {
  readonly entity: EntityCore<unknown>;
  /** The tenant column's property, or `null` for an untenanted entity. */
  readonly tenantColumn: string | null;
  readonly columns: readonly PersonalDataColumn[];
}

/** Every registered entity carrying at least one marked column, in the registry's name order. */
export const personalDataEntities = (): readonly PersonalDataEntity[] =>
  registeredEntities().flatMap((entry) => {
    const core = entry.core;
    if (core === undefined) return [];
    const columns = personalDataOf(core);
    return columns.length === 0
      ? []
      : [{ entity: core, tenantColumn: core.$tenantColumn, columns }];
  });

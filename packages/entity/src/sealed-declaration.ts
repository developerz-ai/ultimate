// Single responsibility: what an ENTITY may not do with a sealed column, refused while it is being
// declared. The column chain refuses what it can see (`sealed-column.ts`); these are the rules that
// need the whole entity — a composite key, the tenant, an index, an invariant — and each one is the
// database comparing a value it only holds as ciphertext.

import { invariantViolated } from './entity-error';
import type { SealedField } from './sealed';
import { sealedPredicate } from './sealed-errors';
import type { IndexDef } from './types';

export interface SealedDeclaration {
  readonly name: string;
  readonly fields: readonly SealedField[];
  /** Property keys. */
  readonly primaryKey: readonly string[];
  readonly tenantColumn: string | null;
  /** Physical columns, as `IndexDef` and `Invariant` carry them. */
  readonly indexes: readonly IndexDef[];
  readonly invariants: readonly { readonly kind: string; readonly columns: readonly string[] }[];
}

export const assertSealedDeclaration = (input: SealedDeclaration): void => {
  const { name, fields } = input;
  if (fields.length === 0) return;
  for (const field of fields) {
    if (input.primaryKey.includes(field.property)) {
      throw invariantViolated(
        name,
        field.property,
        'is sealed and in the primary key — a key is compared and ordered by the database, which holds ciphertext; key the entity by a uuid() and keep the secret beside it',
      );
    }
    if (input.tenantColumn === field.property) {
      throw invariantViolated(
        name,
        field.property,
        'is sealed and the tenant column — every query filters on the tenant, and a sealed value cannot be filtered on',
      );
    }
  }
  const byColumn = new Map(fields.map((field) => [field.column, field]));
  for (const index of input.indexes) {
    for (const column of index.columns) {
      const field = byColumn.get(column);
      // An index over a lookup column is the point of one: it is what makes the equality fast,
      // and a unique one is `.unique()` spelled on the entity.
      if (field === undefined || (field.lookup && index.order === undefined)) continue;
      throw sealedPredicate(name, field.property, 'an index', field.lookup);
    }
  }
  for (const invariant of input.invariants) {
    for (const column of invariant.columns) {
      const field = byColumn.get(column);
      if (field === undefined) continue;
      if (invariant.kind === 'unique') {
        if (!field.lookup) throw sealedPredicate(name, field.property, 'a uniqueness rule', false);
        continue;
      }
      // A CHECK runs in the database against the stored string, and the app-side half runs inside
      // the driver against the same one — neither ever sees the plaintext the rule was written for.
      throw sealedPredicate(name, field.property, 'an invariant', field.lookup);
    }
  }
};

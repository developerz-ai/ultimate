// One registered entity → the flat facts the derivation reads, in declaration order.
//
// Two things are not one-to-one and are decided here, once. Money stays ONE property: the
// admin renders rows, and a row carries `{ minor, currency }` where the migration emits two
// physical columns. And a foreign key is read back from `$describe()`, because the binding
// that turns `() => orgs.id` into `"orgs.id"` is private to @ultimat3/entity.

import { AdminFieldUnsupportedError } from './errors';
import type { AdminColumnMeta, AdminEntity } from './registry';

export interface AdminColumnReference {
  /** The entity the value points at. */
  readonly entity: string;
  /** The column the value IS a value of — the honest default label for the reference. */
  readonly column: string;
}

/** One column, flattened. Everything `fields.ts` and `resource.ts` decide from. */
export interface AdminColumnFacts {
  /** Property key on the row: what a form input, a filter and an MCP argument are named. */
  readonly name: string;
  /** The entity's column kind, mapped to a widget by `fields.ts`. */
  readonly kind: string;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly index: boolean;
  /** Written by the DB or the framework (`id`, `createdAt`): read-only in every form. */
  readonly generated: boolean;
  /** Declared max length. Absent on an unbounded text column, which is prose. */
  readonly length?: number;
  readonly values?: readonly string[];
  readonly references?: AdminColumnReference;
}

const parseReference = (entity: string, property: string, target: string): AdminColumnReference => {
  const dot = target.lastIndexOf('.');
  const entityName = dot < 0 ? '' : target.slice(0, dot);
  const column = dot < 0 ? '' : target.slice(dot + 1);
  if (entityName === '' || column === '') {
    throw new AdminFieldUnsupportedError({
      entity,
      field: property,
      cause: `reference target "${target}" is not "<entity>.<column>", so the admin cannot link it`,
      fix: `references(() => other.id) — pass a column of an entity() result, then: x manifest`,
    });
  }
  return { entity: entityName, column };
};

/**
 * Resolved foreign keys by property. `$describe()` splits a money property into its two
 * physical columns; neither carries a reference, so they simply never match a property here.
 */
const referencesOf = (entity: AdminEntity): ReadonlyMap<string, AdminColumnReference> => {
  const out = new Map<string, AdminColumnReference>();
  for (const column of entity.$describe().columns) {
    if (column.references === null) continue;
    out.set(column.property, parseReference(entity.$name, column.property, column.references));
  }
  return out;
};

const factsFor = (
  name: string,
  meta: AdminColumnMeta,
  primaryKey: boolean,
  references: AdminColumnReference | undefined,
): AdminColumnFacts => ({
  name,
  kind: meta.kind,
  nullable: !meta.notNull,
  primaryKey,
  unique: meta.unique,
  index: meta.index,
  // A value the writer never supplies. `.default('free')` is a starting value the operator
  // may still change, so it stays writable — only a generated one is read-only.
  generated: meta.default?.kind === 'generated' || meta.onUpdate !== undefined,
  ...(meta.length === undefined ? {} : { length: meta.length }),
  ...(meta.values === undefined ? {} : { values: meta.values }),
  ...(references === undefined ? {} : { references }),
});

/**
 * Declaration order, which is the order every list, form and MCP schema is built in. A
 * composite key marks each of its members, the way `$describe()` does — the admin then treats
 * them as it treats any key column: addressable, and never editable.
 */
export function adminColumnsOf(entity: AdminEntity): readonly AdminColumnFacts[] {
  const references = referencesOf(entity);
  const keys = new Set(entity.$primaryKey);
  return Object.entries(entity.$columns).map(([name, column]) =>
    factsFor(name, column.$meta, column.$meta.primaryKey || keys.has(name), references.get(name)),
  );
}

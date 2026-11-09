// Single responsibility: what a same-tenant edge needs that its own entity cannot declare. The
// composite key names `(tenant, id)` on the TARGET, so the unique index behind it belongs to a table
// whose description knows nothing about who points at it. It is answered once, over the whole set.

import type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  IndexDescriptionLike,
} from './entity-shape';
import { referenceParts } from './foreign-key';
import { findTable, type IndexDescription, type SchemaDescription } from './introspect';
import { MAX_IDENTIFIER_BYTES } from './sql';

/** How much of a name survives beside its hash: `_` and eight hex characters. */
const KEPT_BYTES = MAX_IDENTIFIER_BYTES - 9;

/**
 * Within the 63 bytes Postgres truncates at and says nothing. Past them two keys sharing a prefix
 * would be one name on the server, so the end is a hash of the whole: deterministic across
 * processes, because a name is a property of the declaration. Every name a same-tenant edge mints
 * passes here, and a name that fits is untouched.
 */
const bounded = (name: string): string => {
  if (new TextEncoder().encode(name).length <= MAX_IDENTIFIER_BYTES) return name;
  const hash = new Bun.CryptoHasher('sha256').update(name).digest('hex').slice(0, 8);
  return `${name.slice(0, KEPT_BYTES)}_${hash}`;
};

/** `<table>_<column>_tenant_fkey`: another name than the plain key's, so the two can coexist. */
export function sameTenantKeyName(table: string, column: string): string {
  return bounded(`${table}_${column}_tenant_fkey`);
}

/** Whether an index already holds `columns` unique over every row, whichever way round. */
const answers = (index: IndexDescriptionLike, columns: ReadonlySet<string>): boolean =>
  index.unique &&
  index.where === null &&
  index.columns.length === columns.size &&
  index.columns.every((column) => columns.has(column));

/** The same question of a `unique` invariant: `declaredIndexes` makes it an index of its own. */
const invariantAnswers = (entity: EntityDescriptionLike, columns: ReadonlySet<string>): boolean =>
  (entity.invariants ?? []).some(
    ({ kind, where, columns: named }) =>
      kind === 'unique' &&
      where === null &&
      named?.length === columns.size &&
      named.every((column) => columns.has(column)),
  );

const primaryKeyAnswers = (entity: EntityDescriptionLike, columns: ReadonlySet<string>): boolean =>
  entity.primaryKey.length === columns.size &&
  entity.primaryKey.every((column) => columns.has(column));

const sameTenantColumns = (
  entity: EntityDescriptionLike,
): readonly (ColumnDescriptionLike & { readonly references: string })[] =>
  entity.columns.flatMap((column) =>
    column.references !== null && column.references !== undefined && column.sameTenant != null
      ? [{ ...column, references: column.references }]
      : [],
  );

/** Every target's wanted column lists, keyed by target table, then by the list itself. */
type Wanted = Map<string, Map<string, readonly string[]>>;

const want = (wanted: Wanted, target: string, columns: readonly string[]): void => {
  const forTarget = wanted.get(target) ?? new Map<string, readonly string[]>();
  forTarget.set(columns.join('\0'), columns);
  wanted.set(target, forTarget);
};

/**
 * What a retired column's recorded composite key still points at. The column left the description
 * and stays in the table, its key with it, so the unique index under that key cannot go: a drop is
 * `2BP01`, on every run. It goes once the column does (`drop column` takes the key first).
 */
const wantedByRetired = (
  entities: readonly EntityDescriptionLike[],
  current: SchemaDescription | undefined,
  wanted: Wanted,
): void => {
  if (current === undefined) return;
  for (const entity of entities) {
    const retired = entity.retired ?? [];
    if (retired.length === 0) continue;
    for (const key of findTable(current, entity.table)?.foreignKeys ?? []) {
      if (key.columns.length > 1 && key.columns.some((column) => retired.includes(column))) {
        want(wanted, key.referencedTable, key.referencedColumns);
      }
    }
  }
};

/**
 * The set with every target's `(tenant, column)` unique index on its own list. `concurrently: true`
 * means what it means on any index: nothing on a table this migration creates, the deferred step on
 * a live one, which is what `targetIndexDeferred` reads so the key lands after it.
 *
 * Skipped when the table already holds that uniqueness over every row. A PARTIAL one does not count:
 * Postgres refuses a key over it (`42830`). Idempotent, so every entry point may pass through here.
 * `current` is the record a retired column's key is still on; absent, only declared edges count.
 */
export function withSameTenantIndexes(
  entities: readonly EntityDescriptionLike[],
  current?: SchemaDescription,
): readonly EntityDescriptionLike[] {
  const wanted: Wanted = new Map();
  for (const entity of entities) {
    for (const column of sameTenantColumns(entity)) {
      const [target, key] = referenceParts(column.references);
      want(wanted, target, [column.sameTenant?.targetColumn ?? '', key]);
    }
  }
  wantedByRetired(entities, current, wanted);
  if (wanted.size === 0) return entities;
  return entities.map((entity) => {
    const needed = wanted.get(entity.table);
    if (needed === undefined) return entity;
    const extra = [...needed.values()].flatMap((columns): IndexDescriptionLike[] => {
      const set = new Set(columns);
      if (
        primaryKeyAnswers(entity, set) ||
        invariantAnswers(entity, set) ||
        entity.indexes.some((index) => answers(index, set))
      ) {
        return [];
      }
      return [
        {
          name: bounded(`${entity.table}_${columns.join('_')}_tenant_key`),
          columns,
          unique: true,
          where: null,
          order: null,
          concurrently: true,
        },
      ];
    });
    return extra.length === 0 ? entity : { ...entity, indexes: [...entity.indexes, ...extra] };
  });
}

/**
 * The indexes only a retired column's recorded key keeps, per table, as a snapshot records them:
 * for `recordRetired`, which is also `checkSnapshotDrift`'s path and has no migration to read them off.
 */
export function retiredKeyIndexes(
  entities: readonly EntityDescriptionLike[],
  current: SchemaDescription,
): ReadonlyMap<string, readonly IndexDescription[]> {
  const out = new Map<string, readonly IndexDescription[]>();
  const without = withSameTenantIndexes(entities);
  for (const entity of withSameTenantIndexes(entities, current)) {
    const known = new Set(
      without.find((each) => each.table === entity.table)?.indexes.map((index) => index.name),
    );
    const kept = entity.indexes.filter((index) => !known.has(index.name));
    if (kept.length === 0) continue;
    out.set(
      entity.table,
      kept.map((index) => ({
        name: index.name,
        columns: [...index.columns],
        unique: index.unique,
        primary: false,
        where: index.where,
        order: index.order,
      })),
    );
  }
  return out;
}

// Single responsibility: the declared optimistic lock, `entity({ version: 'lockVersion' })`, in
// property space — what a valid declaration is, which write shapes may carry the version, and the
// compare-and-increment a store merging in code applies. Postgres says the same thing in SQL
// (`pg-write-sql.ts`, `pg-update-many-sql.ts`); the per-write rule table is in the entity README.

import type { EntityCore } from './entity';
import { notFound } from './errors';
import { namedColumns } from './plan';
import type { ColumnMap } from './types';
import { entityStale, versionMisused } from './version-lock-errors';

/** The fix every declaration refusal shares: the one spelling of a lock column. */
const declare = (entityName: string, version: string): string =>
  `${version}: integer().default(0)   # in entity('${entityName}', { columns, version: '${version}' }), then: x db gen "lock ${entityName}"`;

/**
 * The declared version property, or `null` for an entity with none. Validated where it is
 * written: a lock over a nullable or defaultless column has a row with no version, and a write
 * conditioned on `null = null` matches nothing, so every update of that row would read as stale.
 */
export const versionColumnOf = (
  entityName: string,
  columns: ColumnMap,
  version: string | undefined,
): string | null => {
  if (version === undefined) return null;
  const meta = Object.hasOwn(columns, version) ? columns[version]?.$meta : undefined;
  const refuse = (detail: string): never => {
    throw versionMisused(
      entityName,
      `version: '${version}' ${detail}`,
      declare(entityName, version),
    );
  };
  if (meta === undefined)
    return refuse(`names no column — pick from: ${Object.keys(columns).join(', ')}`);
  if (meta.kind !== 'integer')
    return refuse(`is a ${meta.kind} column; a version counts writes, so it is an integer()`);
  if (!meta.notNull)
    return refuse('is nullable; a row with no version could never be written again');
  if (meta.default?.kind !== 'value' || typeof meta.default.value !== 'number') {
    return refuse('has no .default(n); an insert that names no version would store none');
  }
  if (meta.primaryKey || meta.tenant)
    return refuse('is a key column; a version moves on every write');
  return version;
};

/**
 * The version property of `entity`, read structurally so a hand-built `EntityCore` (a view, a
 * test double) with no `$version` reads as unversioned rather than as a crash.
 */
export const versionOf = (entity: object): string | null => {
  const declared = (entity as { readonly $version?: string | null }).$version;
  return typeof declared === 'string' ? declared : null;
};

const named = (patch: unknown, property: string): unknown =>
  namedColumns(patch).find(([key]) => key === property)?.[1];

const expectedOf = (entityName: string, property: string, value: unknown, op: string): number => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw versionMisused(
    entityName,
    `${op}() named ${property} as ${value === null ? 'null' : typeof value}, and a version is the integer the row was read with`,
    `${entityName}.${op}(id, { …patch, ${property}: row.${property} })   # the integer from the row this change was decided on`,
  );
};

/**
 * `update(id, patch)` on a versioned entity: the patch names the version it read, or the write is
 * refused — an update that omits it is the lost update the declaration exists to stop. Answers the
 * expected version (`undefined` for an unversioned entity).
 */
export const assertVersionedUpdate = (
  entity: { readonly $name: string },
  patch: unknown,
  op: 'update' | 'updateMany' = 'update',
): number | undefined => {
  const property = versionOf(entity);
  if (property === null) return undefined;
  const value = named(patch, property);
  if (value === undefined) {
    throw versionMisused(
      entity.$name,
      `${op}() names no ${property}, and ${entity.$name} declares version: '${property}' — the write cannot tell whether the row moved since it was read`,
      `${entity.$name}.update(id, { …patch, ${property}: row.${property} })   # carry the version from the read; a mutator takes it as input`,
    );
  }
  return expectedOf(entity.$name, property, value, op);
};

/**
 * A filtered write (`updateWhere`, a chain's `updateAll`, a transition) may not SET the version:
 * the statement increments it on every matched row. A compare-and-set over a filter is spelled in
 * the filter, `where({ id, lockVersion: 3 })`, where a stale row is simply not matched.
 */
export const assertUnversionedPatch = (
  entity: { readonly $name: string },
  patch: unknown,
  op: string,
): void => {
  const property = versionOf(entity);
  if (property === null || named(patch, property) === undefined) return;
  throw versionMisused(
    entity.$name,
    `${op}() sets ${property}, which every write of ${entity.$name} increments itself`,
    `${entity.$name}.where({ id, ${property}: row.${property} }).updateAll(patchWithout${capital(property)})   # the version goes in the filter`,
  );
};

const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * `upsertAll` with `onMatch: 'update'` overwrites a stored row it never read, so it would bypass
 * the lock wholesale. Refused; `onMatch: 'nothing'` writes only new rows and stays allowed.
 */
export const assertVersionedUpsert = (
  entity: { readonly $name: string },
  onMatch: 'update' | 'nothing',
): void => {
  const property = versionOf(entity);
  if (property === null || onMatch === 'nothing') return;
  throw versionMisused(
    entity.$name,
    `upsertAll() would overwrite stored rows without reading their ${property}, and ${entity.$name} declares version: '${property}'`,
    `${entity.$name}.upsertAll(rows, { onConflict, onMatch: 'nothing' })   # then update(id, { …patch, ${property} }) each row that already existed`,
  );
};

/**
 * The memory driver's (and a code-merging store's) half of the lock: `merged` with the version
 * one past `stored`'s, after refusing a patch that named a version the stored row is no longer at.
 * The Postgres statement says the same with `where "v" = $n` and `set "v" = "v" + 1`.
 */
export const versionedMerge = <Row>(
  entity: EntityCore<Row>,
  stored: Row,
  patch: object,
  merged: Row,
  idOf: (row: Row) => string,
): Row => {
  const property = versionOf(entity);
  if (property === null) return merged;
  const current = (stored as Readonly<Record<string, unknown>>)[property];
  const expected = named(patch, property);
  if (expected !== undefined && expected !== current) {
    throw entityStale(entity.$name, property, idOf(stored), expected, current);
  }
  const next = typeof current === 'number' ? current + 1 : 1;
  return Object.assign({}, merged, { [property]: next }) as Row;
};

/** What a store's patch writes as the version when it can only set a value: the expected + 1. */
export const nextVersion = (entity: object, patch: unknown): number | undefined => {
  const property = versionOf(entity);
  if (property === null) return undefined;
  const value = named(patch, property);
  return typeof value === 'number' ? value + 1 : undefined;
};

/**
 * Why a conditioned `update(id)` matched no row, asked only after it did: re-read (tenant scoped,
 * so another org's row is absent) and name the stored version, or `X_NOT_FOUND`.
 */
export const staleOrNotFound = async <Row>(
  entity: EntityCore<Row>,
  id: unknown,
  patch: unknown,
  reread: () => Promise<Row | null>,
): Promise<Error> => {
  const property = versionOf(entity);
  const row = await reread();
  if (row === null || property === null) return notFound(entity.$name, String(id));
  const stored = (row as Readonly<Record<string, unknown>>)[property];
  return entityStale(entity.$name, property, String(id), named(patch, property), stored);
};

// Single responsibility: every way `X_MIGRATION_ROLLING_UNSAFE` is raised, and the path each one
// prints. One code, because all of them are one fact: the previous release is still running. Apart
// from `migration-errors.ts` for its size, and because this one reads `rolling.ts`'s vocabulary.

import { renderFixShellArg } from '@ultimat3/core';
import { DbError } from './errors';
import type { RetireAndContract, RollingUnsafeStatement } from './rolling';

const CODE = 'X_MIGRATION_ROLLING_UNSAFE';

/**
 * The path, whole, once. Followed verbatim it ends with the column gone and neither release ever
 * having read a column that was not there (`retired.live.test.ts`). Every name is from a sidecar,
 * an entity or a migration's text, so it reaches the command through the shell screen.
 */
function twoReleases(entity: string, column: string): string {
  const c = renderFixShellArg(column, '<column>');
  return (
    `entity('${renderFixShellArg(entity, '<entity>')}', { retired: ['${c}'] })   # then x db gen "retire ${c}", deploy, ` +
    `then remove it from retired and x db gen "drop ${c}" --allow-destructive`
  );
}

/** `x db gen`: a column left the entity with no `retired` in between. */
export const columnDropNotRetired = (
  entity: string,
  table: string,
  column: string,
  migration: string,
): DbError =>
  new DbError({
    code: CODE,
    cause:
      `dropping "${table}"."${column}" in the release that stops declaring it fails every read and ` +
      'insert of the pods still running the previous release, which name it (X_DB_SCHEMA_STALE)',
    fix: `${twoReleases(entity, column)} — one instance that stops before the next starts: x db gen ${renderFixShellArg(migration, '<name>')} --allow-destructive --rolling-unsafe`,
    meta: { table, column },
  });

/** `retired` names what no migration recorded, or a column the entity still declares. */
export const retiredNameUnknown = (entity: string, table: string, column: string): DbError =>
  new DbError({
    code: CODE,
    cause: `entity "${entity}" retires "${column}", and "${table}" records no such column to retire, or still declares it`,
    fix: `entity('${renderFixShellArg(entity, '<entity>')}', { retired: [] })   # drop "${renderFixShellArg(column, '<column>')}" from retired: list only a column the newest migration records and columns no longer declares`,
    meta: { table, column },
  });

/** The new release omits it from every insert, so the database must be able to fill it. */
export const retiredColumnRequired = (entity: string, table: string, column: string): DbError =>
  new DbError({
    code: CODE,
    cause:
      `"${table}"."${column}" is NOT NULL with no default or part of the primary key, so an ` +
      'insert from the release that retires it would fail: that release no longer writes it',
    fix: `${renderFixShellArg(column, '<column>')}: text().nullable()   # on entity('${renderFixShellArg(entity, '<entity>')}'), then x db gen "relax ${renderFixShellArg(column, '<column>')}", deploy, then retire it`,
    meta: { table, column },
  });

/** The drop this retire promises would be `2BP01` at apply, so it is refused while it is cheap. */
export const retiredColumnReferenced = (entity: string, table: string, column: string): DbError =>
  new DbError({
    code: CODE,
    cause: `"${table}"."${column}" is the target of a foreign key an entity still declares, so the drop that follows this retire could never apply (2BP01)`,
    fix: `references(() => target.id)   # repoint or remove every references() to "${renderFixShellArg(column, '<column>')}" of entity('${renderFixShellArg(entity, '<entity>')}'), then x db gen`,
    meta: { table, column },
  });

const STATED: Readonly<Record<RollingUnsafeStatement['kind'], string>> = {
  'drop-column': 'drops a column no earlier migration retired',
  'rename-column': 'renames a column the previous release still names',
  'rename-table': 'renames a table the previous release still names',
};

/** The gate's half, over a committed file. One per migration, as `migrationDestructive` is. */
export const migrationRollingUnsafe = (
  file: string,
  first: RollingUnsafeStatement,
  more = 0,
): DbError =>
  new DbError({
    code: CODE,
    cause: `${file} ${STATED[first.kind]}${more === 0 ? '' : ` (and ${more} more)`}: ${first.statement}`,
    fix: `${twoReleases(first.table, first.column ?? '<column>')} — one instance that stops before the next starts: add the line "-- rolling-unsafe: true" to ${file} before it is applied`,
    meta: { file, kind: first.kind, table: first.table, column: first.column },
  });

/** `migrate()`, before the first BEGIN: both are fine, both in one deploy is not. */
export const retireAndContractTogether = (pair: RetireAndContract): DbError =>
  new DbError({
    code: CODE,
    cause:
      `migrations "${pair.retire}" and "${pair.contract}" retire and drop "${pair.table}"."${pair.column}" in ` +
      'one deploy, so the pods of the release before them meet the drop; nothing was applied',
    fix: `git log --oneline -- packages/db/migrations   # deploy the build whose newest migration is the retire, then this one`,
    meta: { retire: pair.retire, contract: pair.contract },
  });

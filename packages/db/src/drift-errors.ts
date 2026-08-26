// Single responsibility: the `X_DB_DRIFT` constructor — the error form of the finding
// `drift-findings.ts`'s `unexpectedColumn` reports, thrown where a caller has no report to hand
// back. Split out of `errors.ts` for the import it needs and nothing else: the fix line puts a
// column name into a shell command, so it screens through `shellInertIdentifier` (`sql.ts`) —
// and `sql.ts` imports `errors.ts`, so this cannot live there without a cycle around the module
// whose evaluation registers every code. The code is still declared, titled and registered in
// `errors.ts`, exactly as `migration-errors.ts` and `invariant-errors.ts` are.

import { DbError } from './errors';
import { shellInertIdentifier } from './sql';

/**
 * The contract's pinned wording. Mirror of `@ultimat3/entity`'s `dbDrift()` — keep in sync; that
 * one screens the column through the same `@ultimat3/db` export, so the two lines are the same
 * text on both sides of the tier seam.
 *
 * The column name is the CATALOG's, so it is data: whoever can add a column picks the text that
 * lands here, and `x db gen "add C"` puts it inside SHELL DOUBLE QUOTES, where `$(…)` and a
 * backtick substitute before `x` is reached at all. The argument is a migration DESCRIPTION and
 * not an identifier, so no quoted form makes a hostile name safe to pass — a name the screen
 * refuses is left OUT of the command rather than escaped into it. The command still runs and
 * still generates the migration; the name is read off `cause` and `meta`, which are prose nobody
 * pastes.
 */
export const dbDrift = (tableName: string, columnName: string): DbError =>
  new DbError({
    code: 'X_DB_DRIFT',
    cause: `table "${tableName}" has column "${columnName}" not present in any migration`,
    fix:
      shellInertIdentifier(columnName) === null
        ? 'x db gen "add the column named in this error"   # its name carries a backtick, a ' +
          'dollar sign, a quote, a backslash or whitespace, so it is in the cause and not in ' +
          'this command'
        : `x db gen "add ${columnName}"`,
    meta: { table: tableName, column: columnName },
  });

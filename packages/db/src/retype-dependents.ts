// Single responsibility: which RECORDED objects a retype of one column breaks, and the statements
// that take them out of the way before the ALTER and put them back in the `down`.
//
// Postgres compiles a partial index's predicate and a CHECK's expression against the column's type
// at creation and cannot recompile either: `alter table "posts" alter column "status" type text
// using "status"::text` answers `42883 operator does not exist: text = post_status` and the
// migration aborts mid-run — inside `ROLE=migrate`, with the ledger recording nothing. Measured on
// Postgres 18.4 (`generate-retype.live.test.ts`), one dependent shape at a time:
//
// | recorded object                          | survives the ALTER |
// |------------------------------------------|--------------------|
// | btree on the column, plain or unique      | yes — Postgres rebuilds it itself |
// | composite btree including the column      | yes |
// | partial index whose predicate names it    | **no — 42883** |
// | partial index naming another column       | yes |
// | CHECK whose expression names it           | **no — 42883** |
//
// So only an expression that MENTIONS the column is dependent, and dropping the rest would be a
// table scan per index for nothing.

import { addCheck, dropCheck } from './check-ddl';
import type { Plan } from './foreign-key-plan';
import { asDeclared, createIndex, dropIndex } from './index-ddl';
import type { CheckDescription, IndexDescription, TableDescription } from './introspect';
import { IDENTIFIER_PART, noiseAt } from './sql-scan';

/**
 * Whether `expression` reads `column`, over-approximating on purpose.
 *
 * The two errors are not symmetrical. A dependent object missed is `42883` in the release phase;
 * one reported that was not is a rebuild nobody asked for — so every ambiguous case answers `true`,
 * and the folding is case-insensitive because Postgres folds an unquoted identifier to lower case
 * and `"Status"` naming a different column is a rarity beside a predicate this must not miss.
 *
 * What it does NOT count is noise, through this package's one lexer (`sql-scan.ts`): the `status`
 * in `where kind = 'status'` is data, not a reference, and the one in `-- status` is prose. A
 * QUOTED identifier is counted — `"status"` is the reference the catalog stores for an author who
 * quoted it, and skipping it as noise is exactly the miss that ends in `42883`.
 */
export function referencesColumn(expression: string, column: string): boolean {
  const wanted = column.toLowerCase();
  let at = 0;
  while (at < expression.length) {
    const noise = noiseAt(expression, at);
    if (noise !== null) {
      if (
        noise.kind === 'identifier' &&
        expression.slice(at + 1, noise.end - 1).toLowerCase() === wanted
      ) {
        return true;
      }
      at = noise.end;
      continue;
    }
    if (!IDENTIFIER_PART.test(expression[at] ?? '')) {
      at += 1;
      continue;
    }
    let end = at;
    while (end < expression.length && IDENTIFIER_PART.test(expression[end] ?? '')) end += 1;
    if (expression.slice(at, end).toLowerCase() === wanted) return true;
    at = end;
  }
  return false;
}

/** The recorded objects a retype of `column` cannot leave in place. */
export interface RetypeDependents {
  /**
   * Partial indexes whose predicate reads the column. A `primary` one is structurally impossible —
   * a primary key index has no predicate — which is what keeps `drop index` off the two indexes
   * Postgres refuses it on: a primary key's and a unique constraint's.
   */
  readonly indexes: readonly IndexDescription[];
  /** CHECK constraints whose expression reads the column. */
  readonly checks: readonly CheckDescription[];
}

/**
 * What a retype of `table`.`column` breaks, read off the RECORDED schema — never the catalog.
 * `x db gen` runs with no database open, so a hand-added expression index over the same column is
 * invisible here and still `42883`; what this can see is every object a migration wrote down.
 */
export function retypeDependents(column: string, live: TableDescription): RetypeDependents {
  return {
    indexes: live.indexes.filter(
      (index) => !index.primary && index.where !== null && referencesColumn(index.where, column),
    ),
    checks: (live.checks ?? []).filter((check) => referencesColumn(check.expression, column)),
  };
}

/**
 * What this plan has already dropped ahead of a retype — names only, because that is all the two
 * readers need. The ordinary diff runs AFTER the ALTER and must not act on an object that is no
 * longer there: the index loop CREATES a name in `indexes` instead of comparing it (a `drop index`
 * on a name already dropped is `42704`, and a definition that never moved would emit nothing at
 * all, leaving the table with no index), and `checkPlan` neither drops nor re-adds a name in
 * `checks` — the declared side is added back by its own arm, and a recorded constraint the entity
 * no longer declares is simply gone, which is what `checkPlan` would have done to it anyway.
 */
export interface MovedAside {
  readonly indexes: Set<string>;
  readonly checks: Set<string>;
}

/**
 * Drop every dependent in `up`, restore it in `down`, and record what was moved.
 *
 * `down` is reversed at assembly, so the restores are pushed FORWARDS here and the retype's own
 * reversal is pushed after them — the reversed script therefore reads: retype back to the old
 * type, then recreate the objects that were compiled against it. Restoring first would recreate a
 * predicate against a type the column no longer has, which is `42883` in the other direction.
 *
 * What is restored is what the snapshot RECORDED, never what the entity declares: an object still
 * declared is re-created by the ordinary diff, one statement later, in its current shape.
 */
export function moveDependentsAside(
  live: TableDescription,
  column: string,
  plan: Plan,
  moved: MovedAside,
): void {
  const dependents = retypeDependents(column, live);
  for (const index of dependents.indexes) {
    plan.up.push(dropIndex(index.name));
    plan.down.push(createIndex(live.name, asDeclared(index)));
    moved.indexes.add(index.name);
  }
  for (const check of dependents.checks) {
    plan.up.push(dropCheck(live.name, check.name));
    plan.down.push(addCheck(live.name, check));
    moved.checks.add(check.name);
  }
}

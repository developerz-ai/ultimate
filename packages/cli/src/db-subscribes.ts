// Single responsibility: which tables `x db gen` must grant `REPLICA IDENTITY FULL`, read off the
// live queries' DECLARED `subscribes:` — and the refusal for a declared name no entity's table
// matches. This tier is the only one holding both registries, so it is the only one that can ask.

import { UltimateError } from '@ultimat3/core';

/**
 * The two fields this reads, and nothing else. Structurally satisfied by `QueryDescriptor` (whose
 * `subscribes` is `null` when the read declared none) and by `@ultimat3/manifest`'s `QueryFact`
 * (where it is absent instead) — one function over both spellings of one fact, rather than a
 * projection per caller that could disagree about which reads are subscribed.
 */
export interface SubscribingQuery {
  readonly name: string;
  readonly subscribes?: readonly string[] | null | undefined;
}

/** Enough of the app's own tables to act on, without printing a hundred of them into one line. */
const NAMED_IN_FIX = 10;

function offer(tables: ReadonlySet<string>): string {
  const known = [...tables].sort();
  if (known.length === 0) return 'this app declares no entity at all — x g entity Note body:text';
  const shown = known.slice(0, NAMED_IN_FIX).join(', ');
  return known.length > NAMED_IN_FIX ? `${shown} and ${known.length - NAMED_IN_FIX} more` : shown;
}

/**
 * A live read declares a relation this app has no entity for.
 *
 * Refused rather than dropped, and that is the whole point of the check: `@ultimat3/db` keeps only
 * the declared names an entity's table matches (`replica-identity.ts`), so an EXTRA name is
 * discarded in silence — and `@ultimat3/query` has no table catalog, so its own `subscribes:`
 * assertions cannot see one either. A typo therefore granted `REPLICA IDENTITY FULL` to nothing
 * while its author read the declaration as granted, which is the failure #357 exists to end.
 *
 * The name goes in the `cause` and never into a command: it is a string from the app's own source,
 * and the remedy is an edit to a field rather than anything to paste at a shell.
 */
export class QuerySubscribesUnknownError extends UltimateError {
  constructor(input: { query: string; table: string; tables: ReadonlySet<string> }) {
    super({
      code: 'X_QUERY_SUBSCRIBES_UNKNOWN',
      cause:
        `the query "${input.query}" declares subscribes: ["${input.table}"] and no entity ` +
        'declares a table with that name',
      fix:
        `edit subscribes: on the query "${input.query}" to name a table this app declares ` +
        `(${offer(input.tables)}), or drop the name — x db gen grants REPLICA IDENTITY FULL to ` +
        'exactly the tables it lists, and would have granted it to nothing',
      meta: { query: input.query, table: input.table },
    });
  }
}

/**
 * The tables to hand `GenerateOptions.replicaIdentityFull`, deduped and sorted.
 *
 * Sorted so the same app generates the same bytes whatever order its modules registered in — the
 * rule `@ultimat3/db`'s own `pending()` states one layer down, kept here too because a caller that
 * ordered by registration would put a diff in a file for nothing.
 *
 * Every name is checked against `tables` BEFORE any of them is returned: a run that emitted the
 * good half and refused afterwards would leave an author with a migration that is right for one
 * table and silently absent for the other.
 */
export function replicaIdentityTables(
  queries: readonly SubscribingQuery[],
  tables: ReadonlySet<string>,
): readonly string[] {
  const wanted = new Set<string>();
  for (const query of queries) {
    for (const table of query.subscribes ?? []) {
      if (!tables.has(table)) {
        throw new QuerySubscribesUnknownError({ query: query.name, table, tables });
      }
      wanted.add(table);
    }
  }
  return [...wanted].sort();
}

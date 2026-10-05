// Single responsibility: which tables `x db gen` must grant `REPLICA IDENTITY FULL` — the `records`
// tables of every channel with params, and since #518 never a live query's `subscribes:` — and the
// refusal for a declared `subscribes:` name no entity's table matches. Only this tier holds both.

import { UltimateError } from '@ultimat3/core';
import { paramsChannelTables } from '@ultimat3/realtime/server';

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
 * Refused rather than dropped: `@ultimat3/query` has no table catalog, so its own `subscribes:`
 * assertions cannot see a name no table has — and a typo there is a declaration its author reads
 * as true. Until #518 the list also chose which tables got `REPLICA IDENTITY FULL`, so the typo
 * granted it to nothing (#357); the grant is gone, the declaration's honesty still matters.
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
        `(${offer(input.tables)}), or drop the name, then x db gen "fix subscribes" --json — a ` +
        'name no table has can never match what the read selects from (X_QUERY_SUBSCRIBES_DRIFT)',
      meta: { query: input.query, table: input.table },
    });
  }
}

/**
 * The tables to hand `GenerateOptions.replicaIdentityFull`, deduped and sorted.
 *
 * A live query's `subscribes:` is VALIDATED here and never granted (#518, owner decision O-518):
 * every entity has a primary key — `entity()` refuses one without — and a live query over a keyed
 * table is correct on DEFAULT identity, because the shared window holds the whole row the
 * in/out/delete decision needs (`realtime/src/pg-identity-window.live.test.ts`, on real WAL). FULL
 * there only made every UPDATE and DELETE log the whole old row. A table already on FULL keeps it:
 * `replica-identity.ts` never reverts, and the drift step reads a recorded FULL as agreement.
 *
 * Sorted so the same app generates the same bytes whatever order its modules registered in — the
 * rule `@ultimat3/db`'s own `pending()` states one layer down, kept here too because a caller that
 * ordered by registration would put a diff in a file for nothing.
 *
 * Every `subscribes:` name is checked against `tables` BEFORE anything is returned, so a refused
 * declaration never leaves a migration half-written behind it.
 *
 * `channelTables` defaults to what the declared channels need (`paramsChannelTables()`): a channel
 * with params routes a DELETE to the topic the OLD row names, and under the default identity that
 * image is the key alone — no topic, no `remove`, and members keep the deleted record. They are
 * derived from entity projections rather than typed by an author, so one outside `tables` is
 * dropped, not refused: there is no declaration to send anyone back to.
 */
export function replicaIdentityTables(
  queries: readonly SubscribingQuery[],
  tables: ReadonlySet<string>,
  channelTables: readonly string[] = paramsChannelTables(),
): readonly string[] {
  for (const query of queries) {
    for (const table of query.subscribes ?? []) {
      if (!tables.has(table)) {
        throw new QuerySubscribesUnknownError({ query: query.name, table, tables });
      }
    }
  }
  return [...new Set(channelTables.filter((table) => tables.has(table)))].sort();
}

/**
 * The fluent surface: every projection this package owns reachable as a method on the query
 * itself, `orgFeed.live(input)` rather than `toLiveQuery(orgFeed, input)`, and every declared
 * field lifted off `def` so app code never reaches through `.def`. The projection functions stay
 * exported for the framework's own call sites — this file only binds them to the query, it never
 * re-implements one. There is no `.tool()`: the MCP tool is `@ultimat3/mcp`'s one projection
 * (`toolFrom(orgFeed)`), a tier this package cannot import.
 */

import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { QueryClientMethodOf } from './client';
import { queryClientMethodFor } from './client';
import { toLiveQuery } from './live';
import { paginate } from './pagination';
import type { Query, QueryDef, QueryFacade } from './query';
import { queryName, runQuery } from './read';

/**
 * `self` is a thunk on purpose: the façade is attached while the query is still
 * being assembled, so every method resolves the query when it is called, not now.
 */
export function facadeFor<
  TInput extends StandardSchemaV1,
  TRow extends object,
  TSingle extends boolean,
>(
  def: QueryDef<TInput, TRow, TSingle>,
  self: () => Query<TInput, TRow, TSingle>,
): QueryFacade<TInput, TRow, TSingle> {
  return {
    input: def.input,
    policy: def.policy,
    // Only when declared, like every lifted field: a list read's surface is unchanged.
    ...(def.single === undefined ? {} : { single: def.single }),
    ...(def.subscribes === undefined ? {} : { subscribes: def.subscribes }),
    ...(def.rows === undefined ? {} : { rows: def.rows }),
    ...(def.cache === undefined ? {} : { cache: def.cache }),
    ...(def.mcp === undefined ? {} : { mcp: def.mcp }),
    ...(def.rateLimit === undefined ? {} : { rateLimit: def.rateLimit }),
    ...(def.deprecated === undefined ? {} : { deprecated: def.deprecated }),
    // `.as()` is impersonation on the one read path: `runQuery` keeps the
    // surrounding context whole and swaps only the actor.
    as: (actor, input, options) => runQuery(self(), input, { ...options, actor }),
    // A page is the read's own answer, not a helper someone has to import: the
    // signed cursor is only reachable through the query that issued it.
    page: (input, args) => paginate(self(), input, args),
    live: (input, options) => toLiveQuery(self(), input, options),
    // One implementation for both wire shapes: the route decides the body, the transport parses
    // it, and only the TYPE differs — a single read's method answers the row, and has no `page`.
    client: (options) =>
      queryClientMethodFor<TInput, TRow>(queryName(self()), options) as QueryClientMethodOf<
        TInput,
        TRow,
        TSingle
      >,
  };
}

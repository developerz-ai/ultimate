/**
 * A `live: true` read is bounded by a declared `.limit()`, refused where its source is built.
 * `sql:` is a callback over a parsed input, so no declaration-time check can see the chain; the
 * build is the first point that can, and every surface — subscribe, route, `x exercise` — meets it.
 */
import { UltimateError } from '@ultimat3/core';
import type { AnyQuery } from './query';
import type { SqlSource } from './source';

/**
 * Every subscriber holds a live read's window and the matcher patches it, so a window with no
 * limit is the whole matching table, per subscriber, re-sent on every refill.
 */
export class QueryLiveUnboundedError extends UltimateError {
  constructor(name: string, entity: string) {
    super({
      code: 'X_QUERY_LIVE_UNBOUNDED',
      cause: `live query "${name}" reads "${entity}" with no .limit(), so every subscriber would hold every matching row — end its sql: chain with a limit, or drop live: true and read it with ${name}.page()`,
      fix: `sql: (input) => <${name}'s chain>.orderBy('<column>', 'desc').limit(50)   // a live window is the rows it declares`,
    });
  }
}

/**
 * Refuses the built source of a `live: true` read when it declares no limit, on every surface.
 * Keyed on the declaration, not the surface: only a `live: true` read is ever subscribed
 * (`@ultimat3/realtime`'s registry and `x dev`'s sync node list `isLive` reads alone).
 */
export function assertLiveBounded(name: string, target: AnyQuery, source: SqlSource<object>): void {
  if (!target.isLive) return;
  const shape = source.shape();
  if (shape.limit === null) throw new QueryLiveUnboundedError(name, shape.entity);
}

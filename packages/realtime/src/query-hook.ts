// The typed projection of a query into the hook a component calls: `liveHookFor(liveFeed)` is
// `useLiveFeed`, and `useLiveFeed({ orgId })` carries that query's own input and row types. It
// binds `useLive` rather than re-implementing it — one subscribe path, given the query's name.

import { QueryNotSubscribableError } from './errors';
import { type LiveInput, type LiveRows, useLive } from './hooks';

/**
 * What the hook needs from a `@ultimat3/query` `Query`: the name it subscribes under, the declared
 * `live:` flag, and the call signature both types are read off. Named structurally rather than
 * imported, the way `hooks.ts` names a mutator — a hook is browser code, and a value import of
 * `@ultimat3/query` would carry the server's read path into the bundle.
 *
 * `options` is `never` because this side never passes one; a `Query`, whose second parameter is
 * optional and wider, still assigns.
 */
export interface LiveQuerySource<TInput, TRow extends object> {
  (input: TInput, options?: never): Promise<readonly TRow[]>;
  readonly name: string;
  readonly isLive: boolean;
}

/**
 * The bound hook. Input is the query's own — a wrong key is a compile error in the component, not
 * a subscription that returns nothing. A thunk is read **once**, at subscribe time, exactly as
 * `useLive`'s is: there is no reactive runtime here to re-run it, so new input means a new
 * subscription.
 */
export type LiveQueryHook<TInput, TRow extends object> = (
  input: TInput | (() => TInput),
) => LiveRows<TRow>;

/**
 * Bind one live query to one hook: `export const useLiveFeed = liveHookFor(liveFeed)`, then
 * `useLiveFeed({ orgId })` in a component. Nothing is generated and nothing is fetched by hand —
 * the types come off the query declaration and the rows off its subscription.
 *
 * Binding a query that is not `live: true` throws here, at module load, rather than handing back a
 * hook that could only ever return an empty set.
 */
export function liveHookFor<TInput, TRow extends object>(
  query: LiveQuerySource<TInput, TRow>,
): LiveQueryHook<TInput, TRow> {
  if (!query.isLive) throw new QueryNotSubscribableError({ name: query.name });
  // The query object is handed through, never its `name` read now: `registerQueries()` stamps that
  // at boot, and this binding runs at import — earlier. `useLive` reads it per subscription.
  return (input) => {
    // Both assertions are the one wire seam: the input is about to be serialised into a subscribe
    // frame, and the rows come back off that subscription. `unknown` in between rather than a
    // direct cast, exactly as `query.client()` hops through it at the same seam.
    const rows: unknown = useLive(query, input as LiveInput);
    // Erased at the wire seam, the way `query.client()` erases its own: the rows arriving on this
    // subscription are this query's by construction, because the server built them from its `sql`.
    return rows as LiveRows<TRow>;
  };
}

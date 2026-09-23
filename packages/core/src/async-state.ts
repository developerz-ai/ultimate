/**
 * The four shapes an async region can be in — pending, refreshing, ready, failed. Tier 0 because
 * every client layer produces or consumes one: `@ultimat3/realtime`'s `useQuery` returns it (tier 3)
 * and `@ultimat3/ui`'s `asyncBranch` renders it (tier 4), and neither may import the other's way.
 */

/**
 * A STATE, never a query: a live-query accessor, a `createResource` and a plain signal all arrive
 * at a region as the same four shapes.
 *
 * `refreshing` is the one that makes search feel fast — it CARRIES the previous data, so a refetch
 * re-renders what is already on screen instead of tearing it down to a skeleton. `pending` holds
 * no data, which is what makes "no results" before the first answer unconstructible.
 */
export type AsyncState<T> =
  | { readonly status: 'pending' }
  | { readonly status: 'refreshing'; readonly data: T }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'failed'; readonly error: unknown };

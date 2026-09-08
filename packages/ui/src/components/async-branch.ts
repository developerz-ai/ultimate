// The ONE four-way decision every async region makes — pending, failed, empty, ready — written as
// a pure rule so "what does this look like while it loads" stops being a judgement an agent makes
// once per screen. Two properties are structural here rather than documented: `empty` is
// unreachable until a result has arrived, and a refetch keeps the previous data on screen.

/**
 * What a caller hands an async region. A STATE, never a query: `@ultimat3/ui` is tier 4 and may
 * not import `query`, `action` or `realtime`, so a live-query accessor, a `createResource` and a
 * plain signal all arrive here as the same four shapes.
 *
 * `refreshing` is the one that makes search feel fast — it CARRIES the previous data, so a refetch
 * re-renders what is already on screen instead of tearing it down to a skeleton.
 */
export type AsyncState<T> =
  | { readonly status: 'pending' }
  | { readonly status: 'refreshing'; readonly data: T }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'failed'; readonly error: unknown };

/**
 * The branch a region renders. `empty` and `ready` carry `busy`; `pending` and `failed` do not,
 * because `pending` IS busy and a failure is not in flight.
 *
 * There is no `{ kind: 'empty' }` reachable from `{ status: 'pending' }` — that is the whole
 * point of this module. "No results" rendered for one frame before the first page arrives is the
 * most common agent-authored UX bug in a list screen, and the union above makes it unconstructible
 * rather than merely discouraged: `pending` holds no data, so nothing can be found empty in it.
 */
export type AsyncBranch<T> =
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'empty'; readonly busy: boolean }
  | { readonly kind: 'ready'; readonly data: T; readonly busy: boolean };

const PENDING: AsyncBranch<never> = Object.freeze({ kind: 'pending' });

/**
 * The default emptiness test: a list with no items, a map or set with no entries, or nothing at
 * all. Anything else is data — a `{ total: 0, items: [] }` envelope is a shape only its author
 * knows, so it passes its own `isEmpty` rather than being guessed at here.
 */
export function isEmptyData(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (data instanceof Map || data instanceof Set) return data.size === 0;
  if (typeof data === 'string') return data === '';
  return false;
}

/**
 * State → branch. The only place the four-way decision is made, so `DataTable`, `AsyncRegion` and
 * an app's own region cannot disagree about what "loading with stale rows" looks like.
 */
export function asyncBranch<T>(
  state: AsyncState<T>,
  isEmpty: (data: T) => boolean = isEmptyData,
): AsyncBranch<T> {
  // Failure first: a query that failed while holding stale data must report the failure, never
  // render the stale rows as if they were the answer to the request that just errored.
  if (state.status === 'failed') return { kind: 'failed', error: state.error };
  if (state.status === 'pending') return PENDING;
  // `ready | refreshing`, and this annotation is the build error: a fifth status added to
  // `AsyncState` fails to assign here instead of falling through to a region that renders nothing.
  const settled: { readonly status: 'ready' | 'refreshing'; readonly data: T } = state;
  const busy = settled.status === 'refreshing';
  return isEmpty(settled.data)
    ? { kind: 'empty', busy }
    : { kind: 'ready', data: settled.data, busy };
}

/** Whether the region is waiting on the network — `aria-busy`, in one derivation. */
export function isBusyBranch<T>(branch: AsyncBranch<T>): boolean {
  return branch.kind === 'pending' || (branch.kind !== 'failed' && branch.busy);
}

/**
 * The flag-shaped source a `createResource` (and most hand-rolled fetches) already are.
 * `data: undefined` means NOTHING HAS ARRIVED; an empty array is data, and it is what makes the
 * empty branch reachable. Solid's `latest` is exactly this: it holds the previous value across a
 * refetch, which is why `loading` beside a defined `data` is `refreshing` and not `pending`.
 */
export interface AsyncFlags<T> {
  readonly loading?: boolean | undefined;
  readonly error?: unknown;
  readonly data?: T | undefined;
}

export function asyncStateOf<T>(flags: AsyncFlags<T>): AsyncState<T> {
  if (flags.error !== undefined && flags.error !== null)
    return { status: 'failed', error: flags.error };
  if (flags.data === undefined) return { status: 'pending' };
  return flags.loading === true
    ? { status: 'refreshing', data: flags.data }
    : { status: 'ready', data: flags.data };
}

/** How much box the pending branch holds, so the skeleton and the loaded content share one size. */
export interface ReserveBox {
  /** Placeholder lines. Match what the loaded content renders, or the load is a layout shift. */
  readonly lines: number;
  /** CSS length of ONE line. Defaults to `1em`, the same default `Skeleton` uses. */
  readonly height?: string | undefined;
}

/**
 * The reserved block size, as one `calc()`. Emitted as a custom property on the region in EVERY
 * branch — that is the mechanism behind `Skeleton`'s own rule (a placeholder that changes size on
 * load is just a slower layout shift): one value feeds the placeholder and the box the real
 * content lands in, so the two cannot be written to disagree.
 */
export function reserveBlockSize(reserve: ReserveBox): string {
  return `calc(${String(reserve.lines)} * ${reserve.height ?? '1em'})`;
}

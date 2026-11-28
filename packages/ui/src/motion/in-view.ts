// "Has this element scrolled into view?" — the one IntersectionObserver module. One observer per
// (margin, amount) for the page, many targets each, so a feed of a hundred cards is one observer.

export interface InViewOptions {
  /** Report the first entry only, then stop watching. Default `true`. */
  readonly once?: boolean | undefined;
  /** Grow or shrink the viewport the element is tested against — `rootMargin`'s grammar. */
  readonly margin?: string | undefined;
  /** The fraction of the element that must show, 0..1. Default `0`: any pixel. */
  readonly amount?: number | undefined;
}

/** What `onEnter` may hand back: called when the element leaves again (`once: false`). */
type Leave = (entry: IntersectionObserverEntry) => void;
type Enter = (entry: IntersectionObserverEntry) => Leave | undefined;

interface Watch {
  readonly enter: Enter;
  readonly once: boolean;
  leave: Leave | undefined;
  inside: boolean;
}

interface Pool {
  readonly key: string;
  readonly observer: IntersectionObserver;
  /** Every watch on an element: two `inView`s (a reveal and a `frameLoop`) on one node are two. */
  readonly watches: Map<Element, Set<Watch>>;
}

const pools = new Map<string, Pool>();

function report(pool: Pool, entry: IntersectionObserverEntry, amount: number): void {
  // A copy: a callback may add or stop a watch on this element while the loop runs.
  for (const watch of [...(pool.watches.get(entry.target) ?? [])]) {
    const inside = entry.isIntersecting && entry.intersectionRatio >= amount;
    if (inside === watch.inside) continue;
    watch.inside = inside;
    if (inside) {
      const leave = watch.enter(entry);
      watch.leave = typeof leave === 'function' ? leave : undefined;
      // Only THIS watch goes: a callback that re-armed on the element keeps what it armed.
      if (watch.once) release(pool, entry.target, watch);
    } else {
      watch.leave?.(entry);
      watch.leave = undefined;
    }
  }
}

function poolFor(margin: string, amount: number): Pool {
  const key = `${margin}|${amount}`;
  const kept = pools.get(key);
  if (kept !== undefined) return kept;
  const pool: Pool = {
    key,
    observer: new IntersectionObserver(
      (entries) => {
        for (const entry of entries) report(pool, entry, amount);
      },
      { rootMargin: margin, threshold: amount },
    ),
    watches: new Map(),
  };
  pools.set(key, pool);
  return pool;
}

/** Drop ONE watch; the element is unobserved only when it holds none, the pool only when empty. */
function release(pool: Pool, el: Element, watch: Watch): void {
  const set = pool.watches.get(el);
  if (set === undefined || !set.delete(watch)) return;
  if (set.size > 0) return;
  pool.watches.delete(el);
  pool.observer.unobserve(el);
  // An empty pool goes: an observer with no targets is a page-lifetime leak for nothing. Reached
  // once per pool — a watch already released returns above — so a successor made by a callback is
  // never the one deleted.
  if (pool.watches.size === 0) {
    pool.observer.disconnect();
    pools.delete(pool.key);
  }
}

/**
 * Call `onEnter(entry)` when `el` scrolls into view. With `once: false` it fires on every entry,
 * and a function it returns is called on the matching exit. With no IntersectionObserver the
 * element counts as in view at once — content an animation would reveal is never left hidden.
 * Returns the stop.
 */
export function inView(el: Element, onEnter: Enter, options: InViewOptions = {}): () => void {
  if (typeof IntersectionObserver !== 'function') {
    onEnter({ target: el, isIntersecting: true } as IntersectionObserverEntry);
    return () => {};
  }
  const pool = poolFor(options.margin ?? '0px', options.amount ?? 0);
  const watch: Watch = {
    enter: onEnter,
    once: options.once ?? true,
    leave: undefined,
    inside: false,
  };
  const set = pool.watches.get(el);
  if (set === undefined) {
    pool.watches.set(el, new Set([watch]));
    pool.observer.observe(el);
  } else {
    set.add(watch);
    // An element already observed gets no fresh first report, so the new watch would wait for the
    // next crossing: observing it again asks for one (the others skip it — nothing changed).
    pool.observer.unobserve(el);
    pool.observer.observe(el);
  }
  return () => release(pool, el, watch);
}

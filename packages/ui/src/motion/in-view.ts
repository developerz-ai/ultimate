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
  readonly watches: Map<Element, Watch>;
}

const pools = new Map<string, Pool>();

function poolFor(margin: string, amount: number): Pool {
  const key = `${margin}|${amount}`;
  const kept = pools.get(key);
  if (kept !== undefined) return kept;
  const watches = new Map<Element, Watch>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const watch = watches.get(entry.target);
        if (watch === undefined) continue;
        const inside = entry.isIntersecting && entry.intersectionRatio >= amount;
        if (inside === watch.inside) continue;
        watch.inside = inside;
        if (inside) {
          const leave = watch.enter(entry);
          watch.leave = typeof leave === 'function' ? leave : undefined;
          if (watch.once) release(pool, entry.target);
        } else {
          watch.leave?.(entry);
          watch.leave = undefined;
        }
      }
    },
    { rootMargin: margin, threshold: amount },
  );
  const pool: Pool = { key, observer, watches };
  pools.set(key, pool);
  return pool;
}

function release(pool: Pool, el: Element): void {
  pool.watches.delete(el);
  pool.observer.unobserve(el);
  // An empty pool goes: an observer with no targets is a page-lifetime leak for nothing.
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
  pool.watches.set(el, {
    enter: onEnter,
    once: options.once ?? true,
    leave: undefined,
    inside: false,
  });
  pool.observer.observe(el);
  return () => {
    if (pool.watches.has(el)) release(pool, el);
  };
}

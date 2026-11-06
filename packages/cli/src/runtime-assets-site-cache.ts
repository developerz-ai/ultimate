// A byte-bounded, least-recently-used memo with single flight: what keeps a public image variant
// from being decoded twice. Concurrent first requests share one promise, so a burst of visitors to
// a fresh deploy is one decode, not one each — and the bound holds the process's memory flat.

export interface VariantLru<T> {
  /** The kept answer for `key`, the one in flight, or `make()`'s — kept if `sizeOf` sizes it. */
  get(key: string, make: () => Promise<T>): Promise<T>;
}

/**
 * `sizeOf` answering `undefined` means "answer, never keep" — a refusal is cheap to recompute and
 * must not hold a slot a real variant could. An entry larger than the whole budget is never kept.
 */
export function variantLru<T>(
  maxBytes: number,
  sizeOf: (value: T) => number | undefined,
): VariantLru<T> {
  const kept = new Map<string, { readonly value: T; readonly bytes: number }>();
  const flying = new Map<string, Promise<T>>();
  let total = 0;

  const keep = (key: string, value: T): void => {
    const bytes = sizeOf(value);
    if (bytes === undefined || bytes > maxBytes) return;
    kept.set(key, { value, bytes });
    total += bytes;
    // A Map iterates in insertion order, and a hit re-inserts: the first key is the coldest.
    for (const [cold, entry] of kept) {
      if (total <= maxBytes) break;
      kept.delete(cold);
      total -= entry.bytes;
    }
  };

  return {
    get(key, make) {
      const hit = kept.get(key);
      if (hit !== undefined) {
        kept.delete(key);
        kept.set(key, hit);
        return Promise.resolve(hit.value);
      }
      const pending = flying.get(key);
      if (pending !== undefined) return pending;
      const made = make()
        .then((value) => {
          keep(key, value);
          return value;
        })
        .finally(() => flying.delete(key));
      flying.set(key, made);
      return made;
    },
  };
}

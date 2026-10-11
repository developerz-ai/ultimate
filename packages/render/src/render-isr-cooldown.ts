/**
 * A short memory of the keys whose last render FAILED (a 5xx). `isr` never stores a failure, so
 * without this every request for a page whose read is down is its own render: a crawler walking
 * the route while the database is unreachable is one failing query per request, back to back.
 * For the cooldown the same answer is repeated instead. Bounded, oldest out first.
 */

/** How long one failed render answers for. Short: it bounds retries, it is not a cache. */
export const DEFAULT_ISR_FAILURE_COOLDOWN_MS = 1_000;

const MAX_REMEMBERED = 1_000;

export interface FailureCooldown<T> {
  /** The failure still answering for `key`, or `undefined` once its cooldown has passed. */
  get(key: string): T | undefined;
  remember(key: string, failure: T): void;
  clear(key: string): void;
}

export function failureCooldown<T>(cooldownMs: number, now: () => number): FailureCooldown<T> {
  const held = new Map<string, { readonly until: number; readonly failure: T }>();
  return {
    get(key) {
      const kept = held.get(key);
      if (kept === undefined) return undefined;
      if (now() < kept.until) return kept.failure;
      held.delete(key);
      return undefined;
    },
    remember(key, failure) {
      if (cooldownMs <= 0) return;
      held.delete(key);
      held.set(key, { until: now() + cooldownMs, failure });
      while (held.size > MAX_REMEMBERED) {
        const oldest = held.keys().next();
        if (oldest.done === true) break;
        held.delete(oldest.value);
      }
    },
    clear: (key) => {
      held.delete(key);
    },
  };
}

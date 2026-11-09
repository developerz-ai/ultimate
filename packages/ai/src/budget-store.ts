// Single responsibility: where cross-request budget counters live — the `BudgetStore` contract
// (an atomic `take`), the per-process `memoryBudgetStore()`, and the guard a store's answer passes.
// Split from ./budget (the ledger) at its line ceiling.

/**
 * What one `take` found. `spent` is the counter as the store read it, BEFORE this take — so a
 * refusal can say how much was left.
 */
export interface BudgetTake {
  readonly taken: boolean;
  readonly spent: number;
}

/** Where cross-request counters live. Swap for Redis in a multi-process deployment. */
export interface BudgetStore {
  spent(key: string): Promise<number> | number;
  /** `tokens` may be NEGATIVE: releasing a reservation the call never spent is a credit. */
  add(key: string, tokens: number): Promise<void> | void;
  /**
   * Add `tokens` to `key` only if the total stays at or under `limit`, in ONE atomic step — a
   * Redis `EVAL`, a SQL `update … set spent = spent + $2 where key = $1 and spent + $2 <= $3`.
   * Required, with no default built on `spent` + `add`: that pair is the read-then-write two
   * concurrent requests both pass, which is the overspend this member exists to close.
   */
  take(key: string, tokens: number, limit: number): Promise<BudgetTake> | BudgetTake;
  reset(key?: string): Promise<void> | void;
}

/**
 * The per-process default. There is NO window: a counter lives until `reset()` or a restart, so an
 * `actor` / `org` ceiling here is "per process lifetime". It holds one entry per caller that has
 * spent under a DECLARED ceiling (none at all without one), and deliberately no eviction: dropping
 * a counter hands that caller its whole ceiling back, which is the bypass the ceiling exists to
 * stop. A window — per day, per month — is a shared store whose keys expire.
 */
export class MemoryBudgetStore implements BudgetStore {
  private readonly counters = new Map<string, number>();

  spent(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  /** A counter back at zero is deleted: absent and zero are the same answer, and an entry costs. */
  add(key: string, tokens: number): void {
    this.write(key, this.spent(key) + tokens);
  }

  /** Atomic because it is synchronous: nothing else runs between the read and the write. */
  take(key: string, tokens: number, limit: number): BudgetTake {
    const spent = this.spent(key);
    if (spent + tokens > limit) return { taken: false, spent };
    this.write(key, spent + tokens);
    return { taken: true, spent };
  }

  /** How many counters are held — one per caller that has spent under a declared ceiling. */
  size(): number {
    return this.counters.size;
  }

  private write(key: string, total: number): void {
    if (total === 0) this.counters.delete(key);
    else this.counters.set(key, total);
  }

  reset(key?: string): void {
    if (key === undefined) this.counters.clear();
    else this.counters.delete(key);
  }
}

/** The one way to build the per-process store; the class is a type in the barrel only. */
export function memoryBudgetStore(): MemoryBudgetStore {
  return new MemoryBudgetStore();
}

/** A store's `take` answer is app code's: read, never trusted. */
export function isBudgetTake(value: unknown): value is BudgetTake {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['taken'] === 'boolean' && Number.isFinite(record['spent']);
}

// Single responsibility: the mutual-exclusion contract behind "exactly one replicator per database",
// and its single-process implementation. The Postgres one is `pg-advisory-lock.ts`.

/** Session-scoped mutual exclusion. Postgres-backed in production, in-memory for `x dev`. */
export interface AdvisoryLock {
  readonly key: string;
  /** `false` means another process holds it — never block, never steal. */
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
  /**
   * Let go WITHOUT asking: drop the session, synchronously, and wait for nothing. Closing the
   * session releases the lock, so this is the release for a session that may be dead — an unlock
   * statement on one is a wait nothing ends. Never calls `onLost`. A no-op when nothing is held.
   */
  abandon(): void;
  /**
   * Told when a lock this object HELD is gone without `release()` — its session died. Never for a
   * release, never for a `tryAcquire` that answered `false`. Returns the unsubscribe. The holder
   * must stop doing what the lock allowed: the database will give it to the next process that asks.
   */
  onLost(listener: (reason: string) => void): () => void;
}

/** Single-process default: correct for `x dev` and tests, useless across containers (by design). */
export class InMemoryAdvisoryLock implements AdvisoryLock {
  static readonly #held = new Set<string>();
  readonly key: string;
  #mine = false;

  constructor(key: string) {
    this.key = key;
  }

  async tryAcquire(): Promise<boolean> {
    if (InMemoryAdvisoryLock.#held.has(this.key)) return false;
    InMemoryAdvisoryLock.#held.add(this.key);
    this.#mine = true;
    return true;
  }

  async release(): Promise<void> {
    if (!this.#mine) return;
    InMemoryAdvisoryLock.#held.delete(this.key);
    this.#mine = false;
  }

  abandon(): void {
    if (!this.#mine) return;
    InMemoryAdvisoryLock.#held.delete(this.key);
    this.#mine = false;
  }

  /** A set in this process's own heap has no session to lose: the listener is never called. */
  onLost(): () => void {
    return () => undefined;
  }
}

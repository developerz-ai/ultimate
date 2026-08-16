// The bounded per-query change window that makes reconnect a delta instead of a refetch. Inside
// the window a reconnecting client costs zero DB work; outside it, `resumeFrom` takes one bounded
// snapshot — never WAL traversal.
//
// **It is per `sync` node, and a `qid` window can only be.** The header used to say it lives on the
// replicator; it does not, and it could not — a patch is query-scoped, so producing one needs that
// query's compiled shape, its matcher and its current window, none of which the replicator has (it
// is entity-scoped by construction). The consequence is real and is not fixed here: a client that
// reconnects onto a node that never served its `qid` finds no ring, `shouldResnapshot` answers
// `out-of-window`, and it takes the snapshot path. What that costs is one *shared* read per
// (query, node) — `fillWindow` joins every subscriber arriving during a read into it — and not one
// read per client. Making the delta path work across nodes means an **entity**-keyed window every
// node fills from the change stream it already subscribes to, which is a `ResumeSource` shape
// change, not a placement change.

import type { ResumeSource } from './cursor';
import type { RowPatch } from './json';

export interface ChangeBufferOptions {
  /** Retained patches per query hash. */
  readonly capacity?: number;
  /** Retained query hashes; the least-recently-written is dropped first. */
  readonly maxQueries?: number;
}

interface Ring {
  patches: RowPatch[];
  /** Highest lsn already dropped. A cursor at or after this is still resumable. */
  evictedThrough: string | null;
}

export class RingChangeBuffer implements ResumeSource {
  readonly #rings = new Map<string, Ring>();
  readonly #capacity: number;
  readonly #maxQueries: number;

  constructor(options: ChangeBufferOptions = {}) {
    this.#capacity = options.capacity ?? 1024;
    this.#maxQueries = options.maxQueries ?? 4096;
  }

  append(qid: string, patch: RowPatch): void {
    const existing = this.#rings.get(qid);
    const ring: Ring = existing ?? { patches: [], evictedThrough: null };
    ring.patches.push(patch);
    while (ring.patches.length > this.#capacity) {
      const dropped = ring.patches.shift();
      if (dropped) ring.evictedThrough = dropped.lsn;
    }
    // Re-insert to move this qid to the tail of the LRU order.
    if (existing) this.#rings.delete(qid);
    this.#rings.set(qid, ring);
    if (this.#rings.size > this.#maxQueries) {
      const oldest = this.#rings.keys().next();
      if (!oldest.done) this.#rings.delete(oldest.value);
    }
  }

  since(qid: string, lsn: string): RowPatch[] | null {
    const ring = this.#rings.get(qid);
    if (!ring) return null;
    if (ring.evictedThrough !== null && lsn < ring.evictedThrough) return null;
    return ring.patches.filter((patch) => patch.lsn > lsn);
  }

  headLsn(qid: string): string | null {
    const ring = this.#rings.get(qid);
    const last = ring?.patches.at(-1);
    return last ? last.lsn : null;
  }

  /** Called when the last subscriber of a query goes away, so an idle query stops costing memory. */
  forget(qid: string): void {
    this.#rings.delete(qid);
  }

  get queryCount(): number {
    return this.#rings.size;
  }
}

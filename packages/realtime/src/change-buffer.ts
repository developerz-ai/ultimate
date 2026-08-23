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
  /** Retained patches per query hash — a REPLAY bound: what a delta resume may cost to fold. */
  readonly capacity?: number;
  /** Retained query hashes; the least-recently-written is dropped first. */
  readonly maxQueries?: number;
  /** Retained bytes per query hash. The memory bound, and the one that actually holds. */
  readonly maxBytesPerQuery?: number;
  /** Retained bytes across every query on this node. */
  readonly maxBytes?: number;
}

/**
 * The node's retained-patch memory ceiling. `packages/cache/src/lru.ts:1-2` states the rule this
 * exists to obey: bounded by BYTES, never by entry count — 4,096 queries x 1,024 patches is 4.19M
 * retained `RowPatch` objects, each holding a whole row, and nothing in that product is memory.
 */
export const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_BUFFER_BYTES_PER_QUERY = 1024 * 1024;

interface Ring {
  patches: RowPatch[];
  bytes: number;
  /** Highest lsn already dropped. A cursor at or after this is still resumable. */
  evictedThrough: string | null;
}

const encoder = new TextEncoder();

/** What one retained patch costs. Its serialised size: the row is the whole of it. */
function patchBytes(patch: RowPatch): number {
  return encoder.encode(JSON.stringify(patch)).length;
}

export class RingChangeBuffer implements ResumeSource {
  readonly #rings = new Map<string, Ring>();
  /**
   * Query hashes whose ring was dropped, so the ring the NEXT change builds knows it does not
   * carry the history before it. A `Set` of ids and not a `Map` of lsns: what the next ring is
   * complete from is its own first patch, which only that patch can name.
   */
  readonly #forgotten = new Set<string>();
  readonly #capacity: number;
  readonly #maxQueries: number;
  readonly #maxBytesPerQuery: number;
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(options: ChangeBufferOptions = {}) {
    this.#capacity = options.capacity ?? 1024;
    this.#maxQueries = options.maxQueries ?? 4096;
    this.#maxBytesPerQuery = options.maxBytesPerQuery ?? DEFAULT_MAX_BUFFER_BYTES_PER_QUERY;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  }

  /** Retained bytes across every query on this node. The number the ceiling is about. */
  get bytes(): number {
    return this.#bytes;
  }

  append(qid: string, patch: RowPatch): void {
    const existing = this.#rings.get(qid);
    // A ring RE-CREATED after a `forget` is complete only from this patch onward: everything before
    // it went with the ring, and — on the `unsubscribe` path — the entry went too, so the changes
    // in between were never appended at all. `evictedThrough` at its own first lsn is what makes
    // `since` refuse a cursor from before that, which it could not do while the field came back
    // `null` and every earlier cursor read as in-window on a ring that had held none of it.
    const reborn = this.#forgotten.delete(qid);
    const ring: Ring = existing ?? {
      patches: [],
      bytes: 0,
      evictedThrough: reborn ? patch.lsn : null,
    };
    ring.patches.push(patch);
    const cost = patchBytes(patch);
    ring.bytes += cost;
    this.#bytes += cost;
    // Two ceilings, because they bound two different things: the count bounds what a resume has
    // to fold, the bytes bound what this process holds. Whichever bites first, bites.
    while (ring.patches.length > this.#capacity || ring.bytes > this.#maxBytesPerQuery) {
      if (!this.#shift(ring)) break;
    }
    // Re-insert to move this qid to the tail of the LRU order.
    if (existing) this.#rings.delete(qid);
    this.#rings.set(qid, ring);
    while (this.#rings.size > this.#maxQueries || this.#bytes > this.#maxBytes) {
      const oldest = this.#rings.keys().next();
      // The only ring left is the one just written: evicting it would make a node under memory
      // pressure retain nothing at all, and every reconnect a snapshot.
      if (oldest.done || this.#rings.size === 1) break;
      this.forget(oldest.value);
    }
  }

  /** Drop the oldest patch of a ring, keeping both byte counters honest. Answers what it did. */
  #shift(ring: Ring): boolean {
    const dropped = ring.patches.shift();
    if (!dropped) return false;
    const cost = patchBytes(dropped);
    ring.bytes -= cost;
    this.#bytes -= cost;
    ring.evictedThrough = dropped.lsn;
    return true;
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

  /**
   * Called when the last subscriber of a query goes away, so an idle query stops costing memory.
   * It had no caller until `LiveQueryRegistry.unsubscribe` gained one: the entry was dropped and
   * the ring behind it kept every patch it held until the LRU happened to reach it.
   */
  forget(qid: string): void {
    const ring = this.#rings.get(qid);
    if (ring !== undefined) {
      this.#bytes -= ring.bytes;
      this.#rings.delete(qid);
    }
    // The qid is remembered, the patches are not — and unconditionally, because the ring being
    // absent is not the history being intact. Both callers lose history here and neither could say
    // so: `LiveQueryRegistry.unsubscribe` drops the ENTRY, so every change until the next
    // subscriber is never appended at all, and the LRU fires on a query that still has LIVE
    // subscribers. Either way the next `append` was building a ring that reported itself complete
    // from the beginning of time, so a client reconnecting inside `maxLagMs` folded a partial patch
    // list onto a stale window with `shouldResnapshot` answering `in-window` and nothing marked
    // desynced — permanently divergent on a healthy socket. What the tombstone costs in exchange is
    // a resume that could have been a delta taking the snapshot path; that is one bounded read, and
    // it is the direction this package errs in everywhere else.
    this.#forgotten.add(qid);
    // Bounded like everything else here: insertion-ordered, so the oldest tombstone goes first.
    // Losing one costs a resume that could have been a delta; keeping them unbounded costs memory
    // a client-chosen input mints at will.
    while (this.#forgotten.size > this.#maxQueries) {
      const oldest = this.#forgotten.values().next();
      if (oldest.done === true) break;
      this.#forgotten.delete(oldest.value);
    }
  }

  get queryCount(): number {
    return this.#rings.size;
  }
}

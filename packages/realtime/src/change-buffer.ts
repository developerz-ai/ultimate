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

import { finiteOption } from '@ultimat3/core';
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

/**
 * THE FLOOR RULE, stated once. A ring answers a resume only for a cursor it can PROVE it holds
 * every later change for; anything else is `null`, and the caller takes one bounded snapshot.
 *
 * | The floor is set by | to | a cursor AT the floor |
 * |---|---|---|
 * | the ring's first patch (no read floored it) | that patch's lsn | resumes — it has that patch |
 * | an eviction | the evicted patch's lsn | resumes — everything after it is retained |
 * | a window's FIRST read, on a node that holds a position | the read's lsn | resumes — the cursor may be that read's own |
 * | a window's FIRST read with NO position behind it (`sole`) | the read's own mark | resumes, and it is the ONLY cursor below the first patch that does |
 * | a FORCED re-read (the window missed a change), a truncate, a partial row | the read's lsn, EXCLUSIVE | is refused |
 *
 * Why `sole`: a node that has received no change holds no position, so its read is marked with
 * the node's own origin (`LiveQueryRegistry`), which sorts below every real lsn. A plain floor
 * there admits every foreign cursor — each is "above" it — for a history this node never held. So
 * the ring answers that one mark, and otherwise only a cursor at or after its FIRST patch.
 *
 * Why the last row is exclusive: a re-read's lsn is the node's last SEEN position, which does not
 * move for the changes it missed — so "the window at L before the gap" and "the window re-read at
 * L with the missed rows in it" carry the same cursor, and only refusing L tells them apart.
 *
 * What never moves the floor: a read served out of a window that is already filled. The retained
 * patches are still its true history, and flooring it evicts every other subscriber's resume.
 */
interface Ring {
  patches: RowPatch[];
  bytes: number;
  /** The lsn this ring is complete from. Set at birth and only ever raised. */
  evictedThrough: string;
  /** Whether a cursor exactly AT the floor is refused — see the rule above. */
  exclusive: boolean;
  /** The one cursor a position-less birth vouches for, until an eviction or a re-read ends it. */
  sole: string | null;
  /** The first patch appended after a `sole` birth: where foreign cursors become answerable. */
  anchor: string | null;
}

const encoder = new TextEncoder();

/** What one retained patch costs. Its serialised size: the row is the whole of it. */
function patchBytes(patch: RowPatch): number {
  return encoder.encode(JSON.stringify(patch)).length;
}

export class RingChangeBuffer implements ResumeSource {
  readonly #rings = new Map<string, Ring>();
  readonly #capacity: number;
  readonly #maxQueries: number;
  readonly #maxBytesPerQuery: number;
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(options: ChangeBufferOptions = {}) {
    this.#capacity = finiteOption('ChangeBuffer', 'capacity', options.capacity ?? 1024);
    this.#maxQueries = finiteOption('ChangeBuffer', 'maxQueries', options.maxQueries ?? 4096);
    this.#maxBytesPerQuery = finiteOption(
      'ChangeBuffer',
      'maxBytesPerQuery',
      options.maxBytesPerQuery ?? DEFAULT_MAX_BUFFER_BYTES_PER_QUERY,
    );
    this.#maxBytes = finiteOption(
      'ChangeBuffer',
      'maxBytes',
      options.maxBytes ?? DEFAULT_MAX_BUFFER_BYTES,
    );
  }

  /** Retained bytes across every query on this node. The number the ceiling is about. */
  get bytes(): number {
    return this.#bytes;
  }

  append(qid: string, patch: RowPatch): void {
    const existing = this.#rings.get(qid);
    // A ring is complete only from where it was born. Born HERE, from a patch, that is the patch
    // itself: this node held no entry for whatever came before, so nothing before it was ever
    // appended. It used to be born with no floor at all, and a cursor minted on another node —
    // the rolling-deploy shape — read as in-window on a ring that had held none of its history.
    // `floorAt` is the earlier, cheaper birth: the lsn the window was read at.
    const ring: Ring = existing ?? {
      patches: [],
      bytes: 0,
      evictedThrough: patch.lsn,
      exclusive: false,
      sole: null,
      anchor: null,
    };
    if (ring.sole !== null && ring.anchor === null) ring.anchor = patch.lsn;
    ring.patches.push(patch);
    const cost = patchBytes(patch);
    ring.bytes += cost;
    this.#bytes += cost;
    // Two ceilings, because they bound two different things: the count bounds what a resume has
    // to fold, the bytes bound what this process holds. Whichever bites first, bites.
    while (ring.patches.length > this.#capacity || ring.bytes > this.#maxBytesPerQuery) {
      if (!this.#shift(ring)) break;
    }
    this.#touch(qid, ring);
  }

  /**
   * The window behind `qid` was read at `lsn`: the ring is complete from there, and from nowhere
   * earlier. The caller decides WHEN (a read that landed, never one served from a filled window)
   * and whether the floor is `exclusive` (a forced re-read) — the rule is on `Ring`.
   *
   * Only ever raises the floor, or tightens it at the same lsn. `''` is no position and says nothing.
   */
  floorAt(
    qid: string,
    lsn: string,
    options: { readonly exclusive?: boolean; readonly sole?: boolean } = {},
  ): void {
    if (lsn === '') return;
    const exclusive = options.exclusive === true;
    const existing = this.#rings.get(qid);
    const ring: Ring = existing ?? {
      patches: [],
      bytes: 0,
      evictedThrough: lsn,
      exclusive,
      sole: options.sole === true ? lsn : null,
      anchor: null,
    };
    if (lsn > ring.evictedThrough || (lsn === ring.evictedThrough && exclusive)) {
      // Superseded, not evicted: what the read replaced is history with a gap in it.
      for (let first = ring.patches[0]; first !== undefined && first.lsn <= lsn; ) {
        this.#shift(ring);
        first = ring.patches[0];
      }
      ring.evictedThrough = lsn;
      ring.exclusive = exclusive;
      ring.sole = null;
    }
    this.#touch(qid, ring);
  }

  /** Move `qid` to the tail of the LRU order, then hold both node-wide ceilings. */
  #touch(qid: string, ring: Ring): void {
    this.#rings.delete(qid);
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
    ring.exclusive = false;
    ring.sole = null;
    return true;
  }

  since(qid: string, lsn: string): RowPatch[] | null {
    const ring = this.#rings.get(qid);
    if (!ring) return null;
    if (lsn < ring.evictedThrough) return null;
    if (ring.exclusive && lsn === ring.evictedThrough) return null;
    if (ring.sole !== null && lsn !== ring.sole && (ring.anchor === null || lsn < ring.anchor)) {
      return null;
    }
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
    if (ring === undefined) return;
    this.#bytes -= ring.bytes;
    this.#rings.delete(qid);
    // Nothing is remembered about it: the next ring for this qid is born with its own floor, so
    // it cannot claim the history that went with this one.
  }

  get queryCount(): number {
    return this.#rings.size;
  }
}

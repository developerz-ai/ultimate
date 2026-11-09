// The registry's windows, indexed by the relations each one reads. One owner for both, so an entry
// added or forgotten can never be in the table and missing from the index (or the reverse): a
// change then reaches only the windows that read its table, never every window on the node.

import type { QueryEntry } from './query-window';

export class LiveEntries {
  readonly #byQid = new Map<string, QueryEntry>();
  /** `shape.entities` → the entries reading it. A shape is fixed at birth, so this never moves. */
  readonly #byTable = new Map<string, Set<QueryEntry>>();

  get size(): number {
    return this.#byQid.size;
  }

  get(qid: string): QueryEntry | undefined {
    return this.#byQid.get(qid);
  }

  values(): IterableIterator<QueryEntry> {
    return this.#byQid.values();
  }

  add(entry: QueryEntry): void {
    this.delete(entry.qid);
    this.#byQid.set(entry.qid, entry);
    for (const table of entry.shape.entities) {
      let readers = this.#byTable.get(table);
      if (readers === undefined) {
        readers = new Set();
        this.#byTable.set(table, readers);
      }
      readers.add(entry);
    }
  }

  delete(qid: string): void {
    const entry = this.#byQid.get(qid);
    if (entry === undefined) return;
    this.#byQid.delete(qid);
    for (const table of entry.shape.entities) {
      const readers = this.#byTable.get(table);
      if (readers === undefined) continue;
      readers.delete(entry);
      // An emptied bucket goes too: a client-chosen table name must not outlive its windows.
      if (readers.size === 0) this.#byTable.delete(table);
    }
  }

  /** The windows that read `table` — `invalidate(entity)`'s set, and a change's first. */
  readersOf(table: string): ReadonlySet<QueryEntry> {
    return this.#byTable.get(table) ?? EMPTY;
  }

  /**
   * Every window one change is work for: its table's readers, plus every window that owes a
   * read whatever it reads — a `stale` one is repaired by the next change to reach it, and one no
   * read has landed in yet marks itself stale so its in-flight read is followed by a fresh one
   * (`live-fanout.ts`). Those two are a boolean pair per entry, read without a lane; the expensive
   * part — a lane entered, a closure queued, a fanout awaited — is paid by these entries only.
   * Measured: 10k windows on other tables, 34.6 ms → 0.23 ms per change (29 → 4,430/s).
   */
  targets(table: string): QueryEntry[] {
    const readers = this.readersOf(table);
    const out = [...readers];
    for (const entry of this.#byQid.values()) {
      if ((entry.stale || entry.applied === 0) && !readers.has(entry)) out.push(entry);
    }
    return out;
  }
}

const EMPTY: ReadonlySet<QueryEntry> = new Set();

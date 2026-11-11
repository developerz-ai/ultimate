// The registry's windows: born under the node's ceiling, indexed by the relations each one reads,
// dropped with their retained patches. One owner for all three, so an entry added or forgotten can
// never be in the table and missing from the index (or the reverse), and a change reaches only the
// windows that read its table, never every window on the node.

import { finiteOption } from '@ultimat3/core';
import { SubscriptionLimitError } from './errors';
import type { JsonValue } from './json';
import type { LiveQueryDefinition, PreparedWindow } from './live-contract';
import { DEFAULT_MAX_ENTRIES, type LiveQueryRegistryOptions } from './live-query-options';
import { type QueryEntry, queryEntry } from './query-window';

/** What the entry table reads off the registry's options. */
export type LiveEntriesOptions = Pick<
  LiveQueryRegistryOptions,
  'source' | 'maxEntries' | 'readDeadlineMs' | 'schedule'
>;

export class LiveEntries {
  readonly #byQid = new Map<string, QueryEntry>();
  /** `shape.entities` → the entries reading it. A shape is fixed at birth, so this never moves. */
  readonly #byTable = new Map<string, Set<QueryEntry>>();
  readonly #options: LiveEntriesOptions;
  readonly #maxEntries: number;

  constructor(options: LiveEntriesOptions) {
    this.#options = options;
    this.#maxEntries = finiteOption(
      'the live-query registry',
      'maxEntries',
      options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    );
  }

  /**
   * The entry for `qid`, born now if none holds it — from `prepare`'s answer when there is one,
   * never a second lookup by input (`QueryEntry`'s `prepared`).
   */
  seat(
    qid: string,
    definition: LiveQueryDefinition,
    input: JsonValue,
    tenant: string | null,
    prepared: PreparedWindow | undefined,
  ): QueryEntry {
    const existing = this.#byQid.get(qid);
    if (existing) return existing;
    // The node-wide ceiling, refused where the entry would be born. `qid` derives from
    // client-chosen input, so one socket varying it mints a matcher, a row window and a
    // `WindowLock` per value, and every change then fans out over all of them.
    if (this.#byQid.size >= this.#maxEntries) {
      throw new SubscriptionLimitError({
        scope: 'node',
        id: definition.name,
        limit: this.#maxEntries,
        knob: 'maxEntries',
      });
    }
    const matcher = prepared?.matcher ?? definition.matcher(input);
    const created = queryEntry(qid, definition, input, matcher, {
      readDeadlineMs: this.#options.readDeadlineMs,
      schedule: this.#options.schedule,
      tenant,
      prepared,
    });
    this.add(created);
    return created;
  }

  /**
   * An entry with no subscribers left, gone with its retained patches. `forget` had no caller once:
   * the entry was dropped and the `ResumeSource` never told, so its ring sat at full capacity until
   * the LRU happened to evict it — a client-chosen input's memory outliving the last subscriber.
   */
  release(qid: string): void {
    this.delete(qid);
    this.#options.source.forget?.(qid);
  }

  /**
   * An entry nothing is holding, released — for the case where a subscriber never arrived. Five
   * cold failures against `maxEntries: 5` used to refuse every later subscribe on the node with
   * `X_SUBSCRIPTION_LIMIT`, forever, after the database recovered.
   */
  dropIfUnheld(qid: string, entry: QueryEntry): void {
    // Identity, never presence: an entry this subscribe did not create may already have been
    // dropped and re-created under the same qid.
    if (this.#byQid.get(qid) !== entry) return;
    if (entry.subscribers.size !== 0) return;
    // A read published on the entry belongs to a subscriber that has not attached yet — it owns
    // the entry's fate, and dropping it here would leave that subscriber holding a window no
    // change is ever fanned out to.
    if (entry.reading !== null) return;
    this.release(qid);
  }

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
   * Every window one change is work for: its table's readers, plus every `stale` one whatever it
   * reads — the next change to reach it repairs it. A window no read has landed in yet is work
   * only as a reader (`live-fanout.ts` stales it so its in-flight read is followed by a fresh
   * one): a change to a table it does not read is no hole in that read. `stale` is a boolean per
   * entry, read without a lane; the expensive part — a lane entered, a closure queued, a fanout
   * awaited — is paid by these entries only.
   * Measured: 10k windows on other tables, 34.6 ms → 0.23 ms per change (29 → 4,430/s).
   */
  targets(table: string): QueryEntry[] {
    const readers = this.readersOf(table);
    const out = [...readers];
    for (const entry of this.#byQid.values()) {
      if (entry.stale && !readers.has(entry)) out.push(entry);
    }
    return out;
  }
}

const EMPTY: ReadonlySet<QueryEntry> = new Set();

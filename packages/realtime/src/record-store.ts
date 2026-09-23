// The page's ONE record store — Ember Data's shape: one record per `type:key`, shown in N places,
// updated once. Two layers: SYNCED is server truth (HTTP envelopes, socket frames), and the
// OVERLAY is every pending optimistic write, replayed over synced truth on every change. It is
// core's `RecordSink`, so `clientTransport` adopts into it without importing this package.

import type { ConflictPolicy, RecordRows, RecordSink, Row } from '@ultimat3/core/page';
import { resolveConflict } from '@ultimat3/core/page';
import { RebaseConflictError, RecordRejectedError } from './page-errors';
import { ServerWait } from './record-await';
import { isRow, type RecordKey, recordKey } from './record-key';
import { WriteNames } from './record-names';
import { SyncedLayer } from './record-synced';
import { type OverlayEntry, replayOverlays, sameRow } from './record-tx';
import type { Scheduler } from './thundering-herd';

// The store's own names for a record, kept importable from here: every caller names a record
// through the store it reads.
export { DEFAULT_AWAIT_SERVER_MS } from './record-await';
export { carriedBy, type RecordKey, recordKey } from './record-key';

export type RecordListener = (changed: ReadonlySet<RecordKey>) => void;

export interface RecordStoreOptions {
  /** Where a rejected row is reported. Browser code: `console.error`, never core's `logger`. */
  readonly report?: (error: unknown) => void;
  /** How an overlay's wait for server truth is bounded. Defaults to `setTimeout`; tests inject. */
  readonly schedule?: Scheduler;
  /** How long an overlay waits for the server's row before the synced layer stands. */
  readonly awaitMs?: number;
}

export class RecordStore implements RecordSink {
  readonly #synced = new SyncedLayer();
  /** The overlay's answer per key: a row, or `null` for a record the overlay deleted. */
  #view = new Map<RecordKey, Row | null>();
  readonly #overlays = new Map<string, OverlayEntry>();
  /** Which keys each pending overlay wrote on its last replay — what a settle resolves over. */
  #touched = new Map<string, ReadonlySet<RecordKey>>();
  readonly #listeners = new Set<RecordListener>();
  readonly #report: (error: unknown) => void;
  #changed: Set<RecordKey> | null = null;
  #syncedMoved = false;
  /** Synced keys moved in the open batch — what an overlay awaiting server truth is checked against. */
  readonly #moved = new Set<RecordKey>();
  readonly #wait: ServerWait;
  /** Which pending overlay each write digest names — what a frame's `write` is looked up in. */
  readonly #names = new WriteNames();

  constructor(options: RecordStoreOptions = {}) {
    this.#report = options.report ?? ((error) => console.error(error));
    this.#wait = new ServerWait(options.schedule, options.awaitMs);
  }

  /** The record as every holder sees it: the overlay's answer over synced truth. */
  peek(type: string, key: string): Row | undefined {
    const rk = recordKey(type, key);
    const overlaid = this.#view.get(rk);
    if (overlaid !== undefined) return overlaid ?? undefined;
    return this.#synced.get(rk);
  }

  /** Every record of one type, as seen — what a mutator's `tx.<type>.all()` walks. */
  all(type: string): readonly Row[] {
    const prefix = `${type}:`;
    const out: Row[] = [];
    const seen = new Set<RecordKey>();
    for (const [rk, row] of this.#view) {
      if (!rk.startsWith(prefix)) continue;
      seen.add(rk);
      if (row !== null) out.push(row);
    }
    for (const [rk, row] of this.#synced.entries()) {
      if (rk.startsWith(prefix) && !seen.has(rk)) out.push(row);
    }
    return out;
  }

  /**
   * `RecordSink.adopt`: server truth, keyed by the server (it holds the entity's primary key; the
   * browser does not). Merged column by column. A structurally bad row is dropped, never merged.
   */
  adopt(type: string, rows: RecordRows): void {
    this.batch(() => {
      for (const [key, row] of Object.entries(rows)) {
        if (!isRow(row) || key === '') {
          this.#report(
            new RecordRejectedError({
              type,
              reason: key === '' ? 'it arrived under an empty key' : 'it is not an object',
            }),
          );
          continue;
        }
        this.merge(type, key, row);
      }
    });
  }

  /** `RecordSink.remove`: the server says these records are gone, for every holder at once. */
  remove(type: string, keys: readonly string[]): void {
    this.batch(() => {
      for (const key of keys) {
        const rk = recordKey(type, key);
        if (this.#synced.remove(rk)) this.#touchSynced(rk);
      }
    });
  }

  /** The server's row alone — no overlay, no notification. What the persister writes to disk. */
  synced(type: string, key: string): Row | undefined {
    return this.#synced.get(recordKey(type, key));
  }

  /**
   * Rows put back from disk before the socket connects. Inserted only where the server has not
   * already answered, and PROVISIONAL: stale until confirmed, so the first server row for that key
   * replaces it outright rather than merging a column the server has since dropped.
   */
  restore(type: string, rows: RecordRows): void {
    this.batch(() => {
      for (const [key, row] of Object.entries(rows)) {
        const rk = recordKey(type, key);
        if (!isRow(row) || key === '') continue;
        if (this.#synced.restore(rk, row)) this.#touchSynced(rk);
      }
    });
  }

  /** One server write, merged column by column (`SyncedLayer.merge`). */
  merge(type: string, key: string, columns: Row): Row {
    const rk = recordKey(type, key);
    const { row, changed } = this.#synced.merge(rk, columns);
    if (changed) {
      this.#touchSynced(rk);
    } else if (this.#overlays.size > 0) {
      // Unchanged is still an answer: an overlay awaiting server truth for this row — or still in
      // flight, and about to — gets it here.
      this.batch(() => {
        this.#moved.add(rk);
        this.#syncedMoved = true;
      });
    }
    return row;
  }

  retain(type: string, key: string): void {
    this.#synced.retain(recordKey(type, key));
  }

  /** The last holder leaving evicts the synced record: an infinite scroll must not keep every row. */
  release(type: string, key: string): void {
    const rk = recordKey(type, key);
    if (this.#synced.release(rk)) this.#touchSynced(rk);
  }

  /**
   * An optimistic write, visible to every holder before this returns. `apply` is the mutator's
   * pure `local` half: it is REPLAYED over synced truth whenever synced truth moves, which is what
   * makes two pending writes on one row land in order over a server update.
   */
  push(key: string, apply: OverlayEntry['apply'], policy: ConflictPolicy): void {
    this.batch(() => {
      this.#overlays.set(key, { key, apply, policy });
      this.#replay();
    });
    this.#names.name(key, (named) => this.#overlays.has(named));
  }

  /** Take the write back — the server refused it. Everything behind it replays without it. */
  drop(key: string): void {
    this.#wait.forget(key);
    this.batch(() => {
      if (this.#forget(key)) this.#replay();
    });
  }

  /**
   * The server took the write, and its records were adopted BEFORE this runs (the transport adopts
   * inside the call), so the overlay is dropped over truth that already carries it: no flicker.
   * A non-default policy decides each record the write touched, local view against server row.
   *
   * `carried` is the answer's own records. A row the write touched that the answer did NOT carry
   * (an action that returns a view, not the entity) has no server truth yet: dropping the overlay
   * would show the pre-write value until a frame arrives. So the overlay waits for that row's next
   * server write, bounded by `awaitMs`, after which the synced layer stands — unless the server
   * already reached it while the write was in flight.
   */
  settle(key: string, carried?: ReadonlySet<RecordKey>): void {
    const entry = this.#overlays.get(key);
    if (entry === undefined) return;
    this.batch(() => {
      const touched = this.#touched.get(key) ?? new Set<RecordKey>();
      if (entry.policy !== 'server-wins') {
        for (const rk of touched)
          if (carried === undefined || carried.has(rk)) this.#resolve(entry, rk);
      }
      const heard = this.#wait.takeHeard(key);
      const missing =
        carried === undefined
          ? []
          : [...touched].filter((rk) => !carried.has(rk) && heard?.has(rk) !== true);
      if (missing.length > 0) {
        // What the server did answer holds this write already: the twin stays on the rest only.
        const answered = [...touched].filter((rk) => !missing.includes(rk));
        if (answered.length > 0) {
          const confirmed = new Set([...(entry.confirmed ?? []), ...answered]);
          this.#overlays.set(key, { ...entry, confirmed });
          this.#replay();
        }
        this.#wait.start(key, new Set(missing), () => this.drop(key));
        return;
      }
      this.#forget(key);
      this.#replay();
    });
  }

  /**
   * A `records` frame's rows, merged in the OPEN batch, named the write `digest`. When that is a
   * write this page still holds, it is settled here against the rows the frame carried — in the
   * same notification as the merge, so no holder ever sees the write's own row with its twin
   * replayed over it (a like counted twice). A digest this page never pushed, or one already
   * settled, changes nothing: the rows are server truth under whatever is still pending.
   */
  settleWrite(digest: string, carried: ReadonlySet<RecordKey>): void {
    const key = this.#names.keyOf(digest);
    if (key === undefined || !this.#overlays.has(key)) return;
    this.batch(() => {
      // The view the settle resolves a custom policy against is the overlay over the NEW truth —
      // what an HTTP answer's settle sees too, because its adopt closed a batch first.
      if (this.#syncedMoved) this.#replay();
      this.settle(key, carried);
    });
  }

  /**
   * The write's answer was unreadable (a 2xx that is not JSON): it MAY have landed. Its overlay
   * stays on screen until server truth next reaches a row it wrote — then the server's row stands.
   * Dropping it now could flash the pre-write value over a write that did land.
   */
  awaitServer(key: string): void {
    if (!this.#overlays.has(key)) return;
    this.#wait.start(key, this.#touched.get(key) ?? new Set(), () => this.drop(key));
  }

  /** Pending optimistic writes, oldest first. */
  pending(): readonly string[] {
    return [...this.#overlays.keys()];
  }

  /** A principal change: nothing of the previous one survives in memory. */
  clear(): void {
    this.batch(() => {
      for (const rk of this.#synced.keys()) this.#touch(rk);
      for (const rk of this.#view.keys()) this.#touch(rk);
      this.#synced.clear();
      this.#overlays.clear();
      this.#names.clear();
      this.#wait.clear();
      this.#view = new Map();
      this.#touched = new Map();
    });
  }

  /** Every write inside `fn` is one notification — one frame, one response, one render. */
  batch<T>(fn: () => T): T {
    if (this.#changed !== null) return fn();
    const collected = new Set<RecordKey>();
    this.#changed = collected;
    try {
      return fn();
    } finally {
      // Synced truth moved under pending writes: replay them once, at the end, over the new truth.
      if (this.#syncedMoved) {
        this.#syncedMoved = false;
        // A row put back from disk is a guess, not the server reaching it.
        this.#wait.hear(
          [...this.#overlays.keys()].map((key) => [key, this.#touched.get(key) ?? new Set()]),
          (rk) => this.#moved.has(rk) && !this.#synced.isProvisional(rk),
        );
        const answered = this.#wait.resolve((key) => this.#overlays.has(key), this.#moved);
        for (const key of answered) this.#forget(key);
        if (this.#overlays.size > 0 || answered.length > 0) this.#replay();
      }
      this.#moved.clear();
      this.#changed = null;
      if (collected.size > 0) for (const listener of this.#listeners) listener(collected);
    }
  }

  subscribe(listener: RecordListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Synced records held. Tests assert on it; nothing branches on a count. */
  get size(): number {
    return this.#synced.size;
  }

  #resolve(entry: OverlayEntry, rk: RecordKey): void {
    const local = this.#view.get(rk);
    const server = this.#synced.get(rk);
    // A delete on either side leaves nothing to merge: the server's answer stands.
    if (local === undefined || local === null || server === undefined) return;
    const kept = resolveConflict(entry.policy, local, server);
    if (kept === server) return;
    if (!isRow(kept)) {
      throw new RebaseConflictError({
        key: entry.key,
        entity: rk.slice(0, rk.indexOf(':')),
        reason: 'the custom merge returned something other than a row',
      });
    }
    this.#synced.set(rk, kept);
    this.#touch(rk);
  }

  #replay(): void {
    const previous = this.#view;
    const result = replayOverlays(
      [...this.#overlays.values()],
      (rk) => this.#synced.get(rk),
      (type) => this.#synced.ofType(type),
      (error) => this.#report(error),
    );
    for (const failed of result.failed) {
      this.#forget(failed);
      this.#wait.unhear(failed);
    }
    const next = new Map<RecordKey, Row | null>();
    for (const [rk, row] of result.view) {
      const before = previous.get(rk);
      // Same content keeps the same object: a replay that changed nothing re-renders nothing.
      next.set(rk, before !== undefined && sameRow(before, row) ? before : row);
      if (before === undefined || !sameRow(before, row)) this.#touch(rk);
    }
    for (const rk of previous.keys()) if (!next.has(rk)) this.#touch(rk);
    this.#view = next;
    this.#touched = result.touched;
  }

  /** The one way an overlay leaves: its entry and the digest that named it go together. */
  #forget(key: string): boolean {
    this.#names.forget(key);
    return this.#overlays.delete(key);
  }

  #touchSynced(rk: RecordKey): void {
    this.#syncedMoved = true;
    this.#moved.add(rk);
    this.#touch(rk);
  }

  #touch(rk: RecordKey): void {
    if (this.#changed !== null) {
      this.#changed.add(rk);
      return;
    }
    this.batch(() => this.#changed?.add(rk));
  }
}

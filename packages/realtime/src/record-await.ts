// The overlays waiting on server truth: a write whose answer did not carry every row it touched
// keeps its overlay until the server next reaches one of those rows, bounded by a timer. Also what
// the server reached while a write was still in flight — the frame routinely beats the answer.

import { finiteCount } from '@ultimat3/core/page';
import type { RecordKey } from './record-key';
import type { Scheduler } from './thundering-herd';

/** An overlay whose answer did not carry every row it wrote waits this long for one, no longer. */
export const DEFAULT_AWAIT_SERVER_MS = 10_000;

export class ServerWait {
  /** Each waiting overlay: the rows it waits for, and the timer bounding the wait. */
  readonly #awaiting = new Map<string, { readonly rows: ReadonlySet<RecordKey>; cancel(): void }>();
  /**
   * Rows server truth reached while each overlay's write was still in flight. The node fans a
   * commit out before the response is written, so the frame routinely beats the answer — and a
   * settle that then waited for ANOTHER server write replayed the twin over a row that already
   * held it, counting the write twice until the bound.
   */
  readonly #heard = new Map<string, Set<RecordKey>>();
  readonly #schedule: Scheduler;
  readonly #ms: number;

  constructor(schedule: Scheduler | undefined, awaitMs: number | undefined) {
    // Inline rather than `thundering-herd`'s `timeoutScheduler`: that module carries the backoff,
    // and a `useRecord`-only island would pay for it to arm one timer.
    this.#schedule =
      schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      });
    this.#ms = finiteCount('RecordStore', 'awaitMs', awaitMs ?? DEFAULT_AWAIT_SERVER_MS, 1);
  }

  /** Wait for any of `rows`; `expire` runs if none is reached in time. */
  start(key: string, rows: ReadonlySet<RecordKey>, expire: () => void): void {
    this.#awaiting.get(key)?.cancel();
    const cancel = this.#schedule(() => {
      // Nothing answered in time: the caller drops the overlay and server truth stands.
      if (this.#awaiting.delete(key)) expire();
    }, this.#ms);
    this.#awaiting.set(key, { rows, cancel });
  }

  /** The overlay went some other way: its wait and what it heard go with it. */
  forget(key: string): void {
    this.#awaiting.get(key)?.cancel();
    this.#awaiting.delete(key);
    this.#heard.delete(key);
  }

  /** A replay dropped the overlay: what it heard goes; a wait ends when `resolve` sees it gone. */
  unhear(key: string): void {
    this.#heard.delete(key);
  }

  /** What the server reached while `key` was in flight — taken, so a second settle starts over. */
  takeHeard(key: string): ReadonlySet<RecordKey> | undefined {
    const heard = this.#heard.get(key);
    this.#heard.delete(key);
    return heard;
  }

  /** Note, per in-flight overlay (one not already waiting), which of its rows the server reached. */
  hear(
    inFlight: Iterable<[string, ReadonlySet<RecordKey>]>,
    reached: (rk: RecordKey) => boolean,
  ): void {
    for (const [key, touched] of inFlight) {
      if (this.#awaiting.has(key)) continue;
      const wrote = [...touched].filter(reached);
      if (wrote.length === 0) continue;
      const heard = this.#heard.get(key) ?? new Set<RecordKey>();
      for (const rk of wrote) heard.add(rk);
      this.#heard.set(key, heard);
    }
  }

  /**
   * The waits the server just answered — or whose overlay is already gone — ended. Answers the
   * keys whose overlay the caller must now drop because server truth reached it.
   */
  resolve(pending: (key: string) => boolean, moved: ReadonlySet<RecordKey>): readonly string[] {
    const answered: string[] = [];
    for (const [key, waiting] of [...this.#awaiting]) {
      const gone = !pending(key);
      if (!gone && ![...waiting.rows].some((rk) => moved.has(rk))) continue;
      waiting.cancel();
      this.#awaiting.delete(key);
      if (!gone) answered.push(key);
    }
    return answered;
  }

  clear(): void {
    for (const waiting of this.#awaiting.values()) waiting.cancel();
    this.#awaiting.clear();
    this.#heard.clear();
  }
}

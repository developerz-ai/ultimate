// The store's SYNCED layer: server truth per `type:key`, merged column by column, with the holds
// that evict a record nobody renders and the provisional mark on rows restored from disk. Pure
// state — it answers what moved, and the store decides who hears about it.

import type { Row } from '@ultimat3/core/page';
import type { RecordKey } from './record-key';

export class SyncedLayer {
  readonly #rows = new Map<RecordKey, Row>();
  readonly #holds = new Map<RecordKey, number>();
  /** Keys restored from disk and not yet confirmed: the first server row REPLACES, never merges. */
  readonly #provisional = new Set<RecordKey>();

  get(rk: RecordKey): Row | undefined {
    return this.#rows.get(rk);
  }

  get size(): number {
    return this.#rows.size;
  }

  keys(): IterableIterator<RecordKey> {
    return this.#rows.keys();
  }

  entries(): IterableIterator<[RecordKey, Row]> {
    return this.#rows.entries();
  }

  /** Every row of one type — what a replay's `tx.<type>.all()` reads under the overlay. */
  ofType(type: string): readonly [RecordKey, Row][] {
    const prefix = `${type}:`;
    return [...this.#rows].filter(([rk]) => rk.startsWith(prefix));
  }

  isProvisional(rk: RecordKey): boolean {
    return this.#provisional.has(rk);
  }

  /**
   * One server write. Merged, never replaced: a projection that selected fewer columns must not
   * blank the columns another is rendering, so an omitted (or `undefined`) field is left alone.
   * Answers the row as it now stands, and whether anything in it changed.
   */
  merge(rk: RecordKey, columns: Row): { readonly row: Row; readonly changed: boolean } {
    // A restored row is a guess from disk: the server's first answer is the whole truth.
    const current = this.#provisional.delete(rk) ? undefined : this.#rows.get(rk);
    const next: Record<string, unknown> = { ...current };
    let changed = current === undefined;
    for (const [column, value] of Object.entries(columns)) {
      if (value === undefined) continue;
      if (current === undefined || current[column] !== value) changed = true;
      next[column] = value;
    }
    if (!changed && current !== undefined) return { row: current, changed: false };
    const row = Object.freeze(next);
    this.#rows.set(rk, row);
    return { row, changed: true };
  }

  /** A conflict policy's verdict replacing the server row outright. */
  set(rk: RecordKey, row: Row): void {
    this.#rows.set(rk, Object.freeze({ ...row }));
  }

  /** A row from disk, only where the server has not answered. Answers whether it went in. */
  restore(rk: RecordKey, row: Row): boolean {
    if (this.#rows.has(rk)) return false;
    this.#rows.set(rk, Object.freeze({ ...row }));
    this.#provisional.add(rk);
    return true;
  }

  /** Answers whether a row was there to remove. */
  remove(rk: RecordKey): boolean {
    this.#provisional.delete(rk);
    return this.#rows.delete(rk);
  }

  retain(rk: RecordKey): void {
    this.#holds.set(rk, (this.#holds.get(rk) ?? 0) + 1);
  }

  /** The last holder leaving evicts the row. Answers whether a row went. */
  release(rk: RecordKey): boolean {
    const holds = this.#holds.get(rk);
    if (holds === undefined) return false;
    if (holds > 1) {
      this.#holds.set(rk, holds - 1);
      return false;
    }
    this.#holds.delete(rk);
    return this.remove(rk);
  }

  clear(): void {
    this.#rows.clear();
    this.#provisional.clear();
  }
}

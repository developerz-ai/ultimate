// The store's SYNCED layer: server truth per `type:key`, merged column by column, with the holds
// that evict a record nobody renders and the provisional mark on rows restored from disk. Pure
// state — it answers what moved, and the store decides who hears about it.

import type { Row } from '@ultimat3/core/page';
import type { RecordKey } from './record-key';

export class SyncedLayer {
  readonly #rows = new Map<RecordKey, Row>();
  readonly #holds = new Map<RecordKey, number>();
  /** Types a whole-type reader holds (`useRecords(type, selection)`): none of their rows is evicted. */
  readonly #typeHolds = new Map<string, number>();
  /** Per held type, the rows whose last key holder left while it was held: the hold's to evict. */
  readonly #spared = new Map<string, Set<RecordKey>>();
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
    // Gone is no longer spared: a row the server sends again later is a new arrival, not this one.
    this.#spared.get(rk.slice(0, rk.indexOf(':')))?.delete(rk);
    return this.#rows.delete(rk);
  }

  retain(rk: RecordKey): void {
    this.#holds.set(rk, (this.#holds.get(rk) ?? 0) + 1);
  }

  /**
   * The last holder leaving evicts the row — unless a reader holds its whole type, which shows
   * every row of it and would lose this one to another holder's unmount. Answers whether a row went.
   */
  release(rk: RecordKey): boolean {
    const holds = this.#holds.get(rk);
    if (holds === undefined) return false;
    if (holds > 1) {
      this.#holds.set(rk, holds - 1);
      return false;
    }
    this.#holds.delete(rk);
    const type = rk.slice(0, rk.indexOf(':'));
    if (this.#typeHolds.has(type)) {
      const spared = this.#spared.get(type) ?? new Set<RecordKey>();
      spared.add(rk);
      this.#spared.set(type, spared);
      return false;
    }
    return this.remove(rk);
  }

  retainType(type: string): void {
    this.#typeHolds.set(type, (this.#typeHolds.get(type) ?? 0) + 1);
  }

  /**
   * The last type hold leaving evicts what it spared — each row whose last key holder left while
   * the type was held and that no key holder has taken since — exactly as that release would have.
   * A row no key holder ever held is not the hold's to evict. Answers the rows that went.
   */
  releaseType(type: string): readonly RecordKey[] {
    const holds = this.#typeHolds.get(type) ?? 0;
    if (holds > 1) {
      this.#typeHolds.set(type, holds - 1);
      return [];
    }
    this.#typeHolds.delete(type);
    const spared = this.#spared.get(type);
    this.#spared.delete(type);
    const evicted: RecordKey[] = [];
    for (const rk of spared ?? []) {
      if (!this.#holds.has(rk) && this.remove(rk)) evicted.push(rk);
    }
    return evicted;
  }

  clear(): void {
    this.#rows.clear();
    this.#provisional.clear();
    this.#spared.clear();
  }
}

// The store's SYNCED layer: server truth per `type:key`, merged column by column, with the holds
// that evict a record nobody renders, the channels that keep what they adopted, the per-type cap,
// and the provisional mark on rows restored from disk. Pure state — it answers what moved, and the
// store decides who hears about it.

import type { Row } from '@ultimat3/core/page';
import { sameJson } from './json';
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
  /**
   * Per type, its keys: a whole-type read walks its own rows, never every row of every type. A
   * run page holds the fleet's runs beside one run's events, and each event reader scanned both.
   */
  readonly #byType = new Map<string, Set<RecordKey>>();
  /**
   * Each indexed key's type, as its writer NAMED it. Never recovered from the key: a type may hold
   * a colon (`?query:<name>`, an unnamed live query's rows), so `type:key` splits two ways.
   */
  readonly #typeOfKey = new Map<RecordKey, string>();
  /**
   * Per key, the owners (a joined channel's sid) whose frames adopted it: each keeps the row like a
   * key holder until it leaves, or the server removes the row. Only rows that are here: a removed
   * row leaves it, so a feed joined for hours holds no key it no longer has.
   */
  readonly #owners = new Map<RecordKey, Set<string>>();
  /** Per type, the writes since the last `trim` — its newest rows, which no reader could hold yet. */
  readonly #written = new Map<string, Set<RecordKey>>();

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
    const out: [RecordKey, Row][] = [];
    for (const rk of this.#byType.get(type) ?? []) {
      const row = this.#rows.get(rk);
      if (row !== undefined) out.push([rk, row]);
    }
    return out;
  }

  isProvisional(rk: RecordKey): boolean {
    return this.#provisional.has(rk);
  }

  /**
   * One server write. Merged, never replaced: a projection that selected fewer columns must not
   * blank the columns another is rendering, so an omitted (or `undefined`) field is left alone.
   * Answers the row as it now stands, and whether anything in it changed. Compared STRUCTURALLY:
   * a JSON column is a fresh array or object on every read, and by identity every catch-up, poll
   * and reconnect moved every row. An unmoved column keeps its object, so its readers stay put.
   */
  merge(
    rk: RecordKey,
    columns: Row,
    type: string,
  ): { readonly row: Row; readonly changed: boolean } {
    // A restored row is a guess from disk: the server's first answer is the whole truth.
    const current = this.#provisional.delete(rk) ? undefined : this.#rows.get(rk);
    const next: Record<string, unknown> = { ...current };
    let changed = current === undefined;
    for (const [column, value] of Object.entries(columns)) {
      if (value === undefined) continue;
      if (current !== undefined && sameJson(current[column], value)) continue;
      changed = true;
      next[column] = value;
    }
    if (!changed && current !== undefined) return { row: current, changed: false };
    const row = Object.freeze(next);
    this.#put(rk, row, type);
    return { row, changed: true };
  }

  /** A conflict policy's verdict replacing the server row outright. */
  set(rk: RecordKey, row: Row): void {
    // Only ever over a row the server already holds: its type was named when it arrived.
    this.#put(rk, Object.freeze({ ...row }), this.#typeOfKey.get(rk) ?? typeOf(rk));
  }

  /** A row from disk, only where the server has not answered. Answers whether it went in. */
  restore(rk: RecordKey, row: Row, type: string): boolean {
    if (this.#rows.has(rk)) return false;
    this.#put(rk, Object.freeze({ ...row }), type);
    this.#provisional.add(rk);
    return true;
  }

  /** Answers whether a row was there to remove. */
  remove(rk: RecordKey): boolean {
    this.#provisional.delete(rk);
    this.#owners.delete(rk);
    // Gone is no longer spared: a row the server sends again later is a new arrival, not this one.
    const type = this.#typeOfKey.get(rk) ?? typeOf(rk);
    this.#typeOfKey.delete(rk);
    this.#spared.get(type)?.delete(rk);
    const keys = this.#byType.get(type);
    keys?.delete(rk);
    if (keys?.size === 0) this.#byType.delete(type);
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
    // A channel that adopted it still keeps it: it goes when that channel leaves.
    return !this.#owners.has(rk) && this.#evict(rk);
  }

  /** `owner` (a joined channel) adopted this row, just merged: it stays until the owner leaves. */
  own(rk: RecordKey, owner: string): void {
    setIn(this.#owners, rk).add(owner);
  }

  /**
   * The owner left (its channel was dropped): every row it alone kept goes — exactly as a last key
   * holder's release would, so a reader of the whole type still spares it. Answers the rows that went.
   */
  disown(owner: string): readonly RecordKey[] {
    const evicted: RecordKey[] = [];
    // A walk of the kept rows, not an index per owner: a drop is rare, and an index is bytes in
    // every page's boot. Deleting the entry being visited is safe while iterating a Map.
    for (const [rk, owners] of this.#owners) {
      if (!owners.delete(owner) || owners.size > 0) continue;
      this.#owners.delete(rk);
      if (!this.#holds.has(rk) && this.#evict(rk)) evicted.push(rk);
    }
    return evicted;
  }

  /**
   * The per-type cap: each type that grew since the last trim is cut back to its cap, least
   * recently written first. Never a row a key reader holds, never one `pinned` (a pending write's),
   * never one written since the last trim (an HTTP answer's rows, before its reader holds them).
   * A channel's ownership and a whole-type hold do NOT protect a row here: a fleet feed
   * joined for hours, read by `useRecords(type)`, is exactly what the cap exists to bound.
   */
  trim(capOf: (type: string) => number, pinned: (rk: RecordKey) => boolean): readonly RecordKey[] {
    const evicted: RecordKey[] = [];
    for (const [type, written] of this.#written) {
      const keys = this.#byType.get(type) ?? new Set<RecordKey>();
      let over = keys.size - capOf(type);
      // Oldest first: `#put` moves a row to the end of its type on every write, so the DISTINCT
      // rows written since the last trim that are still there are the last ones — never reached
      // (a row written twice counts once; one removed since is no longer at the end). Deleting the
      // entry being visited is safe while iterating a Set.
      let fresh = 0;
      for (const rk of written) if (keys.has(rk)) fresh += 1;
      let older = keys.size - fresh;
      for (const rk of keys) {
        if (over <= 0 || older-- <= 0) break;
        if (this.#holds.has(rk) || pinned(rk) || !this.remove(rk)) continue;
        evicted.push(rk);
        over -= 1;
      }
    }
    this.#written.clear();
    return evicted;
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
      if (!this.#holds.has(rk) && !this.#owners.has(rk) && this.remove(rk)) evicted.push(rk);
    }
    return evicted;
  }

  clear(): void {
    this.#owners.clear();
    this.#written.clear();
    this.#rows.clear();
    this.#byType.clear();
    this.#typeOfKey.clear();
    this.#provisional.clear();
    this.#spared.clear();
  }

  /** A row nobody holds goes — unless a reader holds its whole type, which spares it till it leaves. */
  #evict(rk: RecordKey): boolean {
    const type = this.#typeOfKey.get(rk) ?? typeOf(rk);
    if (this.#typeHolds.has(type)) {
      setIn(this.#spared, type).add(rk);
      return false;
    }
    return this.remove(rk);
  }

  #put(rk: RecordKey, row: Row, named: string): void {
    const type = this.#typeOfKey.get(rk) ?? named;
    this.#typeOfKey.set(rk, type);
    // Re-inserted on every write: a type's index is also its recency order, oldest first.
    const keys = setIn(this.#byType, type);
    keys.delete(rk);
    keys.add(rk);
    setIn(this.#written, type).add(rk);
    this.#rows.set(rk, row);
  }
}

/** A key's type when no writer named it (a hold on a row not yet there): before its first `:`. */
const typeOf = (rk: RecordKey): string => rk.slice(0, rk.indexOf(':'));

/** The set `map` holds under `key`, made on first use. */
function setIn<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let set = map.get(key);
  if (set === undefined) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}

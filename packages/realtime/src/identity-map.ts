// One row VALUE per `(scope, id)` for the whole client — the identity map the thesis takes from
// Ember Data. Two components holding two copies of one row is the bug it makes unrepresentable:
// a live query's window and the tier-3 local store are both projections over this one map, so a
// write through either is the same row for both. Membership and order live in the projections.

import type { JsonObject, JsonValue, Row } from './json';

/**
 * The entity's table — the same name `ChangeEvent.entity`, `tx.<table>` and a mutator's `entity`
 * already use, which is what makes the live path and the local store address one row identically.
 * A subscription whose entity the server did not name gets a private `?query:<name>` scope: no
 * sharing is worse than sharing two different entities that happen to spell one id the same way.
 */
export type RowScope = string;

/** `scope`+NUL+`id`. NUL cannot occur in an entity name, so the join is unambiguous. */
export type RowKey = string;

export function rowKey(scope: RowScope, id: string): RowKey {
  return `${scope}\u0000${id}`;
}

/** The scope a subscription uses until the server names its entity. `?` starts no entity name. */
export function privateScope(queryName: string): RowScope {
  return `?query:${queryName}`;
}

export type IdentityListener = (changed: ReadonlySet<RowKey>) => void;

/**
 * The map. Values are immutable: every write produces a NEW row object, because a projection over
 * this map hands its rows to a signal and a mutated-in-place row is a render that never happens.
 * "One row per id" therefore means one *current value* per id, referenced by every holder at once.
 */
export class IdentityMap {
  readonly #values = new Map<RowKey, Row>();
  /** How many projections hold each key. A row nobody holds is dropped — a window is not a leak. */
  readonly #holds = new Map<RowKey, number>();
  readonly #listeners = new Set<IdentityListener>();
  /** Non-null while a batch is open; every write inside one notifies exactly once, at the end. */
  #changed: Set<RowKey> | null = null;

  peek(scope: RowScope, id: string): Row | undefined {
    return this.#values.get(rowKey(scope, id));
  }

  /** Whole-row write: the value becomes exactly this row. `insert` and a rollback's undo use it. */
  set(scope: RowScope, row: Row): Row {
    const key = rowKey(scope, row.id);
    const current = this.#values.get(key);
    if (current === row) return row;
    this.#values.set(key, row);
    this.#touch(key);
    return row;
  }

  /**
   * Merge changed columns onto the current value. This is the write every server patch, every
   * snapshot row and every `upsert` takes: a projection that selected fewer columns must not blank
   * the columns another projection is rendering, so a write never removes a key. `undefined` in a
   * patch means "leave it alone", exactly as the local store's contract already says.
   */
  merge(
    scope: RowScope,
    id: string,
    columns: Readonly<Record<string, JsonValue | undefined>>,
  ): Row {
    const key = rowKey(scope, id);
    const current = this.#values.get(key);
    const next: JsonObject = { ...current };
    let changed = current === undefined;
    for (const [column, value] of Object.entries(columns)) {
      if (value === undefined || column === 'id') continue;
      if (current === undefined || current[column] !== value) changed = true;
      next[column] = value;
    }
    const row: Row = { ...next, id };
    // A patch that changed nothing must not re-emit: a no-op write re-rendering every holder is
    // how a live query becomes the most expensive thing on the page.
    if (!changed && current !== undefined) return current;
    this.#values.set(key, row);
    this.#touch(key);
    return row;
  }

  retain(scope: RowScope, id: string): void {
    const key = rowKey(scope, id);
    this.#holds.set(key, (this.#holds.get(key) ?? 0) + 1);
  }

  /** The last holder leaving drops the value: an infinite scroll must not retain every row it saw. */
  release(scope: RowScope, id: string): void {
    const key = rowKey(scope, id);
    const holds = this.#holds.get(key);
    if (holds === undefined) return;
    if (holds > 1) {
      this.#holds.set(key, holds - 1);
      return;
    }
    this.#holds.delete(key);
    if (this.#values.delete(key)) this.#touch(key);
  }

  /** Every write inside `fn` collapses into one notification — one patch frame, one render. */
  batch<T>(fn: () => T): T {
    if (this.#changed !== null) return fn();
    const collected = new Set<RowKey>();
    this.#changed = collected;
    try {
      return fn();
    } finally {
      this.#changed = null;
      if (collected.size > 0) this.#notify(collected);
    }
  }

  subscribe(listener: IdentityListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Held keys. Tests assert on it; nothing in the client branches on a count. */
  get size(): number {
    return this.#values.size;
  }

  #touch(key: RowKey): void {
    const batch = this.#changed;
    if (batch !== null) {
      batch.add(key);
      return;
    }
    this.#notify(new Set([key]));
  }

  #notify(changed: ReadonlySet<RowKey>): void {
    for (const listener of this.#listeners) listener(changed);
  }
}

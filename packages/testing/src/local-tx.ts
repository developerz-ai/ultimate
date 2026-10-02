// A mutator's `local()` half, run in a unit test: a `LocalTx` over rows held in memory, with the
// semantics of the page's record store. The twin under test is the app's; this is only the store
// it writes into, so a test asserts on rows and holds no cast and no hand-rolled table.

import type { LocalTable, LocalTx } from '@ultimat3/action';

/** `{ <table>: { <key>: <row> } }` — what the store holds, as a test seeds it and reads it back. */
export type LocalRows<TRow extends object = object> = Readonly<
  Record<string, Readonly<Record<string, TRow>>>
>;

export interface MemoryLocalTx {
  /** What `mutator.local(tx, input)` is handed. `tx.<table>` and `tx.table('<name>')` are one table. */
  readonly tx: LocalTx;
  /** What a table holds now, by key — after however many applications. `{}` for one never seen. */
  rows<TRow extends object = object>(table: string): Readonly<Record<string, TRow>>;
}

/** `undefined` in a patch means "leave it alone", exactly as the record store reads it. */
const definedOf = (columns: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== undefined));

/**
 * A client store for one test. Keyed, exactly like the real one: the browser holds no entity
 * schema, so a row is addressed by the key its server twin answers under, never by a column.
 *
 * | Call | Does |
 * |---|---|
 * | `insert(key, row)` | stores the row under the key |
 * | `upsert(key, row)` | merges over what is held; an `undefined` field leaves the column alone |
 * | `update(key, patch)` | changed fields, or a function of the held row. A NO-OP for a key the table does not hold — a twin must not invent a row |
 * | `delete(key)` | removes it |
 */
export function memoryLocalTx(seed: LocalRows = {}): MemoryLocalTx {
  const tables = new Map<string, Map<string, object>>();
  const held = (name: string): Map<string, object> => {
    const existing = tables.get(name);
    if (existing !== undefined) return existing;
    const created = new Map<string, object>();
    tables.set(name, created);
    return created;
  };
  // Frozen on the way in, as the record store freezes: a twin that mutated a row in place would
  // pass here and corrupt the synced truth it was handed in a browser.
  const stored = (row: object): object => Object.freeze({ ...row });
  for (const [name, rows] of Object.entries(seed)) {
    for (const [key, row] of Object.entries(rows)) held(name).set(key, stored(row));
  }

  // The one widening in this file: the store holds rows of whatever shape a test seeded, and a
  // table is read back as the shape its caller names — the same door `tx.table<TRow>()` is.
  const table = <TRow extends object>(name: string): LocalTable<TRow> => {
    const rows = held(name) as Map<string, TRow>;
    return {
      get: (key) => rows.get(key),
      all: () => [...rows.values()],
      insert: (key, row) => {
        rows.set(key, stored(row) as TRow);
      },
      upsert: (key, row) => {
        rows.set(key, stored({ ...rows.get(key), ...definedOf(row) }) as TRow);
      },
      update: (key, patch) => {
        const current = rows.get(key);
        if (current === undefined) return;
        const changed = typeof patch === 'function' ? patch(current) : patch;
        rows.set(key, stored({ ...current, ...definedOf(changed) }) as TRow);
      },
      delete: (key) => {
        rows.delete(key);
      },
    };
  };

  const tx = new Proxy({} as LocalTx, {
    get: (_target, property) => {
      if (typeof property !== 'string') return undefined;
      return property === 'table' ? table : table(property);
    },
  });

  return {
    tx,
    rows: <TRow extends object = object>(name: string): Readonly<Record<string, TRow>> =>
      Object.fromEntries(tables.get(name) ?? []) as Record<string, TRow>,
  };
}

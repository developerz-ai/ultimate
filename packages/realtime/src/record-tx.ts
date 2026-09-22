// The optimistic layer: every pending mutator's pure `local(tx, input)` half, replayed in order
// over synced truth. Replay, not stored results, is the point — a like counted as `likeCount + 1`
// over the OLD row must become `+ 1` over the row the server just sent, never the stale sum.

import type { ConflictPolicy, Row } from '@ultimat3/core/page';

/** One table as a mutator's `local` half sees it, keyed by record type (the entity's name). */
export interface LocalTable<R extends Row = Row> {
  get(key: string): R | undefined;
  all(): readonly R[];
  /**
   * The key is the caller's, never derived here: the browser holds no entity schema, so it cannot
   * know a primary key. An optimistic insert names the key its server twin will answer under.
   */
  insert(key: string, row: R): void;
  upsert(key: string, row: R): void;
  /** Changed fields only — or a function returning them; an omitted field is left as it was. */
  update(key: string, patch: Partial<R> | ((row: R) => Partial<R>)): void;
  delete(key: string): void;
}

export type TableMap = Record<string, Row>;

/** `tx.posts`, typed by the app's own entity rows. `tx.table(name)` is the string-named door. */
export type LocalTx<T extends TableMap = TableMap> = { readonly [K in keyof T]: LocalTable<T[K]> };

export interface OverlayEntry {
  /** The write's idempotency key — the same key the HTTP dispatch carries. */
  readonly key: string;
  readonly policy: ConflictPolicy;
  apply(tx: LocalTx): void;
}

export interface ReplayResult {
  readonly view: ReadonlyMap<string, Row | null>;
  readonly touched: Map<string, ReadonlySet<string>>;
  /** Entries whose `local` threw: dropped from the overlay and reported, never half-applied. */
  readonly failed: readonly string[];
}

/** Shallow content equality — a replay producing the same columns must not re-render anything. */
export function sameRow(a: Row | null, b: Row | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

export function replayOverlays(
  entries: readonly OverlayEntry[],
  synced: (recordKey: string) => Row | undefined,
  syncedOf: (type: string) => readonly (readonly [string, Row])[],
  report: (error: unknown) => void,
): ReplayResult {
  const view = new Map<string, Row | null>();
  const touched = new Map<string, ReadonlySet<string>>();
  const failed: string[] = [];
  for (const entry of entries) {
    // Each entry writes into a scratch copy, so a `local` that throws halfway leaves nothing.
    const scratch = new Map(view);
    const wrote = new Set<string>();
    try {
      entry.apply(txOver(scratch, wrote, synced, syncedOf));
    } catch (error) {
      report(error);
      failed.push(entry.key);
      continue;
    }
    for (const rk of wrote) view.set(rk, scratch.get(rk) ?? null);
    touched.set(entry.key, wrote);
  }
  return { view, touched, failed };
}

function txOver(
  view: Map<string, Row | null>,
  wrote: Set<string>,
  synced: (recordKey: string) => Row | undefined,
  syncedOf: (type: string) => readonly (readonly [string, Row])[],
): LocalTx {
  const tables = new Map<string, LocalTable>();
  const table = (type: string): LocalTable => {
    const existing = tables.get(type);
    if (existing !== undefined) return existing;
    const rk = (key: string): string => `${type}:${key}`;
    const read = (key: string): Row | undefined => {
      const overlaid = view.get(rk(key));
      return overlaid === undefined ? synced(rk(key)) : (overlaid ?? undefined);
    };
    const write = (key: string, row: Row | null): void => {
      view.set(rk(key), row === null ? null : Object.freeze({ ...row }));
      wrote.add(rk(key));
    };
    const created: LocalTable = {
      get: read,
      all: () => {
        const prefix = `${type}:`;
        const out = new Map<string, Row | null>();
        for (const [key, row] of syncedOf(type)) out.set(key, row);
        for (const [key, row] of view) if (key.startsWith(prefix)) out.set(key, row);
        return [...out.values()].filter((row): row is Row => row !== null);
      },
      insert: (key, row) => write(key, row),
      upsert: (key, row) => write(key, { ...read(key), ...definedOf(row) }),
      update: (key, patch) => {
        const current = read(key);
        if (current === undefined) return;
        const changed = typeof patch === 'function' ? patch(current) : patch;
        write(key, { ...current, ...definedOf(changed) });
      },
      delete: (key) => write(key, null),
    };
    tables.set(type, created);
    return created;
  };
  return new Proxy({} as LocalTx, {
    get: (_target, property) => {
      if (typeof property !== 'string') return undefined;
      if (property === 'table') return table;
      return table(property);
    },
  });
}

/** `undefined` in a patch means "leave it alone", exactly as a server merge reads it. */
function definedOf(columns: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(columns))
    if (value !== undefined) out[column] = value;
  return out;
}

// Tier 3: the durable local store a `mutator`'s `local(tx, input)` half writes to.
//
// `local` must be replayable — no I/O, no Date.now(), no Math.random() — because rebase replays it.
// That is why every write goes through a journal keyed by the mutation's idempotency key: rollback
// is "undo this key's journal in reverse", not "re-fetch and hope".

import { NotImplementedError } from './errors';
import type { JsonObject, Row } from './json';

export interface LocalTable<R extends Row = Row> {
  get(id: string): R | undefined;
  all(): readonly R[];
  insert(row: R): void;
  upsert(row: R): void;
  /** `patch` returns changed fields only, mirroring the canonical mutator example. */
  update(id: string, patch: (row: R) => Partial<R>): void;
  delete(id: string): void;
}

export type TableMap = Record<string, Row>;

/**
 * The transaction handle passed to `local`. In a generated app the table map comes from the app's
 * entities, so `tx.posts` is a real property with a real row type — never an index signature.
 */
export type LocalTx<T extends TableMap = TableMap> = { readonly [K in keyof T]: LocalTable<T[K]> };

interface JournalEntry {
  readonly table: string;
  readonly id: string;
  /** Row state before the write; `undefined` means "did not exist" (so undo = delete). */
  readonly before: Row | undefined;
}

export interface LocalStore<T extends TableMap = TableMap> {
  readonly tx: LocalTx<T>;
  table(name: string): LocalTable;
  /** Runs `fn` while journalling every write under `key`, so it can be rolled back verbatim. */
  apply(key: string, fn: (tx: LocalTx<T>) => void): void;
  /** Undo one key's writes, newest first. Used by rebase before reapplying pending mutations. */
  rollback(key: string): void;
  /** Server confirmed: drop the journal. After this the write is no longer optimistic. */
  commit(key: string): void;
  pendingKeys(): readonly string[];
  snapshot(name: string): readonly Row[];
  reset(tables: Readonly<Record<string, readonly Row[]>>): void;
}

/**
 * The reference implementation. Every rule in the tier-3 contract (journalling, ordered undo, key
 * scoping) is implemented here; OPFS SQLite swaps the storage, not the semantics.
 */
export class MemoryLocalStore<T extends TableMap = TableMap> implements LocalStore<T> {
  readonly #tables = new Map<string, Map<string, Row>>();
  readonly #journals = new Map<string, JournalEntry[]>();
  #recordingKey: string | null = null;

  readonly tx: LocalTx<T>;

  constructor(tables: Readonly<Record<string, readonly Row[]>> = {}) {
    this.reset(tables);
    const handler: ProxyHandler<Record<string, LocalTable>> = {
      // Symbols (`Symbol.iterator`, `then`) must not resolve to a table, or awaiting a tx would
      // silently create one.
      get: (_target, property) => (typeof property === 'symbol' ? undefined : this.table(property)),
    };
    this.tx = new Proxy({} as Record<string, LocalTable>, handler) as LocalTx<T>;
  }

  table(name: string): LocalTable {
    const rows = this.#rows(name);
    return {
      get: (id) => rows.get(id),
      all: () => [...rows.values()],
      insert: (row) => {
        this.#journal(name, row.id, rows.get(row.id));
        rows.set(row.id, row);
      },
      upsert: (row) => {
        const current = rows.get(row.id);
        this.#journal(name, row.id, current);
        rows.set(row.id, { ...(current ?? {}), ...row });
      },
      update: (id, patch) => {
        const current = rows.get(id);
        if (!current) return;
        this.#journal(name, id, current);
        rows.set(id, merge(current, patch(current)));
      },
      delete: (id) => {
        const current = rows.get(id);
        if (!current) return;
        this.#journal(name, id, current);
        rows.delete(id);
      },
    };
  }

  apply(key: string, fn: (tx: LocalTx<T>) => void): void {
    const previous = this.#recordingKey;
    this.#recordingKey = key;
    if (!this.#journals.has(key)) this.#journals.set(key, []);
    try {
      fn(this.tx);
    } finally {
      this.#recordingKey = previous;
    }
  }

  rollback(key: string): void {
    const journal = this.#journals.get(key);
    if (!journal) return;
    for (let i = journal.length - 1; i >= 0; i -= 1) {
      const entry = journal[i];
      if (!entry) continue;
      const rows = this.#rows(entry.table);
      if (entry.before === undefined) rows.delete(entry.id);
      else rows.set(entry.id, entry.before);
    }
    this.#journals.delete(key);
  }

  commit(key: string): void {
    this.#journals.delete(key);
  }

  pendingKeys(): readonly string[] {
    return [...this.#journals.keys()];
  }

  snapshot(name: string): readonly Row[] {
    return [...this.#rows(name).values()];
  }

  reset(tables: Readonly<Record<string, readonly Row[]>>): void {
    this.#tables.clear();
    this.#journals.clear();
    for (const [name, rows] of Object.entries(tables)) {
      this.#tables.set(name, new Map(rows.map((row) => [row.id, row])));
    }
  }

  #rows(name: string): Map<string, Row> {
    const existing = this.#tables.get(name);
    if (existing) return existing;
    const created = new Map<string, Row>();
    this.#tables.set(name, created);
    return created;
  }

  /** Only the *first* write to a row within one key is journalled — undo must reach the base state. */
  #journal(table: string, id: string, before: Row | undefined): void {
    const key = this.#recordingKey;
    if (key === null) return;
    const journal = this.#journals.get(key);
    if (!journal) return;
    if (journal.some((entry) => entry.table === table && entry.id === id)) return;
    journal.push(before === undefined ? { table, id, before: undefined } : { table, id, before });
  }
}

/** `undefined` in a patch means "leave it alone" — a row column is never set to undefined. */
function merge(row: Row, patch: Partial<Row>): Row {
  const next: JsonObject = { ...row };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value;
  }
  return { ...next, id: row.id };
}

export interface OpfsLocalStoreOptions {
  /** OPFS file name, versioned so a client-side migration can run before first read. */
  readonly file: string;
  readonly schemaVersion: number;
}

/**
 * The production tier-3 store: SQLite over the Origin Private File System, opened in a worker so a
 * long write never blocks the main thread. Browser-only, so it must not be reachable from a server
 * bundle — which is why it is a factory that throws rather than a class you can accidentally new
 * on the server.
 */
export function createOpfsLocalStore(options: OpfsLocalStoreOptions): LocalStore {
  throw new NotImplementedError({
    what: `OPFS SQLite local store (${options.file} v${options.schemaVersion})`,
    fix: "import { createOpfsLocalStore } from '@ultimat3/realtime/browser' (tier 3, v2); today use MemoryLocalStore or set persist: false on the query",
  });
}

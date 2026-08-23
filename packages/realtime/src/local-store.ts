// Tier 3: the durable local store a `mutator`'s `local(tx, input)` half writes to.
//
// `local` must be replayable — no I/O, no Date.now(), no Math.random() — because rebase replays it.
// That is why every write goes through a journal keyed by the mutation's idempotency key: rollback
// is "undo this key's journal in reverse", not "re-fetch and hope".
//
// A table owns MEMBERSHIP (which ids it holds); the shared `IdentityMap` owns the VALUES, so an
// optimistic write and the live query rendering that row are one row, not two copies.

import { NotImplementedError } from './errors';
import { IdentityMap } from './identity-map';
import type { Row } from './json';

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
  /** Row state before the write; `undefined` means "did not exist" (so undo = drop membership). */
  readonly before: Row | undefined;
}

export interface LocalStore<T extends TableMap = TableMap> {
  /**
   * The one map every row value lives in, shared with the live-query windows on the same client.
   * A `LiveClient` reads it off the store rather than building its own — two identity maps in one
   * client is the bug an identity map exists to prevent, one level up.
   */
  readonly identity: IdentityMap;
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
  /** Membership and nothing else: `#members.get('posts')` is which ids this table holds. */
  readonly #members = new Map<string, Set<string>>();
  readonly #journals = new Map<string, JournalEntry[]>();
  #recordingKey: string | null = null;

  readonly identity: IdentityMap;
  readonly tx: LocalTx<T>;

  constructor(tables: Readonly<Record<string, readonly Row[]>> = {}, identity = new IdentityMap()) {
    this.identity = identity;
    this.reset(tables);
    const handler: ProxyHandler<Record<string, LocalTable>> = {
      // Symbols (`Symbol.iterator`, `then`) must not resolve to a table, or awaiting a tx would
      // silently create one.
      get: (_target, property) => (typeof property === 'symbol' ? undefined : this.table(property)),
    };
    this.tx = new Proxy({} as Record<string, LocalTable>, handler) as LocalTx<T>;
  }

  table(name: string): LocalTable {
    const ids = this.#ids(name);
    const read = (id: string): Row | undefined =>
      ids.has(id) ? this.identity.peek(name, id) : undefined;
    return {
      get: read,
      all: () => {
        const rows: Row[] = [];
        for (const id of ids) {
          const row = this.identity.peek(name, id);
          if (row !== undefined) rows.push(row);
        }
        return rows;
      },
      insert: (row) => {
        this.#journal(name, row.id, read(row.id));
        this.#join(name, row.id, ids);
        this.identity.set(name, row);
      },
      upsert: (row) => {
        this.#journal(name, row.id, read(row.id));
        this.#join(name, row.id, ids);
        this.identity.merge(name, row.id, row);
      },
      update: (id, patch) => {
        const current = read(id);
        if (!current) return;
        this.#journal(name, id, current);
        this.identity.merge(name, id, patch(current));
      },
      delete: (id) => {
        const current = read(id);
        if (!current) return;
        this.#journal(name, id, current);
        this.#leave(name, id, ids);
      },
    };
  }

  apply(key: string, fn: (tx: LocalTx<T>) => void): void {
    const previous = this.#recordingKey;
    this.#recordingKey = key;
    if (!this.#journals.has(key)) this.#journals.set(key, []);
    try {
      // One notification for the whole twin: a mutator touching twenty rows is one render.
      this.identity.batch(() => fn(this.tx));
    } finally {
      this.#recordingKey = previous;
    }
  }

  rollback(key: string): void {
    const journal = this.#journals.get(key);
    if (!journal) return;
    this.identity.batch(() => {
      for (let i = journal.length - 1; i >= 0; i -= 1) {
        const entry = journal[i];
        if (!entry) continue;
        const ids = this.#ids(entry.table);
        if (entry.before === undefined) {
          this.#leave(entry.table, entry.id, ids);
          continue;
        }
        this.#join(entry.table, entry.id, ids);
        this.identity.set(entry.table, entry.before);
      }
    });
    this.#journals.delete(key);
  }

  commit(key: string): void {
    this.#journals.delete(key);
  }

  pendingKeys(): readonly string[] {
    return [...this.#journals.keys()];
  }

  snapshot(name: string): readonly Row[] {
    return this.table(name).all();
  }

  reset(tables: Readonly<Record<string, readonly Row[]>>): void {
    this.identity.batch(() => {
      for (const [name, ids] of this.#members) {
        for (const id of ids) this.identity.release(name, id);
      }
      this.#members.clear();
      this.#journals.clear();
      for (const [name, rows] of Object.entries(tables)) {
        const ids = this.#ids(name);
        for (const row of rows) {
          this.#join(name, row.id, ids);
          this.identity.set(name, row);
        }
      }
    });
  }

  #ids(name: string): Set<string> {
    const existing = this.#members.get(name);
    if (existing) return existing;
    const created = new Set<string>();
    this.#members.set(name, created);
    return created;
  }

  /** Membership is what holds a value in the map, so joining and retaining are one step. */
  #join(name: string, id: string, ids: Set<string>): void {
    if (ids.has(id)) return;
    ids.add(id);
    this.identity.retain(name, id);
  }

  /** Leaving releases: the value survives only while a live window still holds the same row. */
  #leave(name: string, id: string, ids: Set<string>): void {
    if (!ids.delete(id)) return;
    this.identity.release(name, id);
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
 *
 * The refusal below is the whole of what tier 3's durable half ships today, so its two lines have
 * to be true of THIS build. Both were false until 2026-08-23: the fix told the caller to import
 * this factory from a `/browser` subpath, which `package.json`'s `exports` has never declared —
 * two entries ship, `.` and `./server` — so pasting it ended in a module-resolution failure. Its
 * alternative was `persist: false` on the query, which `query()` has never accepted either (a
 * `TS2353` excess property). An instruction that cannot run is axiom 4 failing in the package that
 * documents it, so the fix now names an export that exists on an entry that exists:
 * `MemoryLocalStore`, on `.`, declared beside this factory. `fix-specifier.test.ts` is the
 * mechanical half.
 */
export function createOpfsLocalStore(options: OpfsLocalStoreOptions): LocalStore {
  throw new NotImplementedError({
    what: `the OPFS SQLite local store for ${options.file} (schema v${options.schemaVersion}), which is realtime tier 3's durable half,`,
    fix: "replace createOpfsLocalStore(...) with new MemoryLocalStore(), imported from '@ultimat3/realtime' beside it: the same LocalStore contract — journalled writes, ordered rollback, one row value per (entity, id) — held for the tab's lifetime rather than across a reload",
  });
}

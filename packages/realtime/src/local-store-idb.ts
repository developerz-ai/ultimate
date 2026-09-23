/**
 * The page's durable client store: persisted records and the one outbox, in IndexedDB, every entry
 * keyed by the principal it belongs to so one principal's cache can never restore into another's.
 * IndexedDB blocked (a private window, storage disabled) falls back to memory with ONE warning,
 * `X_LOCAL_STORE_UNAVAILABLE` — a page never breaks because it cannot remember.
 */

import type { ClientScope, RecordRows, Row } from '@ultimat3/core/page';
import { isJsonObject, renderThrowable, type UltimateError } from '@ultimat3/core/page';
import type { IdbDatabaseLike, IdbFactoryLike, IdbRequestLike } from './idb-types';
import type { QueueState } from './offline-queue';
import { LocalStoreUnavailableError } from './page-errors';

/** One persisted row, by record type and record key. */
export interface PersistedRow {
  readonly type: string;
  readonly key: string;
  readonly row: Row;
}

export interface LocalStore {
  readonly kind: 'indexeddb' | 'memory';
  /** Every persisted row of one scope: record type -> record key -> row. */
  rows(scope: string): Promise<ReadonlyMap<string, RecordRows>>;
  write(
    scope: string,
    puts: readonly PersistedRow[],
    deletes: readonly Omit<PersistedRow, 'row'>[],
  ): Promise<void>;
  queue(scope: string): Promise<QueueState | undefined>;
  saveQueue(scope: string, state: QueueState): Promise<void>;
  /** Everything of one scope — its rows AND its outbox. Sign-out, or any principal change. */
  wipe(scope: string): Promise<void>;
  /**
   * Everything of every scope but `keep` — rows and outboxes. The page boot's answer to a sign-out
   * by full navigation, which never calls `rescope()` and so never reaches `wipe`.
   */
  wipeOthers(keep: string): Promise<void>;
}

/**
 * The storage key of a principal, or `undefined` for an UNSCOPED page (rendered for nobody):
 * nothing is persisted there, because there is no principal to key it by. Prefixed so a principal
 * spelled `anon` can never share the anonymous visitor's rows.
 */
export function scopeKey(principal: ClientScope['principal']): string | undefined {
  if (principal === undefined) return undefined;
  return principal === null ? 'anon' : `p:${principal}`;
}

const RECORDS = 'records';
const OUTBOX = 'outbox';
/** JSON, never a joined string: a principal is opaque and may hold any separator. */
const rowKey = (scope: string, type: string, key: string): string =>
  JSON.stringify([scope, type, key]);

/** Memory: tests, SSR, and the fallback when IndexedDB is unavailable. */
export class MemoryLocalStore implements LocalStore {
  readonly kind = 'memory';
  readonly #rows = new Map<string, PersistedRow & { readonly scope: string }>();
  readonly #queues = new Map<string, QueueState>();

  async rows(scope: string): Promise<ReadonlyMap<string, RecordRows>> {
    return group([...this.#rows.values()].filter((entry) => entry.scope === scope));
  }
  async write(
    scope: string,
    puts: readonly PersistedRow[],
    deletes: readonly Omit<PersistedRow, 'row'>[],
  ): Promise<void> {
    for (const { type, key } of deletes) this.#rows.delete(rowKey(scope, type, key));
    for (const put of puts) this.#rows.set(rowKey(scope, put.type, put.key), { ...put, scope });
  }
  async queue(scope: string): Promise<QueueState | undefined> {
    return this.#queues.get(scope);
  }
  async saveQueue(scope: string, state: QueueState): Promise<void> {
    this.#queues.set(scope, structuredClone(state));
  }
  async wipe(scope: string): Promise<void> {
    for (const [key, entry] of this.#rows) if (entry.scope === scope) this.#rows.delete(key);
    this.#queues.delete(scope);
  }
  async wipeOthers(keep: string): Promise<void> {
    for (const [key, entry] of this.#rows) if (entry.scope !== keep) this.#rows.delete(key);
    for (const scope of [...this.#queues.keys()]) if (scope !== keep) this.#queues.delete(scope);
  }
}

class IdbLocalStore implements LocalStore {
  readonly kind = 'indexeddb';
  constructor(private readonly db: IdbDatabaseLike) {}

  async rows(scope: string): Promise<ReadonlyMap<string, RecordRows>> {
    const tx = this.db.transaction(RECORDS, 'readonly');
    const store = tx.objectStore(RECORDS);
    const [keys, values] = await Promise.all([answer(store.getAllKeys()), answer(store.getAll())]);
    const found: PersistedRow[] = [];
    keys.forEach((raw, index) => {
      const parts: unknown = typeof raw === 'string' ? JSON.parse(raw) : undefined;
      const row = values[index];
      if (!Array.isArray(parts) || parts[0] !== scope || !isJsonObject(row)) return;
      found.push({ type: String(parts[1]), key: String(parts[2]), row });
    });
    return group(found);
  }
  async write(
    scope: string,
    puts: readonly PersistedRow[],
    deletes: readonly Omit<PersistedRow, 'row'>[],
  ): Promise<void> {
    const tx = this.db.transaction(RECORDS, 'readwrite');
    const store = tx.objectStore(RECORDS);
    for (const { type, key } of deletes) store.delete(rowKey(scope, type, key));
    for (const put of puts) store.put(put.row, rowKey(scope, put.type, put.key));
    await done(tx);
  }
  async queue(scope: string): Promise<QueueState | undefined> {
    const tx = this.db.transaction(OUTBOX, 'readonly');
    const store = tx.objectStore(OUTBOX);
    const [keys, values] = await Promise.all([answer(store.getAllKeys()), answer(store.getAll())]);
    const at = keys.indexOf(scope);
    return at === -1 ? undefined : (values[at] as QueueState);
  }
  async saveQueue(scope: string, state: QueueState): Promise<void> {
    const tx = this.db.transaction(OUTBOX, 'readwrite');
    tx.objectStore(OUTBOX).put(state, scope);
    await done(tx);
  }
  async wipe(scope: string): Promise<void> {
    const tx = this.db.transaction([RECORDS, OUTBOX], 'readwrite');
    const records = tx.objectStore(RECORDS);
    const keys = await answer(records.getAllKeys());
    for (const raw of keys) {
      if (typeof raw !== 'string') continue;
      const parts: unknown = JSON.parse(raw);
      if (Array.isArray(parts) && parts[0] === scope) records.delete(raw);
    }
    tx.objectStore(OUTBOX).delete(scope);
    await done(tx);
  }
  async wipeOthers(keep: string): Promise<void> {
    const tx = this.db.transaction([RECORDS, OUTBOX], 'readwrite');
    const records = tx.objectStore(RECORDS);
    const outbox = tx.objectStore(OUTBOX);
    const [rowKeys, queueKeys] = await Promise.all([
      answer(records.getAllKeys()),
      answer(outbox.getAllKeys()),
    ]);
    for (const raw of rowKeys) {
      if (typeof raw !== 'string') continue;
      const parts: unknown = JSON.parse(raw);
      if (Array.isArray(parts) && parts[0] !== keep) records.delete(raw);
    }
    for (const scope of queueKeys) {
      if (typeof scope === 'string' && scope !== keep) outbox.delete(scope);
    }
    await done(tx);
  }
}

export interface OpenLocalStoreOptions {
  /** Default `globalThis.indexedDB`, read at call time. */
  readonly indexedDB?: IdbFactoryLike | undefined;
  /** Where the one fallback warning goes. Default `console.warn`. */
  readonly warn?: ((error: UltimateError) => void) | undefined;
  readonly name?: string | undefined;
}

/** IndexedDB when the page has it and it opens; memory, warned once, when it does not. */
export async function openLocalStore(options: OpenLocalStoreOptions = {}): Promise<LocalStore> {
  // The browser's `IDBFactory` IS this shape at runtime; its DOM typings (event-typed handlers)
  // are wider than the slice `idb-types.ts` declares, so the ambient value is narrowed once here.
  const ambient: unknown = Reflect.get(globalThis, 'indexedDB');
  const factory = options.indexedDB ?? (ambient as IdbFactoryLike | undefined);
  const warn = options.warn ?? ((error: UltimateError) => console.warn(error));
  if (factory === undefined) {
    warn(new LocalStoreUnavailableError({ reason: 'this runtime has no indexedDB' }));
    return new MemoryLocalStore();
  }
  try {
    return new IdbLocalStore(await openDatabase(factory, options.name ?? 'ultimate-client'));
  } catch (error) {
    warn(
      new LocalStoreUnavailableError({
        reason: `indexedDB.open failed: ${renderThrowable(error)}`,
      }),
    );
    return new MemoryLocalStore();
  }
}

function openDatabase(factory: IdbFactoryLike, name: string): Promise<IdbDatabaseLike> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = (): void => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS);
      if (!db.objectStoreNames.contains(OUTBOX)) db.createObjectStore(OUTBOX);
    };
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error);
    request.onblocked = (): void => reject(request.error ?? 'blocked by another open tab');
  });
}

function answer<T>(request: IdbRequestLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error);
  });
}

function done(tx: {
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  error: unknown;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = (): void => resolve();
    tx.onerror = (): void => reject(tx.error);
  });
}

function group(entries: readonly PersistedRow[]): ReadonlyMap<string, RecordRows> {
  const out = new Map<string, Record<string, Row>>();
  for (const { type, key, row } of entries) {
    const rows = out.get(type) ?? (Object.create(null) as Record<string, Row>);
    Object.defineProperty(rows, key, { value: row, enumerable: true });
    out.set(type, rows);
  }
  return out;
}

const PAGE_KEY: unique symbol = Symbol.for('ultimate.local-store');
type PageHost = { [PAGE_KEY]?: Promise<LocalStore> };

/**
 * The page's ONE durable store, opened once per tab whichever island asks first — the persister and
 * the outbox share it, so a wipe on a principal change reaches both. On `globalThis`, like the
 * record store, because every island bundle carries its own copy of this module.
 */
export function pageLocalStore(): Promise<LocalStore> {
  const host = globalThis as PageHost;
  const existing = host[PAGE_KEY];
  if (existing !== undefined) return existing;
  const opened = openLocalStore();
  Object.defineProperty(host, PAGE_KEY, { value: opened, configurable: true });
  return opened;
}
